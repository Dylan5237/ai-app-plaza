import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { GitLabSourceReader } from './gitlab-source.js';
import { normalizeLegacyRequirements, prepareLegacyDistribution, type LegacyPreparedEntry } from './legacy-distribution.js';
import { distributionPath, hasConflictingInstallSource, MAX_DISTRIBUTION_BYTES, storeDistribution, type DistributionFile } from './distribution.js';
import type { AgentEntry, StoredAppManifest } from './manifest.js';

interface SnapshotRow {
  app_id: string; snapshot_id: string; revision: number; instance_id: string; project_id: string; app_key: string;
  commit_sha: string; manifest_path: string; project_url: string; version: string; digest: string;
  manifest: StoredAppManifest | string; documents: Record<string, string> | string;
}
interface AssetRow {
  id: string; snapshot_id: string; entry_id: string; package_type: string; sha256: string; byte_size: number;
  files: DistributionFile[] | string; delivery_mode: 'package' | 'remote'; guide_text: string | null;
  transformed_paths: string[] | string; excluded_paths: string[] | string;
}
export interface RefreshItem {
  appId: string; appKey: string; snapshotId: string; revision: number; projectId: string; commitSha: string;
  snapshotDigest: string; entryId: string; delivery: 'package' | 'remote'; packageType: 'source' | 'artifact';
  sha256: string; size: number; guideSha256: string; files: DistributionFile[]; transformedPaths: string[]; excludedPaths: string[]; displayRequirements?: string[];
}
interface Candidate { row: SnapshotRow; item: RefreshItem; guide: string; prepared?: LegacyPreparedEntry }
export interface RefreshResult {
  status: 'ready' | 'blocked' | 'applied'; planId?: string; items: RefreshItem[];
  problems: Array<{ appKey: string; code: string; message: string }>;
  guides?: Array<{ appKey: string; entryId: string; text: string }>;
  applied?: number; unchanged?: number;
}
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function verifyStoredAsset(directory: string, asset: AssetRow): Promise<void> {
  const maxBytes = MAX_DISTRIBUTION_BYTES + 1_200_022;
  if (!Number.isSafeInteger(asset.byte_size) || asset.byte_size < 1 || asset.byte_size > maxBytes) throw new DomainError(503, 'ASSET_UNAVAILABLE', '已有分发包大小无效。');
  let file;
  try {
    file = await open(distributionPath(directory, asset.sha256), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== asset.byte_size) throw new Error('size mismatch');
    const bytes = await file.readFile();
    if (bytes.length !== asset.byte_size || digest(bytes) !== asset.sha256) throw new Error('digest mismatch');
  } catch {
    throw new DomainError(503, 'ASSET_UNAVAILABLE', '已有分发包缺失或校验失败。');
  } finally { await file?.close(); }
}

async function currentRows(db: Queryable): Promise<SnapshotRow[]> {
  return (await db.query<SnapshotRow>(`SELECT a.id AS app_id, a.current_snapshot_id AS snapshot_id, a.revision,
    a.instance_id, a.project_id, a.app_key, s.commit_sha, s.manifest_path, s.project_url, s.version, s.digest,
    s.manifest, s.documents FROM catalog_apps a JOIN published_snapshots s ON s.id = a.current_snapshot_id
    LEFT JOIN catalog_app_lifecycle l ON l.app_id = a.id
    WHERE COALESCE(l.status, 'published') = 'published'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.manifest->'entries') AS e(value) WHERE e.value->>'kind' = 'agent')
    ORDER BY a.id`)).rows;
}

function candidateItem(row: SnapshotRow, entry: AgentEntry, value: {
  sha256: string; size: number; files: DistributionFile[]; delivery: 'package' | 'remote'; packageType: 'source' | 'artifact';
  guide: string; transformedPaths: string[]; excludedPaths: string[]; displayRequirements?: string[];
}): RefreshItem {
  return { appId: row.app_id, appKey: row.app_key, snapshotId: row.snapshot_id, revision: row.revision,
    projectId: row.project_id, commitSha: row.commit_sha, snapshotDigest: row.digest, entryId: entry.id,
    delivery: value.delivery, packageType: value.packageType, sha256: value.sha256, size: value.size,
    guideSha256: digest(value.guide), files: value.files, transformedPaths: value.transformedPaths, excludedPaths: value.excludedPaths,
    ...(value.displayRequirements ? { displayRequirements: value.displayRequirements } : {}) };
}

