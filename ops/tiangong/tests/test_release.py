import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

KIT = Path(__file__).resolve().parents[1]
REPO = KIT.parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); sys.modules[name] = result; spec.loader.exec_module(result)
    return result


release = module('plaza_release', KIT / 'release.py')
packager = module('plaza_package', KIT.parent / 'trial/package.py')


def archive(path, files=None, extra=None):
    files = files or {'server/index.ts': b'export {};\n', 'server/publisher-cli.py': b'print("fixture")\n',
                      'package.json': b'{}', 'package-lock.json': b'{"lockfileVersion":3}',
                      'dist/index.html': b'<html>fixture</html>', 'scripts/refresh-agent-distributions.ts': b'export {};'}
    manifest = {'release': '20990101-01234567', 'sourceSha': '0123456789abcdef0123456789abcdef01234567',
                'sourceTree': 'b' * 40, 'files': {k: release.sha(v) for k, v in files.items()}}
    with tarfile.open(path, 'w:gz') as tar:
        for name, data in {**files, 'release.json': json.dumps(manifest).encode()}.items():
            entry = tarfile.TarInfo(name); entry.size = len(data); tar.addfile(entry, io.BytesIO(data))
        if extra:
            for entry, data in extra: tar.addfile(entry, io.BytesIO(data) if entry.isfile() else None)
    return manifest


