import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { openDatabase } from '../server/domain/database.js';
import { DomainError } from '../server/domain/errors.js';
import { getOperationsDashboard } from '../server/domain/operations-dashboard.js';
import { registerOperationsDashboard } from '../server/operations-dashboard.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const settings = { environment:'test' as const, siteInstanceId:'dashboard-fixture' };
const now = new Date('2026-11-09T04:00:00Z');

test('dashboard uses actual events, respects public scope, time and telemetry boundaries', async t => {
  const db = await openDatabase({ path:'memory://' });
  t.after(() => db.close());
  const published = await seedTagCatalog(db, 'public', ['测试'], 1);
  const hidden = await seedTagCatalog(db, 'public', ['测试'], 2);
  await db.query('INSERT INTO analytics_baselines(environment,site_instance_id,baseline_id,effective_at) VALUES($1,$2,$3,$4)',
    [settings.environment,settings.siteInstanceId,randomUUID(),'2026-11-05T04:00:00Z']);
  const session = randomUUID(), visitor = randomUUID();
  async function event(name:string, attrs:object, options:{ appId?:string; snapshotId?:string; session?:string; time?:string; site?:string; heat?:boolean } = {}) {
    const at = options.time || '2026-11-08T05:00:00Z';
    await db.query(`INSERT INTO analytics_events(event_id,event_name,occurred_at,received_at,effective_at,clock_adjusted,environment,site_instance_id,identity_scope,visitor_id,session_id,view_id,app_id,snapshot_id,heat_counted,attributes)
      VALUES($1,$2,$3,$3,$3,false,'test',$4,'persistent',$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [randomUUID(),name,at,options.site || settings.siteInstanceId,visitor,options.session || session,randomUUID(),options.appId || null,options.snapshotId || null,Boolean(options.heat),JSON.stringify({pageContext:'catalog',...attrs})]);
  }
  const selected = {appId:published.appId,snapshotId:published.snapshotId};
  await event('catalog_results_viewed',{trigger:'search',hasQuery:true,resultCount:0,discoveryRequestId:randomUUID()});
  await event('catalog_results_viewed',{trigger:'filter',hasQuery:false,resultCount:1,discoveryRequestId:randomUUID()},{session:randomUUID()});
  await event('app_card_exposed',{},selected);
  await event('app_card_exposed',{pageContext:'search',section:'search'},{...selected,session:randomUUID()});
  await event('app_detail_viewed',{entryContext:'card'},selected);
  await event('app_entry_clicked',{entryKind:'web'},{...selected,heat:true});
  await event('app_entry_clicked',{entryKind:'web'},selected);
  await event('prompt_copy_result',{promptPurpose:'usage',result:'success'},{...selected,heat:true});
  await event('app_detail_viewed',{entryContext:'management',pageContext:'management'},selected);
  await event('app_entry_clicked',{entryKind:'web'},{appId:hidden.appId,snapshotId:hidden.snapshotId,heat:true,session:randomUUID()});
  await event('app_entry_clicked',{entryKind:'web'},{...selected,heat:true,site:'other'});
  await event('app_entry_clicked',{entryKind:'web'},{...selected,heat:true,time:'2026-11-04T05:00:00Z'});
  const facts = [
    {eventName:'publication_state_changed',toState:'registered',registrationKind:'new',appId:published.appId},
    {eventName:'publication_state_changed',toState:'registered',registrationKind:'new',appId:hidden.appId},
    {eventName:'publication_state_changed',toState:'registered',registrationKind:'version_update',appId:published.appId},
    {eventName:'publication_state_changed',toState:'registered',registrationKind:'noop',appId:published.appId},
  ].map(fact=>({...fact,environment:settings.environment,siteInstanceId:settings.siteInstanceId,occurredAt:'2026-11-08T06:00:00Z'}));
  await db.query(`INSERT INTO publications(id,actor_id,idempotency_digest,request_hash,submission,status,candidate_app_id,next_action,expires_at,created_at,updated_at,analytics_journal)
    VALUES($1,'test','idem','request','{}'::jsonb,'registered',$2,'none',$3,$3,$3,$4::jsonb)`,
  [randomUUID(),randomUUID(),now.toISOString(),JSON.stringify(facts)]);
  const result = await getOperationsDashboard(db,settings,'30d',async()=>[published.appId],now);
  assert.equal(result.status,'available');
  if (result.status !== 'available') return;
  assert.equal(result.partial,true);
  assert.equal(result.start,'2026-11-05T04:00:00.000Z');
  assert.deepEqual(result.summary,{discoverySessions:1,usageSessions:1,discoveryVisitors:1,sessionOnly:0,searches:null,emptySearches:null,webActions:1,agentActions:1});
  assert.equal(result.apps?.length,1);
  assert.equal(result.apps?.[0].id,published.appId);
  assert.equal(result.apps?.[0].exposure,2,'exposures from the smart-search tab count like catalog ones');
  assert.equal(result.apps?.[0].details,1);
  assert.equal(result.apps?.[0].webSessions,1);
  assert.equal(result.apps?.[0].agentSessions,1);
  assert.equal(result.supply?.available,1);
  assert.equal(result.supply?.newApps,1);
  assert.equal(result.supply?.updates,1);
  assert.equal(result.retention,null,'unscoped catalog events cannot establish public first discovery');
  assert.equal(JSON.stringify(result).includes(hidden.appId),false);
  const noPolicy = await getOperationsDashboard(db,settings,'30d',undefined,now);
  assert.equal(noPolicy.status,'available');
  if (noPolicy.status !== 'available') return;
  assert.equal(noPolicy.appScopeAvailable,false);
  assert.equal(noPolicy.summary.discoverySessions,null);
  assert.equal(noPolicy.apps,null);
  assert.equal(noPolicy.supply,null);
  assert.equal(noPolicy.days,null);
  assert.equal((await getOperationsDashboard(db,undefined,'7d',undefined,now)).status,'unavailable');
  assert.equal((await getOperationsDashboard(db,{...settings,siteInstanceId:'not-started'},'7d',undefined,now)).status,'unavailable');
});

test('each dashboard request requires administrator authentication before querying data', async t => {
  const db = await openDatabase({ path:'memory://' });
  const app = Fastify();
  let authenticated = false, visibleCalls = 0, authCalls = 0;
  registerOperationsDashboard(app,db,{analytics:settings,authenticateAdministrator:async()=>{
    authCalls++; if(!authenticated) throw new DomainError(403,'PERMISSION_DENIED','仅管理员可以查看运营看板。');
  },visibleAppIds:async()=>{visibleCalls++;return [];}});
  t.after(async()=>{await app.close();await db.close();});
  const denied=await app.inject({method:'GET',url:'/api/operations/dashboard?period=30d'});
  assert.equal(denied.statusCode,403);
  assert.equal(visibleCalls,0);
  authenticated=true;
  const invalid=await app.inject({method:'GET',url:'/api/operations/dashboard?period=365d'});
  assert.equal(invalid.statusCode,400);
  const allowed=await app.inject({method:'GET',url:'/api/operations/dashboard?period=7d'});
  assert.equal(allowed.statusCode,200);
  assert.equal(allowed.headers['cache-control'],'no-store');
  assert.equal(allowed.json().status,'unavailable');
  assert.equal(authCalls,3);
  assert.equal(visibleCalls,0,'missing baseline never requests scope');
});