async function buildCandidates(options: { db: Database; gitlabUrl: string; token: string; directory: string }): Promise<{ candidates: Candidate[]; problems: RefreshResult['problems'] }> {
  const reader = new GitLabSourceReader(options.gitlabUrl);
  const instance = reader.baseUrl.toString().replace(/\/$/, '');
  const candidates: Candidate[] = [];
  const problems: RefreshResult['problems'] = [];
  for (const row of await currentRows(options.db)) {
    try {
      if (row.instance_id.replace(/\/$/, '') !== instance) throw new DomainError(409, 'SOURCE_MISMATCH', '目录来源实例与广场配置不一致。');
      const manifest = parse<StoredAppManifest>(row.manifest);
      const documents = parse<Record<string, string>>(row.documents);
      const entries = manifest.entries.filter((entry): entry is AgentEntry => entry.kind === 'agent');
      const existing = (await options.db.query<AssetRow>('SELECT * FROM distribution_assets WHERE snapshot_id = $1 ORDER BY entry_id', [row.snapshot_id])).rows;
      const assets = new Map(existing.map(asset => [asset.entry_id, asset]));
      const missing = entries.filter(entry => !assets.has(entry.id));
      let prepared = new Map<string, LegacyPreparedEntry>();
      if (missing.length) {
        const source = await reader.loadLegacySnapshot({ projectId: row.project_id, appKey: row.app_key, manifestPath: row.manifest_path,
          commitSha: row.commit_sha, projectUrl: row.project_url, digest: row.digest, manifest, documents }, options.token);
        prepared = new Map(prepareLegacyDistribution({ manifest, manifestPath: row.manifest_path, documents, source,
          gitlabUrl: options.gitlabUrl, token: options.token }).map(entry => [entry.entryId, entry]));
      }
      for (const entry of entries) {
        const asset = assets.get(entry.id);
        if (asset) {
          await verifyStoredAsset(options.directory, asset);
          const guide = asset.guide_text ?? documents[entry.instructionsPath];
          if (typeof guide !== 'string') throw new DomainError(409, 'LEGACY_GUIDE_MISSING', '已有入口说明不可用。');
          if (hasConflictingInstallSource(guide, options.gitlabUrl)) throw new DomainError(409, 'LEGACY_GUIDE_CONFLICT', '已有入口说明仍引用其他安装来源。');
          const item = candidateItem(row, entry, { sha256: asset.sha256, size: asset.byte_size,
            files: parse<DistributionFile[]>(asset.files), delivery: asset.delivery_mode,
            packageType: asset.package_type as 'source' | 'artifact', guide,
            transformedPaths: parse<string[]>(asset.transformed_paths), excludedPaths: parse<string[]>(asset.excluded_paths),
            ...(asset.guide_text ? { displayRequirements: normalizeLegacyRequirements(manifest.requirements) } : {}) });
          candidates.push({ row, item, guide });
        } else {
          const created = prepared.get(entry.id);
          if (!created) throw new DomainError(400, 'LEGACY_ENTRY_MISSING', '未能准备该 Agent 入口。');
          const item = candidateItem(row, entry, { sha256: created.pack.sha256, size: created.pack.size,
            files: created.pack.files, delivery: created.delivery, packageType: 'source', guide: created.guide,
            transformedPaths: created.transformedPaths, excludedPaths: created.excludedPaths,
            displayRequirements: normalizeLegacyRequirements(manifest.requirements) });
          candidates.push({ row, item, guide: created.guide, prepared: created });
        }
      }
    } catch (error) {
      // Per-app diagnostics contain no source content, credentials or remote response body.
      problems.push({ appKey: row.app_key, code: error instanceof DomainError ? error.code : 'SOURCE_UNAVAILABLE',
        message: error instanceof DomainError ? error.message : '固定来源暂不可用。' });
    }
  }
  candidates.sort((a, b) => a.item.appId.localeCompare(b.item.appId) || a.item.entryId.localeCompare(b.item.entryId));
  return { candidates, problems };
}

