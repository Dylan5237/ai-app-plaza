import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { DomainError } from './errors.js';
import { validateRepoPath } from './manifest.js';

export const MAX_DISTRIBUTION_FILES = 1000;
export const MAX_DISTRIBUTION_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DISTRIBUTION_BYTES = 20 * 1024 * 1024;

export interface DistributionFile { path: string; size: number; sha256: string; executable: boolean }
export interface DistributionPackage {
  entryId: string;
  files: DistributionFile[];
  sha256: string;
  size: number;
  bytes: Buffer;
}

/** Distribution contains only explicitly declared regular files. */
export function validateDistributionPath(value: string): string {
  const path = validateRepoPath(value, '分发文件路径');
  const parts = path.normalize('NFKC').split('/').map(part => part.toLocaleLowerCase('en-US'));
  const name = parts.at(-1)!;
  if (parts.some(part => Buffer.byteLength(part, 'utf8') > 255 || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new DomainError(400, 'VALIDATION_FAILED', '分发文件路径不兼容目标系统。');
  }
  const forbidden = parts.some(part => ['.git', '.worktrees', 'node_modules', '.ssh', '.aws', '.azure', '.kube',
    'credentials', 'credential', 'secrets', 'secret', '.mcp.json', '.npmrc', '.pypirc', '.envrc', '.env'].includes(part)
    || part.startsWith('.env.')) || /\.(?:pem|p12|pfx|key)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name)
    || /(?:^|[._-])credentials?(?:[._-]|$)/.test(name) || ['secrets.json', 'auth.json'].includes(name);
  if (forbidden) throw new DomainError(400, 'VALIDATION_FAILED', '分发文件包含不允许分享的凭据或本地配置路径。');
  return path;
}

export function validateDistributionBytes(path: string, bytes: Uint8Array, token: string): void {
  if (bytes.byteLength > MAX_DISTRIBUTION_FILE_BYTES) throw new DomainError(400, 'VALIDATION_FAILED', '分发文件超过单文件 5 MiB 限制。');
  const text = Buffer.from(bytes).toString('utf8');
  if (text.startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new DomainError(400, 'VALIDATION_FAILED', '分发文件不能是 Git LFS 指针。');
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i.test(text)
    || /\bgl(?:pat|rt|dt|cbt|soat)-[A-Za-z0-9_-]{12,}\b/i.test(text)
    || /(?:PRIVATE-TOKEN|X-GitLab-Token|GITLAB_(?:ACCESS_)?TOKEN)\s*[:=]\s*[^\s"']{8,}/i.test(text)
    || (token.length >= 8 && text.includes(token))) {
    throw new DomainError(400, 'VALIDATION_FAILED', '分发文件包含疑似凭据，请由作者检查并移除。');
  }
  void path;
}

/** Reject contradictory executable acquisition instructions; repository links may be displayed separately as provenance. */
export function hasConflictingInstallSource(text: string, gitlabUrl: string, dependencyManifest = false): boolean {
  const host = new URL(gitlabUrl).host.toLowerCase();
  return /\bgit\s+(?:clone|checkout|switch|pull|fetch)\b/i.test(text)
    || /\bgit\+(?:ssh|https?):\/\//i.test(text)
    || /\bgit@[^\s:]+:/i.test(text)
    || (!dependencyManifest && /https?:\/\/[^\s"'<>]+\.(?:zip|tgz|tar(?:\.(?:gz|bz2|xz))?|whl|msi|exe|git)(?:[?#][^\s"'<>]*)?(?=[\s"'<>)]|$)/i.test(text))
    || (!dependencyManifest && /https?:\/\/[^\s"'<>]+\/(?:archive|releases\/download)\//i.test(text))
    || text.split(/\r?\n/).some(line => /https?:\/\//i.test(line) && (
      /\bwget\b/i.test(line)
      || (/\b(?:curl|iwr|invoke-webrequest)\b/i.test(line) && /(?:\s-(?:o|outfile|output)\b|--output\b|>|\|\s*(?:sh|bash|powershell)\b)/i.test(line))
      || /\b(?:pip|pip3|npm|npx)\s+(?:install|i)\s+https?:\/\//i.test(line)
    ))
    || text.toLowerCase().includes(host);
}

