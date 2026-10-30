import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { openDatabase, type Database } from '../server/domain/database.js';
import { cleanCatalogTags } from '../server/domain/tag-cleanup.js';
import { bundle, performanceHarness } from './helpers/managed-performance.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('normal multi-batch upload keeps one final complete tree scan and verifies fixed version before preview', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const submitted = await h.submit(bundle('1.0.0', 205)); assert.equal(submitted.result.status, 'preview_ready');
  const requests = h.fixture.state.requests;
  assert.equal(h.fixture.state.commitCreateCount, 3);
  assert.equal(requests.filter(item => item.path.includes('/repository/tree?') && item.path.includes('recursive=true')).length, 3,
    'one complete 209-file tree scan has three pages; no per-batch scans');
  assert.equal(requests.filter(item => item.path.match(/\/repository\/commits\/[a-f0-9]+$/)).length, 1,
    'only the independent source gate reads commit metadata on a normal upload');
  const operation = (await h.db.query('SELECT * FROM managed_publish_operations')).rows[0]!;
  assert.equal(operation.publication_id, submitted.result.id);
  assert.equal(operation.status, 'submitted');
  assert.equal((await h.confirm(submitted.result)).status, 'registered');
});

test('missing commit response metadata and lost tag/release responses take the readback path without duplicate writes', async t => {
  const h = await performanceHarness(); t.after(h.close);
  h.fixture.state.omitNextCommitParents = true;
  h.fixture.state.dropNextTagResponse = true; h.fixture.state.dropNextReleaseResponse = true;
  const sent = await h.submit(bundle()); assert.equal(sent.result.status, 'preview_ready');
  assert.equal(h.fixture.state.commitCreateCount, 1);
  const writes = h.fixture.state.writes;
  assert.equal(writes.filter(item => item.path.endsWith('/repository/tags')).length, 1);
  assert.equal(writes.filter(item => item.path.endsWith('/releases')).length, 1);
  assert.ok(h.fixture.state.requests.filter(item => item.path.includes('recursive=true')).length >= 2,
    'an uncertain response retains content readback plus the final gate');
  const retry = await h.submit(bundle(), sent.key, sent.idempotency);
  assert.equal(retry.result.id, sent.result.id); assert.equal(h.fixture.state.writes.length, writes.length);
});

test('a wrong final source tree stops before tag/release and can recover the original operation after source readback is repaired', async t => {
  const h = await performanceHarness(); t.after(h.close); h.fixture.state.corruptNextCommitContent = true;
  const sent = await h.submit(bundle());
  assert.equal(sent.response.status, 409); assert.equal(sent.result.error.code, 'MANAGED_SOURCE_CONFLICT');
  assert.equal(h.fixture.state.writes.filter(item => item.path.endsWith('/repository/tags') || item.path.endsWith('/releases')).length, 0);
  assert.equal((await h.service.list()).total, 0);
  const project = [...h.fixture.state.projects.values()][0]!;
  project.commits.get([...project.branches.values()][0]!)!.files.delete('unexpected.txt');
  const recovered = await h.submit(bundle(), sent.key, sent.idempotency);
  assert.equal(recovered.result.status, 'preview_ready'); assert.equal(h.fixture.state.commitCreateCount, 1);
});

test('DB failure after preview creation resumes after HTTP service restart using the original publication and no source writes', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const original = h.db.query.bind(h.db);
  let inject = true;
  h.db.query = ((sql, params) => {
    if (inject && sql.startsWith('UPDATE managed_publish_operations SET') && sql.includes('publication_id')) {
      inject = false; throw new Error('fixture journal write failure');
    }
    return original(sql, params);
  }) as Database['query'];
  const sent = await h.submit(bundle()); assert.equal(sent.response.status, 500);
  const publication = (await h.db.query('SELECT id FROM publications')).rows[0]!;
  assert.equal((await h.db.query('SELECT status FROM managed_publish_operations')).rows[0]!.status, 'release_ready');
  const count = h.fixture.state.writes.length;
  await h.app.close();
  const restarted = await createApp(h.config, h.db); t.after(() => restarted.app.close());
  await restarted.app.listen({ port: h.config.port, host: h.config.host });
  const recovered = await h.submit(bundle(), sent.key, sent.idempotency);
  assert.equal(recovered.result.id, publication.id); assert.equal(recovered.result.status, 'preview_ready');
  assert.equal(h.fixture.state.writes.length, count);
  assert.equal((await h.db.query('SELECT publication_id FROM managed_publish_operations')).rows[0]!.publication_id, publication.id);
});

