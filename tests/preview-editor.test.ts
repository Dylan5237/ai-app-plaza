import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { openDatabase } from '../server/domain/database.js';
import { DEFAULT_TAG, manifest, SHA, startGitLabFixture, TOKEN } from './helpers/gitlab-fixture.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';

function bundleFiles(version: string, extra: Array<{ path: string; text: string }> = []) {
  const appManifest = {
    ...manifest(1),
    appKey: 'preview-edit-app',
    name: '待编辑预览应用',
    summary: '初始预览简介。',
    projectVersion: version,
    docs: { readme: 'README.md', usage: 'docs/usage-1.md' },
    entries: [
      {
        id: 'agent',
        kind: 'agent',
        label: '接入我的Agent',
        instructionsPath: 'docs/agent-1.md',
        compatibility: ['Codex'],
        distribution: { type: 'source', files: ['src/runtime.js', ...extra.map(e => e.path)] },
      },
    ],
    primaryEntry: 'agent',
  };
  const files = [
    { path: 'ai-app.json', text: JSON.stringify(appManifest) },
    { path: 'README.md', text: '# 待编辑预览应用\n\n初始说明。' },
    { path: 'docs/usage-1.md', text: '# 使用说明\n\n初始使用说明。' },
    { path: 'docs/agent-1.md', text: '# Agent 接入说明\n\n核对分发包后安装。' },
    { path: 'src/runtime.js', text: 'export const versionMarker = "base-runtime";' },
    ...extra,
  ];
  return {
    appKey: 'preview-edit-app',
    manifestPath: 'ai-app.json',
    files: files.map(file => ({ path: file.path, content: Buffer.from(file.text, 'utf8').toString('base64') })),
  };
}