export function isInstallRelevantPath(path: string): boolean {
  return isDependencyManifestPath(path) || /(?:^|\/)(?:[^/]+\.(?:sh|ps1|bat|cmd)|(?:install|setup|postinstall|preinstall)\.(?:mjs|cjs|js|py)|(?:readme|install|usage|guide|setup)(?:[._-][^/]*)?\.(?:md|markdown|txt))$/i.test(path);
}

/** Dependency registries may be used, but repository clones and the configured GitLab host remain forbidden. */
export function isDependencyManifestPath(path: string): boolean {
  return /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|requirements[^/]*\.txt|[^/]+\.lock|pnpm-lock\.ya?ml|pyproject\.toml|cargo\.toml|pipfile)$/i.test(path);
}

/** A deterministic, uncompressed ZIP: fixed timestamps, ordinary files, UTF-8 names, no ZIP64. */
export function makeDistributionPackage(entryId: string, files: Map<string, Uint8Array>, executableFiles = new Set<string>()): DistributionPackage {
  if (!files.size || files.size > MAX_DISTRIBUTION_FILES) throw new DomainError(400, 'VALIDATION_FAILED', '分发文件数量须在 1 到 1000 个之间。');
  const paths = [...files.keys()].sort();
  const folded = new Set<string>();
  let total = 0;
  let offset = 0;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const manifest: DistributionFile[] = [];
  for (const path of paths) {
    validateDistributionPath(path);
    const key = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (folded.has(key) || [...folded].some(other => other.startsWith(key + '/') || key.startsWith(other + '/'))) {
      throw new DomainError(400, 'VALIDATION_FAILED', '分发文件路径存在重复或文件目录冲突。');
    }
    folded.add(key);
    const data = Buffer.from(files.get(path)!);
    total += data.length;
    if (data.length > MAX_DISTRIBUTION_FILE_BYTES || total > MAX_DISTRIBUTION_BYTES) throw new DomainError(400, 'VALIDATION_FAILED', '分发文件超过大小限制。');
    const name = Buffer.from(path, 'utf8');
    const checksum = crc32(data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0, 10); directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    const executable = executableFiles.has(path);
    directory.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name);
    offset += header.length + name.length + data.length;
    manifest.push({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), executable });
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(paths.length, 8); end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, centralBytes, end]);
  return { entryId, files: manifest, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, bytes };
}

export function distributionPath(directory: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new DomainError(404, 'ASSET_NOT_FOUND', '分发包不存在。');
  return join(directory, `${sha256}.zip`);
}

/** Files are published by hash using a same-directory rename; downloads still require an active DB mapping. */
export async function storeDistribution(directory: string, pack: DistributionPackage, staticDir?: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (staticDir) {
    const storage = await realpath(directory);
    let staticRoot = resolve(staticDir);
    try { staticRoot = await realpath(staticRoot); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    const within = relative(staticRoot, storage);
    if (!within || (!within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within))) {
      throw new DomainError(503, 'ASSET_STORAGE_INVALID', '分发目录不能位于公开静态目录中。');
    }
  }
  const target = distributionPath(directory, pack.sha256);
  try {
    const existing = await readFile(target);
    if (existing.length !== pack.size || createHash('sha256').update(existing).digest('hex') !== pack.sha256) throw new DomainError(503, 'ASSET_CORRUPT', '分发包存储内容不匹配，请联系广场维护者。');
    return;
  } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(pack.bytes); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, target); }
    catch (error: any) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const current = await readFile(target);
      if (current.length !== pack.size || createHash('sha256').update(current).digest('hex') !== pack.sha256) throw error;
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}
