import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/domain/database.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import type { Config } from '../server/config.js';
import { startHarness } from './helpers/harness.js';
import { DEFAULT_TAG, SHA, TOKEN } from './helpers/gitlab-fixture.js';
import { recordCatalogBaseline } from '../server/domain/analytics.js';
import { maintainAnalyticsRetention } from '../server/domain/analytics-retention.js';
import { appendBusinessFact } from '../server/domain/analytics-journal.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { startIdentityHarness } from './helpers/identity-fixture.js';

test('browser events persist safe fields, deduplicate retries and exposures, and exclude hidden apps', async t => {
  const db = await openDatabase({ path: 'memory://' });
  const config: Config = { host:'127.0.0.1', port:4000, publicOrigin:'http://127.0.0.1:4000', gitlabUrl:'https://gitlab.example', secret:'test-only-secret-at-least-32-characters', dataDir:'', local:true, audience:'public', staticDir:resolve('dist'), rateLimit:false, analytics:{ environment:'test', siteInstanceId:'fixture' } };
  const { app } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.close(); });
  const seeded = await seedTagCatalog(db, config.audience, ['研发'], 1);
  await recordCatalogBaseline(db, config);
  await recordCatalogBaseline(db, config);
  assert.equal(Number((await db.query<any>('SELECT count(*) AS n FROM analytics_baselines')).rows[0].n), 1);
  assert.equal(Number((await db.query<any>('SELECT count(*) AS n FROM analytics_baseline_items')).rows[0].n), 1, 'existing apps form a snapshot, not invented registration events');
  const randomResponse = await app.inject({ method:'GET', url:'/api/apps/random', headers:{ host:'127.0.0.1:4000' } });
  assert.equal(randomResponse.statusCode, 200);
  assert.equal(randomResponse.json().analyticsEnabled, true, 'random discovery receives the server collection switch for direct links');
  const event = { eventId:randomUUID(), eventName:'app_card_exposed', occurredAt:new Date().toISOString(), identityScope:'persistent', visitorId:randomUUID(), sessionId:randomUUID(), viewId:randomUUID(), resultSetId:randomUUID(), appId:seeded.appId, snapshotId:seeded.snapshotId, attributes:{ pageContext:'catalog', entryMode:'catalog', position:1, section:'catalog' } };
  const send = (payload: object) => app.inject({ method:'POST', url:'/api/analytics/events', headers:{ host:'127.0.0.1:4000', origin:config.publicOrigin }, payload });
  assert.equal((await send(event)).statusCode, 200);
  assert.equal((await send(event)).json().duplicate, true);
  assert.equal((await send({ ...event, eventId:randomUUID() })).json().duplicate, true, 'same result set and app is one exposure');
  assert.equal((await send({ ...event, eventId:randomUUID(), eventName:'publish_operation_received' })).statusCode, 400, 'browser cannot create server facts');
  assert.equal((await send({ ...event, eventId:randomUUID(), token:'must-not-be-recorded' })).statusCode, 400, 'unknown fields are rejected');
  assert.equal((await send({ ...event, eventId:randomUUID(), attributes:{ ...event.attributes, query:'raw query' } })).statusCode, 400, 'raw query is rejected');
  const resultsEvent = { eventId:randomUUID(), eventName:'catalog_results_viewed', occurredAt:new Date().toISOString(), identityScope:'persistent', visitorId:event.visitorId, sessionId:event.sessionId, viewId:event.viewId, resultSetId:randomUUID(), attributes:{ pageContext:'catalog',entryMode:'catalog',trigger:'filter',discoveryRequestId:randomUUID(),resultCount:1,renderedCount:1,page:1,pageSize:6,usageType:'all',selectedTags:['研发'],hasQuery:false,queryLengthBucket:'0' } };
  assert.equal((await send({ ...resultsEvent, attributes:{ ...resultsEvent.attributes, selectedTags:['unapproved free text'] } })).statusCode,400, 'only visible catalog tags can be recorded');
  assert.equal((await send(resultsEvent)).statusCode,200);
  const late = { ...event, eventId:randomUUID(), eventName:'app_detail_viewed', occurredAt:'2000-01-01T00:00:00Z', attributes:{ pageContext:'detail', entryMode:'detail_link', entryContext:'deep_link' } };
  assert.equal((await send(late)).statusCode, 200);
  const rows = (await db.query<any>('SELECT * FROM analytics_events ORDER BY received_at')).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].environment, 'test');
  assert.equal(rows[0].site_instance_id, 'fixture');
  assert.equal(rows.find(row => row.event_id === late.eventId).clock_adjusted, true);
  const searchExposure = { ...event, eventId: randomUUID(), resultSetId: randomUUID(), attributes: { pageContext: 'search', entryMode: 'catalog', position: 1, section: 'search' } };
  assert.equal((await send(searchExposure)).statusCode, 200, 'smart-search discovery context is accepted');
  const click = { ...event, eventId:randomUUID(), eventName:'app_entry_clicked', interactionId:randomUUID(), attributes:{ pageContext:'catalog', entryMode:'catalog', entryId:'web', entryKind:'web', placement:'card' } };
  assert.equal((await send(click)).statusCode, 200);
  assert.equal((await send({ ...click, eventId:randomUUID(), interactionId:randomUUID() })).statusCode, 200);
  const copy = { ...event, eventId:randomUUID(), eventName:'prompt_copy_result', interactionId:randomUUID(), attributes:{ pageContext:'detail', entryMode:'catalog', promptPurpose:'usage', result:'success' } };
  assert.equal((await send(copy)).statusCode, 200);
  assert.equal((await send({ ...copy, eventId:randomUUID(), interactionId:randomUUID(), attributes:{ ...copy.attributes, result:'failure' } })).statusCode, 200);
  let counts = (await db.query<any>('SELECT action,total FROM analytics_usage_counts ORDER BY action')).rows;
  assert.deepEqual(counts.map(row => [row.action, Number(row.total)]), [['agent',1],['web',1]], 'copy failure and repeated actions do not increase counts');
  await db.query("UPDATE analytics_usage_windows SET last_counted_at=now()-interval '31 minutes' WHERE action='web'");
  assert.equal((await send(click)).json().duplicate, true, 'same event retry remains a duplicate after the window');
  assert.equal((await send({ ...click, eventId:randomUUID(), interactionId:randomUUID() })).statusCode, 200);
  counts = (await db.query<any>('SELECT action,total FROM analytics_usage_counts ORDER BY action')).rows;
  assert.deepEqual(counts.map(row => [row.action, Number(row.total)]), [['agent',1],['web',2]], 'new action after 30 minutes counts again');
  await db.query("INSERT INTO catalog_app_lifecycle(app_id,status,revision,updated_at) VALUES($1,'offline',1,now())", [seeded.appId]);
  assert.equal((await send({ ...event, eventId:randomUUID(), resultSetId:randomUUID() })).statusCode, 404);
});

