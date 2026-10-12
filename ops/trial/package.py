"""Package a clean, committed checkout after npm run build; excludes machine state."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--date', required=True, help='Release date YYYYMMDD')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root): raise SystemExit('commit all release source changes before packaging')
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
release = f'{args.date}-{sha[:8]}'
files = [root / name for name in ('package.json', 'package-lock.json')]
for folder in ('dist', 'server'):
    files.extend(path for path in (root / folder).rglob('*') if path.is_file())
if not (root / 'dist/index.html').is_file(): raise SystemExit('run npm run build first')
manifest = {'release': release, 'sourceSha': sha, 'files': {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(files)}}
args.output.mkdir(parents=True, exist_ok=True)
manifest_path = args.output / 'release.json'
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8', newline='\n')
archive_path = args.output / f'ai-app-plaza-{release}.tar.gz'
with tarfile.open(archive_path, 'w:gz') as archive:
    for path in files: archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
    archive.add(manifest_path, arcname='release.json', recursive=False)
print(json.dumps({'archive': str(archive_path), 'release': release, 'sourceSha': sha, 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(), 'bytes': archive_path.stat().st_size}))
