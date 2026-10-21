import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers/harness.js';
import { DEFAULT_TAG, manifest, SHA, SHA2, TOKEN } from './helpers/gitlab-fixture.js';

function requestHeaders(origin: string) {
  return { host: new URL(origin).host };
}

async function registerApp(h: Awaited<ReturnType<typeof startHarness>>, index: number) {
  const input = {
    projectId: 1,
    appKey: `sample-${index}`,
    manifestPath: index === 1 ? 'ai-app.json' : `.ai-apps/sample-${index}/ai-app.json`,
    commitSha: SHA,
    tag: DEFAULT_TAG,
  };
  const candidate = await h.service.submit(input, TOKEN, randomUUID());
  assert.equal(candidate.status, 'preview_ready');
  const registered = await h.service.confirm(candidate.id, candidate.ticket, {
    revision: candidate.revision,
    digest: candidate.digest!,
  });
  assert.equal(registered.status, 'registered');
  assert.ok(registered.appId);
  return registered.appId!;
}

async function changeLifecycle(
  h: Awaited<ReturnType<typeof startHarness>>,
  appId: string,
  action: 'offline' | 'online' | 'delete' | 'restore',
  expectedAppRevision: number,
  expectedLifecycleRevision: number,
) {
  return h.app.inject({
    method: 'POST',
    url: `/api/management/apps/${appId}/lifecycle`,
    payload: { action, expectedAppRevision, expectedLifecycleRevision },
    headers: requestHeaders(h.origin),
  });
}

test('management lifecycle routes expose hidden apps locally while public catalog and tags stay published-only', async t => {
  const disabled = await startHarness();
  t.after(() => disabled.close());
  assert.equal((await disabled.app.inject({ url: '/api/management/apps', headers: requestHeaders(disabled.origin) })).statusCode, 404);

  const h = await startHarness(4, 'memory://', { localManagement: true });
  t.after(() => h.close());
  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(1), tags: ['MCP'] }));
  h.gitlab.state.files.set('.ai-apps/sample-2/ai-app.json', JSON.stringify({ ...manifest(2), tags: ['删除后不可见'] }));
  h.gitlab.state.files.set('.ai-apps/sample-3/ai-app.json', JSON.stringify({ ...manifest(3), tags: ['公开标签'] }));
  const offlineId = await registerApp(h, 1);
  const deletedId = await registerApp(h, 2);
  const publishedId = await registerApp(h, 3);

  assert.equal((await changeLifecycle(h, offlineId, 'offline', 1, 1)).statusCode, 200);
  assert.equal((await changeLifecycle(h, deletedId, 'delete', 1, 1)).statusCode, 200);

  const management = (url: string) => h.app.inject({ url, headers: requestHeaders(h.origin) });
  const publicList = (await management('/api/apps')).json();
  assert.equal(publicList.total, 1);
  assert.deepEqual(publicList.items.map((item: { id: string }) => item.id), [publishedId]);
  assert.deepEqual(publicList.tags, ['公开标签']);
  assert.deepEqual((await management('/api/tags')).json().tags, ['公开标签']);

  const allVisible = await management('/api/management/apps');
  assert.equal(allVisible.statusCode, 200);
  assert.equal(allVisible.json().total, 2, 'default excludes deleted but includes offline');
  assert.deepEqual(new Set(allVisible.json().items.map((item: { lifecycle: { status: string } }) => item.lifecycle.status)), new Set(['offline', 'published']));
  assert.ok(allVisible.json().tags.includes('MCP'));
  assert.ok(!allVisible.json().tags.includes('删除后不可见'));
  assert.equal((await management('/api/management/apps?status=all')).json().total, 2);
  assert.equal((await management('/api/management/apps?status=published')).json().total, 1);
  assert.equal((await management('/api/management/apps?status=offline')).json().total, 1);
  assert.equal((await management('/api/management/apps?status=deleted')).json().total, 1);
  assert.equal((await management('/api/management/apps?status=unknown')).statusCode, 400);

  for (const hiddenId of [offlineId, deletedId]) {
    assert.equal((await management(`/api/apps/${hiddenId}`)).statusCode, 404);
    assert.equal((await management(`/api/apps/${hiddenId}/instructions/agent`)).statusCode, 404);
    assert.equal((await management(`/api/apps/${hiddenId}/publish-contract`)).statusCode, 404);
    assert.equal((await management(`/api/management/apps/${hiddenId}`)).statusCode, 200);
    assert.equal((await management(`/api/management/apps/${hiddenId}/instructions/agent`)).statusCode, 200);
  }
  const details = (await management(`/api/management/apps/${offlineId}`)).json();
  assert.equal(details.lifecycle.status, 'offline');
  assert.equal(details.lifecycle.revision, 2);
  const contract = (await management(`/api/management/apps/${offlineId}/publish-contract`)).json();
  assert.match(contract.prompt, new RegExp(`/api/management/apps/${offlineId}`));
  assert.doesNotMatch(contract.prompt, new RegExp(`/api/apps/${offlineId}(?:\\s|$)`));

  h.gitlab.state.files.set('.ai-apps/sample-4/ai-app.json', JSON.stringify({ ...manifest(4), tags: ['ｍｃｐ'] }));
  const alias = await h.service.submit({
    projectId: 1, appKey: 'sample-4', manifestPath: '.ai-apps/sample-4/ai-app.json', commitSha: SHA, tag: DEFAULT_TAG,
  }, TOKEN, randomUUID());
  assert.equal(alias.status, 'failed');
  assert.equal(alias.error?.code, 'VALIDATION_FAILED', 'a hidden app tag still reserves its canonical spelling');

  h.gitlab.state.files.set('.ai-apps/sample-2/ai-app.json', JSON.stringify({ ...manifest(2), tags: ['删除后不可见'], projectVersion: '1.1.0' }));
  h.gitlab.state.tagName = 'v1.1.0';
  h.gitlab.state.tagSha = SHA2;
  h.gitlab.state.releaseSha = SHA2;
  const deletedUpdate = await h.service.submit({
    projectId: 1, appKey: 'sample-2', manifestPath: '.ai-apps/sample-2/ai-app.json', commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1,
  }, TOKEN, randomUUID());
  assert.equal(deletedUpdate.status, 'failed');
  assert.equal(deletedUpdate.error?.code, 'APP_RESTORE_REQUIRED', 'deleted apps cannot accept source updates before restore');
  const stillDeleted = await h.service.app(deletedId, { includeHidden: true });
  assert.equal(stillDeleted.revision, 1);
  assert.equal(stillDeleted.lifecycle?.status, 'deleted');
});