async function setup(t: any) {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const managedGitlab = await startManagedGitLabFixture('main');
  const integrated = await createApp({
    ...h.config,
    gitlabUrl: managedGitlab.url,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    await managedGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const other = await h.login('fixture-admin');
  const headers = (who: { cookie: string } | null, extra: Record<string, string> = {}) => h.headers({
    ...(who ? { cookie: who.cookie, 'x-plaza-portal-token': who === owner ? 'fixture-member' : 'fixture-admin' } : {}),
    ...extra,
  });

  return { h, integrated, managedGitlab, owner, other, headers };
}

test('private preview editor edits first-time managed preview, preserves code, cancels old preview, replays idempotently, and confirms edited content', async t => {
  const { h, integrated, managedGitlab, owner, other, headers } = await setup(t);

  const publishKey = randomBytes(32).toString('base64url');
  const origKey = randomUUID();
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, origKey);
  assert.equal(first.status, 'preview_ready', JSON.stringify(first));
  const oldId = first.id;
  const oldTicket = first.ticket;

  // Unauthenticated, missing ticket, wrong ticket are denied.
  assert.equal((await integrated.app.inject({ url: `/plaza/api/publications/${oldId}/editor`, headers: headers(owner) })).statusCode, 404);
  assert.equal((await integrated.app.inject({ url: `/plaza/api/publications/${oldId}/editor`, headers: headers(owner, { authorization: 'Bearer wrong-ticket' }) })).statusCode, 404);
  assert.equal((await integrated.app.inject({ url: `/plaza/api/publications/${oldId}/editor`, headers: headers(null, { authorization: `Bearer ${oldTicket}` }) })).statusCode, 401);

  const ctxRes = await integrated.app.inject({
    url: `/plaza/api/publications/${oldId}/editor`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}` }),
  });
  assert.equal(ctxRes.statusCode, 200, ctxRes.body);
  const ctx = ctxRes.json();
  assert.equal(ctx.editable, true);
  assert.equal(ctx.expectedAppRevision, 0);
  assert.equal(ctx.suggestedVersion, '1.0.1');
  assert.equal(ctx.app.manifest.name, '待编辑预览应用');

  // Version-only edit without content change is rejected before any GitLab write.
  const writesBefore = managedGitlab.state.writes.length;
  const noChange = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${oldId}/editor`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}`, 'idempotency-key': randomUUID() }),
    payload: {
      expectedAppRevision: 0,
      manifest: { ...ctx.app.manifest, projectVersion: '1.0.1' },
      documents: ctx.app.documents,
    },
  });
  assert.equal(noChange.statusCode, 400);
  assert.equal(noChange.json().error.code, 'NO_METADATA_CHANGES');
  assert.equal(managedGitlab.state.writes.length, writesBefore);

  // Real metadata edit writes back to managed GitLab and returns a new preview & ticket.
  const editedManifest = structuredClone(ctx.app.manifest);
  editedManifest.name = '预览直接编辑后的名称';
  editedManifest.summary = '在私有预览页直接保存后的新简介。';
  editedManifest.projectVersion = '1.0.1';
  const editedDocs = structuredClone(ctx.app.documents);
  editedDocs['README.md'] = '# 预览直接编辑后的名称\n\n直接编辑并保存的完整说明。';

  const editKey = randomUUID();
  const editRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${oldId}/editor`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}`, 'idempotency-key': editKey }),
    payload: { expectedAppRevision: 0, manifest: editedManifest, documents: editedDocs },
  });
  assert.equal(editRes.statusCode, 200, editRes.body);
  const editBody = editRes.json();
  assert.ok(editBody.ticket);
  assert.ok(editBody.operationId);
  assert.equal(editBody.publication.status, 'preview_ready');
  assert.notEqual(editBody.publication.id, oldId);
  assert.equal(editBody.publication.preview.version, '1.0.1');
  assert.equal(editBody.publication.preview.manifest.name, '预览直接编辑后的名称');
  assert.equal(editBody.publication.preview.documents['README.md'], editedDocs['README.md']);

  // Old preview is cancelled so pending list does not duplicate.
  const oldRow = (await h.db.query('SELECT status FROM publications WHERE id = $1', [oldId])).rows[0];
  assert.equal(oldRow.status, 'cancelled');

  // Same Idempotency-Key replays cleanly even though oldId is now cancelled.
  const writesAfterEdit = managedGitlab.state.writes.length;
  const replay = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${oldId}/editor`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}`, 'idempotency-key': editKey }),
    payload: { expectedAppRevision: 0, manifest: editedManifest, documents: editedDocs },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().publication.id, editBody.publication.id);
  assert.equal(replay.json().ticket, editBody.ticket);
  assert.equal(managedGitlab.state.writes.length, writesAfterEdit);

  // A different Idempotency-Key against the cancelled old preview is rejected.
  const staleOld = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${oldId}/editor`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: { ...editedManifest, projectVersion: '1.0.2' }, documents: editedDocs },
  });
  assert.equal(staleOld.statusCode, 409);

  // Another user cannot read/edit the new preview via management or private route.
  assert.equal((await integrated.app.inject({
    url: `/plaza/api/management/publications/${editBody.publication.id}/editor`,
    headers: headers(other),
  })).statusCode, 404);
  assert.equal((await integrated.app.inject({
    url: `/plaza/api/publications/${editBody.publication.id}/editor`,
    headers: headers(other, { authorization: `Bearer ${editBody.ticket}` }),
  })).statusCode, 404);

  // Original receipt reflects the superseding preview before confirmation, and transitions to registered after confirmation.
  const supersededBeforeConfirm = await integrated.managed!.receipt(publishKey, origKey);
  if (supersededBeforeConfirm.status === 'recovery_required') throw new Error('expected active receipt before confirmation');
  assert.equal(supersededBeforeConfirm.id, editBody.publication.id);
  assert.equal(supersededBeforeConfirm.status, 'preview_ready');
  assert.equal(supersededBeforeConfirm.superseded, true);
  assert.equal(supersededBeforeConfirm.originalPublicationId, oldId);
  assert.equal(supersededBeforeConfirm.originalStatus, 'cancelled');

  // Confirm the edited preview and verify live catalog app reflects edited content + retained runtime.js.
  const confirmRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${editBody.publication.id}/confirm`,
    headers: headers(owner, { authorization: `Bearer ${editBody.ticket}` }),
    payload: { revision: editBody.publication.revision, digest: editBody.publication.digest },
  });
  assert.equal(confirmRes.statusCode, 200, confirmRes.body);
  const confirmed = confirmRes.json();
  assert.equal(confirmed.status, 'registered');

  // Calling original managed receipt + HTTP receipt endpoint recovers as `registered` instead of stuck `cancelled`.
  const recovered = await integrated.managed!.receipt(publishKey, origKey);
  if (recovered.status === 'recovery_required') throw new Error('expected recovered registered receipt');
  assert.equal(recovered.status, 'registered');
  assert.equal(recovered.id, editBody.publication.id);
  assert.equal(recovered.superseded, true);
  assert.equal(recovered.originalPublicationId, oldId);
  const httpReceipt = await integrated.app.inject({
    url: '/plaza/api/managed-publications/receipt',
    headers: h.headers({ 'x-plaza-publish-key': publishKey, 'idempotency-key': origKey }),
  });
  assert.equal(httpReceipt.statusCode, 200, httpReceipt.body);
  assert.equal(httpReceipt.json().status, 'registered');
  assert.equal(httpReceipt.json().superseded, true);

  // Superseded old preview cannot be confirmed anymore.
  const staleConfirm = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${oldId}/confirm`,
    headers: headers(owner, { authorization: `Bearer ${oldTicket}` }),
    payload: { revision: first.revision, digest: first.digest },
  });
  assert.equal(staleConfirm.statusCode, 409);
  const live = await integrated.service.app(confirmed.appId, { viewerId: owner.user.id });
  assert.equal(live.version, '1.0.1');
  assert.equal(live.manifest.name, '预览直接编辑后的名称');
  assert.equal(live.manifest.summary, '在私有预览页直接保存后的新简介。');
  assert.equal(live.documents['README.md'], editedDocs['README.md']);
  assert.ok(live.distributions![0].files.some(f => f.path === 'src/runtime.js'));
});

