"""Build and package committed runtime sources; never include machine configuration."""
import argparse
import datetime
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root)


def build(root):
    node = Path(shutil.which('node') or '').resolve()
    candidates = [node.parent / 'node_modules/npm/bin/npm-cli.js', node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js']
    npm = next((p for p in candidates if p.is_file()), None)
    if not node.is_file() or npm is None:
        raise RuntimeError('NODE_NPM_NOT_FOUND')
    version = subprocess.check_output([str(node), '--version'], text=True).strip()
    if tuple(map(int, version.lstrip('v').split('.'))) < (22, 16, 0):
        raise RuntimeError('NODE_22_16_REQUIRED')
    process = subprocess.run([str(node), str(npm), 'run', 'build'], cwd=root, capture_output=True)
    if process.returncode:
        raise RuntimeError('BUILD_FAILED')


def package(root, date, output, main_ref=None):
    if not re.fullmatch(r'\d{8}', date):
        raise RuntimeError('INVALID_RELEASE_DATE')
    datetime.datetime.strptime(date, '%Y%m%d')
    if git(root, 'status', '--porcelain'):
        raise RuntimeError('COMMIT_SOURCE_BEFORE_PACKAGING')
    sha = git(root, 'rev-parse', 'HEAD').decode().strip()
    if main_ref and git(root, 'rev-parse', main_ref).decode().strip() != sha:
        raise RuntimeError('HEAD_MUST_EQUAL_VERIFIED_MAIN_REF')
    tree = git(root, 'rev-parse', 'HEAD^{tree}').decode().strip()
    # Build in this invocation, binding generated assets to the selected committed source.
    build(root)
    if git(root, 'status', '--porcelain') or git(root, 'rev-parse', 'HEAD').decode().strip() != sha:
        raise RuntimeError('SOURCE_CHANGED_DURING_BUILD')
    names = git(root, 'ls-files', '-z', '--', 'package.json', 'package-lock.json', 'server', 'scripts/refresh-agent-distributions.ts').decode().split('\0')
    content = {}
    for name in filter(None, names):
        if any(ord(c) < 32 for c in name) or Path(name).suffix.lower() not in {'.json', '.ts', '.js', '.py', '.sql'} or any(part.lower().startswith('.env') for part in Path(name).parts):
            raise RuntimeError('UNEXPECTED_RUNTIME_SOURCE')
        # Read Git blobs, not CRLF-converted Windows checkout bytes.
        content[name] = git(root, 'cat-file', 'blob', f'{sha}:{name}')
    for path in (root / 'dist').rglob('*'):
        if path.is_symlink():
            raise RuntimeError('BUILD_SYMLINK_NOT_ALLOWED')
        if path.is_file():
            content[path.relative_to(root).as_posix()] = path.read_bytes()
    required = {'package.json', 'package-lock.json', 'server/index.ts', 'dist/index.html', 'scripts/refresh-agent-distributions.ts'}
    if not required <= content.keys():
        raise RuntimeError('RELEASE_FILE_MISSING')
    release = f'{date}-{sha[:8]}'
    manifest = {'release': release, 'sourceSha': sha, 'sourceTree': tree,
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(content.items())}}
    content['release.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'ai-app-plaza-{release}.tar.gz'
    with archive.open('xb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w') as tar:
        for name, data in sorted(content.items()):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
            tar.addfile(entry, io.BytesIO(data))
    (output / 'release.json').write_bytes(content['release.json'])
    return {'archive': str(archive), 'release': release, 'sourceSha': sha, 'sourceTree': tree,
            'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'bytes': archive.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--main-ref', help='Require HEAD to equal this freshly fetched main ref')
    args = parser.parse_args()
    print(json.dumps(package(Path(__file__).resolve().parents[2], args.date, args.output, args.main_ref)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'error': str(error) if isinstance(error, RuntimeError) else 'PACKAGING_FAILED'}))
        raise SystemExit(1)