test('lifecycle changes use independent source and state revisions, and restore returns offline', async t => {
  const h = await startHarness(1, 'memory://', { localManagement: true });
  t.after(() => h.close());
  const appId = await registerApp(h, 1);

  const offline = await changeLifecycle(h, appId, 'offline', 1, 1);
  assert.equal(offline.statusCode, 200);
  assert.deepEqual(offline.json(), {
    appId,
    appRevision: 1,
    lifecycle: { status: 'offline', revision: 2, updatedAt: offline.json().lifecycle.updatedAt },
  });

  const updatedManifest = { ...manifest(1), projectVersion: '1.1.0', summary: '来源版本更新后仍保持下架状态。' };
  h.gitlab.state.files.set('ai-app.json', JSON.stringify(updatedManifest));
  h.gitlab.state.files.set('docs/agent-1.md', '# 更新说明\n保留配置并验证固定版本。');
  h.gitlab.state.tagName = 'v1.1.0';
  h.gitlab.state.tagSha = SHA2;
  h.gitlab.state.releaseSha = SHA2;
  const candidate = await h.service.submit({
    projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1,
  }, TOKEN, randomUUID());
  assert.equal(candidate.status, 'preview_ready');
  const registered = await h.service.confirm(candidate.id, candidate.ticket, { revision: candidate.revision, digest: candidate.digest! });
  assert.equal(registered.status, 'registered');
  const current = await h.service.app(appId, { includeHidden: true });
  assert.equal(current.revision, 2, 'source update advances only the app revision');
  assert.deepEqual(current.lifecycle, { status: 'offline', revision: 2, updatedAt: current.lifecycle?.updatedAt });
  assert.equal((await h.app.inject({ url: `/api/apps/${appId}`, headers: requestHeaders(h.origin) })).statusCode, 404);

  const staleSource = await changeLifecycle(h, appId, 'delete', 1, 2);
  assert.equal(staleSource.statusCode, 409);
  assert.equal(staleSource.json().error.code, 'APP_REVISION_CONFLICT');
  const staleLifecycle = await changeLifecycle(h, appId, 'delete', 2, 1);
  assert.equal(staleLifecycle.statusCode, 409);
  assert.equal(staleLifecycle.json().error.code, 'LIFECYCLE_REVISION_CONFLICT');

  const deleted = await changeLifecycle(h, appId, 'delete', 2, 2);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().lifecycle.status, 'deleted');
  assert.equal(deleted.json().lifecycle.revision, 3);
  const restored = await changeLifecycle(h, appId, 'restore', 2, 3);
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().lifecycle.status, 'offline');
  assert.equal(restored.json().lifecycle.revision, 4);
  const online = await changeLifecycle(h, appId, 'online', 2, 4);
  assert.equal(online.statusCode, 200);
  assert.equal(online.json().lifecycle.status, 'published');
  assert.equal(online.json().lifecycle.revision, 5);
  assert.equal((await changeLifecycle(h, appId, 'restore', 2, 5)).statusCode, 409, 'restore is valid only for deleted apps');

  const malformed = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/lifecycle`,
    payload: { action: 'online', expectedAppRevision: 2, expectedLifecycleRevision: 5, extra: true },
    headers: requestHeaders(h.origin),
  });
  assert.equal(malformed.statusCode, 400);
  const published = (await h.app.inject({ url: `/api/apps/${appId}`, headers: requestHeaders(h.origin) })).json();
  assert.equal(published.revision, 2);
  assert.deepEqual(published.lifecycle, { status: 'published', revision: 5, updatedAt: published.lifecycle.updatedAt });
});
