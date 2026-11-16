"""Native Nginx contract tests, confined to loopback and temporary fixture data."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from test_release import KIT, REPO, module, release


class Nginx(unittest.TestCase):
    def test_native_portal_and_both_legacy_protocols(self):
        nginx, openssl = shutil.which('nginx'), shutil.which('openssl')
        if os.name != 'posix' or not nginx or not openssl:
            if os.environ.get('REQUIRE_NGINX') == '1': self.fail('Nginx/OpenSSL are required in CI')
            self.skipTest('Native Nginx/OpenSSL unavailable; Linux CI requires this contract test')
        with tempfile.TemporaryDirectory(prefix='plaza-nginx-') as directory:
            root = Path(directory).resolve()
            sockets = [socket.socket() for _ in range(3)]
            for s in sockets: s.bind(('127.0.0.1', 0))
            tls_port, old_port, portal_port = [s.getsockname()[1] for s in sockets]
            for s in sockets: s.close()
            origin = 'https://127.0.0.1:' + str(portal_port)
            cli = ('print("' + origin + '/plaza")\n').encode()
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, 'w') as z: z.writestr('fixture.txt', origin + '/plaza')
            package = zipped.getvalue()
            calls = []

            class Upstream(BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def do_POST(self): self.do_GET()
                def do_GET(self):
                    body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                    calls.append(self.path)
                    if self.path.endswith('publisher-cli.py'): data, kind = cli, 'text/x-python'
                    elif self.path.endswith('/packages/fixture'): data, kind = package, 'application/zip'
                    else:
                        payload = {'path': self.path, 'body': body.decode(), 'origin': origin + '/plaza',
                                   'previewUrl': origin + '/plaza/#publish=43d40f2f-41bd-49c7-9466-26b8b2e744c4&key=' + 'A' * 43,
                                   'cookie': self.headers.get('Cookie'), 'portal': self.headers.get('X-Plaza-Portal-Token'),
                                   'source': self.headers.get('Authorization'), 'host': self.headers.get('Host'),
                                   'realIp': self.headers.get('X-Real-IP'), 'xff': self.headers.get('X-Forwarded-For'),
                                   'requestId': self.headers.get('Idempotency-Key')}
                        data, kind = json.dumps(payload).encode(), 'application/json'
                    self.send_response(200); self.send_header('Content-Type', kind)
                    self.send_header('Content-Length', str(len(data))); self.send_header('Set-Cookie', 'fixture=not-a-credential')
                    self.end_headers(); self.wfile.write(data)

            upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
            thread = threading.Thread(target=upstream.serve_forever, daemon=True); thread.start()
            self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
            ca, key = root / 'fixture-ca.pem', root / 'fixture.key'
            subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                            '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', str(key), '-out', str(ca)], check=True, capture_output=True)
            plan = json.loads((KIT / 'deployment.example.json').read_text())
            plan.update(root=str(root), portal_origin=origin, portal_peer_ip='127.0.0.1', gateway_ip='127.0.0.1',
                        gateway_tls_port=tls_port, legacy_http_port=old_port, backend_port=upstream.server_port,
                        portal_gateway_ca=str(ca))
            fragments = release.render(plan)
            (root / 'config').mkdir(); gate = root / 'config/plaza-entry-state.conf'; gate.write_text('# open\n')
            tls = 'ssl_certificate ' + str(ca) + '; ssl_certificate_key ' + str(key) + ';\n'
            config = ('worker_processes 1;\nerror_log ' + str(root / 'error.log') + ' warn;\npid ' + str(root / 'nginx.pid')
                      + ';\nevents { worker_connections 64; }\nhttp { access_log off; proxy_temp_path ' + str(root / 'proxy-temp')
                      + '; client_body_temp_path ' + str(root / 'body-temp') + ';\nserver { listen 127.0.0.1:' + str(tls_port)
                      + ' ssl;\n' + tls + fragments['gateway-canonical.conf'] + fragments['gateway-legacy.conf'] + '}\n'
                      + fragments['gateway-legacy-server.conf'] + '\nserver { listen 127.0.0.1:' + str(portal_port)
                      + ' ssl;\n' + tls + fragments['portal-location.conf'] + '}\n}\n')
            conf = root / 'nginx.conf'; conf.write_text(config)
            check = subprocess.run([nginx, '-t', '-p', str(root), '-c', str(conf)], capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stderr)
            process = subprocess.Popen([nginx, '-p', str(root), '-c', str(conf), '-g', 'daemon off;'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs): return None

            context = ssl.create_default_context(cafile=str(ca))
            opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))

            def get(url, headers=None, body=None):
                try:
                    with opener.open(urllib.request.Request(url, headers=headers or {}, data=body), timeout=4) as response:
                        return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
                except urllib.error.HTTPError as error: return error.code, dict(error.headers), error.read()

            def until(fn):
                deadline = time.monotonic() + 8
                while True:
                    try:
                        if fn(): return
                    except OSError: pass
                    if time.monotonic() > deadline: self.fail('Fixture Nginx did not reach expected state')
                    time.sleep(0.05)

            try:
                until(lambda: get(origin + '/plaza/api/health')[0] == 200)
                headers = {'Cookie': 'fixture-browser', 'X-Plaza-Portal-Token': 'fixture-portal', 'X-Real-IP': '198.51.100.23', 'X-Forwarded-For': '203.0.113.12'}
                # The front portal overrides client-supplied forwarding headers.
                code, _, body = get(origin + '/plaza/api/health', headers)
                canonical = json.loads(body)
                self.assertEqual((code, canonical['path'], canonical['host']), (200, '/plaza/api/health', '127.0.0.1:' + str(portal_port)))
                self.assertEqual((canonical['cookie'], canonical['portal']), ('fixture-browser', 'fixture-portal'))
                self.assertEqual(canonical['realIp'], '127.0.0.1'); self.assertIsNone(canonical['xff'])
                for scheme, port in [('http', old_port), ('https', tls_port)]:
                    old = scheme + '://127.0.0.1:' + str(port)
                    source_headers = {**headers, 'Authorization': 'Bearer fixture-source', 'Idempotency-Key': 'fixture-request', 'Content-Type': 'application/json'}
                    code, response_headers, body = get(old + '/api/managed-publications', source_headers, b'{"fixture":1}')
                    source = json.loads(body)
                    self.assertEqual((code, source['origin'], source['body']), (200, old, '{"fixture":1}'))
                    self.assertIsNone(source['cookie']); self.assertIsNone(source['portal']); self.assertIsNone(source['xff'])
                    self.assertEqual((source['source'], source['requestId']), ('Bearer fixture-source', 'fixture-request'))
                    self.assertNotIn('set-cookie', response_headers)
                    publisher = module('fixture_publisher', REPO / 'server/publisher-cli.py')
                    self.assertIsNotNone(publisher._author_preview_details(source['previewUrl'], old))
                    self.assertIsNone(publisher._author_preview_details(source['previewUrl'], origin + '/plaza'))
                    for suffix in ['/api/auth/tiangong/status', '/api/personal/favorites', '/api/operations/dashboard', '/api/publications/example/confirm']:
                        count = len(calls); self.assertEqual(get(old + suffix)[0], 403); self.assertEqual(len(calls), count)
                    self.assertEqual(get(old + '/api/publisher-cli.py')[2], cli)
                    self.assertEqual(hashlib.sha256(get(old + '/api/apps/example/packages/fixture')[2]).hexdigest(), hashlib.sha256(package).hexdigest())
                    redirect_code, redirect_headers, _ = get(old + '/?entry=compat')
                    self.assertEqual(redirect_code, 308); self.assertEqual({k.lower(): v for k, v in redirect_headers.items()}['location'], origin + '/plaza/?entry=compat')
                    self.assertEqual(get(old + '/', {'Host': 'attacker.invalid'})[0], 421)
                gate.write_text('return 503;\n'); process.send_signal(signal.SIGHUP)
                until(lambda: get(origin + '/plaza/api/health')[0] == 503)
                for scheme, port in [('http', old_port), ('https', tls_port)]:
                    self.assertEqual(get(scheme + '://127.0.0.1:' + str(port) + '/api/health')[0], 503)
            finally:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
                if process.stderr: process.stderr.close()


if __name__ == '__main__': unittest.main()