test('editing an update preview overlays on top of the pending update commit and management editor hides tickets', async t => {
  const { h, integrated, managedGitlab, owner, other, headers } = await setup(t);

  const publishKey = randomBytes(32).toString('base64url');
  const v1 = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  const v1View = await integrated.service.publication(v1.id, v1.ticket, owner.user.id);
  const reg1 = await integrated.service.confirm(v1.id, v1.ticket, { revision: v1View.revision, digest: v1View.digest! }, owner.user.id);
  const appId = reg1.appId!;

  // Delegate maintainer permission to `other`.
  await createAppAccessService(h.db, h.config.audience).update(owner.user.id, appId, {
    revision: 1, requestId: randomUUID(), maintainerIds: [other.user.id],
  });

  // Upload v1.1.0 with a brand new source file `src/v11-feature.js`.
  const v11 = await integrated.managed!.submit({
    ...bundleFiles('1.1.0', [{ path: 'src/v11-feature.js', text: 'export const feature = "v1.1.0-only";' }]),
    managedAppId: v1.managedAppId,
    expectedAppRevision: 1,
  }, publishKey, randomUUID());
  assert.equal(v11.status, 'preview_ready');
  const v11CommitSha = v11.preview!.source.commitSha;

  // Maintainer opens management preview editor for v1.1.0 (never returns ticket).
  const mgmtCtx = await integrated.app.inject({
    url: `/plaza/api/management/publications/${v11.id}/editor`,
    headers: headers(other),
  });
  assert.equal(mgmtCtx.statusCode, 200, mgmtCtx.body);
  assert.equal(mgmtCtx.json().editable, true);
  assert.equal(mgmtCtx.json().expectedAppRevision, 1);
  assert.equal(mgmtCtx.json().suggestedVersion, '1.1.1');
  assert.equal('ticket' in mgmtCtx.json(), false);

  const editedManifest = structuredClone(mgmtCtx.json().app.manifest);
  editedManifest.name = '更新预览二次编辑名称';
  editedManifest.summary = '基于 v1.1.0 预览直接修订的摘要。';
  editedManifest.projectVersion = '1.1.1';
  const editedDocs = structuredClone(mgmtCtx.json().app.documents);
  editedDocs['docs/usage-1.md'] = '# 使用说明 v1.1.1\n\n包含更新预览修订内容。';

  const mgmtEdit = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/management/publications/${v11.id}/editor`,
    headers: headers(other, { 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 1, manifest: editedManifest, documents: editedDocs },
  });
  assert.equal(mgmtEdit.statusCode, 200, mgmtEdit.body);
  const mgmtEditBody = mgmtEdit.json();
  assert.equal('ticket' in mgmtEditBody, false, 'management endpoint must never expose private tickets');
  assert.equal('previewUrl' in mgmtEditBody, false);
  const newPub = mgmtEditBody.managementPublication;
  assert.equal(newPub.status, 'preview_ready');
  assert.equal(newPub.preview.version, '1.1.1');

  // Verify the v1.1.1 commit was built on top of v1.1.0 (not v1.0.0!) and retains src/v11-feature.js.
  const opRow = (await h.db.query('SELECT base_commit_sha FROM managed_publish_operations WHERE id = $1', [mgmtEditBody.operationId])).rows[0];
  assert.equal(opRow.base_commit_sha, v11CommitSha);
  const project = managedGitlab.state.projects.get(Number(newPub.preview.source.projectId))!;
  const commitFiles = project.commits.get(newPub.preview.source.commitSha)!.files;
  assert.equal(Buffer.from(commitFiles.get('src/v11-feature.js')!).toString('utf8'), 'export const feature = "v1.1.0-only";');
  assert.equal(Buffer.from(commitFiles.get('src/runtime.js')!).toString('utf8'), 'export const versionMarker = "base-runtime";');

  // Confirm via management endpoint and verify live catalog contains both v1.1.0 code and edited metadata.
  const confirmUpdate = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/management/publications/${newPub.id}/confirm`,
    headers: headers(other),
    payload: { revision: newPub.revision, digest: newPub.digest },
  });
  assert.equal(confirmUpdate.statusCode, 200, confirmUpdate.body);
  const updatedLive = await integrated.service.app(appId, { viewerId: owner.user.id });
  assert.equal(updatedLive.version, '1.1.1');
  assert.equal(updatedLive.manifest.name, '更新预览二次编辑名称');
  assert.equal(updatedLive.documents['docs/usage-1.md'], '# 使用说明 v1.1.1\n\n包含更新预览修订内容。');
  assert.ok(updatedLive.distributions![0].files.some(f => f.path === 'src/v11-feature.js'));
});

test('non-managed direct GitLab preview returns editable: false from preview editor', async t => {
  const { h, integrated, owner, headers } = await setup(t);
  // Direct GitLab publication on h.service (using read-only GitLab fixture from h).
  const direct = await h.service.submit({
    projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG,
  }, TOKEN, randomUUID());
  assert.equal(direct.status, 'preview_ready');

  const res = await integrated.app.inject({
    url: `/plaza/api/publications/${direct.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${direct.ticket}` }),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().editable, false);
  assert.match(res.json().reason, /托管/);
});

