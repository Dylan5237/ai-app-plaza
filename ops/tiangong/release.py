"""Plaza-only update: render/check/stage/switch/activate/verify. No SSH or rollback."""
import argparse
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import ssl
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

TEMPLATES = Path(__file__).with_name('templates')
FIELDS = set(json.loads(Path(__file__).with_name('deployment.example.json').read_text(encoding='utf-8')))
INVARIANTS = ('DATABASE_URL', 'PLAZA_SECRET', 'PLAZA_MANAGED_GITLAB_TOKEN', 'PLAZA_MANAGED_GROUP_ID', 'PLAZA_MANAGED_GROUP_PATH', 'PLAZA_DATA_DIR')


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def load_plan(path, complete=True):
    plan = json.loads(path.read_text(encoding='utf-8'))
    require(set(plan) == FIELDS, 'PLAN_FIELDS_INVALID')
    for name, value in plan.items():
        if name.endswith('_port'):
            require(type(value) is int and 1024 <= value <= 65535, 'PORT_INVALID')
        else:
            require(isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9_/.:+-]+', value)), 'PLAN_VALUE_INVALID')
    require(len({plan[k] for k in FIELDS if k.endswith('_port')}) == 3, 'PORTS_MUST_DIFFER')
    require(re.fullmatch(r'\d{8}-[a-f0-9]{8}', plan['release']), 'RELEASE_INVALID')
    require(re.fullmatch(r'[a-f0-9]{40}', plan['source_sha']) and plan['release'].endswith(plan['source_sha'][:8]), 'SOURCE_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9_-]+\.service', plan['service']), 'SERVICE_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9_-]+', plan['database_container']), 'CONTAINER_INVALID')
    for key in ('portal_peer_ip', 'gateway_ip'):
        require(ipaddress.ip_address(plan[key]).version == 4, 'IPV4_REQUIRED')
    origin = urlsplit(plan['portal_origin'])
    require(origin.scheme == 'https' and origin.hostname and origin.path == '' and not origin.username and not origin.query and not origin.fragment, 'PORTAL_ORIGIN_INVALID')
    require(origin.port != 443, 'OMIT_DEFAULT_HTTPS_PORT')
    paths = FIELDS - {'release', 'source_sha', 'service', 'database_container', 'portal_origin', 'portal_peer_ip', 'gateway_ip'}
    paths = {k for k in paths if not k.endswith(('_port', '_sha256'))}
    for name in paths:
        value = PurePosixPath(plan[name])
        require(value.is_absolute() and '..' not in value.parts and str(value) == plan[name], 'ABSOLUTE_SAFE_PATH_REQUIRED')
    root = PurePosixPath(plan['root'])
    require(root != PurePosixPath('/') and len(root.parts) >= 3, 'APP_ROOT_INVALID')
    require(PurePosixPath(plan['previous_release']).parent == root / 'releases', 'PREVIOUS_RELEASE_OUTSIDE_ROOT')
    require(PurePosixPath(plan['node']).is_relative_to(root / 'runtime'), 'NODE_OUTSIDE_RUNTIME')
    require(PurePosixPath(plan['gateway_candidate']).parent == PurePosixPath(plan['gateway_config']).parent
            and plan['gateway_candidate'] != plan['gateway_config'], 'CANDIDATE_MUST_SHARE_CONFIG_DIRECTORY')
    if complete:
        for name in ('archive_sha256', 'gateway_before_sha256', 'gateway_candidate_sha256', 'portal_ca_sha256'):
            require(re.fullmatch(r'[a-f0-9]{64}', plan[name]), 'EXPECTED_SHA256_REQUIRED')
    return plan


