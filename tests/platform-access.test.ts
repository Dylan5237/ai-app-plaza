import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { administratorUsers, setAdministrator } from '../server/domain/platform-access.js';

test('only an explicitly configured, server-verified account bootstraps once to a pinned stable subject', async t => {
  const h = await startIdentityHarness('', { superAdminAccount: 'fixture.member' }); t.after(h.close);
  const roster = await h.login('fixture-admin');
  assert.equal(roster.user.identityAdmin, true);
  assert.equal(roster.user.administrator, false, 'roster administration does not grant dashboard access');
  const member = await h.login('fixture-member');
  assert.equal(member.response.statusCode, 200);
  assert.equal(member.user.superAdministrator, true);
  assert.equal(member.user.identityAdmin, true);
  const repeated = await h.login('fixture-member');
  assert.equal(repeated.user.id, member.user.id);
  assert.equal((await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE action='super_administrator_bound'")).rows[0].n, 1);
  h.users['fixture-member'].userId = '9223372036854775805';
  const conflicting = await h.login('fixture-member');
  assert.equal(conflicting.response.statusCode, 409);
  assert.equal(conflicting.response.json().error.code, 'BOOTSTRAP_IDENTITY_CONFLICT');
  assert.equal((await h.db.query('SELECT count(*) AS n FROM plaza_platform_roles')).rows[0].n, 1);
});

test('platform roles require super-administrator authority, reject stale writes and protect the last super administrator', async t => {
  const h = await startIdentityHarness('', { superAdminAccount: 'fixture.admin' }); t.after(h.close);
  const admin = await h.login('fixture-admin');
  const member = await h.login('fixture-member');
  const input = { userId: member.user.id, role: 'administrator' as const, revision: 0, requestId: randomUUID() };
  await assert.rejects(() => administratorUsers(h.db, member.user.id), /管理员/);
  await assert.rejects(() => setAdministrator(h.db, member.user.id, input), /管理员/);
  await setAdministrator(h.db, admin.user.id, input);
  assert.deepEqual(await setAdministrator(h.db, admin.user.id, input), { recovered: true });
  const me = await h.app.inject({ url: '/api/auth/me', headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }) });
  assert.equal(me.json().user.administrator, true);
  assert.equal(me.json().user.superAdministrator, false);
  await assert.rejects(() => setAdministrator(h.db, admin.user.id, { ...input, requestId: randomUUID(), role: 'member' }), /变化/);
  await setAdministrator(h.db, admin.user.id, { ...input, requestId: randomUUID(), revision: 1, role: 'member' });
  await assert.rejects(() => setAdministrator(h.db, admin.user.id, { ...input, requestId: randomUUID() }), /变化/, 'revocation retains the revision instead of returning to revision zero');
  await assert.rejects(() => setAdministrator(h.db, admin.user.id, { ...input, userId: admin.user.id, requestId: randomUUID(), revision: 1, role: 'member' }), /最后一人/);
  h.users['fixture-admin'].enabled = false;
  const stopped = await h.app.inject({ url: '/api/auth/me', headers: h.headers({ cookie: admin.cookie, 'x-plaza-portal-token': 'fixture-admin' }) });
  assert.equal(stopped.statusCode, 401, 'a local super-admin role never bypasses portal revocation');
});
