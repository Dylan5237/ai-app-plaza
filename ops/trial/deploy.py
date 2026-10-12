#!/usr/bin/env python3
"""First installation only. Creates one isolated service and PostgreSQL container."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import secrets
import socket
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path('/opt/ai-app-plaza-trial')
UNIT = 'ai-app-plaza-trial.service'
CONTAINER = 'ai-app-plaza-trial-db'
NODE_VERSION = '22.22.1'

def command(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=kwargs.pop('timeout', 60), **kwargs)
    if result.returncode:
        # Do not echo process output: child programs may include environment credentials.
        raise RuntimeError(f'command failed: {args[0]} ({result.returncode})')
    return result.stdout.strip()

def free_port(host, port):
    with socket.socket() as sock:
        sock.bind((host, port))

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()

def extract(archive, destination):
    with tarfile.open(archive) as package:
        if any(m.issym() or m.islnk() or m.isdev() for m in package.getmembers()):
            raise RuntimeError('release must contain only regular files/directories')
        package.extractall(destination, filter='data')

def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as file: file.write(text)

def download(url, destination):
    with urllib.request.urlopen(url, timeout=60) as response, destination.open('wb') as output:
        while block := response.read(1024 * 1024): output.write(block)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--release', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=16090)
    parser.add_argument('--db-port', type=int, default=16432)
    parser.add_argument('--gitlab', required=True)
    parser.add_argument('--postgres-image', required=True, help='Locally verified immutable image ID')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    gitlab = urlsplit(args.gitlab)
    if gitlab.scheme not in ('http', 'https') or not gitlab.hostname or gitlab.username or gitlab.password or gitlab.query or gitlab.fragment or gitlab.path not in ('', '/') or any(ord(c) < 33 for c in args.gitlab):
        raise RuntimeError('GitLab must be an HTTP(S) root URL without credentials')
    ip = ipaddress.IPv4Address(args.host)
    if not any(ip in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise RuntimeError('trial host must be an RFC1918 IPv4 address')
    if not re.fullmatch(r'[0-9]{8}-[a-f0-9]{7,40}', args.release): raise RuntimeError('invalid release identifier')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.postgres_image): raise RuntimeError('immutable PostgreSQL image ID required')
    for port in (args.port, args.db_port):
        if not 1024 <= port <= 65535: raise RuntimeError('invalid port')
    if args.port == args.db_port: raise RuntimeError('ports must differ')
    if os.getuid() != 0: raise RuntimeError('root is needed for the new isolated systemd unit')
    if not hasattr(tarfile, 'data_filter'): raise RuntimeError('Python tarfile data filter support is required')
    runuser = shutil.which('runuser')
    if not runuser: raise RuntimeError('runuser is required for unprivileged dependency installation')
    installer = pwd.getpwnam('nobody')
    if installer.pw_uid == 0: raise RuntimeError('dependency installer must be unprivileged')
    if ROOT.exists() or ROOT.is_symlink(): raise RuntimeError('target already exists; inspect before any recovery, no overwrite')
    if Path('/etc/systemd/system', UNIT).exists(): raise RuntimeError('unit already exists')
    if command(['systemctl', 'show', UNIT, '--property=LoadState', '--value']) != 'not-found': raise RuntimeError('unit name is already registered')
    if command(['docker', 'ps', '-a', '--filter', f'name=^{CONTAINER}$', '--format', '{{.Names}}']):
        raise RuntimeError('container already exists')
    command(['docker', 'image', 'inspect', args.postgres_image, '--format', '{{.Id}}'])
    free_port('0.0.0.0', args.port)
    free_port('127.0.0.1', args.db_port)
    if digest(args.archive) != args.sha256: raise RuntimeError('release archive SHA-256 mismatch')
    with tarfile.open(args.archive) as package:
        manifest = json.load(package.extractfile('release.json'))
    if manifest['release'] != args.release or not re.fullmatch(r'[a-f0-9]{40}', manifest['sourceSha']):
        raise RuntimeError('release manifest mismatch')
    if args.check:
        print(json.dumps({'status': 'READY', 'root': str(ROOT), 'release': args.release, 'port': args.port, 'dbPort': args.db_port}))
        return

    ROOT.mkdir(mode=0o755)
    state = {'status': 'INSTALLING', 'release': args.release, 'sourceSha': manifest['sourceSha'], 'archiveSha256': args.sha256}
    (ROOT / 'deployment.json').write_text(json.dumps(state), encoding='utf-8')
    release = ROOT / 'releases' / args.release
    release.mkdir(parents=True)
    extract(args.archive, release)
    for relative, expected in manifest['files'].items():
        path = (release / relative).resolve()
        if not path.is_relative_to(release) or digest(path) != expected: raise RuntimeError('release file hash mismatch')
    print(json.dumps({'stage': 'release_verified'}), flush=True)

    # Runtime is private to this application; never replace system Node/npm.
    runtime = ROOT / 'runtime'
    runtime.mkdir()
    node_name = f'node-v{NODE_VERSION}-linux-x64'
    node_archive = runtime / f'{node_name}.tar.xz'
    base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as response:
        checksums = response.read().decode('utf-8')
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == node_archive.name)
    download(base + node_archive.name, node_archive)
    if digest(node_archive) != expected: raise RuntimeError('Node download SHA-256 mismatch')
    with tarfile.open(node_archive) as package: package.extractall(runtime, filter='data')
    node = runtime / node_name / 'bin' / 'node'
    npm = runtime / node_name / 'lib/node_modules/npm/bin/npm-cli.js'
    cache, home = ROOT / 'npm-cache', ROOT / 'npm-home'
    cache.mkdir(mode=0o700)
    home.mkdir(mode=0o700)
    install_paths = [release, *release.rglob('*'), cache, home]
    for path in install_paths: os.chown(path, installer.pw_uid, installer.pw_gid, follow_symlinks=False)
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8',
        'USER': 'nobody', 'LOGNAME': 'nobody', 'NODE_ENV': 'development',
        'npm_config_cache': str(cache), 'npm_config_userconfig': '/dev/null', 'npm_config_globalconfig': '/dev/null'}
    try:
        command([runuser, '--preserve-environment', '-u', 'nobody', '--', 'nice', '-n', '10', str(node), str(npm), 'ci', '--include=dev', '--no-audit', '--no-fund'], cwd=release, env=env, timeout=300)
    finally:
        # Restore root ownership even after an install failure; never traverse external symlinks.
        for path in [release, *release.rglob('*'), cache, *cache.rglob('*'), home, *home.rglob('*')]:
            os.chown(path, 0, 0, follow_symlinks=False)
    print(json.dumps({'stage': 'runtime_ready', 'node': command([str(node), '--version'])}), flush=True)

    config = ROOT / 'config'
    config.mkdir(mode=0o700)
    data = ROOT / 'data/postgres'
    data.mkdir(parents=True, mode=0o700)
    database_password = secrets.token_hex(32)
    origin = f'http://{args.host}:{args.port}'
    write_private(config / 'postgres.env', f'POSTGRES_DB=plaza\nPOSTGRES_USER=plaza\nPOSTGRES_PASSWORD={database_password}\n')
    write_private(config / 'app.env', '\n'.join([
        'NODE_ENV=production', f'HOST={args.host}', f'PORT={args.port}', f'PUBLIC_ORIGIN={origin}',
        'ALLOW_INSECURE_PORTAL=1', 'ALLOW_INSECURE_GITLAB=1', f'GITLAB_URL={args.gitlab}',
        f'DATABASE_URL=postgresql://plaza:{database_password}@127.0.0.1:{args.db_port}/plaza',
        f'PLAZA_SECRET={secrets.token_hex(32)}', '',
    ]))
    free_port('0.0.0.0', args.port)
    free_port('127.0.0.1', args.db_port)
    command(['docker', 'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
        '--label', 'com.ai-app-plaza.role=trial-database', '--env-file', str(config / 'postgres.env'),
        '--publish', f'127.0.0.1:{args.db_port}:5432', '--volume', f'{data}:/var/lib/postgresql/data',
        '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', args.postgres_image])
    for _ in range(30):
        ready = subprocess.run(['docker', 'exec', CONTAINER, 'pg_isready', '-U', 'plaza', '-d', 'plaza'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0: break
        time.sleep(1)
    else: raise RuntimeError('new PostgreSQL instance did not become ready')

    unit = f'''[Unit]
Description=AI App Plaza intranet trial
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory={release}
EnvironmentFile={config}/app.env
ExecStart={node} --import tsx server/index.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
MemoryMax=512M
CPUQuota=100%
TasksMax=128
UMask=0077

[Install]
WantedBy=multi-user.target
'''
    with Path('/etc/systemd/system', UNIT).open('x', encoding='utf-8') as output: output.write(unit)
    command(['systemctl', 'daemon-reload'])
    command(['systemctl', 'enable', '--now', UNIT])
    for _ in range(40):
        try:
            with urllib.request.urlopen(origin + '/api/health', timeout=2) as response:
                health = json.load(response)
            if health.get('loginRequired') is False: break
        except (OSError, ValueError): time.sleep(1)
    else: raise RuntimeError('new portal did not become healthy')
    with urllib.request.urlopen(origin + '/api/apps', timeout=5) as response: catalog = json.load(response)
    if catalog['total'] != 0: raise RuntimeError('first installation must start with an empty catalog')
    state.update(status='RUNNING', url=origin, databasePort=args.db_port, postgresImage=args.postgres_image, nodeSha256=expected)
    (ROOT / 'deployment.json').write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(json.dumps(state), flush=True)

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'errorType': type(error).__name__, 'message': str(error) if isinstance(error, RuntimeError) else 'deployment step failed; inspect isolated service state before recovery'}), flush=True)
        raise SystemExit(1)