test('completed same-key receipt is zero-GitLab-read, owner/content bound, and expiry or crossed receipt cannot bypass the gate', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const first = await h.submit(bundle()); assert.equal(first.result.status, 'preview_ready');
  let requests = h.fixture.state.requests.length;
  const repeated = await h.submit(bundle(), first.key, first.idempotency);
  assert.equal(repeated.result.previewUrl, first.result.previewUrl); assert.equal(h.fixture.state.requests.length, requests);
  const wrong = await h.submit({ ...bundle(), managedAppId: first.result.managedAppId, expectedAppRevision: 0 });
  assert.equal(wrong.response.status, 403); assert.equal(h.fixture.state.requests.length, requests);
  const changed = bundle(); changed.files[1]!.content = Buffer.from('different content').toString('base64');
  assert.equal((await h.submit(changed, first.key, first.idempotency)).result.error.code, 'IDEMPOTENCY_CONFLICT');
  const other = await h.submit(bundle()); assert.equal(other.result.status, 'preview_ready'); requests = h.fixture.state.requests.length;
  const operation = (await h.db.query('SELECT id FROM managed_publish_operations WHERE publication_id = $1', [first.result.id])).rows[0]!.id;
  await h.db.query('UPDATE managed_publish_operations SET publication_id = $1 WHERE id = $2', [other.result.id, operation]);
  const crossed = await h.submit(bundle(), first.key, first.idempotency);
  assert.equal(crossed.result.error.code, 'MANAGED_SOURCE_CONFLICT');
  assert.ok(!JSON.stringify(crossed.result).includes(other.result.ticket));
  await h.db.query('UPDATE managed_publish_operations SET publication_id = $1 WHERE id = $2', [first.result.id, operation]);
  await h.db.query("UPDATE publications SET expires_at = '2020-01-01' WHERE id = $1", [first.result.id]);
  const expired = await h.submit(bundle(), first.key, first.idempotency);
  assert.equal(expired.response.status, 410); assert.equal(expired.result.error.code, 'PUBLICATION_EXPIRED');
  assert.equal(h.fixture.state.requests.length, requests);
});

test('NULL receipt recovers the same managed preview, enforces expiry and preserves applied tag cleanup state', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const sent = await h.submit(bundle()); assert.equal(sent.result.status, 'preview_ready');
  const operation = (await h.db.query('SELECT id FROM managed_publish_operations WHERE publication_id = $1', [sent.result.id])).rows[0]!.id;
  const audience = 'legacy-receipt-history';
  const catalog = await seedTagCatalog(h.db, audience, ['MCP', '框架'], 73);
  const plan = { schemaVersion: 1 as const, operationId: randomUUID(), audience, entries: [catalog.entry] };
  await cleanCatalogTags(h.db, plan, { apply: true, saveBackup: async () => {} });
  const overridesBefore = (await h.db.query('SELECT * FROM catalog_tag_overrides WHERE snapshot_id = $1', [catalog.snapshotId])).rows;
  const identityBefore = (await h.db.query('SELECT * FROM catalog_tag_cleanup_operations WHERE operation_id = $1', [plan.operationId])).rows;
  const writes = h.fixture.state.writes.length;

  await h.db.query('UPDATE managed_publish_operations SET publication_id = NULL WHERE id = $1', [operation]);
  const recovered = await h.submit(bundle(), sent.key, sent.idempotency);
  assert.equal(recovered.response.status, 201);
  assert.equal(recovered.result.id, sent.result.id);
  assert.equal(recovered.result.status, sent.result.status);
  assert.equal(recovered.result.previewUrl, sent.result.previewUrl);
  assert.equal((await h.db.query('SELECT publication_id FROM managed_publish_operations WHERE id = $1', [operation])).rows[0]!.publication_id, sent.result.id);
  assert.equal(h.fixture.state.writes.length, writes, 'receipt recovery must not write to GitLab');
  assert.deepEqual((await h.db.query('SELECT * FROM catalog_tag_overrides WHERE snapshot_id = $1', [catalog.snapshotId])).rows, overridesBefore);
  assert.deepEqual((await h.db.query('SELECT * FROM catalog_tag_cleanup_operations WHERE operation_id = $1', [plan.operationId])).rows, identityBefore);

  await h.db.query("UPDATE publications SET expires_at = '2020-01-01' WHERE id = $1", [sent.result.id]);
  await h.db.query('UPDATE managed_publish_operations SET publication_id = NULL WHERE id = $1', [operation]);
  const expired = await h.submit(bundle(), sent.key, sent.idempotency);
  assert.equal(expired.response.status, 410);
  assert.equal(expired.result.error.code, 'PUBLICATION_EXPIRED');
  assert.equal((await h.db.query('SELECT publication_id FROM managed_publish_operations WHERE id = $1', [operation])).rows[0]!.publication_id, null);
  assert.equal(h.fixture.state.writes.length, writes, 'expired receipt rejection must not write to GitLab');
  assert.deepEqual((await h.db.query('SELECT * FROM catalog_tag_overrides WHERE snapshot_id = $1', [catalog.snapshotId])).rows, overridesBefore);
  assert.deepEqual((await h.db.query('SELECT * FROM catalog_tag_cleanup_operations WHERE operation_id = $1', [plan.operationId])).rows, identityBefore);
});