def render(plan):
    values = {name.upper(): str(value) for name, value in plan.items()}
    values['PORTAL_HOST'] = urlsplit(plan['portal_origin']).netloc
    result = {}
    for source in sorted(TEMPLATES.glob('*.in')):
        text = source.read_text(encoding='utf-8')
        text = re.sub(r'@@([A-Z_]+)@@', lambda m: values[m[1]], text)
        require('@@' not in text, 'TEMPLATE_PLACEHOLDER_UNRESOLVED')
        result[source.stem] = text
    legacy = result['gateway-legacy.conf']
    result['gateway-legacy-server.conf'] = ('server {\n    listen ' + plan['gateway_ip'] + ':' + str(plan['legacy_http_port'])
        + ';\n    server_name ' + plan['gateway_ip'] + ';\n    if ($http_host != "' + plan['gateway_ip'] + ':'
        + str(plan['legacy_http_port']) + '") { return 421; }\n' + legacy + '}\n')
    return result


def mask_nginx(text):
    out, quote, comment, escaped = list(text), None, False, False
    for i, char in enumerate(text):
        if comment:
            if char == '\n': comment = False
            else: out[i] = ' '
        elif quote:
            out[i] = ' '
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == quote: quote = None
        elif char == '#': comment = True; out[i] = ' '
        elif char in ('"', "'"): quote = char; out[i] = ' '
    require(not quote, 'NGINX_QUOTE_UNBALANCED')
    return ''.join(out)


def unrelated_gateway(text, plan):
    """Remove only the two Plaza server blocks; preserve every other nonblank byte."""
    masked, spans = mask_nginx(text), []
    counts = {str(plan[k]): 0 for k in ('gateway_tls_port', 'legacy_http_port')}
    for match in re.finditer(r'\bserver\s*\{', masked):
        end, depth = masked.index('{', match.start()) + 1, 1
        while end < len(masked) and depth:
            depth += (masked[end] == '{') - (masked[end] == '}'); end += 1
        require(depth == 0, 'NGINX_BRACES_UNBALANCED')
        body = masked[match.start():end]
        targets = [port for port in counts if re.search(r'\blisten\s+' + re.escape(plan['gateway_ip'] + ':' + port) + r'(?:\s|;)', body)]
        if targets:
            require(len(targets) == 1, 'MIXED_PLAZA_SERVER_PORTS')
            counts[targets[0]] += 1
            spans.append((match.start(), end))
    require(counts[str(plan['gateway_tls_port'])] == 1 and counts[str(plan['legacy_http_port'])] <= 1, 'PLAZA_SERVER_LAYOUT_INVALID')
    for start, end in reversed(spans):
        text = text[:start] + text[end:]
    return '\n'.join(line for line in text.splitlines() if line.strip())


def validate_archive(archive, digest, source_sha, release):
    require(file_sha(archive) == digest, 'ARCHIVE_SHA256_MISMATCH')
    with tarfile.open(archive) as tar:
        entries = tar.getmembers()
        names = [e.name for e in entries]
        require(len(names) == len(set(names)) and len(names) <= 10000, 'ARCHIVE_NAMES_INVALID')
        require(sum(e.size for e in entries) <= 256 * 1024 * 1024, 'ARCHIVE_TOO_LARGE')
        for entry in entries:
            name = PurePosixPath(entry.name)
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.name
                    and not any(ord(c) < 32 for c in entry.name) and entry.name.rstrip('/') == str(name)
                    and (entry.isfile() or entry.isdir()), 'UNSAFE_ARCHIVE_ENTRY')
            require(entry.name == 'release.json' or name.parts[0] in {'server', 'dist', 'scripts', 'package.json', 'package-lock.json'}, 'UNEXPECTED_ARCHIVE_FILE')
            require(name.suffix.lower() not in {'.env', '.pem', '.key', '.dump', '.pyc'}
                    and not any(part.lower().startswith('.env') for part in name.parts), 'PRIVATE_ARCHIVE_FILE')
        manifest = json.load(tar.extractfile('release.json'))
        require(manifest['release'] == release and manifest['sourceSha'] == source_sha and re.fullmatch(r'[a-f0-9]{40}', manifest['sourceTree']), 'RELEASE_MANIFEST_MISMATCH')
        files = {e.name for e in entries if e.isfile()} - {'release.json'}
        require(files == set(manifest['files']) and {'server/index.ts', 'package.json', 'package-lock.json', 'dist/index.html'} <= files, 'MANIFEST_FILE_SET_MISMATCH')
        for name, expected in manifest['files'].items():
            require(sha(tar.extractfile(name).read()) == expected, 'MANIFEST_FILE_SHA256_MISMATCH')
    return manifest