test('preview editor refuses Agent distribution changes and conflicts if confirm has started', async t => {
  const { h, integrated, managedGitlab, owner, headers } = await setup(t);

  const publishKey = randomBytes(32).toString('base64url');
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');
  const writesBefore = managedGitlab.state.writes.length;

  await integrated.app.inject({
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}` }),
  });

  // 1) Attempting to widen distribution.files via metadata editor is rejected before GitLab writes.
  const ctx = (await integrated.app.inject({
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}` }),
  })).json();
  const tampered = structuredClone(ctx.app.manifest);
  tampered.projectVersion = '1.0.1';
  tampered.entries[0].distribution.files = ['src/runtime.js', 'README.md'];
  const tamperRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: tampered, documents: ctx.app.documents },
  });
  assert.equal(tamperRes.statusCode, 400);
  assert.equal(tamperRes.json().error.code, 'EDITOR_IDENTITY_IMMUTABLE');
  assert.equal(managedGitlab.state.writes.length, writesBefore);

  // 2) Once confirmation has started (confirmed_at is set), editing that preview fails cleanly and preserves old preview.
  await h.db.query('UPDATE publications SET confirmed_at = now() WHERE id = $1', [first.id]);
  const blockedCtx = await integrated.app.inject({
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}` }),
  });
  assert.equal(blockedCtx.statusCode, 200);
  assert.equal(blockedCtx.json().editable, false);

  const validEdit = structuredClone(ctx.app.manifest);
  validEdit.name = '确认竞争期间不允许替代';
  validEdit.projectVersion = '1.0.1';
  const conflictEdit = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: validEdit, documents: ctx.app.documents },
  });
  assert.equal(conflictEdit.statusCode, 409);
  assert.equal(conflictEdit.json().error.code, 'PUBLICATION_STATE_CONFLICT');
  const oldAfter = (await h.db.query('SELECT status, superseded_by_publication_id FROM publications WHERE id = $1', [first.id])).rows[0];
  assert.equal(oldAfter.status, 'preview_ready');
  assert.equal(oldAfter.superseded_by_publication_id, null);
});

test('transient failure on edited preview supersedes old preview and binds actor upon retry', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const managedGitlab = await startManagedGitLabFixture('main');
  let armedFailAfterRelease = false;
  let failNextTreeOnce = false;
  const targetUrl = new URL(managedGitlab.url);
  const proxy = createServer((req, res) => {
    if (armedFailAfterRelease && req.method === 'POST' && req.url?.includes('/releases')) {
      armedFailAfterRelease = false;
      failNextTreeOnce = true;
    } else if (failNextTreeOnce && req.method === 'GET' && req.url?.includes('/repository/tree')) {
      failNextTreeOnce = false;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'transient tree read failure' }));
      return;
    }
    const upstreamReq = httpRequest(new URL(req.url!, targetUrl), {
      method: req.method,
      headers: req.headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', err => {
      res.writeHead(502);
      res.end(String(err));
    });
    req.pipe(upstreamReq);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const integrated = await createApp({
    ...h.config,
    gitlabUrl: proxyUrl,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await managedGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const headers = (extra: Record<string, string> = {}) => h.headers({
    cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-member', ...extra,
  });

  const publishKey = randomBytes(32).toString('base64url');
  const origKey = randomUUID();
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, origKey);
  assert.equal(first.status, 'preview_ready', JSON.stringify(first));

  const ctx = (await integrated.app.inject({
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers({ authorization: `Bearer ${first.ticket}` }),
  })).json();
  const edited = structuredClone(ctx.app.manifest);
  edited.name = '瞬时失败重试后修订';
  edited.projectVersion = '1.0.1';

  // Fail source tree inspection once after v1.0.1 release creation when submit() evaluates the new commit -> returns failed/retry new candidate.
  armedFailAfterRelease = true;
  const editRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers({ authorization: `Bearer ${first.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: edited, documents: ctx.app.documents },
  });
  assert.equal(editRes.statusCode, 200, editRes.body);
  const failedNew = editRes.json().publication;
  assert.equal(failedNew.status, 'failed');
  assert.equal(failedNew.nextAction, 'retry');

  // Old preview remains preview_ready until retry succeeds, and owner can access/retry the failed new candidate.
  const oldBeforeRetry = (await h.db.query('SELECT status, superseded_by_publication_id FROM publications WHERE id = $1', [first.id])).rows[0];
  assert.equal(oldBeforeRetry.status, 'preview_ready');
  assert.equal(oldBeforeRetry.superseded_by_publication_id, null);

  const retried = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${failedNew.id}/retry`,
    headers: headers({ authorization: `Bearer ${editRes.json().ticket}` }),
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().status, 'preview_ready');

  const oldAfterRetry = (await h.db.query('SELECT status, superseded_by_publication_id FROM publications WHERE id = $1', [first.id])).rows[0];
  assert.equal(oldAfterRetry.status, 'cancelled');
  assert.equal(oldAfterRetry.superseded_by_publication_id, failedNew.id);

  // Confirm retried preview and confirm original CLI receipt recovers to `registered`.
  const confirmRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${failedNew.id}/confirm`,
    headers: headers({ authorization: `Bearer ${editRes.json().ticket}` }),
    payload: { revision: retried.json().revision, digest: retried.json().digest },
  });
  assert.equal(confirmRes.statusCode, 200, confirmRes.body);
  assert.equal(confirmRes.json().status, 'registered');
  assert.equal((await integrated.managed!.receipt(publishKey, origKey)).status, 'registered');
});

