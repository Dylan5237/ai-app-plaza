import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { tiangongConfig, parsePortalIdentity } from '../server/domain/tiangong-identity.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { openDatabase } from '../server/domain/database.js';
import { createIdentityService } from '../server/domain/identity.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const env = { TIANGONG_AUTH_ENABLED: 'true', TIANGONG_USERINFO_URL: 'https://portal.example.invalid/findByToken',
  TIANGONG_SUCCESS_CODE: '00000000', TIANGONG_TOKEN_STORAGE_KEY: 'sky-token' };

test('Tiangong config is explicit and cannot silently accept unsafe or partial configuration', () => {
  assert.equal(tiangongConfig({}), undefined);
  for (const patch of [ { TIANGONG_AUTH_ENABLED: '1' }, { TIANGONG_TOKEN_STORAGE_KEY: '' }, { TIANGONG_SUCCESS_CODE: '' },
    { TIANGONG_USERINFO_URL: 'http://public.example.invalid/findByToken' }, { TIANGONG_USERINFO_URL: 'https://user:secret@portal.example.invalid/findByToken' },
    { TIANGONG_USERINFO_URL: 'https://portal.example.invalid/findByToken?token=hidden' }, { PLAZA_IDENTITY_ADMIN_SUBJECTS: 'admin' },
    { TIANGONG_WEB_SESSION_HOURS: '25' }, { TIANGONG_ALLOWED_USER_TYPES: '03,' }]) assert.throws(() => tiangongConfig({ ...env, ...patch }));
  assert.ok(tiangongConfig({ ...env, TIANGONG_USERINFO_URL: 'http://192.168.5.143/findByToken', TIANGONG_ALLOW_INTRANET_HTTP: 'true' }));
  assert.throws(() => tiangongConfig({ ...env, TIANGONG_USERINFO_URL: 'http://3232236943/findByToken', TIANGONG_ALLOW_INTRANET_HTTP: 'true' }));
});

test('portal contract preserves long numeric IDs and rejects disabled, ambiguous, duplicate and anonymous data', () => {
  const cfg = tiangongConfig(env)!;
  const text = '{"code":"00000000","data":{"userId":9223372036854775807,"tenantId":null,"enabled":true,"isAnonymous":false,"userTypeCode":"03","userName":"测试用户"}}';
  assert.deepEqual(parsePortalIdentity(text, cfg), { subject: '9223372036854775807', tenantId: null, name: '测试用户' });
  for (const changed of [text.replace('9223372036854775807', '9223372036854775808'), text.replace('9223372036854775807', '1e3'),
    text.replace('"enabled":true', '"enabled":false'), text.replace('"isAnonymous":false', '"isAnonymous":true'),
    text.replace('"isAnonymous":false', '"isAnonymous":false,"anonymous":true'), text.replace('"isAnonymous":false,', ''),
    text.replace('"tenantId":null,', ''), text.replace('"userTypeCode":"03"', '"userTypeCode":"03","userType":"01"'),
    text.replace('"enabled":true', '"enabled":true,"enabled":false'), text.replace('"enabled":true', '"enabled":true,"mockLogin":true'),
    text.replace('"userName":"测试用户"', '"userName":null'),
    '{"code":"00000000","data":null}', '{"code":"00000000","data":{}}']) assert.throws(() => parsePortalIdentity(changed, cfg));
});

test('browser-bound login, replay protection, stable identity, explicit switching and no credential persistence', async t => {
  const h = await startIdentityHarness('/plaza'); t.after(h.close);
  const status = await h.app.inject({ url: '/plaza/api/auth/tiangong/status', headers: h.headers() });
  assert.equal(status.json().tokenStorage.key, 'fixture-sky-token');
  assert.equal((await h.app.inject({ url: '/plaza/api/preview-admin/publications', headers: h.headers() })).statusCode, 404, 'identity mode closes legacy anonymous preview management');
  const contract = await h.app.inject({ url: '/plaza/api/publish-contract', headers: h.headers() });
  assert.ok(contract.body.includes(`${h.origin}/plaza/api/publications`));
  const noOrigin = await h.app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/requests', headers: { host: new URL(h.origin).host }, payload: {} });
  assert.equal(noOrigin.statusCode, 403);
  const challenge = await h.app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/requests', headers: h.headers(), payload: {} });
  const body = { requestId: challenge.json().requestId, token: 'fixture-admin' };
  const exchange = (cookie?: string) => h.app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/exchange', headers: h.headers(cookie ? { cookie } : {}), payload: body });
  assert.equal((await exchange()).statusCode, 409);
  const challengeCookie = String(challenge.headers['set-cookie']).split(';')[0];
  const signedIn = await exchange(challengeCookie);
  assert.equal(signedIn.statusCode, 200);
  assert.equal(signedIn.json().user.subject, '9223372036854775807');
  assert.equal(signedIn.json().user.identityAdmin, true);
  assert.match(String(signedIn.headers['set-cookie']), /Path=\/plaza; HttpOnly; SameSite=Strict/);
  assert.equal((await exchange(challengeCookie)).statusCode, 409);
  const firstCookie = String(signedIn.headers['set-cookie']).split(';')[0];
  h.users['fixture-admin'].tenantId = '42';
  const again = await h.login('fixture-admin', firstCookie);
  assert.equal(again.user.id, signedIn.json().user.id);
  const mismatch = await h.login('fixture-member', again.cookie);
  assert.equal(mismatch.response.statusCode, 409);
  assert.equal(mismatch.response.json().error.code, 'ACCOUNT_SWITCH_REQUIRED');
  const switched = await h.login('fixture-member', again.cookie, true);
  assert.equal(switched.user.identityAdmin, false);
  const old = await h.app.inject({ url: '/plaza/api/auth/me', headers: h.headers({ cookie: again.cookie, 'x-plaza-portal-token': 'fixture-admin' }) });
  assert.equal(old.statusCode, 401);
  const persisted = JSON.stringify((await h.db.query('SELECT * FROM plaza_identities')).rows) + JSON.stringify((await h.db.query('SELECT * FROM plaza_sessions')).rows);
  assert.ok(!persisted.includes('fixture-admin'));
  assert.ok(!persisted.includes(again.cookie.split('=')[1]));
  const logout = await h.app.inject({ method: 'POST', url: '/plaza/api/auth/logout', headers: h.headers({ cookie: switched.cookie }), payload: {} });
  assert.equal(logout.statusCode, 200);
  assert.equal((await h.app.inject({ url: '/plaza/api/auth/me', headers: h.headers({ cookie: switched.cookie, 'x-plaza-portal-token': 'fixture-member' }) })).statusCode, 401);
});

