import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { startGitLabFixture } from './helpers/gitlab-fixture.js';

function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  return { child, closed, output: () => ({ stdout, stderr }) };
}

test('actual service process starts with an empty durable catalog and sanitizes startup errors', async t => {
  const gitlab = await startGitLabFixture();
  t.after(gitlab.close);
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const runtime = start({ PLAZA_LOCAL: '1', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
    GITLAB_URL: gitlab.url, DATABASE_URL: '', PLAZA_SECRET: 'test-only-cli-secret-long-enough-for-startup', PLAZA_DATA_DIR: await mkdtemp(join(tmpdir(), 'plaza-startup-')) });
  t.after(async () => { runtime.child.kill(); await runtime.closed; });
  let health: any;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (runtime.child.exitCode !== null) break;
    try { health = await (await fetch(`${origin}/api/health`)).json(); break; } catch { await pause(100); }
  }
  assert.equal(health?.loginRequired, false, runtime.output().stderr);
  assert.equal((await (await fetch(`${origin}/api/apps`)).json() as any).total, 0);
  assert.equal(gitlab.state.requests.length, 0, 'startup/list never read repositories without a publication');
  assert.equal(runtime.output().stderr, '');

  const invalid = start({ PLAZA_LOCAL: '1', NODE_ENV: 'production', DATABASE_URL: 'postgresql://secret-sentinel:password@invalid/db' });
  assert.equal(await invalid.closed, 1);
  assert.ok(invalid.output().stderr.includes('服务启动失败'));
  assert.ok(!invalid.output().stderr.includes('secret-sentinel') && !invalid.output().stderr.includes('password'));
});