test('management editor enforces decoded maintenance auth on encoded paths, recovers interrupted operation links, and returns REVISION_CONFLICT on stale previews', async t => {
  const { h, integrated, owner, other, headers } = await setup(t);

  // 1) Percent-encoded UUID path in /api/management/publications/:id/editor cannot bypass requirePublicationMaintenance.
  const publishKey = randomBytes(32).toString('base64url');
  const unclaimed = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(unclaimed.status, 'preview_ready');
  const encodedId = unclaimed.id.slice(0, 2).split('').map(c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('') + unclaimed.id.slice(2);
  const bypassGet = await integrated.app.inject({
    url: `/plaza/api/management/publications/${encodedId}/editor`,
    headers: headers(other),
  });
  assert.equal(bypassGet.statusCode, 404);
  const bypassPost = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/management/publications/${encodedId}/editor`,
    headers: headers(other, { 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: unclaimed.preview!.manifest, documents: unclaimed.preview!.documents },
  });
  assert.equal(bypassPost.statusCode, 404);

  // 2) Simulated crash before managed_publish_operations.publication_id is backfilled still finds managed source via publications.managed_operation_id.
  await h.db.query('UPDATE managed_publish_operations SET publication_id = NULL WHERE publication_id = $1', [unclaimed.id]);
  const recoveredEditorCtx = await integrated.app.inject({
    url: `/plaza/api/publications/${unclaimed.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${unclaimed.ticket}` }),
  });
  assert.equal(recoveredEditorCtx.statusCode, 200, recoveredEditorCtx.body);
  assert.equal(recoveredEditorCtx.json().editable, true);

  // Restore link cleanly and confirm v1.0.0 -> rev 1.
  const opIdRow = (await h.db.query('SELECT managed_operation_id FROM publications WHERE id = $1', [unclaimed.id])).rows[0];
  assert.ok(opIdRow.managed_operation_id);
  await h.db.query('UPDATE managed_publish_operations SET publication_id = $1 WHERE id = $2', [unclaimed.id, opIdRow.managed_operation_id]);
  const confirmV1 = await integrated.service.confirm(unclaimed.id, unclaimed.ticket, { revision: 1, digest: unclaimed.digest! }, owner.user.id);
  const appId = confirmV1.appId!;

  // 3) Create v1.1.0 and v1.2.0 candidates; confirm v1.2.0 first so v1.1.0 becomes revision-stale while still preview_ready -> edit must return 409 REVISION_CONFLICT.
  const v11 = await integrated.managed!.submit({ ...bundleFiles('1.1.0'), managedAppId: unclaimed.managedAppId, expectedAppRevision: 1 }, publishKey, randomUUID());
  const v12 = await integrated.managed!.submit({ ...bundleFiles('1.2.0'), managedAppId: unclaimed.managedAppId, expectedAppRevision: 1 }, publishKey, randomUUID());
  await integrated.service.confirm(v12.id, v12.ticket, { revision: 1, digest: v12.digest! }, owner.user.id);

  const staleManifest = structuredClone(v11.preview!.manifest);
  staleManifest.name = '并发修订冲突后的命名';
  staleManifest.projectVersion = '1.2.1';
  const staleRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${v11.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${v11.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 1, manifest: staleManifest, documents: v11.preview!.documents },
  });
  assert.equal(staleRes.statusCode, 409);
  assert.equal(staleRes.json().error.code, 'REVISION_CONFLICT');
  void appId;
});

test('non-identity non-management instances disable private preview editing', async t => {
  const db = await openDatabase({ path: 'memory://' });
  const managedGitlab = await startManagedGitLabFixture('main');
  let appToClose: { close(): Promise<void> } | undefined;
  t.after(async () => {
    if (appToClose) await appToClose.close();
    await managedGitlab.close();
    await db.close();
  });
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as AddressInfo).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const integrated = await createApp({
    host: '127.0.0.1',
    port,
    publicOrigin: origin,
    gitlabUrl: managedGitlab.url,
    secret: 'non-identity-editor-test-secret-00000',
    dataDir: '',
    staticDir: resolve('dist'),
    rateLimit: false,
    audience: '内部同事',
    local: true,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, db);
  appToClose = integrated.app;

  const publishKey = randomBytes(32).toString('base64url');
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');
  const headers = { host: new URL(origin).host, origin, authorization: `Bearer ${first.ticket}` };

  const getCtx = await integrated.app.inject({ url: `/api/publications/${first.id}/editor`, headers });
  assert.equal(getCtx.statusCode, 200, getCtx.body);
  assert.equal(getCtx.json().editable, false);

  const writesBefore = managedGitlab.state.writes.length;
  const postEdit = await integrated.app.inject({
    method: 'POST',
    url: `/api/publications/${first.id}/editor`,
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: {
      expectedAppRevision: 0,
      manifest: { ...first.preview!.manifest, name: '不应被匿名票据修改', projectVersion: '1.0.1' },
      documents: first.preview!.documents,
    },
  });
  assert.equal(postEdit.statusCode, 403);
  assert.equal(postEdit.json().error.code, 'EDITOR_AUTH_REQUIRED');
  assert.equal(managedGitlab.state.writes.length, writesBefore);
});

test('revoking maintainer mid-edit aborts superseding in preparePreview without cancelling old preview', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const managedGitlab = await startManagedGitLabFixture('main');
  let onReleaseCreated: (() => Promise<void>) | null = null;
  const targetUrl = new URL(managedGitlab.url);
  const proxy = createServer((req, res) => {
    const upstreamReq = httpRequest(new URL(req.url!, targetUrl), {
      method: req.method,
      headers: req.headers,
    }, upstreamRes => {
      const finalize = async () => {
        if (onReleaseCreated && req.method === 'POST' && req.url?.includes('/releases')) {
          const hook = onReleaseCreated;
          onReleaseCreated = null;
          await hook();
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        res.end(Buffer.concat(chunks));
      };
      const chunks: Buffer[] = [];
      upstreamRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
      upstreamRes.on('end', () => { void finalize(); });
    });
    upstreamReq.on('error', err => {
      res.writeHead(502);
      res.end(String(err));
    });
    req.pipe(upstreamReq);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const integrated = await createApp({
    ...h.config,
    gitlabUrl: proxyUrl,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await managedGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const maintainer = await h.login('fixture-admin');
  const access = createAppAccessService(h.db, h.config.audience);
  const publishKey = randomBytes(32).toString('base64url');
  const v1 = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  const reg1 = await integrated.service.confirm(v1.id, v1.ticket, { revision: 1, digest: v1.digest! }, owner.user.id);
  const appId = reg1.appId!;
  await access.update(owner.user.id, appId, { revision: 1, requestId: randomUUID(), maintainerIds: [maintainer.user.id] });

  const v11 = await integrated.managed!.submit({ ...bundleFiles('1.1.0'), managedAppId: v1.managedAppId, expectedAppRevision: 1 }, publishKey, randomUUID());
  assert.equal(v11.status, 'preview_ready');

  // Revoke maintainer right after GitLab commit/release finish, before preparePreview() runs.
  onReleaseCreated = async () => {
    await access.update(owner.user.id, appId, { revision: 2, requestId: randomUUID(), maintainerIds: [] });
  };

  const edited = structuredClone(v11.preview!.manifest);
  edited.name = '权限撤销后禁止替代';
  edited.projectVersion = '1.1.1';
  const revokedRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/management/publications/${v11.id}/editor`,
    headers: h.headers({ cookie: maintainer.cookie, 'x-plaza-portal-token': 'fixture-admin', 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 1, manifest: edited, documents: v11.preview!.documents },
  });
  assert.equal(revokedRes.statusCode, 404);
  const v11After = (await h.db.query('SELECT status, superseded_by_publication_id FROM publications WHERE id = $1', [v11.id])).rows[0];
  assert.equal(v11After.status, 'preview_ready');
  assert.equal(v11After.superseded_by_publication_id, null);
});

test('replaying interrupted managed submission preserves original publication_id across multiple retries after preview edit', async t => {
  const { h, integrated, owner, headers } = await setup(t);

  const publishKey = randomBytes(32).toString('base64url');
  const origKey = randomUUID();
  const bundle = bundleFiles('1.0.0');
  const first = await integrated.managed!.submit(bundle, publishKey, origKey);
  assert.equal(first.status, 'preview_ready');

  const opRowBefore = (await h.db.query('SELECT id FROM managed_publish_operations WHERE publication_id = $1', [first.id])).rows[0];
  // Simulate crash right before operation row recorded publication_id and submitted status.
  await h.db.query("UPDATE managed_publish_operations SET status = 'release_ready', publication_id = NULL WHERE id = $1", [opRowBefore.id]);

  // Edit the original preview (found via publications.managed_operation_id).
  const edited = structuredClone(first.preview!.manifest);
  edited.name = '中断操作后被编辑替代';
  edited.projectVersion = '1.0.1';
  const editRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${first.id}/editor`,
    headers: headers(owner, { authorization: `Bearer ${first.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: edited, documents: first.preview!.documents },
  });
  assert.equal(editRes.statusCode, 200, editRes.body);
  const editedPubId = editRes.json().publication.id;

  // Replay original submission twice: both must return editedPubId AND persist original first.id on operation row.
  const replay1 = await integrated.managed!.submit(bundle, publishKey, origKey);
  assert.equal(replay1.id, editedPubId);
  assert.equal(replay1.superseded, true);
  assert.equal(replay1.originalPublicationId, first.id);

  const opAfterReplay1 = (await h.db.query('SELECT status, publication_id FROM managed_publish_operations WHERE id = $1', [opRowBefore.id])).rows[0];
  assert.equal(opAfterReplay1.status, 'submitted');
  assert.equal(opAfterReplay1.publication_id, first.id);

  const replay2 = await integrated.managed!.submit(bundle, publishKey, origKey);
  assert.equal(replay2.id, editedPubId);
  assert.equal(replay2.superseded, true);
  assert.equal(replay2.originalPublicationId, first.id);
});