class Inputs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.plan = json.loads((KIT / 'deployment.example.json').read_text())

    def validate(self, plan=None):
        file = self.root / 'plan.json'; file.write_text(json.dumps(plan or self.plan))
        return release.load_plan(file, complete=False)

    def test_render_has_no_unresolved_placeholders_or_real_identity(self):
        files = release.render(self.validate())
        self.assertEqual(len(files), 5)
        self.assertNotIn('@@', ''.join(files.values()))
        self.assertIn('PLAZA_SUPER_ADMIN_ACCOUNT=\n', files['identity.env'])
        self.assertIn('proxy_ssl_verify on;', files['portal-location.conf'])
        self.assertIn('proxy_set_header Cookie "";', files['gateway-legacy.conf'])

    def test_render_cli_accepts_relative_new_output_and_refuses_replay(self):
        output = self.root / 'private-output'
        cmd = [sys.executable, '-B', str(KIT / 'release.py'), 'render', '--plan', str(KIT / 'deployment.example.json'), '--output', 'private-output']
        first = subprocess.run(cmd, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stdout)
        (output / 'identity.env').write_text('PRIVATE_SENTINEL')
        second = subprocess.run(cmd, cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((output / 'identity.env').read_text(), 'PRIVATE_SENTINEL')

    def test_plan_injection_and_unsafe_targets_rejected(self):
        for key, value in [('portal_origin', 'https://portal.invalid;include'), ('root', '/'),
                           ('root', '/opt/../etc'), ('gateway_ip', '0.0.0.0/0'),
                           ('backend_port', 16490), ('node', '/usr/bin/node'),
                           ('portal_origin', 'https://portal.invalid:443'),
                           ('gateway_candidate', '/different/nginx.conf')]:
            with self.subTest(key=key, value=value):
                plan = copy.deepcopy(self.plan); plan[key] = value
                with self.assertRaises((RuntimeError, ValueError)): self.validate(plan)

    def test_unknown_private_fields_never_echoed(self):
        self.plan['password'] = 'PRIVATE_SENTINEL'
        path = self.root / 'plan.json'; path.write_text(json.dumps(self.plan))
        result = subprocess.run([sys.executable, '-B', str(KIT / 'release.py'), 'render', '--plan', str(path), '--output', str(self.root / 'output')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('PRIVATE_SENTINEL', result.stdout + result.stderr)

    def test_gateway_protects_unrelated_servers_and_global_directives(self):
        p = self.validate(); rendered = release.render(p)
        other = 'server { listen 192.0.2.20:16488 ssl; location / { return 200 "{fixture}"; } }'
        old = 'events {}\nhttp {\n' + other + '\nserver { listen 192.0.2.20:16490 ssl; location / { return 200; } }\n}'
        new = 'events {}\nhttp {\n' + other + '\nserver { listen 192.0.2.20:16490 ssl;\n' + rendered['gateway-canonical.conf'] + rendered['gateway-legacy.conf'] + '}\n' + rendered['gateway-legacy-server.conf'] + '\n}'
        self.assertEqual(release.unrelated_gateway(old, p), release.unrelated_gateway(new, p))
        self.assertNotEqual(release.unrelated_gateway(old, p), release.unrelated_gateway(new.replace('16488', '16487'), p))
        with self.assertRaises(RuntimeError): release.unrelated_gateway(new.replace('events {}', 'server { listen 192.0.2.20:16490; }'), p)

    def test_valid_archive_and_safe_directories(self):
        file = self.root / 'release.tar.gz'
        directory = tarfile.TarInfo('server/'); directory.type = tarfile.DIRTYPE
        archive(file, extra=[(directory, b'')])
        manifest = release.validate_archive(file, release.file_sha(file), self.plan['source_sha'], self.plan['release'])
        self.assertIn('server/index.ts', manifest['files'])

    def test_archive_traversal_links_duplicates_private_files_and_wrong_digest(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('server/../../escape', tarfile.REGTYPE),
                           ('server\\..\\escape', tarfile.REGTYPE), ('server/index.ts', tarfile.REGTYPE),
                           ('server/key.pem', tarfile.REGTYPE), ('server/linked', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                file = self.root / 'bad.tar.gz'; entry = tarfile.TarInfo(name); entry.type = kind; entry.linkname = '/etc/passwd'
                archive(file, extra=[(entry, b'')])
                with self.assertRaises(RuntimeError): release.validate_archive(file, release.file_sha(file), self.plan['source_sha'], self.plan['release'])
        with self.assertRaises(RuntimeError): release.validate_archive(file, '0' * 64, self.plan['source_sha'], self.plan['release'])
        self.assertFalse((self.root / 'escape').exists())


class Packaging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'source'; self.root.mkdir()
        def git(*args): return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL)
        self.git = git
        git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false')
        for name in ['server/index.ts', 'server/publisher-cli.py', 'scripts/refresh-agent-distributions.ts', 'package.json', 'package-lock.json']:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'{}\n' if name.endswith('.json') else b'fixture\n')
        (self.root / '.gitignore').write_text('dist/\n.env\nbackup.dump\n')
        (self.root / '.env').write_text('PRIVATE_SENTINEL'); (self.root / 'backup.dump').write_text('PRIVATE_SENTINEL')
        git('add', '.'); git('commit', '-m', 'fixture')
        git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').decode().strip())
        self.output = self.root.parent / 'output'

    def build(self, root):
        (root / 'dist').mkdir(exist_ok=True); (root / 'dist/index.html').write_text('<html>fresh</html>')

    def test_git_blob_bytes_and_fresh_build_bound_to_manifest(self):
        self.git('config', 'core.autocrlf', 'true')
        source = self.root / 'server/publisher-cli.py'; source.write_bytes(b'fixture\r\n')
        self.git('add', '--renormalize', '--', 'server/publisher-cli.py')
        self.assertEqual(self.git('status', '--porcelain'), b'')
        with patch.object(packager, 'build', side_effect=self.build) as build:
            result = packager.package(self.root, '20990101', self.output, 'origin/main')
        self.assertEqual(build.call_count, 1)
        with tarfile.open(result['archive']) as tar:
            self.assertEqual(tar.extractfile('server/publisher-cli.py').read(), b'fixture\n')
            self.assertEqual(tar.extractfile('dist/index.html').read(), b'<html>fresh</html>')
            self.assertNotIn('.env', tar.getnames()); self.assertNotIn('backup.dump', tar.getnames())
            self.assertNotIn(b'PRIVATE_SENTINEL', b''.join(tar.extractfile(e).read() for e in tar.getmembers() if e.isfile()))
        release.validate_archive(Path(result['archive']), result['sha256'], result['sourceSha'], result['release'])

    def test_main_drift_and_source_changes_during_build_rejected(self):
        with patch.object(packager, 'build', side_effect=lambda root: (root / 'server/index.ts').write_text('changed')):
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED'): packager.package(self.root, '20990101', self.output)
        self.git('add', '.'); self.git('commit', '-m', 'changed')
        with patch.object(packager, 'build') as build:
            with self.assertRaisesRegex(RuntimeError, 'VERIFIED_MAIN'): packager.package(self.root, '20990101', self.output, 'origin/main')
            build.assert_not_called()


class FakeHost(release.Release):
    """Only OS command boundaries are synthetic; files, archives and states are real."""
    def __init__(self, plan, root):
        super().__init__(plan)
        self.unit = root / 'systemd/service.d/90-plaza-tiangong.conf'
        self.original_unit = root / 'systemd/service'; self.original_unit.parent.mkdir(); self.original_unit.write_text('[Service]\n')
        self.running, self.events, self.timeout_start = True, [], False

    def check(self):
        return release.validate_archive(Path(self.p['archive']), self.p['archive_sha256'], self.p['source_sha'], self.p['release'])

    def prop(self, name):
        return {'MainPID': ('202' if self.unit.exists() else '101') if self.running else '0', 'ActiveState': 'active' if self.running else 'inactive',
                'WorkingDirectory': str(self.target) if self.unit.exists() else self.p['previous_release'], 'FragmentPath': str(self.original_unit),
                'EnvironmentFiles': str(self.root / 'config/original.env') + ' (ignore_errors=no)' + ('\n' + str(self.overlay) + ' (ignore_errors=no)' if self.unit.exists() else '')}[name]

    def env(self):
        return {b'DATABASE_URL': b'PRIVATE_SENTINEL', b'PLAZA_SECRET': b'PRIVATE_SENTINEL', b'PLAZA_DATA_DIR': self.p['data_dir'].encode()}

    def identity_runtime_matches(self): pass

    def baseline(self): return {'apps': 16, 'catalog': 'unchanged', 'roles': 'same', 'access': 'same'}
    def reload(self): self.events.append('reload')

    def run(self, args, stdin=None, stdout=None, timeout=60, cwd=None):
        if args[:2] == ['systemctl', 'stop']: self.events.append('stop'); self.running = False
        elif args[:2] == ['systemctl', 'start']:
            self.events.append('start'); self.running = True
            if self.timeout_start: raise subprocess.TimeoutExpired('systemctl', timeout)
        elif 'pg_dump' in ' '.join(args):
            assert not self.running; self.events.append('dump'); stdout.write(b'PGDMP-fixture')
        elif 'pg_restore' in args: return b'TABLE DATA fixture'
        elif args[0] == 'tar' and '-cpf' in args:
            assert not self.running; self.events.append('data-backup'); Path(args[3]).write_bytes(b'data-fixture')
        elif args[0] == self.p['node']: assert cwd == self.target
        return b''

    def get(self, url, ca=None, headers=None):
        portal = self.p['portal_origin'] + '/plaza'
        if url.startswith('http://127.0.0.1:'):
            if url.endswith('/api/health'): return 200, {}, b'{"managementMode":"identity"}'
            if url.endswith('/api/auth/tiangong/status'): return 200, {}, b'{"enabled":true}'
            return 401, {}, b'{}'
        if url == portal + '/api/health': return (503 if self.gate.read_text().strip() == 'return 503;' else 200), {}, b'{}'
        if url.startswith(portal): return (401 if url.endswith('/api/operations/dashboard') else 200), {}, b'{}'
        if url.endswith('/?entry=compat'): return 308, {'location': portal + '/?entry=compat'}, b''
        if url.endswith('/api/auth/tiangong/status'): return 403, {}, b'{}'
        body = (self.target / 'server/publisher-cli.py').read_bytes()
        return 200, {'x-content-sha256': release.sha(body)}, body


class UpdatePhases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve(); plan = json.loads((KIT / 'deployment.example.json').read_text())
        plan.update(root=str(root), data_dir=str(root / 'data'), previous_release=str(root / 'releases/previous'))
        for name in ['archive', 'gateway_candidate', 'gateway_config', 'identity_env', 'portal_ca', 'gateway_ca']: plan[name] = str(root / name)
        for name in ['config', 'data', 'releases/previous/node_modules/tsx']: (root / name).mkdir(parents=True, exist_ok=True)
        (root / 'config/original.env').write_text('DATABASE_URL=PRIVATE_SENTINEL\n')
        for name in ['gateway_candidate', 'gateway_config', 'identity_env', 'portal_ca', 'gateway_ca']: (root / name).write_text('fixture')
        archive(root / 'archive'); plan['archive_sha256'] = release.file_sha(root / 'archive'); plan['gateway_candidate_sha256'] = release.file_sha(root / 'gateway_candidate')
        self.host = FakeHost(plan, root)

    def state(self): return json.loads((self.host.operation / 'state.json').read_text())

    def test_complete_update_backups_precede_gateway_and_start(self):
        host = self.host; host.stage(); self.assertEqual(self.state()['phase'], 'STAGED')
        host.switch(); self.assertEqual(self.state()['phase'], 'SWITCHED')
        self.assertEqual(host.events, ['stop', 'dump', 'data-backup', 'reload', 'start'])
        self.assertTrue(host.verify(self.state(), maintenance=True)['maintenance'])
        host.activate(); self.assertEqual(self.state()['phase'], 'ACTIVE')
        self.assertEqual(host.verify(self.state(), maintenance=False)['status'], 'VERIFIED')
        with self.assertRaisesRegex(RuntimeError, 'STATE_REPLAY'): host.switch()

    def test_changed_inputs_block_before_stop(self):
        host = self.host; host.stage(); Path(host.p['identity_env']).write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'FROZEN_INPUT'): host.switch()
        self.assertEqual(host.events, [])

    def test_unknown_start_result_retained_and_not_replayed(self):
        host = self.host; host.stage(); host.timeout_start = True
        with self.assertRaises(subprocess.TimeoutExpired): host.switch()
        self.assertEqual(self.state()['phase'], 'UNKNOWN')
        self.assertEqual(host.events.count('start'), 1)
        with self.assertRaisesRegex(RuntimeError, 'STATE_REPLAY'): host.switch()
        self.assertEqual(host.events.count('start'), 1)
        self.assertEqual(host.gate.read_text().strip(), 'return 503;')

    def test_failed_activation_restores_maintenance_without_old_binary(self):
        host = self.host; host.stage(); host.switch()
        real_get = host.get
        def broken_cli(url, ca=None, headers=None):
            if url.endswith('/api/publisher-cli.py'): return 200, {}, b'corrupted'
            return real_get(url, ca, headers)
        with patch.object(host, 'get', side_effect=broken_cli):
            with self.assertRaisesRegex(RuntimeError, 'LEGACY_CLI_CHANGED'): host.activate()
        state = self.state()
        self.assertEqual(state['phase'], 'FAILED'); self.assertTrue(state['maintenanceRestored'])
        self.assertEqual(host.prop('WorkingDirectory'), str(host.target))
        self.assertEqual(host.events.count('start'), 1)


if __name__ == '__main__': unittest.main()
