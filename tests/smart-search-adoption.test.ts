import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { setAdministrator } from '../server/domain/platform-access.js';
import { authorAppStats } from '../server/domain/author-stats.js';

async function setup(t: any) {
  const h = await startIdentityHarness('', { analytics: true, superAdminAccount: 'fixture.admin' });
  t.after(h.close);
  const admin = await h.login('fixture-admin');
  const member = await h.login('fixture-member');
  const seeded = await seedTagCatalog(h.db, h.config.audience, ['测试'], 70);
  const manifest = { ...seeded.source, name: '作者数据测试应用', summary: '用于作者统计回归。' };
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [seeded.snapshotId, JSON.stringify(manifest), '作者 数据 测试']);
  const access = createAppAccessService(h.db, h.config.audience);
  await access.adopt(admin.user.id, seeded.appId, { ownerId: admin.user.id, expectedAppRevision: 1, requestId: randomUUID() });
  return { h, admin, member, seeded, settings: h.config.analytics! };
}

test('demand registrations accept anonymous submissions and gate administration', async t => {
  const { h, admin, member } = await setup(t);
  const anonymous = await h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers(), payload: { description: '帮我汇总每周门诊量\u0001并出图' } });
  assert.equal(anonymous.statusCode, 200);
  const id = anonymous.json().id;
  const authenticated = await h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }), payload: { description: '想要一个合同审查助手' } });
  assert.equal(authenticated.statusCode, 200);

  assert.equal((await h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers(), payload: { description: '' } })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers(), payload: { description: 'x'.repeat(201) } })).statusCode, 400);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers(), payload: { description: '描述', extra: 1 } })).statusCode, 400);

  assert.equal((await h.app.inject({ method: 'GET', url: '/api/access/smart-search-requests', headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }) })).statusCode, 403);
  await setAdministrator(h.db, admin.user.id, { userId: member.user.id, role: 'administrator', revision: 0, requestId: randomUUID() });
  const listed = await h.app.inject({ method: 'GET', url: '/api/access/smart-search-requests', headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }) });
  assert.equal(listed.statusCode, 200);
  const items = listed.json().items;
  assert.equal(items.length, 2);
  assert.equal(items.find((item: any) => item.id === id).description, '帮我汇总每周门诊量并出图', 'control characters are stripped on store');
  assert.equal(items.find((item: any) => item.id === id).submitter, null);
  assert.equal(items.find((item: any) => item.id !== id).submitter, '测试普通成员', 'authenticated submissions carry the identity name');

  const requestId = randomUUID();
  const resolve = (body: object) => h.app.inject({ method: 'PUT', url: `/api/access/smart-search-requests/${id}`, headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }), payload: { requestId, confirmed: true, ...body } });
  assert.equal((await resolve({ status: 'done' })).statusCode, 200);
  assert.equal((await resolve({ status: 'done' })).json().recovered, true, 'replays are idempotent');
  assert.equal((await resolve({ status: 'open' })).statusCode, 409, 'the same request id cannot carry a different change');
  const reopened = await h.app.inject({ method: 'PUT', url: `/api/access/smart-search-requests/${id}`, headers: h.headers({ cookie: member.cookie, 'x-plaza-portal-token': 'fixture-member' }), payload: { requestId: randomUUID(), confirmed: true, status: 'open' } });
  assert.equal(reopened.statusCode, 200);
  const audit = (await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE action='smart_search_request_updated'")).rows[0].n;
  assert.equal(Number(audit), 2, 'resolve and reopen are audited');
});

test('demand registration is rate-limited per client so the admin list cannot be flooded', async t => {
  const h = await startIdentityHarness('', { analytics: true, rateLimit: true });
  t.after(h.close);
  const submit = () => h.app.inject({ method: 'POST', url: '/api/smart-search-requests', headers: h.headers(), payload: { description: '限频验证需求' } });
  for (let i = 0; i < 10; i++) assert.equal((await submit()).statusCode, 200, `submission ${i + 1} within the hourly budget succeeds`);
  assert.equal((await submit()).statusCode, 429, 'an eleventh submission within the hour is rejected');
});

