import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Database, Queryable } from './database.js';
import { DomainError } from './errors.js';
import { validateCapabilityTags } from './tags.js';

const tagList = z.array(z.string().min(1).max(32));
const desiredTags = tagList.max(3);
const entrySchema = z.object({
  appId: z.string().uuid(), appKey: z.string().min(1).max(64),
  expectedRevision: z.number().int().positive(), expectedCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  expectedTags: tagList.max(12), tags: desiredTags, reason: z.string().min(1).max(1000),
}).strict();
const planSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), audience: z.string().min(1).max(200),
  entries: z.array(entrySchema).min(1).max(1000),
}).strict();
const overrideSchema = z.object({ tags: desiredTags, operationId: z.string().uuid(), reason: z.string(), updatedAt: z.string() }).strict();
const backupSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string().uuid(), audience: z.string(), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(entrySchema.extend({ snapshotId: z.string().uuid(), before: overrideSchema.nullable() })).min(1).max(1000),
}).strict();

export type TagCleanupPlan = z.infer<typeof planSchema>;
export type TagCleanupBackup = z.infer<typeof backupSchema>;
type Override = z.infer<typeof overrideSchema>;
interface Row {
  id: string; app_key: string; revision: number; snapshot_id: string; commit_sha: string;
  source_tags: string[]; override: Override | null;
}

function conflict(message: string): never { throw new DomainError(409, 'TAG_CLEANUP_CONFLICT', message); }
function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function cleanupPlanHash(plan: TagCleanupPlan): string { return digest(plan); }

export function parseCleanupPlan(value: unknown): TagCleanupPlan {
  const result = planSchema.safeParse(value);
  if (!result.success) throw new DomainError(400, 'VALIDATION_FAILED', '标签清洗计划格式无效。');
  const ids = new Set<string>();
  for (const entry of result.data.entries) {
    if (ids.has(entry.appId)) throw new DomainError(400, 'VALIDATION_FAILED', '清洗计划的应用 ID 不能重复。');
    ids.add(entry.appId);
    validateCapabilityTags(entry.tags);
  }
  return result.data;
}

export function parseCleanupBackup(value: unknown): TagCleanupBackup {
  const result = backupSchema.safeParse(value);
  if (!result.success) throw new DomainError(400, 'VALIDATION_FAILED', '标签回滚备份格式无效。');
  const { checksum, ...payload } = result.data;
  if (digest(payload) !== checksum) conflict('备份内容摘要不一致，停止回滚。');
  const { planHash, entries, ...identity } = payload;
  const plan = parseCleanupPlan({ ...identity, entries: entries.map(({ snapshotId, before, ...entry }) => entry) });
  if (cleanupPlanHash(plan) !== planHash) conflict('备份的计划摘要不一致，停止回滚。');
  for (const entry of entries) if (entry.before) validateCapabilityTags(entry.before.tags);
  return result.data;
}

async function hasOverrides(db: Queryable): Promise<boolean> {
  return Boolean((await db.query<{ present: boolean }>("SELECT to_regclass('catalog_tag_overrides') IS NOT NULL AS present")).rows[0]?.present);
}

async function readRow(db: Queryable, entry: TagCleanupPlan['entries'][number], audience: string, overrides: boolean, lock: boolean): Promise<Row> {
  const result = await db.query<Row>(
    `SELECT a.id, a.app_key, a.revision, s.id AS snapshot_id, s.commit_sha, s.manifest->'tags' AS source_tags,
       ${overrides ? "CASE WHEN o.snapshot_id IS NULL THEN NULL ELSE jsonb_build_object('tags', o.tags, 'operationId', o.operation_id, 'reason', o.reason, 'updatedAt', o.updated_at) END" : 'NULL::jsonb'} AS override
       FROM catalog_apps a JOIN published_snapshots s ON s.id = a.current_snapshot_id
       ${overrides ? 'LEFT JOIN catalog_tag_overrides o ON o.snapshot_id = s.id' : ''}
      WHERE a.id = $1 AND s.audience = $2${lock ? ' FOR UPDATE OF a' : ''}`, [entry.appId, audience],
  );
  const row = result.rows[0];
  if (!row || row.app_key !== entry.appKey || row.revision !== entry.expectedRevision || row.commit_sha !== entry.expectedCommitSha) {
    conflict('应用、版本或来源已变化，停止整批标签操作并重新盘点。');
  }
  return row;
}