test('collection disabled rejects events and preserves existing catalog response', async t => {
  const db = await openDatabase({ path:'memory://' });
  const config: Config = { host:'127.0.0.1', port:4000, publicOrigin:'http://127.0.0.1:4000', gitlabUrl:'https://gitlab.example', secret:'test-only-secret-at-least-32-characters', dataDir:'', local:true, audience:'public', staticDir:resolve('dist'), rateLimit:false };
  const { app } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject({ method:'POST',url:'/api/analytics/events',headers:{ host:'127.0.0.1:4000' },payload:{} })).statusCode, 404);
  const response = await app.inject({ method:'GET',url:'/api/apps',headers:{ host:'127.0.0.1:4000' } });
  assert.equal(response.json().analyticsEnabled, undefined);
  const randomResponse = await app.inject({ method:'GET',url:'/api/apps/random',headers:{ host:'127.0.0.1:4000' } });
  assert.equal(randomResponse.json().analyticsEnabled, undefined);
});

test('selected analytics tags use the authenticated viewer catalog scope', async t => {
  const h = await startIdentityHarness('', { analytics: true, superAdminAccount: 'fixture.admin' });
  t.after(h.close);
  const owner = await h.login('fixture-admin');
  const privateApp = await seedTagCatalog(h.db, h.config.audience, ['PrivateOnly']);
  const access = createAppAccessService(h.db, h.config.audience);
  await access.adopt(owner.user.id, privateApp.appId, { ownerId: owner.user.id, expectedAppRevision: 1, requestId: randomUUID() });
  await access.update(owner.user.id, privateApp.appId, { revision: 1, requestId: randomUUID(), scope: 'self', memberIds: [], groupIds: [] });
  const event = { eventId: randomUUID(), eventName: 'catalog_results_viewed', occurredAt: new Date().toISOString(),
    identityScope: 'persistent', visitorId: randomUUID(), sessionId: randomUUID(), viewId: randomUUID(), resultSetId: randomUUID(),
    attributes: { pageContext: 'catalog', entryMode: 'catalog', trigger: 'filter', discoveryRequestId: randomUUID(), resultCount: 1,
      renderedCount: 1, page: 1, pageSize: 8, usageType: 'all', selectedTags: ['privateonly'], hasQuery: false, queryLengthBucket: '0' } };
  const send = (payload: object, headers: Record<string, string> = h.headers()) => h.app.inject({ method: 'POST', url: '/api/analytics/events', headers, payload });
  assert.equal((await send(event)).statusCode, 400, 'anonymous callers cannot claim a tag visible only on a restricted app');
  const authorizedEvent = { ...event, eventId: randomUUID() };
  const authorized = await send(authorizedEvent, h.headers({ cookie: owner.cookie, 'x-plaza-portal-token': 'fixture-admin' }));
  assert.equal(authorized.statusCode, 200, authorized.body);
  const recorded = (await h.db.query('SELECT attributes->\'selectedTags\' AS tags FROM analytics_events WHERE event_id=$1', [authorizedEvent.eventId])).rows[0].tags;
  assert.deepEqual(recorded, ['PrivateOnly'], 'case-insensitive selection is persisted in the visible canonical spelling');
});

