import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/domain/database.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('invalid cleanup plans fail at the process boundary before opening or creating a database', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'plaza-cleanup-cli-'));
  t.after(async () => { assert.equal(dirname(temporary), resolve(tmpdir())); await rm(temporary, { recursive: true, force: true }); });
  const plan = join(temporary, 'invalid.json');
  const db = join(temporary, 'must-not-be-created');
  await writeFile(plan, JSON.stringify({ schemaVersion: 999 }));
  const script = fileURLToPath(new URL('../scripts/clean-catalog-tags.ts', import.meta.url));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, '--plan', plan, '--database-path', db], { env: { ...process.env, DATABASE_URL: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'VALIDATION_FAILED');
  await assert.rejects(access(db), { code: 'ENOENT' });
});

test('CLI preserves the original plan identity across retries, legacy recovery and rollback', async t => {
  const temporary=await mkdtemp(join(tmpdir(),'plaza-cleanup-identity-cli-'));
  t.after(async()=>{assert.equal(dirname(temporary),resolve(tmpdir()));await rm(temporary,{recursive:true,force:true});});
  const database=join(temporary,'database'),planFile=join(temporary,'plan.json'),changedFile=join(temporary,'changed.json');
  const backup=join(temporary,'original-backup.json'),otherBackup=join(temporary,'other-backup.json');
  const db=await openDatabase({path:database});
  const a=await seedTagCatalog(db,'cli-identity',['MCP','框架'],1),b=await seedTagCatalog(db,'cli-identity',['mcp','组件'],2);
  const plan={schemaVersion:1,operationId:randomUUID(),audience:'cli-identity',entries:[a.entry,b.entry]};
  await db.close();await writeFile(planFile,JSON.stringify(plan));
  const script=fileURLToPath(new URL('../scripts/clean-catalog-tags.ts',import.meta.url));
  const run=(args:string[],databasePath=database)=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
    const child=spawn(process.execPath,['--import','tsx',script,'--database-path',databasePath,...args],{env:{...process.env,DATABASE_URL:''},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);child.once('close',code=>done({code,stdout,stderr}));
  });
  const apply=['--plan',planFile,'--apply','--backup',backup];
  assert.equal(JSON.parse((await run(apply)).stdout).status,'applied');
  const original=await readFile(backup,'utf8');
  assert.equal(JSON.parse((await run(apply)).stdout).status,'already_applied');
  const fixture=await openDatabase({path:database,migrate:false});
  const before=(await fixture.query('SELECT * FROM catalog_tag_overrides ORDER BY snapshot_id')).rows;
  await fixture.query('DELETE FROM catalog_tag_cleanup_operations');await fixture.close();
  const missing=await run(['--plan',planFile,'--apply','--backup',otherBackup]);
  assert.equal(missing.code,2);assert.equal(JSON.parse(missing.stderr).error.code,'TAG_CLEANUP_CONFLICT');
  await assert.rejects(access(otherBackup),{code:'ENOENT'});
  assert.equal(JSON.parse((await run(['--plan',planFile,'--backup',backup])).stdout).status,'already_applied');
  const preview=await openDatabase({path:database,migrate:false});
  assert.equal((await preview.query('SELECT count(*) AS total FROM catalog_tag_cleanup_operations')).rows[0]?.total,0);await preview.close();
  assert.equal(JSON.parse((await run(apply)).stdout).status,'already_applied');
  const changed=structuredClone(plan);
  for(const entry of changed.entries){entry.expectedTags=[...entry.tags];entry.tags=['MCP'];entry.reason+=' changed';}
  await writeFile(changedFile,JSON.stringify(changed));
  const unopened=join(temporary,'must-not-open');
  const mismatch=await run(['--plan',changedFile,'--apply','--backup',backup],unopened);
  assert.equal(mismatch.code,2);assert.equal(JSON.parse(mismatch.stderr).error.code,'TAG_CLEANUP_CONFLICT');
  await assert.rejects(access(unopened),{code:'ENOENT'});
  const rejected=await run(['--plan',changedFile,'--apply','--backup',otherBackup]);
  assert.equal(rejected.code,2);assert.equal(JSON.parse(rejected.stderr).error.code,'TAG_CLEANUP_CONFLICT');
  const check=await openDatabase({path:database,migrate:false});
  assert.deepEqual((await check.query('SELECT * FROM catalog_tag_overrides ORDER BY snapshot_id')).rows,before);
  assert.equal((await check.query('SELECT count(*) AS total FROM catalog_tag_cleanup_operations')).rows[0]?.total,1);await check.close();
  assert.equal(await readFile(backup,'utf8'),original);await assert.rejects(access(otherBackup),{code:'ENOENT'});
  assert.equal(JSON.parse((await run(['--rollback',backup,'--apply'])).stdout).status,'restored');
  const afterRollback=await run(['--plan',changedFile,'--apply','--backup',otherBackup]);
  assert.equal(afterRollback.code,2);assert.equal(JSON.parse(afterRollback.stderr).error.code,'TAG_CLEANUP_CONFLICT');
});
