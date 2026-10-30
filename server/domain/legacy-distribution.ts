import { basename, dirname } from 'node:path/posix';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DomainError } from './errors.js';
import { hasConflictingInstallSource, isDependencyManifestPath, makeDistributionPackage, validateDistributionBytes, validateDistributionPath,
  type DistributionPackage } from './distribution.js';
import { validateRepoPath, type AgentEntry, type StoredAppManifest } from './manifest.js';

export type LegacyDelivery = 'package' | 'remote';
export interface DisabledLegacyEntry { status: 'disabled'; reason: string }
interface DisabledLegacyProfile { instanceId: string; projectId: string; appKey: string; entryId: string; reason: string }
const profileDocument: unknown = JSON.parse(readFileSync(new URL('../contracts/legacy-distribution-profiles.json', import.meta.url), 'utf8'));
if (!profileDocument || typeof profileDocument !== 'object' || (profileDocument as any).schemaVersion !== 1
    || !Array.isArray((profileDocument as any).disabledEntries)) throw new Error('Invalid legacy distribution profile.');
const disabledProfiles: DisabledLegacyProfile[] = (profileDocument as any).disabledEntries.map((profile: any) => {
  if (!profile || typeof profile !== 'object' || !/^https?:\/\/[^/]+$/.test(profile.instanceId)
      || !/^[1-9]\d*$/.test(profile.projectId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.appKey)
      || typeof profile.entryId !== 'string' || !profile.entryId.trim() || profile.entryId.length > 64
      || typeof profile.reason !== 'string' || !profile.reason.trim() || profile.reason.length > 500) {
    throw new Error('Invalid legacy distribution profile.');
  }
  return { instanceId: profile.instanceId, projectId: profile.projectId, appKey: profile.appKey,
    entryId: profile.entryId, reason: profile.reason };
});

/** Disable a specific application's entry for every version until the profile is explicitly reviewed. */
export function disabledLegacyEntry(input: { instanceId: string; projectId: string; appKey: string; entryId: string }): DisabledLegacyEntry | undefined {
  const profile = disabledProfiles.find(item => item.instanceId === input.instanceId.replace(/\/$/, '')
    && item.projectId === input.projectId && item.appKey === input.appKey && item.entryId === input.entryId);
  return profile ? { status: 'disabled', reason: profile.reason } : undefined;
}
export interface LegacySourceFiles {
  files: Map<string, Uint8Array>;
  executable: Set<string>;
}
export interface LegacyPreparedEntry {
  entryId: string;
  delivery: LegacyDelivery;
  guide: string;
  pack: DistributionPackage;
  transformedPaths: string[];
  excludedPaths: string[];
}

export function legacySourceRoot(manifestPath: string, manifest: StoredAppManifest): string {
  const parent = dirname(validateRepoPath(manifestPath, 'Manifest 路径'));
  if (parent === '.') return '';
  const paths = [manifest.docs.readme, manifest.docs.usage,
    ...manifest.entries.filter((entry): entry is AgentEntry => entry.kind === 'agent').map(entry => entry.instructionsPath)];
  if (!paths.every(path => path.startsWith(`${parent}/`))) {
    throw new DomainError(400, 'LEGACY_SCOPE_AMBIGUOUS', '应用清单位于子目录但共享资料跨目录，不能自动分享整个仓库。');
  }
  return `${parent}/`;
}

const ACQUISITION_HEADING = /^(?:\d+[.、]\s*)?(?:取得|获取|源码取得|源码从|来源与固定版本|版本与来源|固定版本取得|固定版本与材料)/i;
const GIT_ACQUISITION = /\bgit\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?(?:clone|fetch|checkout|switch|pull|archive|rev-parse)\b/i;

