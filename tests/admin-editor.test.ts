import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { openDatabase } from '../server/domain/database.js';
import { DomainError } from '../server/domain/errors.js';
import { createManagedPublisher } from '../server/domain/managed-publisher.js';
import { createService } from '../server/domain/service.js';
import type { Config } from '../server/config.js';
import { registerManagementEditor } from '../server/management-editor.js';
import { manifest } from './helpers/gitlab-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const SECRET = 'admin-editor-test-secret-with-at-least-32-bytes';
const AUDIENCE = '测试内网';

function makeBundle(version = '1.0.0', extraFiles: Array<{ path: string; text: string }> = []) {
  const appManifest = {
    ...manifest(1),
    appKey: 'sample-1',
    projectVersion: version,
    docs: { readme: 'README.md', usage: 'docs/usage-1.md' },
  };
  const files = [
    { path: 'ai-app.json', text: JSON.stringify(appManifest) },
    { path: 'README.md', text: '# 文档助手\n\n用于管理编辑器验证。' },
    { path: 'docs/usage-1.md', text: '# 使用说明\n\n初始版本内容。' },
    { path: 'docs/agent-1.md', text: '# Agent 接入说明\n\n核对环境和授权后执行最小验证。' },
    ...extraFiles,
  ];
  return {
    appKey: 'sample-1',
    manifestPath: 'ai-app.json',
    files: files.map(({ path, text }) => ({ path, content: Buffer.from(text, 'utf8').toString('base64') })),
  };
}

async function harness() {
  const db = await openDatabase({ path: 'memory://' });
  const gitlab = await startManagedGitLabFixture();
  const service = createService({ db, gitlabUrl: gitlab.url, publicOrigin: 'http://127.0.0.1:4173', secret: SECRET, audience: AUDIENCE });
  const managed = createManagedPublisher({ db, gitlabUrl: gitlab.url, gitlabToken: MANAGED_GITLAB_TOKEN, groupId: '63', secret: SECRET, service });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '请求字段不符合规范。' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '请求未完成。' } });
  });
  const config = { localManagement: true } as Config;
  registerManagementEditor(app, config, db, service, managed);
  await app.ready();
  return {
    db, gitlab, service, managed, app,
    close: async () => { await app.close(); await db.close(); await gitlab.close(); },
  };
}

function postBody(app: any, expectedAppRevision: number, projectVersion: string, name = '管理编辑后的名称') {
  const manifestValue = structuredClone(app.manifest);
  manifestValue.name = name;
  manifestValue.summary = '资料已由本地管理编辑器修订。';
  manifestValue.projectVersion = projectVersion;
  const documents = structuredClone(app.documents);
  documents['README.md'] = '# 文档助手\n\n管理编辑器更新了说明。';
  return { expectedAppRevision, manifest: manifestValue, documents };
}

