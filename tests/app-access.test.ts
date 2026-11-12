import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAppAccessService, publicCatalogAppIds } from '../server/domain/app-access.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { createApp } from '../server/app.js';
import { SHA, DEFAULT_TAG, TOKEN, manifest } from './helpers/gitlab-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';
import { createPreviewAdministration } from '../server/domain/preview-administration.js';

test('visibility is applied before totals, tags, random selection and all detail reads, including with identity disabled', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const owner = await h.login('fixture-admin'), member = await h.login('fixture-member');
  const access = createAppAccessService(h.db, h.config.audience);
  const privateApp = await seedTagCatalog(h.db, h.config.audience, ['受限标签']);
  const publicApp = await seedTagCatalog(h.db, h.config.audience, ['公开标签'], 2);
  await h.db.query("UPDATE published_snapshots SET search_text='privatewordonly' WHERE id=$1", [privateApp.snapshotId]);
  await access.adopt(owner.user.id, privateApp.appId, { ownerId: owner.user.id, expectedAppRevision: 1, requestId: randomUUID() });
  await access.update(owner.user.id, privateApp.appId, { revision: 1, requestId: randomUUID(), scope: 'self', memberIds: [], groupIds: [] });
  const anonymous = await h.service.list({ pageSize: 1, sort: 'updated' });
  assert.equal(anonymous.total, 1);
  assert.equal(anonymous.items[0].id, publicApp.appId);
  assert.deepEqual(anonymous.tags, ['公开标签']);
  assert.deepEqual(await h.service.tags(), ['公开标签']);
  assert.deepEqual((await h.service.random()).items.map(item => item.id), [publicApp.appId]);
  assert.deepEqual(await publicCatalogAppIds(h.db, h.config.audience), [publicApp.appId]);
  assert.equal((await h.service.list({ viewerId: owner.user.id })).total, 2);
  assert.equal((await h.service.list({ viewerId: member.user.id })).total, 1);
  for (const path of [`/api/apps/${privateApp.appId}`, `/api/apps/${privateApp.appId}/instructions/agent`, `/api/apps/${privateApp.appId}/packages/${randomUUID()}`]) {
    assert.equal((await h.app.inject({ url: `/plaza${path}`, headers: h.headers() })).statusCode, 404);
  }
  const detail = await h.app.inject({ url: `/plaza/api/apps/${privateApp.appId}`, headers: h.headers({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-admin' }) });
  assert.equal(detail.statusCode, 200);
  assert.equal((await h.service.list({ tags: ['受限标签'] })).total, 0);
  assert.equal((await h.service.list({ query: 'privatewordonly' })).total, 0);
  assert.equal((await h.service.list({ query: 'privatewordonly', viewerId: owner.user.id })).total, 1);
  const disabled = await createApp({ ...h.config, tiangong: undefined }, h.db);
  t.after(() => disabled.app.close());
  assert.equal((await disabled.app.inject({ url: `/plaza/api/apps/${privateApp.appId}`, headers: h.headers() })).statusCode, 404);
});

test('member and current group audiences grant reading, while maintenance and delegation remain independent', async t => {
  const h = await startIdentityHarness('', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const owner = await h.login('fixture-admin'), member = await h.login('fixture-member');
  const access = createAppAccessService(h.db, h.config.audience);
  const app = await seedTagCatalog(h.db, h.config.audience, ['边界']);
  await access.adopt(owner.user.id, app.appId, { ownerId: owner.user.id, expectedAppRevision: 1, requestId: randomUUID() });
  const sharing = { revision: 1, requestId: randomUUID(), scope: 'members' as const, memberIds: [member.user.id], groupIds: [] };
  await access.update(owner.user.id, app.appId, sharing);
  assert.deepEqual(await access.update(owner.user.id, app.appId, sharing), { recovered: true });
  assert.equal((await h.service.list({ viewerId: member.user.id })).total, 1);
  assert.equal((await h.service.list({ viewerId: member.user.id, management: true, includeHidden: true })).total, 0);
  await assert.rejects(() => access.update(member.user.id, app.appId, { ...sharing, revision: 2, requestId: randomUUID(), scope: 'all', memberIds: [] }), /不可访问/);
  await access.update(owner.user.id, app.appId, { revision: 2, requestId: randomUUID(), maintainerIds: [member.user.id] });
  assert.equal((await h.service.list({ viewerId: member.user.id, management: true, includeHidden: true })).total, 1);
  await assert.rejects(() => access.update(member.user.id, app.appId, { revision: 3, requestId: randomUUID(), maintainerIds: [] }), /不可访问/);
  const groupId = randomUUID();
  await h.db.query('INSERT INTO plaza_groups(id,name) VALUES($1,$2)', [groupId, '真实本地组夹具']);
  await h.db.query('INSERT INTO plaza_group_members(group_id,user_id) VALUES($1,$2)', [groupId, member.user.id]);
  await access.update(owner.user.id, app.appId, { revision: 3, requestId: randomUUID(), scope: 'groups', memberIds: [], groupIds: [groupId] });
  assert.equal((await h.service.list({ viewerId: member.user.id })).total, 1);
  await h.db.query('DELETE FROM plaza_group_members WHERE group_id=$1', [groupId]);
  assert.equal((await h.service.list({ viewerId: member.user.id })).total, 0, 'membership is evaluated at read time');
  await assert.rejects(() => h.service.app(app.appId, { viewerId: member.user.id }), /不存在/);
  assert.equal((await h.service.app(app.appId, { viewerId: member.user.id, management: true, includeHidden: true })).id, app.appId);
  await h.db.query('UPDATE plaza_groups SET enabled=false WHERE id=$1', [groupId]);
  await access.update(owner.user.id, app.appId, { revision: 4, requestId: randomUUID(), maintainerIds: [] });
  assert.equal((await h.service.list({ viewerId: member.user.id, management: true })).total, 0, 'an inactive sharing group cannot prevent revoking maintenance');
});

test('ownership handoff requires the receiver and preserves share state, and stale acceptance cannot overwrite changed permissions', async t => {
  const h = await startIdentityHarness('', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const owner = await h.login('fixture-admin'), receiver = await h.login('fixture-member');
  const access = createAppAccessService(h.db, h.config.audience);
  const app = await seedTagCatalog(h.db, h.config.audience, ['交接']);
  await access.adopt(owner.user.id, app.appId, { ownerId: owner.user.id, expectedAppRevision: 1, requestId: randomUUID() });
  const requestId = randomUUID();
  await access.requestTransfer(owner.user.id, app.appId, { receiverId: receiver.user.id, revision: 1, requestId });
  await assert.rejects(() => access.decideTransfer(owner.user.id, requestId, { action: 'accept', requestId: randomUUID() }), /不可访问/);
  await access.update(owner.user.id, app.appId, { revision: 1, requestId: randomUUID(), scope: 'self', memberIds: [], groupIds: [] });
  await assert.rejects(() => access.decideTransfer(receiver.user.id, requestId, { action: 'accept', requestId: randomUUID() }), /变化/);
  const currentRequest = randomUUID();
  await access.requestTransfer(owner.user.id, app.appId, { receiverId: receiver.user.id, revision: 2, requestId: currentRequest });
  await access.decideTransfer(receiver.user.id, currentRequest, { action: 'accept', requestId: randomUUID() });
  const result = await access.settings(receiver.user.id, app.appId);
  assert.equal(result.owner_id, receiver.user.id); assert.equal(result.scope, 'self');
  await assert.rejects(() => access.settings(owner.user.id, app.appId), /不可访问/, 'super administrator is not an implicit private-content reader');
  assert.equal((await h.service.list({ viewerId: owner.user.id })).total, 0);
  assert.equal((await h.db.query('SELECT revision FROM catalog_apps WHERE id=$1', [app.appId])).rows[0].revision, 1, 'access changes do not manufacture a new application version');
});

test('new registration requires a live Plaza identity, defaults to self, and old source receipts cannot read or confirm private content', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const owner = await h.login('fixture-member'), other = await h.login('fixture-admin');
  const created = await h.app.inject({ method: 'POST', url: '/plaza/api/publications', headers: h.headers({ 'x-gitlab-token': TOKEN, 'idempotency-key': randomUUID() }),
    payload: { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG } });
  assert.equal(created.statusCode, 201, created.body);
  const receipt = created.json();
  assert.equal(receipt.requiresIdentity, true); assert.equal(receipt.preview, undefined); assert.equal(receipt.change, undefined);
  const raw = await h.service.publication(receipt.id, receipt.ticket, owner.user.id);
  assert.ok(raw.preview);
  const anonymousPreviews = createPreviewAdministration(h.db);
  assert.equal((await anonymousPreviews.list({ query: '', status: 'all', page: 1 })).total, 0);
  await assert.rejects(() => anonymousPreviews.detail(receipt.id), /未找到/);
  await assert.rejects(() => h.service.confirm(receipt.id, receipt.ticket, { revision: raw.revision, digest: raw.digest! }), /登录/);
  const confirmation = await h.app.inject({ method: 'POST', url: `/plaza/api/publications/${receipt.id}/confirm`,
    headers: h.headers({ authorization: `Bearer ${receipt.ticket}`, cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-member' }), payload: { revision: raw.revision, digest: raw.digest } });
  assert.equal(confirmation.statusCode, 200, confirmation.body);
  assert.equal(confirmation.json().status, 'registered', confirmation.body);
  const appId = confirmation.json().appId;
  const access = createAppAccessService(h.db, h.config.audience);
  assert.equal((await access.settings(owner.user.id, appId)).scope, 'self');
  assert.equal((await h.app.inject({ url: `/plaza/api/apps/${appId}`, headers: h.headers() })).statusCode, 404);
  const history = await h.app.inject({ url: `/plaza/api/publications/${receipt.id}`, headers: h.headers({ authorization: `Bearer ${receipt.ticket}` }) });
  assert.equal(history.json().requiresIdentity, true); assert.equal(history.json().preview, undefined); assert.equal(history.json().appId, undefined);
  assert.equal((await h.app.inject({ url: `/plaza/api/publications/${receipt.id}`, headers: h.headers({ authorization: `Bearer ${receipt.ticket}`, cookie: other.cookie, 'x-plaza-portal-token': 'fixture-admin' }) })).statusCode, 404);
  const disabled = await createApp({ ...h.config, tiangong: undefined }, h.db); t.after(() => disabled.app.close());
  const hiddenReceipt = await disabled.app.inject({ url: `/plaza/api/publications/${receipt.id}`, headers: h.headers({ authorization: `Bearer ${receipt.ticket}` }) });
  assert.equal(hiddenReceipt.json().requiresIdentity, true); assert.equal(hiddenReceipt.json().preview, undefined);
  await assert.rejects(() => disabled.service.confirm(receipt.id, receipt.ticket, { revision: raw.revision, digest: raw.digest! }), /登录/);
  // A pre-identity failed row may have no preview, app id, claim or new flag.
  // Its immutable source locator still identifies the now-private application.
  await h.db.query("UPDATE publications SET identity_required=false,status='failed',app_id=NULL,preview_jsonb=NULL,confirmed_at=NULL WHERE id=$1", [receipt.id]);
  await h.db.query('DELETE FROM plaza_publication_actors WHERE publication_id=$1', [receipt.id]);
  const legacyList = await disabled.app.inject({ url: '/plaza/api/preview-admin/publications', headers: h.headers() });
  assert.equal(legacyList.json().total, 0, legacyList.body);
  assert.equal((await disabled.app.inject({ url: `/plaza/api/preview-admin/publications/${receipt.id}`, headers: h.headers() })).statusCode, 404);
});

test('private managed updates and metadata edits retain source ownership and require current maintenance again at confirmation', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const owner = await h.login('fixture-member'), other = await h.login('fixture-admin');
  const gitlab = await startManagedGitLabFixture(); t.after(gitlab.close);
  const integrated = await createApp({ ...h.config, gitlabUrl: gitlab.url,
    managedPublishing: { token: MANAGED_GITLAB_TOKEN, groupId: '63', groupPath: 'fixture/apps' } }, h.db);
  t.after(() => integrated.app.close());
  const key = randomBytes(32).toString('base64url');
  function bundle(version: string) {
    const files = { 'ai-app.json': JSON.stringify({ ...manifest(1), projectVersion: version }),
      'docs/usage-1.md': '# 使用说明\n仅受限应用的说明。', 'docs/agent-1.md': '# 接入说明\n核对当前版本。' };
    return { appKey: 'sample-1', manifestPath: 'ai-app.json', files: Object.entries(files).map(([path, text]) => ({ path, content: Buffer.from(text).toString('base64') })) };
  }
  const first = await integrated.app.inject({ method: 'POST', url: '/plaza/api/managed-publications',
    headers: h.headers({ 'x-plaza-publish-key': key, 'idempotency-key': randomUUID() }), payload: bundle('1.0.0') });
  assert.equal(first.statusCode, 201, first.body); assert.equal(first.json().requiresIdentity, true); assert.equal(first.json().preview, undefined);
  const raw = await integrated.service.publication(first.json().id, first.json().ticket, owner.user.id);
  const registered = await integrated.service.confirm(raw.id, first.json().ticket, { revision: raw.revision, digest: raw.digest! }, owner.user.id);
  const appId = registered.appId!;
  assert.equal((await integrated.app.inject({ url: `/plaza/api/managed-apps/${first.json().managedAppId}/status`, headers: h.headers({ 'x-plaza-publish-key': key }) })).statusCode, 404);
  const update = await integrated.app.inject({ method: 'POST', url: '/plaza/api/managed-publications',
    headers: h.headers({ 'x-plaza-publish-key': key, 'idempotency-key': randomUUID() }),
    payload: { ...bundle('1.1.0'), managedAppId: first.json().managedAppId, expectedAppRevision: 1 } });
  assert.equal(update.statusCode, 201, update.body); assert.equal(update.json().status, 'preview_ready'); assert.equal(update.json().preview, undefined);
  const access = createAppAccessService(h.db, h.config.audience);
  await access.update(owner.user.id, appId, { revision: 1, requestId: randomUUID(), maintainerIds: [other.user.id] });
  const headers = h.headers({ cookie: other.cookie, 'x-plaza-portal-token': 'fixture-admin' });
  const pending = await integrated.app.inject({ url: `/plaza/api/management/publications/${update.json().id}`, headers });
  assert.equal(pending.statusCode, 200, pending.body); assert.equal(pending.json().preview.id, appId);
  const listed = await integrated.app.inject({ url: '/plaza/api/management/publications', headers });
  assert.equal(listed.json().total, 1, listed.body);
  const confirmed = await integrated.app.inject({ method: 'POST', url: `/plaza/api/management/publications/${update.json().id}/confirm`, headers,
    payload: { revision: pending.json().revision, digest: pending.json().digest } });
  assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().status, 'registered');
  const editor = await integrated.app.inject({ url: `/plaza/api/management/apps/${appId}/editor`, headers });
  assert.equal(editor.statusCode, 200, editor.body); assert.equal(editor.json().editable, true);
  const editable = editor.json().app;
  const edited = await integrated.app.inject({ method: 'POST', url: `/plaza/api/management/apps/${appId}/editor`, headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { expectedAppRevision: editable.revision, manifest: { ...editable.manifest, name: '权限维护后的资料', projectVersion: '1.1.1' }, documents: editable.documents } });
  assert.equal(edited.statusCode, 200, edited.body);
  const preview = edited.json().managementPublication;
  assert.equal(preview.preview.manifest.name, '权限维护后的资料');
  await h.db.query('INSERT INTO plaza_publication_actors(publication_id,user_id) VALUES($1,$2)', [preview.id, other.user.id]);
  await access.update(owner.user.id, appId, { revision: 2, requestId: randomUUID(), maintainerIds: [] });
  const revoked = await integrated.app.inject({ method: 'POST', url: `/plaza/api/management/publications/${preview.id}/confirm`, headers,
    payload: { revision: preview.revision, digest: preview.digest } });
  assert.equal(revoked.statusCode, 404, revoked.body);
  assert.equal((await integrated.app.inject({ url: '/plaza/api/management/publications', headers })).json().total, 0, 'an old publication claim cannot bypass current app maintenance');
  assert.equal((await integrated.service.app(appId, { viewerId: owner.user.id })).version, '1.1.0');
});

test('HTTP management and dashboard independently authenticate every caller and scope management to explicit maintainers', async t => {
  const h = await startIdentityHarness('/plaza', { superAdminAccount: 'fixture.admin', analytics: true }); t.after(h.close);
  const admin = await h.login('fixture-admin'), owner = await h.login('fixture-member');
  const app = await seedTagCatalog(h.db, h.config.audience, ['治理']);
  const headers = (who = owner, token = 'fixture-member') => h.headers({ cookie: who.cookie, 'x-plaza-portal-token': token });
  const get = (path: string, extra: Record<string, string> = headers()) => h.app.inject({ url: `/plaza${path}`, headers: extra });
  for (const path of ['/api/management/apps/------------------------------------', '/api/management/publications/------------------------------------']) {
    const malformed = await get(path, headers(admin, 'fixture-admin'));
    assert.equal(malformed.statusCode, 400, `${path} is rejected as a malformed UUID before database access`);
    assert.equal(malformed.json().error.code, 'INVALID_REQUEST');
  }
  assert.equal((await get('/api/management/apps', h.headers())).statusCode, 401);
  assert.equal((await get('/api/operations/dashboard', headers())).statusCode, 403);
  assert.equal((await get('/api/operations/dashboard', { ...headers(), 'x-plaza-role': 'super_administrator' })).statusCode, 403);
  assert.equal((await get('/api/operations/dashboard', headers(admin, 'fixture-admin'))).statusCode, 200);
  assert.equal((await get('/api/management/apps')).json().total, 0);
  assert.equal((await get(`/api/management/apps/${app.appId}`, headers(admin, 'fixture-admin'))).statusCode, 404);
  const adopted = await h.app.inject({ method: 'POST', url: `/plaza/api/access/apps/${app.appId}/adopt`, headers: headers(admin, 'fixture-admin'),
    payload: { ownerId: owner.user.id, expectedAppRevision: 1, requestId: randomUUID(), confirmed: true } });
  assert.equal(adopted.statusCode, 200, adopted.body);
  assert.equal((await get('/api/management/apps')).json().total, 1);
  assert.equal((await get('/api/management/apps', headers(admin, 'fixture-admin'))).json().total, 0);
  const editor = await get(`/api/management/apps/${app.appId}/editor`);
  assert.equal(editor.statusCode, 200, editor.body); assert.equal(editor.json().app.id, app.appId);
  const lifecycle = await h.app.inject({ method: 'POST', url: `/plaza/api/management/apps/${app.appId}/lifecycle`, headers: headers(),
    payload: { action: 'offline', expectedAppRevision: 1, expectedLifecycleRevision: 1 } });
  assert.equal(lifecycle.statusCode, 200, lifecycle.body);
  assert.equal((await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE action='lifecycle_offline' AND actor_id=$1", [owner.user.id])).rows[0].n, 1);
  h.users['fixture-admin'].enabled = false;
  assert.equal((await get('/api/operations/dashboard', headers(admin, 'fixture-admin'))).statusCode, 401);
});