test('local groups require a separately authorized identity administrator and retain revisioned operation evidence', async t => {
  const h = await startIdentityHarness(); t.after(h.close);
  const admin = await h.login('fixture-admin'), member = await h.login('fixture-member');
  const request = (method: any, url: string, cookie: string, token: string, payload?: any) => h.app.inject({ method, url, headers: h.headers({ cookie, 'x-plaza-portal-token': token }), payload });
  assert.equal((await request('GET', '/api/identity/groups', member.cookie, 'fixture-member')).statusCode, 403);
  assert.equal((await h.app.inject({ url: '/api/identity/users', headers: h.headers() })).statusCode, 401);
  const input = { name: '测试协作小组', enabled: true, members: [member.user.id], confirmed: true };
  const createInput = { ...input, requestId: randomUUID() };
  const created = await request('POST', '/api/identity/groups', admin.cookie, 'fixture-admin', createInput);
  assert.equal(created.statusCode, 201, created.body);
  const group = created.json();
  const retried = await request('POST', '/api/identity/groups', admin.cookie, 'fixture-admin', createInput);
  assert.equal(retried.json().id, group.id);
  assert.equal((await request('POST', '/api/identity/groups', admin.cookie, 'fixture-admin', { ...createInput, name: '不同请求' })).statusCode, 409);
  assert.deepEqual(group.members, [member.user.id]);
  assert.equal((await request('GET', '/api/identity/groups', member.cookie, 'fixture-member')).statusCode, 403, 'group membership grants no admin role');
  const updated = await request('PUT', `/api/identity/groups/${group.id}`, admin.cookie, 'fixture-admin', { ...input, members: [], revision: 1 });
  assert.equal(updated.json().revision, 2);
  assert.equal((await request('PUT', `/api/identity/groups/${group.id}`, admin.cookie, 'fixture-admin', { ...input, revision: 1 })).statusCode, 409);
  assert.equal((await request('POST', '/api/identity/groups', admin.cookie, 'fixture-admin', { ...createInput, requestId: randomUUID(), members: [randomUUID()] })).statusCode, 400);
  const logs = (await h.db.query('SELECT * FROM plaza_identity_operations ORDER BY created_at,id')).rows;
  assert.equal(logs.length, 2); assert.equal(logs[1].actor_id, admin.user.id);
  assert.deepEqual(logs[1].before_value.members, [member.user.id]); assert.deepEqual(logs[1].after_value.members, []);
  h.users['fixture-admin'].enabled = false;
  assert.equal((await request('GET', '/api/identity/groups', admin.cookie, 'fixture-admin')).statusCode, 401);
  assert.equal((await request('POST', '/api/identity/groups', admin.cookie, 'fixture-admin', input)).statusCode, 401);
  h.portalState.unavailable = true;
  assert.equal((await request('GET', '/api/identity/groups', admin.cookie, 'fixture-admin')).statusCode, 503, 'outage is not a permission denial');
  h.portalState.unavailable = false; h.portalState.redirect = true;
  assert.equal((await request('GET', '/api/identity/groups', admin.cookie, 'fixture-admin')).statusCode, 503, 'portal redirects are not followed');
  assert.equal((await h.db.query('SELECT count(*) AS n FROM plaza_groups')).rows[0].n, 1);
});

test('local users, groups, sessions and favorites survive a database restart without rewriting existing catalog data', async t => {
  const h = await startIdentityHarness(); t.after(h.close);
  const directory = await mkdtemp(join(tmpdir(), 'plaza-identity-persistence-'));
  let db = await openDatabase({ path: directory });
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const app = await seedTagCatalog(db, h.config.audience, ['原有标签']);
  const first = await createIdentityService(db, h.config.tiangong);
  const challenge = await first.challenge();
  const signedIn = await first.login({ ...challenge, token: 'fixture-admin', switchAccount: false });
  const group = await first.saveGroup(signedIn.user, { requestId: randomUUID(), name: '持久化小组', enabled: true, members: [signedIn.user.id] });
  await first.saveFavorite(signedIn.user, app.appId, true, h.config.audience);
  await db.close();
  db = await openDatabase({ path: directory });
  const restored = await createIdentityService(db, h.config.tiangong);
  const user = await restored.authenticate(signedIn.credential, 'fixture-admin');
  assert.equal(user.id, signedIn.user.id);
  assert.equal((await restored.groups(user))[0].id, group.id);
  assert.deepEqual(await restored.favoriteIds(user), [app.appId]);
  const catalog = (await db.query('SELECT revision,current_snapshot_id FROM catalog_apps WHERE id=$1', [app.appId])).rows[0];
  assert.deepEqual(catalog, { revision: 1, current_snapshot_id: app.snapshotId });
  assert.equal((await db.query('SELECT count(*) AS n FROM published_snapshots')).rows[0].n, 1);
});
