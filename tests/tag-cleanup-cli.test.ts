import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