test('analytics rate limits cannot consume the catalog request budget', async t => {
  const db=await openDatabase({path:'memory://'});
  const config:Config={host:'127.0.0.1',port:4000,publicOrigin:'http://127.0.0.1:4000',gitlabUrl:'https://gitlab.example',secret:'test-only-secret-at-least-32-characters',dataDir:'',local:true,audience:'public',staticDir:resolve('dist'),rateLimit:true,analytics:{environment:'test',siteInstanceId:'fixture'}};
  const {app}=await createApp(config,db);
  t.after(async()=>{await app.close();await db.close()});
  let response;
  for (let i=0;i<241;i++) response=await app.inject({method:'POST',url:'/api/analytics/events',headers:{host:'127.0.0.1:4000'},payload:{}});
  assert.equal(response!.statusCode,429);
  assert.equal((await app.inject({method:'GET',url:'/api/apps',headers:{host:'127.0.0.1:4000'}})).statusCode,200);
});

test('retention aggregates before deleting, preserves recent and other-site records, and is repeatable', async t => {
  const db = await openDatabase({ path:'memory://' });
  const config: Config = { host:'127.0.0.1', port:4000, publicOrigin:'http://127.0.0.1:4000', gitlabUrl:'https://gitlab.example', secret:'test-only-secret-at-least-32-characters', dataDir:'', local:true, audience:'public', staticDir:resolve('dist'), rateLimit:false, analytics:{ environment:'test', siteInstanceId:'fixture' } };
  const { app } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.close(); });
  const seeded = await seedTagCatalog(db, 'public', ['研发'], 1);
  const visitorId = randomUUID(), sessionId = randomUUID();
  const send = (eventId:string) => app.inject({ method:'POST', url:'/api/analytics/events', headers:{ host:'127.0.0.1:4000', origin:config.publicOrigin }, payload:{ eventId,eventName:'app_detail_viewed',occurredAt:new Date().toISOString(),identityScope:'persistent',visitorId,sessionId,viewId:randomUUID(),appId:seeded.appId,snapshotId:seeded.snapshotId,attributes:{pageContext:'detail',entryMode:'catalog',entryContext:'card'} } });
  const old1=randomUUID(),old2=randomUUID(),recent=randomUUID();
  assert.equal((await send(old1)).statusCode,200);
  assert.equal((await send(old2)).statusCode,200);
  assert.equal((await send(recent)).statusCode,200);
  await db.query("UPDATE analytics_events SET effective_at='2026-01-01T16:10:00Z', received_at='2026-01-01T16:10:00Z' WHERE event_id IN ($1,$2)", [old1,old2]);
  await db.query("UPDATE analytics_events SET effective_at='2026-07-04T00:00:00Z', received_at='2026-07-04T00:00:00Z' WHERE event_id=$1", [recent]);
  const journal = [
    {eventName:'app_lifecycle_changed',occurredAt:'2026-01-01T16:15:00Z',environment:'test',siteInstanceId:'fixture',appId:seeded.appId,action:'online'},
    {eventName:'app_lifecycle_changed',occurredAt:'2026-07-04T00:00:00Z',environment:'test',siteInstanceId:'fixture',appId:seeded.appId,action:'offline'},
    {eventName:'app_lifecycle_changed',occurredAt:'2026-01-01T16:15:00Z',environment:'test',siteInstanceId:'other',appId:seeded.appId,action:'online'},
  ];
  await db.query("INSERT INTO catalog_app_lifecycle(app_id,status,revision,updated_at,analytics_journal) VALUES($1,'published',1,now(),$2::jsonb)", [seeded.appId,JSON.stringify(journal)]);
  const now = new Date('2026-07-05T00:00:00Z');
  await db.query('ALTER TABLE analytics_rollups ADD CONSTRAINT reject_rollup CHECK (event_count < 0)');
  await assert.rejects(maintainAnalyticsRetention(db, config, now));
  assert.equal(Number((await db.query<any>('SELECT count(*) AS n FROM analytics_events')).rows[0].n),3, 'failed aggregation cannot delete source');
  assert.equal(Number((await db.query<any>('SELECT count(*) AS n FROM analytics_rollup_periods')).rows[0].n),0, 'failure rolls the period markers back');
  await db.query('ALTER TABLE analytics_rollups DROP CONSTRAINT reject_rollup');
  const collectionDisabled = { ...config, analytics:undefined, analyticsRetention:config.analytics };
  await maintainAnalyticsRetention(db, collectionDisabled, now);
  await maintainAnalyticsRetention(db, collectionDisabled, now);
  assert.deepEqual((await db.query<any>('SELECT event_id FROM analytics_events')).rows.map(row=>row.event_id),[recent]);
  const remaining = (await db.query<any>('SELECT analytics_journal FROM catalog_app_lifecycle')).rows[0].analytics_journal;
  assert.equal(remaining.length,2);
  assert.ok(remaining.some((row:any)=>row.siteInstanceId==='other'));
  const totals=(await db.query<any>(`SELECT period,period_start,event_name,event_count,visitor_count,session_count FROM analytics_rollups WHERE dimension='{"total":true}'::jsonb ORDER BY period,event_name`)).rows;
  assert.equal(totals.length,4);
  const detail=totals.filter(row=>row.event_name==='app_detail_viewed');
  assert.deepEqual(detail.map(row=>[row.period,Number(row.event_count),Number(row.visitor_count),Number(row.session_count)]),[['day',2,1,1],['week',2,1,1]]);
  assert.equal(new Date(detail[0].period_start).toISOString(),'2026-01-01T16:00:00.000Z', 'daily boundary is Beijing midnight');
  assert.equal(new Date(detail[1].period_start).toISOString(),'2025-12-28T16:00:00.000Z', 'week begins Monday in Beijing');
});