async function writeOverride(db: Queryable, snapshotId: string, value: Omit<Override, 'updatedAt'> & { updatedAt?: string }): Promise<void> {
  await db.query(
    `INSERT INTO catalog_tag_overrides (snapshot_id, tags, operation_id, reason, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5::timestamptz)
     ON CONFLICT (snapshot_id) DO UPDATE SET tags = EXCLUDED.tags, operation_id = EXCLUDED.operation_id, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`,
    [snapshotId, JSON.stringify(value.tags), value.operationId, value.reason, value.updatedAt ?? new Date().toISOString()],
  );
}

export async function cleanCatalogTags(db: Database, input: unknown, options: {
  apply?: boolean; saveBackup?: (backup: TagCleanupBackup) => Promise<void>;
} = {}) {
  const plan = parseCleanupPlan(input);
  if (options.apply && !options.saveBackup) throw new DomainError(400, 'VALIDATION_FAILED', '执行清洗前必须保存备份。');
  return db.transaction(async tx => {
    if (!options.apply) await tx.query('SET TRANSACTION READ ONLY');
    const overrides = await hasOverrides(tx);
    if (options.apply && !overrides) conflict('标签数据迁移尚未安装，请先部署已验证的服务版本。');
    const entries: TagCleanupBackup['entries'] = [];
    let applied = 0;
    for (const entry of [...plan.entries].sort((a, b) => a.appId.localeCompare(b.appId))) {
      const row = await readRow(tx, entry, plan.audience, overrides, Boolean(options.apply));
      const effective = row.override?.tags ?? row.source_tags;
      if (row.override?.operationId === plan.operationId && same(effective, entry.tags)) applied++;
      else if (!same(effective, entry.expectedTags)) conflict('有效标签与清洗预览不同，停止整批操作并重新盘点。');
      entries.push({ ...entry, snapshotId: row.snapshot_id, before: row.override });
    }
    if (applied && applied !== entries.length) conflict('发现部分清洗记录，停止操作并核对原回执。');
    const changes = applied ? [] : entries.filter(entry => !same(entry.expectedTags, entry.tags));
    const backupPayload = { schemaVersion: 1 as const, operationId: plan.operationId, audience: plan.audience, planHash: cleanupPlanHash(plan), entries: plan.entries.map(entry => entries.find(row => row.appId === entry.appId)!) };
    const backup: TagCleanupBackup = { ...backupPayload, checksum: digest(backupPayload) };
    if (options.apply && !applied) {
      await options.saveBackup!(backup);
      for (const entry of entries) await writeOverride(tx, entry.snapshotId, { tags: entry.tags, operationId: plan.operationId, reason: entry.reason });
    }
    return { status: applied ? 'already_applied' : options.apply ? 'applied' : 'preview', operationId: plan.operationId,
      changedApps: changes.length, entries: entries.map(entry => ({ appId: entry.appId, appKey: entry.appKey, before: entry.expectedTags, after: entry.tags })) };
  });
}

export async function restoreCatalogTags(db: Database, input: unknown, apply = false) {
  const backup = parseCleanupBackup(input);
  return db.transaction(async tx => {
    if (!apply) await tx.query('SET TRANSACTION READ ONLY');
    const overrides = await hasOverrides(tx);
    const entries: TagCleanupBackup['entries'] = [];
    let restored = 0;
    for (const entry of [...backup.entries].sort((a, b) => a.appId.localeCompare(b.appId))) {
      const row = await readRow(tx, entry, backup.audience, overrides, apply);
      if (row.snapshot_id !== entry.snapshotId) conflict('目录快照已变化，停止整批回滚。');
      if (same(row.override, entry.before)) restored++;
      else if (row.override?.operationId !== backup.operationId || !same(row.override.tags, entry.tags)) conflict('清洗后标签或操作身份已变化，停止整批回滚。');
      entries.push(entry);
    }
    if (restored && restored !== entries.length) conflict('发现部分回滚记录，停止操作并核对原回执。');
    if (apply && !restored) for (const entry of entries) {
      if (entry.before) await writeOverride(tx, entry.snapshotId, entry.before);
      else await tx.query('DELETE FROM catalog_tag_overrides WHERE snapshot_id = $1 AND operation_id = $2', [entry.snapshotId, backup.operationId]);
    }
    return { status: restored ? 'already_restored' : apply ? 'restored' : 'rollback_preview', operationId: backup.operationId,
      changedApps: restored ? 0 : entries.length, entries: entries.map(entry => ({ appId: entry.appId, before: entry.tags, after: entry.before?.tags ?? entry.expectedTags })) };
  });
}
