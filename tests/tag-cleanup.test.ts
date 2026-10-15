import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openDatabase, type Database } from '../server/domain/database.js';
import { cleanCatalogTags, restoreCatalogTags, type TagCleanupBackup } from '../server/domain/tag-cleanup.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const audience = 'cleanup-test-audience';
async function setup(t: { after(cb: () => Promise<void>): void }) {
  const db = await openDatabase({ path: 'memory://' });
  t.after(() => db.close());
  const a = await seedTagCatalog(db, audience, ['MCP', '框架', '组件', '操作'], 1);
  const b = await seedTagCatalog(db, audience, ['mcp', '语言', '工具', '内部名'], 2);
  const plan = { schemaVersion: 1 as const, operationId: randomUUID(), audience, entries: [a.entry, b.entry] };
  return { db, a, b, plan };
}
async function overrides(db: Database) { return (await db.query('SELECT * FROM catalog_tag_overrides ORDER BY snapshot_id')).rows; }

test('cleanup preview is zero-write; apply is backed up, atomic, replayable and reversible', async t => {
  const { db, plan } = await setup(t);
  const snapshots = (await db.query('SELECT * FROM published_snapshots ORDER BY id')).rows;
  const apps = (await db.query('SELECT * FROM catalog_apps ORDER BY id')).rows;
  assert.equal((await cleanCatalogTags(db, plan)).status, 'preview');
  assert.deepEqual(await overrides(db), []);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true }), /保存备份/);
  let backup: TagCleanupBackup | undefined;
  const saveBackup = async (value: TagCleanupBackup) => { backup = value; };
  assert.equal((await cleanCatalogTags(db, plan, { apply: true, saveBackup })).changedApps, 2);
  const after = await overrides(db);
  assert.equal(after.length, 2);
  assert.equal((await cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => { throw new Error('Must not replace original backup'); } })).status, 'already_applied');
  assert.deepEqual(await overrides(db), after);
  assert.equal((await restoreCatalogTags(db, backup)).status, 'rollback_preview');
  assert.deepEqual(await overrides(db), after);
  assert.equal((await restoreCatalogTags(db, backup, true)).status, 'restored');
  assert.deepEqual(await overrides(db), []);
  assert.equal((await restoreCatalogTags(db, backup, true)).status, 'already_restored');
  assert.deepEqual((await db.query('SELECT * FROM published_snapshots ORDER BY id')).rows, snapshots);
  assert.deepEqual((await db.query('SELECT * FROM catalog_apps ORDER BY id')).rows, apps);
});

test('any app/source/tag drift stops the whole cleanup, including earlier entries', async t => {
  const { db, b, plan } = await setup(t);
  await db.query('UPDATE catalog_apps SET revision = revision + 1 WHERE id = $1', [b.appId]);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => {} }), /来源已变化/);
  assert.deepEqual(await overrides(db), []);
  await db.query('UPDATE catalog_apps SET revision = revision - 1 WHERE id = $1', [b.appId]);
  await db.query('UPDATE published_snapshots SET commit_sha = $2 WHERE id = $1', [b.snapshotId, 'b'.repeat(40)]);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => {} }), /来源已变化/);
  assert.deepEqual(await overrides(db), []);
  await db.query('UPDATE published_snapshots SET commit_sha = $2 WHERE id = $1', [b.snapshotId, b.entry.expectedCommitSha]);
  const tagsDrift = structuredClone(plan); tagsDrift.entries[1].expectedTags = ['不匹配'];
  await assert.rejects(cleanCatalogTags(db, tagsDrift, { apply: true, saveBackup: async () => {} }), /标签与清洗预览不同/);
  assert.deepEqual(await overrides(db), []);
});

test('backup failure and interrupted database writes roll back the complete batch', async t => {
  const { db, plan } = await setup(t);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => { throw new Error('backup unavailable'); } }), /backup unavailable/);
  assert.deepEqual(await overrides(db), []);
  let inserts = 0;
  const failing: Database = { query: db.query.bind(db), close: async () => {}, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
    if (sql.startsWith('INSERT INTO catalog_tag_overrides') && ++inserts === 2) throw new Error('write interrupted');
    return tx.query(sql, params);
  } })) };
  await assert.rejects(cleanCatalogTags(failing, plan, { apply: true, saveBackup: async () => {} }), /write interrupted/);
  assert.deepEqual(await overrides(db), []);
  assert.equal((await db.query('SELECT count(*) AS total FROM catalog_tag_cleanup_operations')).rows[0]?.total,0);
});

