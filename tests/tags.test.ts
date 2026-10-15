import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateManifest } from '../server/domain/manifest.js';
import { validateTagReuse } from '../server/domain/tags.js';
import { cleanCatalogTags } from '../server/domain/tag-cleanup.js';
import { manifest, SHA, SHA2, TOKEN, DEFAULT_TAG } from './helpers/gitlab-fixture.js';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('new manifests allow three capability tags and reject four or normalized duplicates', () => {
  const source = { ...manifest(), tags: ['MCP', '需求管理', 'AI协作'] };
  assert.deepEqual(validateManifest(source, source.appKey).tags, source.tags);
  assert.throws(() => validateManifest({ ...source, tags: [...source.tags, '额外能力'] }, source.appKey), /最多 3 个/);
  assert.throws(() => validateManifest({ ...source, tags: ['MCP', 'ｍｃｐ'] }, source.appKey), /不能重复/);
  assert.throws(() => validateTagReuse(['mcp'], ['MCP']), /复用已有标签/);
  validateTagReuse(['MCP', '新能力'], ['MCP']);
});

test('manifest validation and HTTP tag filters count supplementary characters as code points', async t => {
  const tag = '😀'.repeat(32);
  assert.deepEqual(validateManifest({ ...manifest(), tags: [tag] }, 'sample-1').tags, [tag]);
  assert.throws(() => validateManifest({ ...manifest(), tags: [tag+'😀'] }, 'sample-1'), /32 个字符/);
  const h = await startHarness(); t.after(() => h.close());
  await seedTagCatalog(h.db, h.config.audience, [tag]);
  const response = await fetch(h.origin+'/api/apps?tags='+encodeURIComponent(tag));
  assert.equal(response.status, 200); assert.equal((await response.json()).total, 1);
  assert.equal((await fetch(h.origin+'/api/apps?tags='+encodeURIComponent(tag+'😀'))).status, 400);
});

test('HTTP exposes existing tags, preserves source manifests, and filters the same curated tags as details', async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const seeded = await seedTagCatalog(harness.db, harness.config.audience, ['MCP', '框架A', '组件B', '内部操作']);
  const before = (await harness.db.query('SELECT * FROM published_snapshots')).rows;
  const plan = { schemaVersion: 1, operationId: randomUUID(), audience: harness.config.audience, entries: [seeded.entry] };
  await cleanCatalogTags(harness.db, plan, { apply: true, saveBackup: async () => {} });
  const get = async (url: string) => (await fetch(harness.origin + url)).json();
  assert.deepEqual(await get('/api/tags'), { tags: ['MCP', '知识整理'], maxTagsPerApp: 3 });
  const detail = await get('/api/apps/' + seeded.appId);
  assert.deepEqual(detail.tags, ['MCP', '知识整理']);
  assert.deepEqual(detail.manifest.tags, seeded.source.tags);
  assert.equal(detail.revision, 1);
  const matching = await get('/api/apps?tags=MCP&tags=' + encodeURIComponent('知识整理'));
  assert.equal(matching.total, 1);
  assert.deepEqual(matching.items[0].tags, detail.tags);
  assert.equal((await get('/api/apps?tags=' + encodeURIComponent('框架A'))).total, 0);
  const guide = await get('/api/apps/' + seeded.appId + '/instructions/agent');
  assert.ok(guide.text.includes('SOURCE-INSTRUCTIONS-UNCHANGED'));
  assert.deepEqual((await harness.db.query('SELECT * FROM published_snapshots')).rows, before);
  const contract = await get('/api/publish-contract');
  assert.equal(contract.schema.properties.tags.maxItems, 3);
  assert.deepEqual(contract.tagPolicy.existingTags, ['MCP', '知识整理']);
  assert.ok(contract.prompt.includes('/api/tags'));
  assert.ok(contract.prompt.includes('优先复用'));
});

test('HTTP publication rejects four tags and existing label variants before offering confirmation', async t => {
  const harness = await startHarness();
  t.after(() => harness.close());
  await seedTagCatalog(harness.db, harness.config.audience, ['MCP']);
  const submit = async (tags: string[]) => {
    harness.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), tags }));
    return (await fetch(harness.origin + '/api/publications', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitLab-Token': TOKEN, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }) })).json();
  };
  const tooMany = await submit(['MCP', '能力二', '能力三', '能力四']);
  assert.equal(tooMany.status, 'failed');
  assert.match(tooMany.error.message, /最多 3 个/);
  const variant = await submit(['mcp']);
  assert.equal(variant.status, 'failed');
  assert.match(variant.error.message, /复用已有标签/);
  const valid = await submit(['MCP', '能力二', '能力三']);
  assert.equal(valid.status, 'preview_ready');
  assert.equal((await harness.db.query('SELECT count(*) AS total FROM published_snapshots')).rows[0]?.total, 1);
});