test('expired registered receipts recover the same app without rewriting legacy operations or publication history', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const sent = await h.submit(bundle());
  const confirmed = await h.confirm(sent.result);
  assert.equal(confirmed.status, 'registered');
  const operation = (await h.db.query('SELECT id FROM managed_publish_operations WHERE publication_id = $1', [sent.result.id])).rows[0]!;
  await h.db.query("UPDATE publications SET expires_at = '2020-01-01' WHERE id = $1", [sent.result.id]);
  await h.db.query('UPDATE managed_publish_operations SET publication_id = NULL WHERE id = $1', [operation.id]);
  const history = async () => Promise.all([
    h.db.query('SELECT * FROM publications ORDER BY id'),
    h.db.query('SELECT * FROM managed_app_bindings ORDER BY id'),
    h.db.query('SELECT * FROM managed_publish_operations ORDER BY id'),
    h.db.query('SELECT * FROM catalog_apps ORDER BY id'),
    h.db.query('SELECT * FROM published_snapshots ORDER BY id'),
  ]).then(results => results.map(result => result.rows));
  const before = await history();
  const writes = h.fixture.state.writes.length;
  const receipt = (key: string) => fetch(`${h.origin}/api/managed-publications/receipt`, {
    headers: { 'X-Plaza-Publish-Key': key, 'Idempotency-Key': sent.idempotency },
  });
  const denied = await receipt('A'.repeat(43));
  assert.equal(denied.status, 404);
  assert.equal((await denied.json() as any).error.code, 'MANAGED_OPERATION_NOT_FOUND');
  const response = await receipt(sent.key);
  assert.equal(response.status, 200);
  const recovered = await response.json() as any;
  assert.equal(recovered.status, 'registered');
  assert.equal(recovered.id, sent.result.id);
  assert.equal(recovered.appId, confirmed.appId);
  assert.equal(recovered.managedAppId, sent.result.managedAppId);
  assert.equal(recovered.sourceUploaded, true);
  assert.equal(h.fixture.state.writes.length, writes);
  assert.deepEqual(await history(), before, 'read-only recovery must preserve the expired record and legacy NULL link');

  const record = (await h.db.query('SELECT submission FROM publications WHERE id = $1', [sent.result.id])).rows[0]!;
  const input = record.submission as Parameters<typeof h.service.managedReceipt>[1];
  const linked = await h.service.managedReceipt(sent.result.id, input);
  assert.equal(linked.status, 'registered');
  assert.equal(linked.appId, confirmed.appId);
  await assert.rejects(h.service.managedReceipt(sent.result.id, { ...input, commitSha: 'f'.repeat(40) }),
    (error: any) => error.code === 'MANAGED_SOURCE_CONFLICT');
  await assert.rejects(h.service.lookupManagedReceipt({ ...input, tag: 'v9.9.9' }, h.config.managedPublishing.token, `managed:${operation.id}`),
    (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.fixture.state.writes.length, writes);
  assert.deepEqual(await history(), before);
});