test('transient GitLab 403 during edit returns retryable candidate + ticket on initial save and replay', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const managedGitlab = await startManagedGitLabFixture('main');
  let blockGitLabReads = false;
  let blockAfterRelease = false;
  const targetUrl = new URL(managedGitlab.url);
  const proxy = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (blockGitLabReads && req.method === 'GET' && /^\/api\/v4\/projects\/\d+$/.test(pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '403 Forbidden (simulated transient GitLab read error)' }));
      return;
    }
    const upstreamReq = httpRequest(new URL(req.url!, targetUrl), {
      method: req.method,
      headers: req.headers,
    }, upstreamRes => {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
      upstreamRes.on('end', () => {
        if (blockAfterRelease && req.method === 'POST' && req.url?.includes('/releases')) {
          blockAfterRelease = false;
          blockGitLabReads = true;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        res.end(Buffer.concat(chunks));
      });
    });
    upstreamReq.on('error', err => {
      res.writeHead(502);
      res.end(String(err));
    });
    req.pipe(upstreamReq);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const integrated = await createApp({
    ...h.config,
    gitlabUrl: proxyUrl,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await managedGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const publishKey = randomBytes(32).toString('base64url');
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');

  blockAfterRelease = true;
  const editKey = randomUUID();
  const edited = structuredClone(first.preview!.manifest);
  edited.name = 'GitLab 403 可重试候选';
  edited.projectVersion = '1.0.1';
  const payload = { expectedAppRevision: 0, manifest: edited, documents: first.preview!.documents };
  const editHeaders = h.headers({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-member', authorization: `Bearer ${first.ticket}`, 'idempotency-key': editKey });

  const firstRes = await integrated.app.inject({ method: 'POST', url: `/plaza/api/publications/${first.id}/editor`, headers: editHeaders, payload });
  assert.equal(firstRes.statusCode, 200, firstRes.body);
  const firstBody = firstRes.json();
  assert.equal(firstBody.publication.status, 'failed');
  assert.equal(firstBody.publication.nextAction, 'retry');
  assert.equal(firstBody.publication.error.code, 'PERMISSION_DENIED');
  assert.ok(firstBody.ticket);

  // Replay with same Idempotency-Key also returns the retryable candidate + ticket instead of throwing 403.
  const replayRes = await integrated.app.inject({ method: 'POST', url: `/plaza/api/publications/${first.id}/editor`, headers: editHeaders, payload });
  assert.equal(replayRes.statusCode, 200, replayRes.body);
  assert.equal(replayRes.json().publication.id, firstBody.publication.id);
  assert.equal(replayRes.json().publication.nextAction, 'retry');
  assert.equal(replayRes.json().ticket, firstBody.ticket);

  // Once GitLab permission recovers, retrying the returned candidate transitions to preview_ready and supersedes first.
  blockGitLabReads = false;
  const retryRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${firstBody.publication.id}/retry`,
    headers: h.headers({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-member', authorization: `Bearer ${firstBody.ticket}` }),
    payload: {},
  });
  assert.equal(retryRes.statusCode, 200, retryRes.body);
  assert.equal(retryRes.json().status, 'preview_ready');
  assert.equal(retryRes.json().preview.manifest.name, 'GitLab 403 可重试候选');
});

test('replaying unfinished metadata edit checks preview mutability before GitLab writes', async t => {
  const { h, integrated, owner, managedGitlab, headers } = await setup(t);
  const publishKey = randomBytes(32).toString('base64url');
  const first = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(first.status, 'preview_ready');

  // Record an unfinished metadata_patch operation in commit_ready state, then confirm first preview.
  const editKey = randomUUID();
  const edited = structuredClone(first.preview!.manifest);
  edited.name = '未完成重放冲突检查';
  edited.projectVersion = '1.0.1';
  const payload = { expectedAppRevision: 0, manifest: edited, documents: first.preview!.documents };
  const editHeaders = headers(owner, { authorization: `Bearer ${first.ticket}`, 'idempotency-key': editKey });

  const editRes = await integrated.app.inject({ method: 'POST', url: `/plaza/api/publications/${first.id}/editor`, headers: editHeaders, payload });
  assert.equal(editRes.statusCode, 200, editRes.body);
  const editedId = editRes.json().publication.id;
  // Reset operation back to 'commit_ready' AND revert supersession/cancellation on first so we can confirm first.
  await h.db.query("UPDATE managed_publish_operations SET status = 'commit_ready', publication_id = NULL WHERE publication_id = $1", [editedId]);
  await h.db.query("UPDATE publications SET status = 'cancelled', superseded_by_publication_id = NULL WHERE id = $1", [editedId]);
  await h.db.query("UPDATE publications SET status = 'preview_ready', next_action = 'confirm', superseded_by_publication_id = NULL WHERE id = $1", [first.id]);
  await integrated.service.confirm(first.id, first.ticket, { revision: 1, digest: first.digest! }, owner.user.id);

  const writesBefore = managedGitlab.state.writes.length;
  const conflictReplay = await integrated.app.inject({ method: 'POST', url: `/plaza/api/publications/${first.id}/editor`, headers: editHeaders, payload });
  assert.equal(conflictReplay.statusCode, 409, conflictReplay.body);
  assert.equal(conflictReplay.json().error.code, 'PUBLICATION_STATE_CONFLICT');
  assert.equal(managedGitlab.state.writes.length, writesBefore, 'must not write tags/releases to GitLab when original preview is already confirmed');
});

test('preview edit before first confirmation keeps initial candidate_app_id and classifies subsequent updates as update', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin', analytics: true });
  const managedGitlab = await startManagedGitLabFixture('main');
  const integrated = await createApp({
    ...h.config,
    gitlabUrl: managedGitlab.url,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' },
  }, h.db);
  t.after(async () => {
    await integrated.app.close();
    await managedGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const publishKey = randomBytes(32).toString('base64url');
  const v1 = await integrated.managed!.submit(bundleFiles('1.0.0'), publishKey, randomUUID());
  assert.equal(v1.status, 'preview_ready');

  const edited = structuredClone(v1.preview!.manifest);
  edited.name = '首版预览修订后再更新';
  edited.projectVersion = '1.0.1';
  const editRes = await integrated.app.inject({
    method: 'POST',
    url: `/plaza/api/publications/${v1.id}/editor`,
    headers: h.headers({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-member', authorization: `Bearer ${v1.ticket}`, 'idempotency-key': randomUUID() }),
    payload: { expectedAppRevision: 0, manifest: edited, documents: v1.preview!.documents },
  });
  assert.equal(editRes.statusCode, 200, editRes.body);
  const editedPub = editRes.json().publication;
  assert.equal(editedPub.preview.id, v1.preview!.id, 'editing unconfirmed preview reuses candidate_app_id');

  const reg = await integrated.service.confirm(editedPub.id, editRes.json().ticket, { revision: 1, digest: editedPub.digest }, owner.user.id);
  const bindingRow = (await h.db.query<{ public_app_id: string }>('SELECT public_app_id FROM managed_app_bindings WHERE id = $1', [v1.managedAppId])).rows[0];
  assert.equal(reg.appId, bindingRow.public_app_id, 'binding public_app_id matches registered catalog_apps.id');

  const v2 = await integrated.managed!.submit({ ...bundleFiles('1.2.0'), managedAppId: v1.managedAppId, expectedAppRevision: 1 }, publishKey, randomUUID());
  assert.equal(v2.status, 'preview_ready');

  const opRows = (await h.db.query<{ tag: string; analytics_journal: any[] }>('SELECT tag, analytics_journal FROM managed_publish_operations ORDER BY created_at')).rows;
  const kinds = opRows.map(row => ({
    tag: row.tag,
    kind: row.analytics_journal.find((ev: any) => ev.eventName === 'publish_operation_received')?.publishKind,
  }));
  assert.deepEqual(kinds, [
    { tag: 'v1.0.0', kind: 'new' },
    { tag: 'v1.0.1', kind: 'metadata_edit' },
    { tag: 'v1.2.0', kind: 'update' },
  ]);
});

test('direct GitLab submit still rejects expired registered receipt while managed recovery allows history', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' });
  const directGitlab = await startGitLabFixture(1);
  const integrated = await createApp({ ...h.config, gitlabUrl: directGitlab.url }, h.db);
  t.after(async () => {
    await integrated.app.close();
    await directGitlab.close();
    await h.close();
  });

  const owner = await h.login('fixture-member');
  const idemKey = randomUUID();
  const submitInput = { projectId: '1', appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
  const sub = await integrated.service.submit(submitInput, TOKEN, idemKey);
  await integrated.service.confirm(sub.id, sub.ticket, { revision: 1, digest: sub.digest! }, owner.user.id);

  await h.db.query("UPDATE publications SET expires_at = now() - interval '1 hour' WHERE id = $1", [sub.id]);
  await assert.rejects(
    () => integrated.service.submit(submitInput, TOKEN, idemKey),
    (err: any) => err?.statusCode === 410 && err?.code === 'PUBLICATION_EXPIRED',
  );
  const managedRecovered = await integrated.service.managedReceipt(sub.id, submitInput);
  assert.equal(managedRecovered.status, 'registered');
});