test('confirmation rechecks canonical names added after its preview without changing the source', async t => {
  const h = await startHarness(2);
  t.after(() => h.close());
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), tags: ['mcp'] }));
  h.gitlab.state.files.set('.ai-apps/sample-2/ai-app.json', JSON.stringify({ ...manifest(2), tags: ['MCP'] }));
  const submit = (index: number) => h.service.submit({ projectId: 1, appKey: `sample-${index}`, manifestPath: index === 1 ? 'ai-app.json' : '.ai-apps/sample-2/ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  const stale = await submit(1), canonical = await submit(2);
  assert.equal(stale.status, 'preview_ready');
  assert.equal(canonical.status, 'preview_ready');
  await h.service.confirm(canonical.id, canonical.ticket, { revision: canonical.revision, digest: canonical.digest! });
  const result = await h.service.confirm(stale.id, stale.ticket, { revision: stale.revision, digest: stale.digest! });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'VALIDATION_FAILED');
  assert.match(result.error?.message ?? '', /复用已有标签/);
  assert.deepEqual(await h.service.tags(), ['MCP']);
  assert.equal((await h.service.list()).total, 1);
  assert.deepEqual((await h.service.publication(stale.id, stale.ticket)).preview?.manifest.tags, ['mcp']);
});

test('competing confirmations can register only one spelling of a new capability tag', async t => {
  const h = await startHarness(2);
  t.after(() => h.close());
  const drafts = [];
  for (const index of [1, 2]) {
    const manifestPath = index === 1 ? 'ai-app.json' : '.ai-apps/sample-2/ai-app.json';
    h.gitlab.state.files.set(manifestPath, JSON.stringify({ ...manifest(index), tags: [index === 1 ? 'mcp' : 'MCP'] }));
    drafts.push(await h.service.submit({ projectId: 1, appKey: `sample-${index}`, manifestPath, commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID()));
  }
  const results = await Promise.all(drafts.map(draft => h.service.confirm(draft.id, draft.ticket, { revision: draft.revision, digest: draft.digest! })));
  assert.deepEqual(results.map(result => result.status).sort(), ['failed', 'registered']);
  assert.equal(results.find(result => result.status === 'failed')?.error?.code, 'VALIDATION_FAILED');
  assert.equal((await h.service.tags()).length, 1);
  assert.equal((await h.service.list()).total, 1);
});

test('a newly confirmed author version uses its own tags instead of inheriting historical curation', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), tags: ['MCP', '知识整理', '文档处理'] }));
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const first = await h.service.submit(input, TOKEN, randomUUID());
  const registered = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const previous = await h.service.app(registered.appId!);
  const plan = { schemaVersion: 1, operationId: randomUUID(), audience: h.config.audience, entries: [{ appId: previous.id, appKey: 'sample-1', expectedRevision: previous.revision, expectedCommitSha: SHA, expectedTags: previous.tags, tags: ['MCP'], reason: '历史目录分类测试' }] };
  await cleanCatalogTags(h.db, plan, { apply: true, saveBackup: async () => {} });
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), projectVersion: '1.1.0', tags: ['作者新能力'] }));
  h.gitlab.state.tagName = 'v1.1.0'; h.gitlab.state.tagSha = SHA2; h.gitlab.state.releaseSha = SHA2;
  const next = await h.service.submit({ ...input, commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: previous.revision }, TOKEN, randomUUID());
  const updated = await h.service.confirm(next.id, next.ticket, { revision: next.revision, digest: next.digest! });
  assert.equal(updated.status, 'registered');
  assert.equal(updated.appId, previous.id);
  const current = await h.service.app(previous.id);
  assert.deepEqual(current.tags, ['作者新能力']);
  assert.deepEqual(current.manifest.tags, current.tags);
  assert.equal(current.revision, previous.revision + 1);
  assert.equal((await h.db.query('SELECT count(*) AS total FROM catalog_tag_overrides')).rows[0]?.total, 1);
});

for (const keepCurated of [false, true]) test(`update preview compares effective catalog tags when ${keepCurated ? 'keeping curated labels' : 'restoring source labels'}`, async t => {
  const h = await startHarness(); t.after(() => h.close());
  const originalTags = ['MCP', '知识整理', '文档处理'];
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), tags: originalTags }));
  const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const first = await h.service.submit(input, TOKEN, randomUUID());
  const saved = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
  const previous = await h.service.app(saved.appId!);
  await cleanCatalogTags(h.db, { schemaVersion: 1, operationId: randomUUID(), audience: h.config.audience, entries: [{ appId: previous.id, appKey: 'sample-1', expectedRevision: previous.revision, expectedCommitSha: SHA, expectedTags: originalTags, tags: ['MCP'], reason: '验证公开标签变更摘要' }] }, { apply: true, saveBackup: async () => {} });
  const nextTags = keepCurated ? ['MCP'] : originalTags;
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), projectVersion: '1.1.0', tags: nextTags }));
  h.gitlab.state.tagName='v1.1.0'; h.gitlab.state.tagSha=SHA2; h.gitlab.state.releaseSha=SHA2;
  const next = await h.service.submit({ ...input, commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: previous.revision }, TOKEN, randomUUID());
  assert.equal(next.status, 'preview_ready');
  assert.deepEqual(next.change?.changedFields, keepCurated ? [] : ['能力标签']);
  assert.deepEqual(next.preview?.tags, nextTags);
  assert.deepEqual((await h.service.app(previous.id)).manifest.tags, originalTags);
  const confirmed = await h.service.confirm(next.id, next.ticket, { revision: next.revision, digest: next.digest! });
  assert.equal(confirmed.status, 'registered');
  assert.deepEqual(confirmed.change?.changedFields, next.change?.changedFields);
  assert.deepEqual((await h.service.app(previous.id)).tags, nextTags);
});