def atomic(path, data, mode=0o600):
    path = path.absolute()
    require(path.parent.resolve() == path.parent, 'SYMLINK_WRITE_PARENT')
    temporary = path.with_name(path.name + '.plaza-tmp')
    with temporary.open('xb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    temporary.chmod(mode)
    os.replace(temporary, path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Release:
    def __init__(self, plan):
        self.p = plan
        self.root = Path(plan['root'])
        self.target = self.root / 'releases' / plan['release']
        self.operation = self.root / 'deployments' / plan['release']
        self.gate = self.root / 'config/plaza-entry-state.conf'
        self.overlay = self.root / 'config' / ('identity-' + plan['release'] + '.env')
        self.ca = self.root / 'public-trust' / ('portal-ca-' + plan['release'] + '.pem')
        self.unit = Path('/etc/systemd/system') / (plan['service'] + '.d') / '90-plaza-tiangong.conf'
        self.plan_hash = sha(json.dumps(plan, sort_keys=True).encode())

    def run(self, args, stdin=None, stdout=None, timeout=60, cwd=None):
        result = subprocess.run(args, stdin=stdin, stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, cwd=cwd)
        require(result.returncode == 0, 'EXTERNAL_COMMAND_FAILED')
        return result.stdout

    def prop(self, name):
        return self.run(['systemctl', 'show', self.p['service'], '-p', name, '--value']).decode().strip()

    def env(self):
        pid = int(self.prop('MainPID'))
        require(pid > 1, 'SERVICE_NOT_RUNNING')
        return dict(part.split(b'=', 1) for part in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in part)

    def invariants(self):
        env = self.env()
        require(all(env.get(k.encode()) for k in ('DATABASE_URL', 'PLAZA_SECRET', 'PLAZA_DATA_DIR')), 'PERSISTENT_CONFIG_MISSING')
        require(Path(env[b'PLAZA_DATA_DIR'].decode()).resolve() == Path(self.p['data_dir']).resolve(), 'DATA_DIRECTORY_CHANGED')
        return {key: sha(env[key.encode()]) if key.encode() in env else None for key in INVARIANTS}

    def identity_runtime_matches(self):
        expected = dict(line.split('=', 1) for line in self.overlay.read_text().splitlines() if line and not line.startswith('#'))
        env = self.env()
        require(all(env.get(key.encode()) == value.encode() for key, value in expected.items()), 'IDENTITY_RUNTIME_CONFIG_MISMATCH')

    def sql(self, sql):
        command = 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"'
        output = self.run(['docker', 'exec', self.p['database_container'], 'sh', '-c', command, 'plaza-read-only', 'BEGIN READ ONLY; ' + sql + '; COMMIT;'])
        return next(json.loads(line) for line in output.decode().splitlines() if line.startswith('{'))

    def baseline(self):
        value = self.sql("SELECT json_build_object('apps',(SELECT count(*) FROM catalog_apps WHERE current_snapshot_id IS NOT NULL),'catalog',(SELECT md5(string_agg(id::text||':'||revision::text||':'||current_snapshot_id::text,',' ORDER BY id)) FROM catalog_apps WHERE current_snapshot_id IS NOT NULL),'snapshots',(SELECT count(*) FROM published_snapshots),'publications',(SELECT count(*) FROM publications),'bindings',(SELECT count(*) FROM managed_app_bindings),'access',to_regclass('public.plaza_app_access') IS NOT NULL,'roles',to_regclass('public.plaza_platform_roles') IS NOT NULL)")
        for table, key in [('plaza_app_access', 'access'), ('plaza_platform_roles', 'roles')]:
            value[key] = self.sql("SELECT json_build_object('digest',md5(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text))) FROM " + table + ' t')['digest'] if value[key] else None
        return value

    def master(self):
        pid = int(Path(self.p['gateway_pid_file']).read_text().strip())
        require(pid > 1 and Path(f'/proc/{pid}/exe').resolve() == Path(self.p['nginx']).resolve(), 'NGINX_MASTER_MISMATCH')
        title = Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode().strip()
        require(title.startswith('nginx: master process '), 'NGINX_MASTER_MISMATCH')
        args = shlex.split(title[len('nginx: master process '):])
        require('-c' in args and '-p' in args, 'EXPLICIT_NGINX_CONFIG_REQUIRED')
        config = Path(args[args.index('-c') + 1])
        prefix = Path(args[args.index('-p') + 1])
        require(prefix.resolve() == Path(self.p['gateway_prefix']).resolve() and (prefix / config).resolve() == Path(self.p['gateway_config']).resolve(), 'NGINX_CONFIG_MISMATCH')
        return pid

    def reload(self):
        pid = self.master()
        self.run([self.p['nginx'], '-t', '-p', self.p['gateway_prefix'], '-c', self.p['gateway_config']])
        os.kill(pid, signal.SIGHUP)

    def get(self, url, ca=None, headers=None):
        context = ssl.create_default_context(cafile=ca or str(self.ca))
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))
        try:
            with opener.open(urllib.request.Request(url, headers=headers or {}), timeout=8) as response:
                return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read(32 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read(100000)

    def backend(self):
        url = 'http://127.0.0.1:' + str(self.p['backend_port']) + '/plaza'
        headers = {'Host': urlsplit(self.p['portal_origin']).netloc}
        code, _, body = self.get(url + '/api/health', headers=headers)
        require(code == 200 and json.loads(body).get('managementMode') == 'identity', 'BACKEND_IDENTITY_HEALTH_FAILED')
        code, _, body = self.get(url + '/api/auth/tiangong/status', headers=headers)
        require(code == 200 and json.loads(body).get('enabled') is True, 'IDENTITY_NOT_ENABLED')
        require(self.get(url + '/api/operations/dashboard', headers=headers)[0] == 401, 'ANONYMOUS_ADMIN_NOT_DENIED')

    def inputs(self):
        return {k: file_sha(self.p[k]) for k in ('archive', 'gateway_candidate', 'identity_env', 'portal_ca', 'gateway_ca')}

    def check(self):
        require(self.root.resolve() == self.root and self.root.is_dir(), 'APP_ROOT_MISMATCH')
        require(all(p.resolve() == p for p in [self.target, self.operation, self.overlay, self.ca, self.gate]), 'SYMLINK_DEPLOYMENT_TARGET')
        for key in ('archive', 'gateway_candidate', 'identity_env', 'portal_ca', 'gateway_ca'):
            path = Path(self.p[key])
            require(path.is_file() and not path.is_symlink() and path.stat().st_uid == 0
                    and not path.stat().st_mode & 0o022, 'PROTECTED_INPUT_REQUIRED')
        require(not Path(self.p['identity_env']).stat().st_mode & 0o077, 'PRIVATE_OVERLAY_MODE_REQUIRED')
        require(self.prop('WorkingDirectory') == self.p['previous_release'] and self.prop('ActiveState') == 'active', 'PREVIOUS_SERVICE_MISMATCH')
        require(not self.prop('ExecStartPre') and not self.prop('ExecStartPost'), 'CUSTOM_SERVICE_HOOKS_REQUIRE_REVIEW')
        node_version = self.run([self.p['node'], '--version']).decode().strip()
        require(re.fullmatch(r'v\d+\.\d+\.\d+', node_version) and tuple(map(int, node_version[1:].split('.'))) >= (22, 16, 0), 'NODE_22_16_REQUIRED')
        manifest = validate_archive(Path(self.p['archive']), self.p['archive_sha256'], self.p['source_sha'], self.p['release'])
        require(file_sha(self.p['gateway_config']) == self.p['gateway_before_sha256'] and file_sha(self.p['gateway_candidate']) == self.p['gateway_candidate_sha256'], 'GATEWAY_DIGEST_MISMATCH')
        before = Path(self.p['gateway_config']).read_text()
        after = Path(self.p['gateway_candidate']).read_text()
        require(unrelated_gateway(before, self.p) == unrelated_gateway(after, self.p), 'UNRELATED_GATEWAY_CHANGED')
        fragments = render(self.p)
        require(fragments['gateway-canonical.conf'] in after and fragments['gateway-legacy.conf'] in after
                and fragments['gateway-legacy-server.conf'] in after, 'REVIEWED_GATEWAY_FRAGMENTS_MISSING')
        pem = Path(self.p['portal_ca']).read_bytes()
        require(file_sha(self.p['portal_ca']) == self.p['portal_ca_sha256'] and b'PRIVATE KEY' not in pem, 'PUBLIC_CA_MISMATCH')
        ssl.create_default_context(cafile=self.p['portal_ca'])
        require(b'PRIVATE KEY' not in Path(self.p['gateway_ca']).read_bytes(), 'GATEWAY_CA_MUST_BE_PUBLIC')
        ssl.create_default_context(cafile=self.p['gateway_ca'])
        expected = dict(line.split('=', 1) for line in fragments['identity.env'].splitlines() if line and not line.startswith('#'))
        actual = dict(line.split('=', 1) for line in Path(self.p['identity_env']).read_text().splitlines() if line and not line.startswith('#'))
        require(set(actual) == set(expected) and all(actual[k] == v for k, v in expected.items() if k != 'PLAZA_SUPER_ADMIN_ACCOUNT'), 'IDENTITY_OVERLAY_INVALID')
        require(re.fullmatch(r'[A-Za-z0-9_.@+-]*', actual['PLAZA_SUPER_ADMIN_ACCOUNT']), 'BOOTSTRAP_ACCOUNT_INVALID')
        with tarfile.open(self.p['archive']) as tar:
            target_lock = json.load(tar.extractfile('package-lock.json'))
        require(target_lock == json.loads((Path(self.p['previous_release']) / 'package-lock.json').read_text()), 'DEPENDENCY_CHANGE_REQUIRES_SEPARATE_INSTALL')
        self.master()
        version = subprocess.run([self.p['nginx'], '-V'], capture_output=True, timeout=10)
        require(version.returncode == 0 and all(name in version.stderr for name in (b'--with-http_sub_module', b'--with-http_realip_module')), 'NGINX_MODULES_REQUIRED')
        self.invariants()
        return manifest

    def save(self, value):
        atomic(self.operation / 'state.json', (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())

    def state(self, allowed):
        value = json.loads((self.operation / 'state.json').read_text())
        require(value['planHash'] == self.plan_hash and value['phase'] in allowed, 'STATE_REPLAY_OR_PLAN_MISMATCH')
        require(value['inputs'] == self.inputs(), 'FROZEN_INPUT_CHANGED')
        return value

    @contextmanager
    def locked(self):
        path = self.operation / 'operation.lock'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, str(os.getpid()).encode()); os.close(fd)
            yield
        finally:
            path.unlink()  # Only this invocation's lock; no stale-lock recovery or recursive removal.

    def stage(self):
        manifest = self.check()
        require(not self.target.exists() and not self.overlay.exists() and not self.ca.exists(), 'RELEASE_TARGET_EXISTS')
        self.operation.parent.mkdir(mode=0o700, exist_ok=True)
        self.operation.mkdir(mode=0o700)
        value = {'planHash': self.plan_hash, 'phase': 'STAGING', 'inputs': self.inputs(), 'sourceSha': self.p['source_sha'], 'invariants': self.invariants()}
        self.save(value)
        with self.locked():
            try:
                backup = self.operation / 'backup'; backup.mkdir(mode=0o700)
                shutil.copy2(self.p['gateway_config'], backup / 'nginx.conf')
                unit = Path(self.prop('FragmentPath'))
                shutil.copy2(unit, backup / 'service.unit')
                if self.unit.parent.exists(): shutil.copytree(self.unit.parent, backup / 'service.d', symlinks=True)
                env_files = re.findall(r'(\S+) \(ignore_errors=', self.prop('EnvironmentFiles'))
                require(env_files and all(Path(p).is_relative_to(self.root / 'config') and not Path(p).is_symlink()
                        and Path(p).resolve().is_relative_to(self.root / 'config') for p in env_files), 'INHERITED_ENV_FILE_SCOPE_INVALID')
                for i, path in enumerate(env_files): shutil.copy2(path, backup / ('environment-' + str(i)))
                self.target.mkdir(mode=0o755)
                with tarfile.open(self.p['archive']) as tar:
                    for entry in tar.getmembers():
                        destination = self.target / entry.name
                        if entry.isdir(): destination.mkdir(mode=0o755, parents=True, exist_ok=True); continue
                        destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                        with tar.extractfile(entry) as source, destination.open('xb') as output: shutil.copyfileobj(source, output)
                        destination.chmod(0o644)
                modules = Path(self.p['previous_release']) / 'node_modules'
                require(modules.is_dir() and all(not p.is_symlink() or p.resolve().is_relative_to(modules.resolve()) for p in modules.rglob('*')), 'DEPENDENCY_LINK_OUTSIDE_RELEASE')
                shutil.copytree(modules, self.target / 'node_modules', symlinks=True)
                self.ca.parent.mkdir(mode=0o755, exist_ok=True)
                atomic(self.ca, Path(self.p['portal_ca']).read_bytes(), 0o644)
                atomic(self.overlay, Path(self.p['identity_env']).read_bytes())
                if not self.gate.exists(): atomic(self.gate, b'return 503;\n', 0o644)
                self.run([self.p['nginx'], '-t', '-p', self.p['gateway_prefix'], '-c', self.p['gateway_candidate']])
                self.run([self.p['node'], '--import', 'tsx', '-e', 'import("node:fs")'], timeout=20, cwd=self.target)
                value.update(phase='STAGED', files=manifest['files'], previousPID=self.prop('MainPID'))
                self.save(value)
            except Exception as error:
                value['phase'] = 'UNKNOWN' if isinstance(error, subprocess.TimeoutExpired) else 'FAILED'; self.save(value); raise

    def switch(self):
        with self.locked():
            value = self.state({'STAGED'})
            self.check()
            require(self.prop('MainPID') == value['previousPID'], 'PREVIOUS_PROCESS_CHANGED')
            require(all(file_sha(self.target / k) == v for k, v in value['files'].items()), 'STAGED_SOURCE_CHANGED')
            value['phase'] = 'SWITCHING'; self.save(value)
            try:
                atomic(self.gate, b'return 503;\n', 0o644)
                if str(self.gate) in Path(self.p['gateway_config']).read_text():
                    self.reload()
                    require(self.get(self.p['portal_origin'] + '/plaza/api/health')[0] == 503, 'MAINTENANCE_NOT_APPLIED')
                self.run(['systemctl', 'stop', self.p['service']])
                require(self.prop('MainPID') == '0' and self.prop('ActiveState') == 'inactive', 'OLD_SERVICE_NOT_STOPPED')
                value['baseline'] = self.baseline()
                backup = self.operation / 'backup'
                with (backup / 'database.dump').open('xb') as stream:
                    self.run(['docker', 'exec', self.p['database_container'], 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], stdout=stream, timeout=120)
                with (backup / 'database.dump').open('rb') as stream:
                    listing = self.run(['docker', 'exec', '-i', self.p['database_container'], 'pg_restore', '--list'], stdin=stream)
                require(b'TABLE DATA' in listing, 'BACKUP_INVALID')
                self.run(['tar', '--one-file-system', '-cpf', str(backup / 'persistent-data.tar'), '-C', self.p['data_dir'], '.'], timeout=180)
                self.run(['tar', '-tf', str(backup / 'persistent-data.tar')])
                value['backups'] = {p.name: file_sha(p) for p in [backup / 'database.dump', backup / 'persistent-data.tar']}
                self.save(value)
                atomic(Path(self.p['gateway_config']), Path(self.p['gateway_candidate']).read_bytes(), 0o600)
                self.reload()
                self.unit.parent.mkdir(exist_ok=True)
                text = '[Service]\nWorkingDirectory=' + str(self.target) + '\nEnvironmentFile=' + str(self.overlay) + '\nExecStart=\nExecStart=' + self.p['node'] + ' --import tsx server/index.ts\n'
                atomic(self.unit, text.encode(), 0o644)
                self.run(['systemctl', 'daemon-reload'])
                files = re.findall(r'(\S+) \(ignore_errors=', self.prop('EnvironmentFiles'))
                require(self.prop('WorkingDirectory') == str(self.target) and files and files[-1] == str(self.overlay), 'EFFECTIVE_UNIT_MISMATCH')
                self.run(['systemctl', 'start', self.p['service']])
                self.identity_runtime_matches()
                for attempt in range(40):
                    try: self.backend(); break
                    except (OSError, RuntimeError):
                        if attempt == 39: raise
                        time.sleep(0.25)
                require(self.invariants() == value['invariants'] and self.baseline() == value['baseline'], 'PERSISTENT_DATA_CHANGED')
                value['phase'] = 'SWITCHED'; self.save(value)
            except Exception as error:
                value['phase'] = 'UNKNOWN' if isinstance(error, subprocess.TimeoutExpired) else 'FAILED'; self.save(value); raise

    def verify(self, value, maintenance):
        require(self.prop('ActiveState') == 'active' and self.prop('WorkingDirectory') == str(self.target), 'RELEASE_NOT_ACTIVE')
        require(all(file_sha(self.target / k) == v for k, v in value['files'].items()), 'ACTIVE_SOURCE_CHANGED')
        require(file_sha(self.p['gateway_config']) == self.p['gateway_candidate_sha256'], 'ACTIVE_GATEWAY_CHANGED')
        require(self.invariants() == value['invariants'], 'PERSISTENT_CONFIG_CHANGED')
        self.identity_runtime_matches()
        self.backend()
        portal = self.p['portal_origin'] + '/plaza'
        require(self.get(portal + '/api/health')[0] == (503 if maintenance else 200), 'PORTAL_HEALTH_MISMATCH')
        if maintenance:
            require(self.gate.read_text().strip() == 'return 503;' and self.baseline() == value['baseline'], 'MAINTENANCE_OR_DATA_MISMATCH')
        else:
            require(self.get(portal + '/')[0] == 200 and self.get(portal + '/api/operations/dashboard')[0] == 401, 'PUBLIC_ENTRY_AUTHORIZATION_FAILED')
            for scheme, port in [('http', self.p['legacy_http_port']), ('https', self.p['gateway_tls_port'])]:
                old = scheme + '://' + self.p['gateway_ip'] + ':' + str(port)
                code, headers, _ = self.get(old + '/?entry=compat', self.p['gateway_ca'])
                require(code == 308 and headers.get('location') == portal + '/?entry=compat', 'LEGACY_REDIRECT_FAILED')
                require(self.get(old + '/api/auth/tiangong/status', self.p['gateway_ca'])[0] == 403, 'LEGACY_IDENTITY_NOT_DENIED')
                code, headers, body = self.get(old + '/api/publisher-cli.py', self.p['gateway_ca'])
                require(code == 200 and body == (self.target / 'server/publisher-cli.py').read_bytes() and sha(body) == headers.get('x-content-sha256'), 'LEGACY_CLI_CHANGED')
        return {'status': 'VERIFIED', 'maintenance': maintenance, 'sourceSha': self.p['source_sha'], 'realLogin': 'MANUAL_REQUIRED'}

    def activate(self):
        with self.locked():
            value = self.state({'SWITCHED'})
            self.verify(value, maintenance=True)  # A separate process invocation re-reads physical state.
            value['phase'] = 'ACTIVATING'; self.save(value)
            try:
                atomic(self.gate, b'# Plaza entry enabled\n', 0o644)
                self.reload()
                for attempt in range(20):
                    try:
                        if self.get(self.p['portal_origin'] + '/plaza/api/health')[0] == 200: break
                    except OSError:
                        if attempt == 19: raise
                    time.sleep(0.25)
                self.verify(value, maintenance=False)
                value['phase'] = 'ACTIVE'; self.save(value)
            except Exception as error:
                value['phase'] = 'UNKNOWN' if isinstance(error, subprocess.TimeoutExpired) else 'FAILED'
                self.save(value)  # Preserve the original outcome before the bounded protective action.
                try:
                    atomic(self.gate, b'return 503;\n', 0o644)
                    self.reload()
                    value['maintenanceRestored'] = self.get(self.p['portal_origin'] + '/plaza/api/health')[0] == 503
                except Exception:
                    value['maintenanceRestored'] = False
                if not value['maintenanceRestored']: value['phase'] = 'UNKNOWN'
                self.save(value); raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['render', 'check', 'stage', 'switch', 'activate', 'verify'])
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, help='New private output directory for render only')
    args = parser.parse_args()
    plan = load_plan(args.plan, complete=args.phase != 'render')
    if args.phase == 'render':
        require(args.output is not None, 'RENDER_OUTPUT_REQUIRED')
        args.output.mkdir(mode=0o700, parents=True)
        for name, text in render(plan).items(): atomic(args.output / name, text.encode())
        print(json.dumps({'status': 'RENDERED', 'files': sorted(render(plan))})); return
    require(os.name == 'posix' and os.getuid() == 0, 'RUN_ON_OWNING_LINUX_HOST_AS_ROOT')
    require(not args.plan.is_symlink() and args.plan.stat().st_uid == 0 and not args.plan.stat().st_mode & 0o077
            and args.plan.parent.stat().st_uid == 0 and not args.plan.parent.stat().st_mode & 0o022, 'PRIVATE_PLAN_REQUIRED')
    os.umask(0o077)
    release = Release(plan)
    if args.phase == 'check': release.check(); result = {'status': 'PREFLIGHT_PASSED', 'readOnly': True}
    elif args.phase == 'verify':
        state = release.state({'SWITCHED', 'ACTIVE', 'FAILED', 'UNKNOWN'})
        result = release.verify(state, maintenance=state['phase'] != 'ACTIVE')
    else:
        getattr(release, args.phase)(); result = {'status': args.phase.upper() + '_COMPLETE', 'sourceSha': plan['source_sha']}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'UNKNOWN' if isinstance(error, subprocess.TimeoutExpired) else 'FAILED',
                          'error': str(error) if isinstance(error, RuntimeError) else 'INSPECT_OWNING_HOST', 'nextAction': 'READ_ONLY_INSPECTION_NO_REPLAY'}))
        raise SystemExit(1)
