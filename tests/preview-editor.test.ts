import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { DEFAULT_TAG, manifest, SHA, TOKEN } from './helpers/gitlab-fixture.js';
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
