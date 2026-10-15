import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/domain/database.js';
import { cleanCatalogTags, restoreCatalogTags, cleanupPlanHash, type TagCleanupBackup } from '../server/domain/tag-cleanup.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const audience='identity-regression';
async function setup(t: { after(cb: () => Promise<void>): void }) {
  const db=await openDatabase({path:'memory://'});t.after(() => db.close());
  const a=await seedTagCatalog(db,audience,['MCP','框架'],1),b=await seedTagCatalog(db,audience,['mcp','组件'],2);
  const plan={schemaVersion:1 as const,operationId:randomUUID(),audience,entries:[a.entry,b.entry]};
  let backup: TagCleanupBackup | undefined;
  await cleanCatalogTags(db,plan,{apply:true,saveBackup:async value=>{backup=value;}});
  return {db,plan,backup:backup!};
}
async function classifications(db: Awaited<ReturnType<typeof setup>>['db']) { return (await db.query('SELECT * FROM catalog_tag_overrides ORDER BY snapshot_id')).rows; }

test('same cleanup ID rejects changed reasons, expected tags and entry order before any backup or write',async t=>{
  const {db,plan}=await setup(t);const before=await classifications(db);let saves=0;
  for(const mutate of [
    (value:typeof plan)=>{value.entries[0].reason+=' changed';},
    (value:typeof plan)=>{value.entries[0].expectedTags=['伪造原标签'];},
    (value:typeof plan)=>{value.entries.reverse();},
  ]) {
    const changed=structuredClone(plan);mutate(changed);
    await assert.rejects(cleanCatalogTags(db,changed),/操作 ID.*不同的清洗计划/);
    await assert.rejects(cleanCatalogTags(db,changed,{apply:true,saveBackup:async()=>{saves++;}}),/操作 ID.*不同的清洗计划/);
  }
  assert.equal(saves,0);assert.deepEqual(await classifications(db),before);
  assert.equal((await db.query('SELECT plan_hash FROM catalog_tag_cleanup_operations WHERE operation_id=$1',[plan.operationId])).rows[0]?.plan_hash,cleanupPlanHash(plan));
});

test('same cleanup ID cannot become a second plan by using current tags as expected tags and another backup',async t=>{
  const {db,plan}=await setup(t);const before=await classifications(db);let saves=0;
  const changed=structuredClone(plan);
  for(const entry of changed.entries){entry.expectedTags=[...entry.tags];entry.tags=['MCP'];}
  await assert.rejects(cleanCatalogTags(db,changed,{apply:true,saveBackup:async()=>{saves++;}}),/操作 ID.*不同的清洗计划/);
  assert.equal(saves,0);assert.deepEqual(await classifications(db),before);
});

test('a reused cleanup ID is checked globally even when the new plan targets other applications',async t=>{
  const {db,plan}=await setup(t);const c=await seedTagCatalog(db,audience,['其他能力'],3);const before=await classifications(db);let saves=0;
  await assert.rejects(cleanCatalogTags(db,{...plan,entries:[c.entry]},{apply:true,saveBackup:async()=>{saves++;}}),/操作 ID.*不同的清洗计划/);
  assert.equal(saves,0);assert.deepEqual(await classifications(db),before);
});

test('rollback retains operation identity, rejects a different plan, and permits the original plan to be reapplied',async t=>{
  const {db,plan,backup}=await setup(t);
  const identity=(await db.query('SELECT * FROM catalog_tag_cleanup_operations')).rows;
  await restoreCatalogTags(db,backup,true);assert.deepEqual(await classifications(db),[]);
  const changed=structuredClone(plan);changed.entries[0].reason+=' new operation';
  await assert.rejects(cleanCatalogTags(db,changed,{apply:true,saveBackup:async()=>{throw new Error('must not save');}}),/操作 ID.*不同的清洗计划/);
  assert.equal((await cleanCatalogTags(db,plan,{apply:true,saveBackup:async value=>{assert.deepEqual(value,backup);}})).status,'applied');
  assert.deepEqual((await db.query('SELECT * FROM catalog_tag_cleanup_operations')).rows,identity);
});