test('local editor overlays only current metadata, preserves source history, and replays one preview', async t => {
  const h = await harness();
  t.after(() => h.close());

  const publishKey = randomBytes(32).toString('base64url');
  const first = await h.managed.submit(makeBundle('1.0.0', [
    { path: 'src/runtime.js', text: 'export const runtime = "keep";' },
    { path: 'assets/brand.txt', text: 'historical source retained' },
  ]), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');
  const appId = first.preview!.id;
  await h.service.managementConfirm(first.id, { revision: first.revision, digest: first.digest! });
  const registered = await h.service.app(appId, { includeHidden: true });
  assert.equal(registered.revision, 1);
  const oldCommit = registered.source.commitSha;
  const project = h.gitlab.state.projects.get(100)!;
  const oldTagSha = project.tags.get('v1.0.0');
  assert.equal(oldTagSha, oldCommit);

  const pending = await h.managed.submit({
    ...makeBundle('1.1.0'), managedAppId: first.managedAppId, expectedAppRevision: 1,
  }, publishKey, randomUUID());
  assert.equal(pending.status, 'preview_ready');
  const pendingTagSha = project.tags.get('v1.1.0');
  assert.ok(pendingTagSha);
  assert.equal((await h.service.app(appId)).version, '1.0.0', 'pending candidate must not change the catalog');

  const editorUrl = `/api/management/apps/${appId}/editor`;
  const editorResponse = await h.app.inject({ method: 'GET', url: editorUrl });
  assert.equal(editorResponse.statusCode, 200);
  const context = editorResponse.json();
  assert.equal(context.editable, true);
  assert.equal(context.suggestedVersion, '1.1.1', 'suggestion must advance beyond the pending 1.1.0 candidate');
  assert.equal(context.app.id, appId);
  assert.equal('ticket' in context, false);
  assert.equal('publishKey' in context, false);

  const body = postBody(context.app, 1, context.suggestedVersion);
  const writesBeforeRejectedEdits = h.gitlab.state.writes.length;
  const noChange = await h.app.inject({ method: 'POST', url: editorUrl, headers: { 'idempotency-key': randomUUID() }, payload: {
    expectedAppRevision: context.app.revision, manifest: { ...context.app.manifest, projectVersion: context.suggestedVersion }, documents: context.app.documents,
  } });
  assert.equal(noChange.statusCode, 400);
  assert.equal(noChange.json().error.code, 'NO_METADATA_CHANGES');
  assert.equal(h.gitlab.state.writes.length, writesBeforeRejectedEdits, 'version-only saves must not create any GitLab writes');
  const olderThanPending = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/editor`, headers: { 'idempotency-key': randomUUID() },
    payload: postBody(context.app, 1, '1.0.2'),
  });
  assert.equal(olderThanPending.statusCode, 409);
  assert.equal(olderThanPending.json().error.code, 'VERSION_NOT_NEWER');

  const secretContent = structuredClone(body);
  secretContent.documents['README.md'] = '# 说明\n\nPRIVATE-TOKEN=fixture-secret-value-12345';
  const secretRejected = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/editor`, headers: { 'idempotency-key': randomUUID() }, payload: secretContent,
  });
  assert.equal(secretRejected.statusCode, 400);
  assert.equal(secretRejected.json().error.code, 'VALIDATION_FAILED');

  const pathMutation = structuredClone(body);
  pathMutation.manifest.docs.usage = 'docs/new-usage.md';
  pathMutation.documents['docs/new-usage.md'] = pathMutation.documents['docs/usage-1.md'];
  delete pathMutation.documents['docs/usage-1.md'];
  const pathRejected = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/editor`, headers: { 'idempotency-key': randomUUID() }, payload: pathMutation,
  });
  assert.equal(pathRejected.statusCode, 400);
  assert.equal(pathRejected.json().error.code, 'EDITOR_IDENTITY_IMMUTABLE');
  const malformedEntry = structuredClone(body);
  malformedEntry.manifest.entries = [null];
  const malformedRejected = await h.app.inject({
    method: 'POST', url: editorUrl, headers: { 'idempotency-key': randomUUID() }, payload: malformedEntry,
  });
  assert.equal(malformedRejected.statusCode, 400);
  assert.equal(malformedRejected.json().error.code, 'VALIDATION_FAILED');
  assert.equal(h.gitlab.state.writes.length, writesBeforeRejectedEdits, 'invalid version, secret, and path edits fail before any GitLab write');

  const idempotencyKey = randomUUID();
  const originalTree = project.commits.get(oldCommit)!.files;
  const beforeWrites = h.gitlab.state.writes.length;
  const beforeCommitCount = h.gitlab.state.commitCreateCount;
  h.gitlab.state.dropNextCommitResponse = true;
  const firstEdit = await h.app.inject({ method: 'POST', url: editorUrl, headers: { 'idempotency-key': idempotencyKey }, payload: body });
  assert.equal(firstEdit.statusCode, 200, firstEdit.body);
  const editResult = firstEdit.json();
  assert.equal(editResult.managementPublication.status, 'preview_ready');
  assert.ok(editResult.operationId);
  assert.equal('ticket' in editResult, false);
  assert.equal('previewUrl' in editResult, false);
  assert.equal('managedAppId' in editResult, false);
  assert.equal(h.gitlab.state.commitCreateCount, beforeCommitCount + 1, 'a lost commit response must be recovered by GitLab readback');

  const newTagSha = project.tags.get('v1.1.1');
  assert.ok(newTagSha);
  const editedTree = project.commits.get(newTagSha)!.files;
  assert.deepEqual([...editedTree.keys()].sort(), [...originalTree.keys()].sort(), 'metadata editing must not create or remove source files');
  const touchedPaths = new Set(['ai-app.json', 'README.md']);
  for (const [path, content] of originalTree) {
    if (touchedPaths.has(path)) continue;
    assert.deepEqual(editedTree.get(path), content, `untouched GitLab blob must remain byte-identical: ${path}`);
  }
  assert.equal(Buffer.from(editedTree.get('src/runtime.js')!).toString('utf8'), 'export const runtime = "keep";');
  assert.equal(project.tags.get('v1.0.0'), oldTagSha, 'historical version tag remains immutable');
  assert.equal(project.tags.get('v1.1.0'), pendingTagSha, 'an earlier candidate tag remains immutable');
  const beforeConfirm = await h.service.app(appId);
  assert.equal(beforeConfirm.version, '1.0.0');
  assert.equal(beforeConfirm.revision, 1);

  const writesAfterPreview = h.gitlab.state.writes.length;
  const replay = await h.app.inject({ method: 'POST', url: editorUrl, headers: { 'idempotency-key': idempotencyKey }, payload: body });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().managementPublication.id, editResult.managementPublication.id);
  assert.equal(replay.json().operationId, editResult.operationId);
  assert.equal(h.gitlab.state.writes.length, writesAfterPreview, 'same key and payload must return the original preview without GitLab writes');

  const changedPayload = structuredClone(body);
  changedPayload.manifest.summary = '同一个幂等键不能提交不同内容。';
  const conflict = await h.app.inject({ method: 'POST', url: editorUrl, headers: { 'idempotency-key': idempotencyKey }, payload: changedPayload });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.gitlab.state.writes.length, writesAfterPreview);

  const confirmed = await h.service.managementConfirm(editResult.managementPublication.id, {
    revision: editResult.managementPublication.revision,
    digest: editResult.managementPublication.digest,
  });
  assert.equal(confirmed.status, 'registered');
  const afterConfirm = await h.service.app(appId);
  assert.equal(afterConfirm.version, '1.1.1');
  assert.equal(afterConfirm.revision, 2);

  const staleBody = postBody(afterConfirm, 1, '1.1.2');
  const writesBeforeStale = h.gitlab.state.writes.length;
  const stale = await h.app.inject({ method: 'POST', url: editorUrl, headers: { 'idempotency-key': randomUUID() }, payload: staleBody });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'REVISION_CONFLICT');
  assert.equal(h.gitlab.state.writes.length, writesBeforeStale, 'stale compare-and-swap must fail before GitLab writes');
}
);

test('editor follows the canonical catalog app when the first managed preview was never confirmed', async t => {
  const h = await harness();
  t.after(() => h.close());

  const publishKey = randomBytes(32).toString('base64url');
  const first = await h.managed.submit(makeBundle('1.0.0'), publishKey, randomUUID());
  const firstCandidateId = first.preview!.id;
  const registeredCandidate = await h.managed.submit({
    ...makeBundle('1.0.1'),
    managedAppId: first.managedAppId,
    expectedAppRevision: 0,
  }, publishKey, randomUUID());
  assert.notEqual(registeredCandidate.preview!.id, firstCandidateId);
  const confirmed = await h.service.managementConfirm(registeredCandidate.id, {
    revision: registeredCandidate.revision,
    digest: registeredCandidate.digest!,
  });
  assert.equal(confirmed.status, 'registered');

  const current = await h.service.app(registeredCandidate.preview!.id, { includeHidden: true });
  const binding = (await h.db.query<{ public_app_id: string }>(
    'SELECT public_app_id FROM managed_app_bindings WHERE id = $1', [first.managedAppId],
  )).rows[0]!;
  assert.equal(binding.public_app_id, firstCandidateId, 'binding retains its first candidate id');
  assert.equal(current.id, registeredCandidate.preview!.id, 'catalog identity follows the confirmed later candidate');

  const contextResponse = await h.app.inject({ method: 'GET', url: `/api/management/apps/${current.id}/editor` });
  assert.equal(contextResponse.statusCode, 200);
  assert.equal(contextResponse.json().editable, true);
  assert.equal(contextResponse.json().app.id, current.id);
  const body = postBody(contextResponse.json().app, current.revision, contextResponse.json().suggestedVersion);
  const edit = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${current.id}/editor`,
    headers: { 'idempotency-key': randomUUID() }, payload: body,
  });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().managementPublication.status, 'preview_ready');
});