test('failed analytics journal write does not roll back the business transaction', async t => {
  const db = await openDatabase({path:'memory://'});
  t.after(() => db.close());
  const seeded = await seedTagCatalog(db,'public',['研发'],1);
  await db.query("INSERT INTO catalog_app_lifecycle(app_id,status,revision,updated_at) VALUES($1,'published',1,now())", [seeded.appId]);
  await db.transaction(async tx => {
    await tx.query('UPDATE catalog_app_lifecycle SET revision=2 WHERE app_id=$1',[seeded.appId]);
    const broken = { query: (sql:string, values?:unknown[]) => sql.startsWith('UPDATE catalog_app_lifecycle SET analytics_journal=')
      ? tx.query('SELECT column_that_does_not_exist FROM catalog_app_lifecycle') : tx.query(sql, values) };
    await appendBusinessFact(broken as any,'catalog_app_lifecycle',seeded.appId,{environment:'test',siteInstanceId:'fixture'},'app_lifecycle_changed',{action:'online'});
  });
  const row=(await db.query<any>('SELECT revision,analytics_journal FROM catalog_app_lifecycle WHERE app_id=$1',[seeded.appId])).rows[0];
  assert.equal(row.revision,2);
  assert.deepEqual(row.analytics_journal,[]);
});

test('business facts are committed with actual state transitions and contain no credentials', async t => {
  const h = await startHarness(1, 'memory://', { analytics:{ environment:'test', siteInstanceId:'fixture' } });
  t.after(() => h.close());
  const key = randomUUID();
  const input = { projectId:1, appKey:'sample-1', manifestPath:'ai-app.json', commitSha:SHA, tag:DEFAULT_TAG };
  const candidate = await h.service.submit(input, TOKEN, key);
  assert.equal(candidate.status, 'preview_ready');
  const again = await h.service.submit(input, TOKEN, key);
  assert.equal(again.id, candidate.id);
  const view = await h.service.publication(candidate.id, candidate.ticket);
  const registered = await h.service.confirm(candidate.id, candidate.ticket, { revision:view.revision, digest:view.digest! });
  assert.equal(registered.status, 'registered');
  await h.service.confirm(candidate.id, candidate.ticket, { revision:view.revision, digest:view.digest! });
  const journal = (await h.db.query<any>('SELECT analytics_journal FROM publications WHERE id=$1', [candidate.id])).rows[0].analytics_journal;
  assert.equal(journal.filter((event: any) => event.eventName === 'publish_operation_received').length, 1);
  assert.deepEqual(journal.filter((event: any) => event.eventName === 'publication_state_changed').map((event: any) => event.toState), ['checking','preview_ready','registered']);
  const last = journal.find((event: any) => event.eventName === 'publication_state_changed' && event.toState === 'registered');
  assert.equal(last.registrationKind, 'new');
  assert.equal(last.appId, registered.appId);
  assert.ok(last.snapshotId);
  const confirm = journal.filter((event: any) => event.eventName === 'publication_confirm_requested');
  assert.equal(confirm.length, 1, 'reading an already registered result does not start a new confirm');
  assert.ok(journal.some((event: any) => event.eventName === 'publish_attempt_finished' && event.attemptId === confirm[0].attemptId && event.result === 'success'));
  assert.ok(!JSON.stringify(journal).includes(TOKEN));
  assert.ok(!JSON.stringify(journal).includes(candidate.ticket));
  await h.service.changeLifecycle(registered.appId!, 'offline', 1, 1);
  const lifecycle = (await h.db.query<any>('SELECT analytics_journal FROM catalog_app_lifecycle WHERE app_id=$1', [registered.appId])).rows[0].analytics_journal;
  assert.deepEqual(lifecycle.map((event: any) => [event.eventName,event.fromStatus,event.toStatus]), [['app_lifecycle_changed','published','offline']]);
});