/** Rewrite the author's installation document, never executable Skill instructions. */
export function normalizeLegacyGuide(text: string, gitlabUrl: string): string {
  const releaseMarkers = [...new Set(text.match(/\*\*v[\w.-]+ 正式 GitLab Release\*\*/g) ?? [])];
  const output: string[] = [];
  let skipSection = false;
  let skipContinuation = false;
  let skipCheckoutDirectory = false;
  let skipAddressContinuation = false;
  for (let line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (skipAddressContinuation && /^\s{2,}\S/.test(line)) continue;
    skipAddressContinuation = false;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      skipSection = ACQUISITION_HEADING.test(heading[1]!.trim());
      if (skipSection) {
        output.push('## 获取已确认版本', '', '从广场下载当前入口的固定分发包，核验 SHA-256 后解压到新目录；不要从其他仓库取得应用源码。', '');
        continue;
      }
    }
    if (skipSection) continue;
    // Old catalog documents sometimes contain a stale, multiline repository
    // address notice outside the acquisition section. The catalog provides
    // current provenance separately; do not leave an obsolete second source.
    if (/^\s*[-*]\s*(?:仓库|项目)地址\s*[：:]/.test(line)) {
      skipAddressContinuation = true;
      continue;
    }
    // Removing only the git command would leave an orphaned instruction that
    // still offers Git as an alternative installation source.
    if (/(?:源码|commit|安装).*(?:Git\s*方式|Git\s*命令|Git\s*克隆)/i.test(line)) {
      output.push('请按上方说明使用广场固定分发包。');
      continue;
    }
    if (skipContinuation) {
      skipContinuation = /\\\s*$/.test(line);
      continue;
    }
    const acquisition = GIT_ACQUISITION.test(line) || /\bGitLab\b/i.test(line)
      || hasConflictingInstallSource(line, gitlabUrl);
    if (acquisition) {
      skipContinuation = /\\\s*$/.test(line);
      if (GIT_ACQUISITION.test(line)) skipCheckoutDirectory = true;
      continue;
    }
    if (skipCheckoutDirectory && /^\s*(?:cd|Set-Location)\s+/i.test(line)) {
      skipCheckoutDirectory = false;
      continue;
    }
    if (line.trim() && !/^\s*```/.test(line)) skipCheckoutDirectory = false;
    if (/^\s*[-*]\s*(?:appKey|固定来源)\s*[：:]/i.test(line)) continue;
    line = line.replace(/源码权限不足、固定来源不可达/g, '广场分发包不可用');
    output.push(line);
  }
  let result = output.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  const removedMarkers = releaseMarkers.filter(marker => !result.includes(marker));
  if (removedMarkers.length) result += `\n\n版本来源记录：${removedMarkers.join('、')}。这些记录仅供溯源，安装仍使用广场固定分发包。`;
  if (!result || hasConflictingInstallSource(result, gitlabUrl) || GIT_ACQUISITION.test(result)) {
    throw new DomainError(400, 'LEGACY_GUIDE_CONFLICT', '历史安装说明无法自动整理为统一来源，请检查具体入口。');
  }
  return result;
}

/** Preserve the original manifest; only derive public-facing legacy requirements. */
export function normalizeLegacyRequirements(requirements: string[]): string[] {
  return requirements.map(value => {
    const updated = value
      .replace(/以及固定来源的仓库读取权限和/g, '以及')
      .replace(/[；;]\s*通过\s*Git\s*取得源码时还需要\s*Git[。.]?/gi, '。')
      .replace(/固定版本源码需从接入提示词指定的来源项目和完整\s*commit\s*取得/gi, '固定版本源码从广场分发包取得并核验 SHA-256')
      .replace(/从接入提示词给出的统一托管来源项目和固定\s*commit\s*取得\s*([^\s，；。]+)\s*源码，不使用浮动\s*main/gi,
        '从广场分发包取得 $1 固定源码并核验 SHA-256');
    if (/(?:安装|取得|获取|下载|源码).{0,40}(?:仓库|GitLab).{0,40}(?:权限|凭证|账号|读取)|(?:源码|commit).{0,30}(?:来源项目|仓库).{0,25}(?:取得|获取|下载)|通过\s*Git\s*(?:取得|获取|克隆)源码/i.test(updated)) {
      return '应用源码获取请按广场接入说明操作；其他环境条件请查看完整使用说明。';
    }
    return updated;
  });
}

function remoteGuide(text: string, gitlabUrl: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => /^##\s+.*(?:远程|remote).*mcp/i.test(line));
  if (start < 0) throw new DomainError(400, 'REMOTE_GUIDE_MISSING', '远程入口缺少可核验的专用连接说明。');
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end]!)) end++;
  const guide = normalizeLegacyGuide(lines.slice(start, end).join('\n'), gitlabUrl);
  if (!/https?:\/\//i.test(guide) || !/(?:streamable\s*http|MCP)/i.test(guide)) {
    throw new DomainError(400, 'REMOTE_GUIDE_MISSING', '远程入口未提供可核验的连接地址或协议。');
  }
  return `${guide}\n\n连接成功后进行 MCP 初始化并读取工具清单；远程服务实际运行版本需要单独核对。`;
}

function confidentialPath(path: string): boolean {
  const parts = path.normalize('NFKC').toLowerCase().split('/');
  const name = parts.at(-1)!;
  return parts.some(part => ['.git', '.worktrees', 'node_modules', '.ssh', '.aws', '.azure', '.kube',
    'credentials', 'credential', 'secrets', 'secret', '.mcp.json', '.npmrc', '.pypirc', '.envrc', '.env'].includes(part)
    || part.startsWith('.env.')) || /\.(?:pem|p12|pfx|key)$/.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name)
    || /(?:^|[._-])credentials?(?:[._-]|$)/.test(name) || ['secrets.json', 'auth.json'].includes(name);
}

function checkDependencySources(path: string, bytes: Uint8Array, gitlabUrl: string): void {
  const name = basename(path).toLowerCase();
  if (name !== 'package.json') {
    const installScript = /^(?:install|setup|postinstall|preinstall)(?:[._-][^/]*)?\.(?:js|mjs|cjs|py|sh|ps1|bat|cmd)$/.test(name);
    if (isDependencyManifestPath(path) || installScript) {
      const content = Buffer.from(bytes).toString('utf8');
      if (GIT_ACQUISITION.test(content) || hasConflictingInstallSource(content, gitlabUrl, true)) {
        throw new DomainError(400, 'LEGACY_DEPENDENCY_CONFLICT', '安装依赖仍引用仓库来源，请补齐可分发依赖。');
      }
    }
    return;
  }
  let value: any;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new DomainError(400, 'LEGACY_DEPENDENCY_INVALID', '包内 package.json 无法解析，请核对依赖。'); }
  const relevant = JSON.stringify({ dependencies: value.dependencies, devDependencies: value.devDependencies,
    optionalDependencies: value.optionalDependencies, peerDependencies: value.peerDependencies,
    scripts: value.scripts, overrides: value.overrides, pnpm: value.pnpm });
  if (GIT_ACQUISITION.test(relevant) || hasConflictingInstallSource(relevant, gitlabUrl, true)) {
    throw new DomainError(400, 'LEGACY_DEPENDENCY_CONFLICT', '安装依赖仍引用私有 GitLab，请补齐可分发依赖。');
  }
}

export function prepareLegacyDistribution(input: {
  manifest: StoredAppManifest;
  manifestPath: string;
  documents: Record<string, string>;
  source: LegacySourceFiles;
  gitlabUrl: string;
  token: string;
}): LegacyPreparedEntry[] {
  const entries = input.manifest.entries.filter((entry): entry is AgentEntry => entry.kind === 'agent');
  if (!entries.length) return [];
  const guidePath = validateRepoPath(input.manifest.docs.usage, '使用说明路径');
  const rawGuide = input.documents[guidePath];
  if (typeof rawGuide !== 'string' || !rawGuide.trim()) throw new DomainError(400, 'LEGACY_GUIDE_MISSING', '缺少已收录的使用说明。');
  const guide = normalizeLegacyGuide(rawGuide, input.gitlabUrl);
  const root = legacySourceRoot(input.manifestPath, input.manifest);
  const files = new Map<string, Uint8Array>();
  const excludedPaths: string[] = [];
  for (const [path, raw] of [...input.source.files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith(root)) continue;
    if (confidentialPath(path)) { excludedPaths.push(path); continue; }
    validateDistributionPath(path);
    validateDistributionBytes(path, raw, input.token);
    checkDependencySources(path, raw, input.gitlabUrl);
    files.set(path, path === guidePath ? Buffer.from(guide, 'utf8') : raw);
  }
  if (!files.has(guidePath)) throw new DomainError(400, 'LEGACY_GUIDE_MISSING', '分发范围缺少使用说明。');
  const transformedPaths = [guidePath];
  const inventoryPath = `${root}distribution-files.json`;
  const inventoryBytes = files.get(inventoryPath);
  if (inventoryBytes) {
    let inventory: any;
    try { inventory = JSON.parse(Buffer.from(inventoryBytes).toString('utf8')); }
    catch { throw new DomainError(400, 'LEGACY_INTEGRITY_INVALID', '原分发文件清单无法解析。'); }
    if (inventory?.schemaVersion !== 1 || inventory?.algorithm !== 'sha256' || !inventory.files
        || typeof inventory.files !== 'object' || Array.isArray(inventory.files)) {
      throw new DomainError(400, 'LEGACY_INTEGRITY_INVALID', '原分发文件清单格式不受支持。');
    }
    for (const [relativePath, expected] of Object.entries(inventory.files)) {
      validateRepoPath(relativePath, '分发清单路径');
      const original = input.source.files.get(`${root}${relativePath}`);
      if (!original || typeof expected !== 'string' || createHash('sha256').update(original).digest('hex') !== expected) {
        throw new DomainError(400, 'LEGACY_INTEGRITY_MISMATCH', '原分发文件清单与固定源码不一致。');
      }
      if (!files.has(`${root}${relativePath}`)) {
        throw new DomainError(400, 'LEGACY_INTEGRITY_MISMATCH', '原分发清单包含不能共享的文件，需先解决分享范围。');
      }
    }
    const guideRelative = guidePath.slice(root.length);
    if (Object.hasOwn(inventory.files, guideRelative)) {
      inventory.files[guideRelative] = createHash('sha256').update(files.get(guidePath)!).digest('hex');
      files.set(inventoryPath, Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8'));
      transformedPaths.push(inventoryPath);
    }
  }
  return entries.map(entry => {
    const remote = /(?:^|[-_])remote(?:$|[-_])/i.test(entry.id) && /远程|remote/i.test(entry.label);
    const entryGuide = remote ? remoteGuide(rawGuide, input.gitlabUrl) : guide;
    const pack = makeDistributionPackage(entry.id, files, input.source.executable);
    return { entryId: entry.id, delivery: remote ? 'remote' : 'package', guide: entryGuide, pack, transformedPaths, excludedPaths };
  });
}