test('author stats cover owned apps only and count exposure, details, usage and shares', async t => {
  const { h, admin, member, seeded, settings } = await setup(t);
  const other = await seedTagCatalog(h.db, h.config.audience, ['他人'], 71);
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb WHERE id = $1', [other.snapshotId, JSON.stringify({ ...other.source, name: '他人应用' })]);

  const memberView = await authorAppStats(h.db, settings, member.user.id);
  assert.equal(memberView.status, 'available');
  assert.deepEqual((memberView as any).items, [], 'non-owners see nothing');

  const event = async (name: string, attributes: any, appId: string, options: { session?: string; heat?: boolean } = {}) => h.db.query(
    `INSERT INTO analytics_events(event_id,event_name,occurred_at,received_at,effective_at,clock_adjusted,environment,site_instance_id,identity_scope,visitor_id,session_id,view_id,app_id,snapshot_id,heat_counted,attributes)
     VALUES($1,$2,now(),now(),now(),false,$3,$4,'persistent',null,$5,$6,$7,$8,$9,$10::jsonb)`,
    [randomUUID(), name, settings.environment, settings.siteInstanceId, options.session ?? randomUUID(), randomUUID(), appId, seeded.snapshotId, Boolean(options.heat), JSON.stringify({ pageContext: 'search', ...attributes })]);
  await event('app_card_exposed', { section: 'search' }, seeded.appId);
  await event('app_card_exposed', { section: 'search' }, seeded.appId);
  await event('app_detail_viewed', { entryContext: 'search_result' }, seeded.appId);
  await event('prompt_copy_result', { promptPurpose: 'usage', result: 'success' }, seeded.appId, { heat: true });
  const entrySession = randomUUID();
  await event('app_entry_clicked', { entryKind: 'web' }, seeded.appId, { session: entrySession, heat: true });
  // A repeat click from the same client inside the 30-minute window is not heat-counted at ingest
  // and must not inflate the author's usage numbers.
  await event('app_entry_clicked', { entryKind: 'web' }, seeded.appId, { session: entrySession });
  await event('app_share_link_copied', { placement: 'card' }, seeded.appId);
  await event('app_card_exposed', { section: 'search' }, other.appId);
  // Management-context events must not count as public usage.
  await event('app_entry_clicked', { entryKind: 'web', entryContext: 'management', pageContext: 'management' }, seeded.appId, { heat: true });

  const view = await authorAppStats(h.db, settings, admin.user.id) as any;
  assert.equal(view.items.length, 1, 'only owned apps are listed');
  const item = view.items[0];
  assert.equal(item.name, '作者数据测试应用');
  assert.equal(item.exposed, 2);
  assert.equal(item.detailSessions, 1);
  assert.equal(item.usages, 2, 'usages follow the shared 30-minute heat_counted dedup, so the repeat click adds nothing');
  assert.equal(item.shares, 1);

  // Taking an app offline (下架) must not erase its recent history for the author.
  await h.db.query("INSERT INTO catalog_app_lifecycle(app_id, status, revision, updated_at) VALUES($1,'offline',1,now())", [seeded.appId]);
  const offlineView = await authorAppStats(h.db, settings, admin.user.id) as any;
  assert.equal(offlineView.items.length, 1, 'offline apps keep their author stats history');
  assert.equal(offlineView.items[0].usages, 2);
  assert.equal(offlineView.items[0].exposed, 2);
  // Deleted apps leave the author view entirely.
  await h.db.query("UPDATE catalog_app_lifecycle SET status='deleted' WHERE app_id=$1", [seeded.appId]);
  const deletedView = await authorAppStats(h.db, settings, admin.user.id) as any;
  assert.deepEqual(deletedView.items, [], 'deleted apps drop out of the author view');
});