test('editor explains non-managed and missing-key records, allows offline updates, and rejects deleted apps', async t => {
  const h = await harness();
  t.after(() => h.close());

  const nonManaged = await seedTagCatalog(h.db, AUDIENCE, ['文档处理'], 8);
  const noBinding = await h.app.inject({ method: 'GET', url: `/api/management/apps/${nonManaged.appId}/editor` });
  assert.equal(noBinding.statusCode, 200);
  assert.equal(noBinding.json().editable, false);
  assert.match(noBinding.json().reason, /没有对应的托管 GitLab 绑定/);
  const nonManagedPost = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${nonManaged.appId}/editor`, headers: { 'idempotency-key': randomUUID() },
    payload: { expectedAppRevision: 1, manifest: nonManaged.source, documents: { [nonManaged.source.docs.readme]: '# readme' } },
  });
  assert.equal(nonManagedPost.statusCode, 409);
  assert.equal(nonManagedPost.json().error.code, 'MANAGED_EDITOR_UNAVAILABLE');

  const missingKey = await seedTagCatalog(h.db, AUDIENCE, ['文档处理'], 9);
  await h.db.query('UPDATE catalog_apps SET instance_id = $1 WHERE id = $2', [h.gitlab.url, missingKey.appId]);
  await h.db.query(
    `INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, project_id, public_app_id, created_at, updated_at)
     VALUES ($1, $2, '', $3, $4, now(), now())`,
    [randomUUID(), missingKey.source.appKey, '9', missingKey.appId],
  );
  const missingKeyGet = await h.app.inject({ method: 'GET', url: `/api/management/apps/${missingKey.appId}/editor` });
  assert.equal(missingKeyGet.statusCode, 200);
  assert.equal(missingKeyGet.json().editable, false);
  assert.match(missingKeyGet.json().reason, /缺少可验证的服务端密钥/);
  const missingKeyPost = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${missingKey.appId}/editor`, headers: { 'idempotency-key': randomUUID() },
    payload: { expectedAppRevision: 1, manifest: missingKey.source, documents: { [missingKey.source.docs.readme]: '# readme' } },
  });
  assert.equal(missingKeyPost.statusCode, 409);
  assert.equal(missingKeyPost.json().error.code, 'MANAGED_KEY_MISSING');

  const key = randomBytes(32).toString('base64url');
  const first = await h.managed.submit(makeBundle(), key, randomUUID());
  const appId = first.preview!.id;
  await h.service.managementConfirm(first.id, { revision: first.revision, digest: first.digest! });
  await h.db.query(
    `INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at)
     VALUES ($1, 'offline', 2, now())`,
    [appId],
  );
  const offlineContext = await h.app.inject({ method: 'GET', url: `/api/management/apps/${appId}/editor` });
  assert.equal(offlineContext.statusCode, 200);
  assert.equal(offlineContext.json().editable, true);
  assert.equal(offlineContext.json().app.lifecycle.status, 'offline');
  const offlineBody = postBody(offlineContext.json().app, 1, '1.0.1');
  const offlineEdit = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/editor`, headers: { 'idempotency-key': randomUUID() }, payload: offlineBody,
  });
  assert.equal(offlineEdit.statusCode, 200, offlineEdit.body);
  assert.equal(offlineEdit.json().managementPublication.status, 'preview_ready');

  await h.db.query("UPDATE catalog_app_lifecycle SET status = 'deleted', revision = revision + 1, updated_at = now() WHERE app_id = $1", [appId]);
  const deletedContext = await h.app.inject({ method: 'GET', url: `/api/management/apps/${appId}/editor` });
  assert.equal(deletedContext.statusCode, 200);
  assert.equal(deletedContext.json().editable, false);
  assert.match(deletedContext.json().reason, /应用已删除/);
  const writesBeforeDeletePost = h.gitlab.state.writes.length;
  const deletedPost = await h.app.inject({
    method: 'POST', url: `/api/management/apps/${appId}/editor`, headers: { 'idempotency-key': randomUUID() },
    payload: postBody(deletedContext.json().app, 1, '1.0.2'),
  });
  assert.equal(deletedPost.statusCode, 409);
  assert.equal(deletedPost.json().error.code, 'APP_DELETED');
  assert.equal(h.gitlab.state.writes.length, writesBeforeDeletePost);
});

test('management editor routes are absent when local management is disabled', async t => {
  const db = await openDatabase({ path: 'memory://' });
  const gitlab = await startManagedGitLabFixture();
  const service = createService({ db, gitlabUrl: gitlab.url, publicOrigin: 'http://127.0.0.1:4173', secret: SECRET, audience: AUDIENCE });
  const managed = createManagedPublisher({ db, gitlabUrl: gitlab.url, gitlabToken: MANAGED_GITLAB_TOKEN, groupId: '63', secret: SECRET, service });
  const app = Fastify({ logger: false });
  registerManagementEditor(app, { localManagement: false } as Config, db, service, managed);
  await app.ready();
  t.after(async () => { await app.close(); await db.close(); await gitlab.close(); });
  const response = await app.inject({ method: 'GET', url: `/api/management/apps/${randomUUID()}/editor` });
  assert.equal(response.statusCode, 404);
});