test('legacy overrides fail closed until the original backup verifies the complete operation',async t=>{
  const {db,plan,backup}=await setup(t);const before=await classifications(db);
  await db.query('DELETE FROM catalog_tag_cleanup_operations');
  await assert.rejects(cleanCatalogTags(db,plan),/历史操作缺少计划身份记录/);
  await assert.rejects(cleanCatalogTags(db,plan,{apply:true,saveBackup:async()=>{throw new Error('must not save');}}),/历史操作缺少计划身份记录/);
  const altered=structuredClone(plan);altered.entries[0].reason+=' changed';
  await assert.rejects(cleanCatalogTags(db,altered,{apply:true,originalBackup:backup,saveBackup:async()=>{}}),/原备份与清洗计划不一致/);
  assert.equal((await cleanCatalogTags(db,plan,{originalBackup:backup})).status,'already_applied');
  assert.equal((await db.query('SELECT count(*) AS total FROM catalog_tag_cleanup_operations')).rows[0]?.total,0);
  assert.equal((await cleanCatalogTags(db,plan,{apply:true,originalBackup:backup,saveBackup:async()=>{throw new Error('must retain backup');}})).status,'already_applied');
  assert.deepEqual(await classifications(db),before);
  assert.equal((await db.query('SELECT plan_hash FROM catalog_tag_cleanup_operations')).rows[0]?.plan_hash,backup.planHash);
});

test('rollback refuses an operation hash mismatch even when the supplied backup checksum is valid',async t=>{
  const {db,plan,backup}=await setup(t);const before=await classifications(db);
  await db.query('UPDATE catalog_tag_cleanup_operations SET plan_hash=$2 WHERE operation_id=$1',[plan.operationId,'f'.repeat(64)]);
  await assert.rejects(restoreCatalogTags(db,backup,true),/操作 ID.*不同的清洗计划/);
  assert.deepEqual(await classifications(db),before);
});

test('legacy preview can verify the original backup without installing the operation identity migration',async t=>{
  const {db,plan,backup}=await setup(t);const before=await classifications(db);
  await db.query('DROP TABLE catalog_tag_cleanup_operations');
  assert.equal((await cleanCatalogTags(db,plan,{originalBackup:backup})).status,'already_applied');
  assert.equal((await db.query("SELECT to_regclass('catalog_tag_cleanup_operations') IS NULL AS absent")).rows[0]?.absent,true);
  await assert.rejects(cleanCatalogTags(db,plan,{apply:true,originalBackup:backup,saveBackup:async()=>{}}),/身份迁移尚未安装/);
  assert.deepEqual(await classifications(db),before);
});

test('an existing operation rejects stored result drift instead of applying or rolling back over it',async t=>{
  const {db,plan,backup}=await setup(t);
  await db.query("UPDATE catalog_tag_overrides SET reason='后续变动' WHERE operation_id=$1",[plan.operationId]);
  const before=await classifications(db);
  await assert.rejects(cleanCatalogTags(db,plan,{apply:true,saveBackup:async()=>{throw new Error('must not save');}}),/操作结果与固定计划不一致/);
  await assert.rejects(restoreCatalogTags(db,backup,true),/标签或操作身份已变化/);
  assert.deepEqual(await classifications(db),before);
});

for (const restored of [false,true]) test(`fixed operation rejects extra attributed snapshots even when original targets are ${restored?'restored':'applied'}`,async t=>{
  const {db,plan,backup}=await setup(t);
  if(restored) await restoreCatalogTags(db,backup,true);
  const extra=await seedTagCatalog(db,audience,['其他能力'],3);
  await db.query('INSERT INTO catalog_tag_overrides(snapshot_id,tags,operation_id,reason,updated_at) VALUES($1,$2::jsonb,$3,$4,now())',[extra.snapshotId,JSON.stringify(['MCP']),plan.operationId,'异常导入归因到原操作']);
  const before=await classifications(db),identity=(await db.query('SELECT * FROM catalog_tag_cleanup_operations')).rows;let saves=0;
  for(const action of [
    ()=>cleanCatalogTags(db,plan),
    ()=>cleanCatalogTags(db,plan,{apply:true,saveBackup:async()=>{saves++;}}),
    ()=>restoreCatalogTags(db,backup),
    ()=>restoreCatalogTags(db,backup,true),
  ]) await assert.rejects(action,/操作 ID.*完整目标集不一致/);
  assert.equal(saves,0);assert.deepEqual(await classifications(db),before);
  assert.deepEqual((await db.query('SELECT * FROM catalog_tag_cleanup_operations')).rows,identity);
});