/** Preview is read-only; apply rebuilds the exact plan and atomically links all current snapshots. */
export async function refreshLegacyDistributions(options: {
  db: Database; gitlabUrl: string; token: string; directory: string; staticDir?: string;
  apply?: boolean; expectedPlan?: string; includeGuides?: boolean;
}): Promise<RefreshResult> {
  if (!options.token || /[\r\n\u0000]/.test(options.token)) throw new DomainError(400, 'VALIDATION_FAILED', '广场服务源码授权不可用。');
  const { candidates, problems } = await buildCandidates(options);
  const items = candidates.map(candidate => candidate.item);
  const review = options.includeGuides ? { guides: candidates.map(candidate => ({ appKey: candidate.item.appKey,
    entryId: candidate.item.entryId, text: candidate.guide })) } : {};
  if (problems.length) return { status: 'blocked', items, problems, ...review };
  const planId = digest(JSON.stringify({ version: 1, items }));
  if (!options.apply) return { status: 'ready', planId, items, problems: [], ...review };
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlan ?? '') || options.expectedPlan !== planId) {
    throw new DomainError(409, 'REFRESH_PLAN_MISMATCH', '固定来源或刷新计划已变化，请重新预览。');
  }
  for (const candidate of candidates) if (candidate.prepared) await storeDistribution(options.directory, candidate.prepared.pack, options.staticDir);
  let applied = 0;
  let unchanged = 0;
  await options.db.transaction(async tx => {
    // Prevent new catalog registrations and lifecycle transitions from racing
    // the complete-set check and the following short transaction.
    await tx.query('LOCK TABLE catalog_apps IN EXCLUSIVE MODE');
    const rows = new Map<string, SnapshotRow>();
    for (const row of await currentRows(tx)) rows.set(row.app_id, row);
    const beforeIds = [...new Set(items.map(item => item.appId))].sort();
    if (!isDeepStrictEqual(beforeIds, [...rows.keys()].sort())) throw new DomainError(409, 'REFRESH_PLAN_MISMATCH', '目录应用集合已变化，请重新预览。');
    for (const candidate of candidates) {
      const { item } = candidate;
      const locked = (await tx.query<{ current_snapshot_id: string; revision: number; lifecycle: string }>(
        `SELECT a.current_snapshot_id, a.revision, COALESCE((SELECT status FROM catalog_app_lifecycle WHERE app_id = a.id), 'published') AS lifecycle
           FROM catalog_apps a WHERE a.id = $1 FOR UPDATE`, [item.appId])).rows[0];
      const current = rows.get(item.appId);
      if (!locked || !current || locked.current_snapshot_id !== item.snapshotId || locked.revision !== item.revision
          || locked.lifecycle !== 'published' || current.commit_sha !== item.commitSha
          || current.digest !== item.snapshotDigest || current.project_id !== item.projectId) {
        throw new DomainError(409, 'REFRESH_PLAN_MISMATCH', '目录快照已变化，请重新预览。');
      }
      const saved = (await tx.query<AssetRow>('SELECT * FROM distribution_assets WHERE snapshot_id = $1 AND entry_id = $2', [item.snapshotId, item.entryId])).rows[0];
      if (saved) {
        const currentEntry = parse<StoredAppManifest>(current.manifest).entries
          .find((entry): entry is AgentEntry => entry.kind === 'agent' && entry.id === item.entryId);
        const currentGuide = saved.guide_text ?? (currentEntry ? parse<Record<string, string>>(current.documents)[currentEntry.instructionsPath] : undefined);
        if (saved.sha256 !== item.sha256 || saved.byte_size !== item.size || saved.delivery_mode !== item.delivery
            || saved.package_type !== item.packageType || !isDeepStrictEqual(parse<DistributionFile[]>(saved.files), item.files)
            || !isDeepStrictEqual(parse<string[]>(saved.transformed_paths), item.transformedPaths)
            || !isDeepStrictEqual(parse<string[]>(saved.excluded_paths), item.excludedPaths)
            || typeof currentGuide !== 'string' || digest(currentGuide) !== item.guideSha256) {
          throw new DomainError(409, 'REFRESH_PLAN_MISMATCH', '已有分发记录与刷新计划不一致。');
        }
        unchanged++;
      } else {
        if (!candidate.prepared) throw new DomainError(409, 'REFRESH_PLAN_MISMATCH', '分发候选已失效，请重新预览。');
        await tx.query(`INSERT INTO distribution_assets (id, snapshot_id, entry_id, package_type, sha256, byte_size, files,
          delivery_mode, guide_text, transformed_paths, excluded_paths, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,now())`,
        [randomUUID(), item.snapshotId, item.entryId, item.packageType, item.sha256, item.size, JSON.stringify(item.files),
          item.delivery, candidate.guide, JSON.stringify(item.transformedPaths), JSON.stringify(item.excludedPaths)]);
        applied++;
      }
    }
  });
  return { status: 'applied', planId, items, problems: [], applied, unchanged, ...review };
}
