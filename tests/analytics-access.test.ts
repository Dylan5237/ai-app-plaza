import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('application analytics require the current public or authorized browsing scope', async t => {
  const { startIdentityHarness } = await import('./helpers/identity-fixture.js');
  const h = await startIdentityHarness('/plaza', { analytics: true }); t.after(h.close);
  const owner = await h.login('fixture-admin'), member = await h.login('fixture-member');
  const target = await seedTagCatalog(h.db, h.config.audience, ['受限统计标签']);
  await h.db.query("INSERT INTO plaza_app_access(app_id,owner_id,scope) VALUES($1,$2,'self')", [target.appId, owner.user.id]);
  const entry = target.source.entries.find(item => item.kind === 'web')!;
  const send = (extra: Record<string, string> = {}) => h.app.inject({ method: 'POST', url: '/plaza/api/analytics/events', headers: h.headers(extra), payload: {
    eventId: randomUUID(), eventName: 'app_entry_clicked', occurredAt: new Date().toISOString(), identityScope: 'session_only', visitorId: null,
    sessionId: randomUUID(), viewId: randomUUID(), interactionId: randomUUID(), appId: target.appId, snapshotId: target.snapshotId,
    attributes: { pageContext: 'catalog', entryMode: 'catalog', entryId: entry.id, entryKind: 'web', placement: 'card' },
  } });
  const memberHeaders = { cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' };
  const counts = async () => [
    Number((await h.db.query('SELECT count(*) AS n FROM analytics_events WHERE app_id=$1', [target.appId])).rows[0].n),
    Number((await h.db.query('SELECT COALESCE(sum(total),0) AS n FROM analytics_usage_counts WHERE app_id=$1', [target.appId])).rows[0].n),
  ];
  assert.equal((await send()).statusCode, 404);
  assert.equal((await send(memberHeaders)).statusCode, 404);
  assert.equal((await send({ 'x-plaza-role': 'super_administrator', cookie: owner.cookie })).statusCode, 404, 'a cookie or asserted role does not grant an anonymous event access');
  assert.deepEqual(await counts(), [0, 0], 'rejected events persist no private metadata or usage');
  assert.equal((await send({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-admin' })).statusCode, 200);
  await h.db.query("UPDATE plaza_app_access SET scope='members',member_ids=$2::uuid[] WHERE app_id=$1", [target.appId, [member.user.id]]);
  assert.equal((await send(memberHeaders)).statusCode, 200);
  assert.equal((await send()).statusCode, 404);
  assert.deepEqual(await counts(), [2, 2]);
  const groupId = randomUUID();
  await h.db.query('INSERT INTO plaza_groups(id,name) VALUES($1,$2)', [groupId, '统计授权测试组']);
  await h.db.query('INSERT INTO plaza_group_members(group_id,user_id) VALUES($1,$2)', [groupId, member.user.id]);
  await h.db.query("UPDATE plaza_app_access SET scope='groups',member_ids='{}',group_ids=$2::uuid[] WHERE app_id=$1", [target.appId, [groupId]]);
  assert.equal((await send(memberHeaders)).statusCode, 200);
  await h.db.query('DELETE FROM plaza_group_members WHERE group_id=$1', [groupId]);
  assert.equal((await send(memberHeaders)).statusCode, 404, 'current group membership is rechecked');
  assert.deepEqual(await counts(), [3, 3]);
  await h.db.query("UPDATE plaza_app_access SET scope='all',group_ids='{}' WHERE app_id=$1", [target.appId]);
  assert.equal((await send()).statusCode, 200, 'public app events remain anonymously accepted');
  assert.deepEqual(await counts(), [4, 4]);
});