test('receipt migration preserves managed and catalog history through migrate:false and repeated normal opens', async t => {
  const path = await mkdtemp(join(tmpdir(), 'plaza-perf-migration-'));
  const first = await openDatabase({ path });
  let closeCurrent: (() => Promise<void>) | undefined = first.close;
  t.after(async () => { await closeCurrent?.(); });
  const binding = randomUUID(), operation = randomUUID();
  await first.query("INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at) VALUES ($1, 'old-app', 'old-key', now(), now())", [binding]);
  await first.query("INSERT INTO managed_publish_operations (id, binding_id, idempotency_digest, request_digest, manifest_path, branch, tag, status, created_at, updated_at) VALUES ($1, $2, 'old-idempotency', 'old-content', 'ai-app.json', 'old-branch', 'v1.0.0', 'prepared', now(), now())", [operation, binding]);
  const audience = 'receipt-migration-history';
  const catalog = await seedTagCatalog(first, audience, ['MCP', '框架'], 74);
  const plan = { schemaVersion: 1 as const, operationId: randomUUID(), audience, entries: [catalog.entry] };
  await cleanCatalogTags(first, plan, { apply: true, saveBackup: async () => {} });

  const readHistory = async (db: typeof first) => {
    const row = (await db.query('SELECT * FROM managed_publish_operations WHERE id = $1', [operation])).rows[0]!;
    const legacyOperation = Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'publication_id'));
    return {
      binding: (await db.query('SELECT * FROM managed_app_bindings WHERE id = $1', [binding])).rows,
      operation: legacyOperation,
      catalogApp: (await db.query('SELECT * FROM catalog_apps WHERE id = $1', [catalog.appId])).rows,
      snapshot: (await db.query('SELECT * FROM published_snapshots WHERE id = $1', [catalog.snapshotId])).rows,
      override: (await db.query('SELECT * FROM catalog_tag_overrides WHERE snapshot_id = $1', [catalog.snapshotId])).rows,
      cleanupIdentity: (await db.query('SELECT * FROM catalog_tag_cleanup_operations WHERE operation_id = $1', [plan.operationId])).rows,
    };
  };
  const original = await readHistory(first);
  await first.query('ALTER TABLE managed_publish_operations DROP COLUMN publication_id');
  await first.close(); closeCurrent = undefined;

  const legacy = await openDatabase({ path, migrate: false }); closeCurrent = legacy.close;
  const absent = await legacy.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'managed_publish_operations' AND column_name = 'publication_id'");
  assert.equal(absent.rows.length, 0, 'migrate:false must leave the historical schema untouched');
  assert.deepEqual(await readHistory(legacy), original);
  await legacy.close(); closeCurrent = undefined;

  const reopened = await openDatabase({ path }); closeCurrent = reopened.close;
  const column = await reopened.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'managed_publish_operations' AND column_name = 'publication_id'");
  assert.equal(column.rows.length, 1);
  assert.equal(column.rows[0]!.is_nullable, 'YES');
  assert.equal(column.rows[0]!.column_default, null, 'migration must not backfill old receipts');
  assert.equal((await reopened.query('SELECT publication_id FROM managed_publish_operations WHERE id = $1', [operation])).rows[0]!.publication_id, null);
  assert.deepEqual(await readHistory(reopened), original);
  await reopened.close(); closeCurrent = undefined;

  const reopenedAgain = await openDatabase({ path }); closeCurrent = reopenedAgain.close;
  const columnsAgain = await reopenedAgain.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'managed_publish_operations' AND column_name = 'publication_id'");
  assert.equal(columnsAgain.rows.length, 1, 'reopening must not duplicate or alter the migrated column');
  assert.equal(columnsAgain.rows[0]!.is_nullable, 'YES');
  assert.equal((await reopenedAgain.query('SELECT publication_id FROM managed_publish_operations WHERE id = $1', [operation])).rows[0]!.publication_id, null);
  assert.deepEqual(await readHistory(reopenedAgain), original);
});