test('rollback refuses changed cleanup identity, changed tags and corrupted backup', async t => {
  const { db, a, plan } = await setup(t);
  let backup: TagCleanupBackup | undefined;
  await cleanCatalogTags(db, plan, { apply: true, saveBackup: async value => { backup = value; } });
  const corrupt = structuredClone(backup!); corrupt.entries[0].before = { tags: ['伪造'], operationId: randomUUID(), reason: 'wrong', updatedAt: new Date().toISOString() };
  await assert.rejects(restoreCatalogTags(db, corrupt, true), /备份内容摘要不一致/);
  await db.query('UPDATE catalog_tag_overrides SET operation_id = $2 WHERE snapshot_id = $1', [a.snapshotId, randomUUID()]);
  const before = await overrides(db);
  await assert.rejects(restoreCatalogTags(db, backup, true), /操作身份已变化/);
  assert.deepEqual(await overrides(db), before);
  await db.query("UPDATE catalog_tag_overrides SET operation_id = $2, tags = '[\"后续整理\"]'::jsonb WHERE snapshot_id = $1", [a.snapshotId, plan.operationId]);
  const changedTags = await overrides(db);
  await assert.rejects(restoreCatalogTags(db, backup, true), /标签或操作身份已变化/);
  assert.deepEqual(await overrides(db), changedTags);
});

test('rollback restores a prior classification and its original operation metadata', async t => {
  const { db, a, plan } = await setup(t);
  await db.query(`INSERT INTO catalog_tag_overrides (snapshot_id, tags, operation_id, reason, updated_at)
    VALUES ($1, '["历史分类"]'::jsonb, $2, '原整理依据', '2026-01-02T00:00:00Z')`, [a.snapshotId, randomUUID()]);
  plan.entries[0].expectedTags = ['历史分类'];
  const before = await overrides(db);
  let backup: TagCleanupBackup | undefined;
  await cleanCatalogTags(db, plan, { apply: true, saveBackup: async value => { backup = value; } });
  assert.equal((await restoreCatalogTags(db, backup, true)).status, 'restored');
  assert.deepEqual(await overrides(db), before);
  assert.equal((await restoreCatalogTags(db, backup, true)).status, 'already_restored');
});

test('preview works against a pre-migration database without installing any schema', async t => {
  const { db, plan } = await setup(t);
  await db.query('DROP TABLE catalog_tag_overrides');
  await db.query('DROP TABLE catalog_tag_cleanup_operations');
  assert.equal((await cleanCatalogTags(db, plan)).status, 'preview');
  assert.equal((await db.query("SELECT to_regclass('catalog_tag_overrides') IS NULL AS absent")).rows[0]?.absent, true);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => {} }), /迁移尚未安装/);
});

test('cleanup rejects a variant retained by an unplanned app before backup or any override write', async t => {
  const { db, b, plan } = await setup(t);
  plan.entries = [{ ...b.entry, tags: ['mcp'] }];
  let backups = 0;
  await assert.rejects(cleanCatalogTags(db, plan), /规范化.*标签|标签.*规范化/);
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => { backups++; } }), /规范化.*标签|标签.*规范化/);
  assert.equal(backups, 0); assert.deepEqual(await overrides(db), []);
  plan.entries[0].tags = ['MCP'];
  assert.equal((await cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => {} })).changedApps, 1);
});

test('cleanup validates the complete replacement set so a batch may consolidate but never create variants', async t => {
  const { db, plan } = await setup(t);
  plan.entries[0].tags = ['ＭＣＰ']; plan.entries[1].tags = ['mcp'];
  await assert.rejects(cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => { throw new Error('must reject before backup'); } }), /规范化.*标签|标签.*规范化/);
  assert.deepEqual(await overrides(db), []);
  plan.entries[0].tags = ['MCP']; plan.entries[1].tags = ['MCP'];
  assert.equal((await cleanCatalogTags(db, plan)).changedApps, 2);
  assert.equal((await cleanCatalogTags(db, plan, { apply: true, saveBackup: async () => {} })).changedApps, 2);
});

test('cleanup and rollback use the schema Unicode code-point tag length', async t => {
  const { db, plan } = await setup(t);
  for (const entry of plan.entries) entry.tags = ['😀'.repeat(32)];
  let backup: TagCleanupBackup | undefined;
  assert.equal((await cleanCatalogTags(db, plan)).status, 'preview');
  await cleanCatalogTags(db, plan, { apply: true, saveBackup: async value => { backup=value; } });
  assert.equal((await restoreCatalogTags(db, backup)).status, 'rollback_preview');
  assert.equal((await overrides(db)).length, 2);
});
