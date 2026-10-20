import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitLabFixture } from './helpers/gitlab-fixture.js';
import { STARTUP_READINESS_TIMEOUT_MS, waitForStartupReadiness } from './helpers/startup-readiness.js';

function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  return { child, closed, output: () => ({ stdout, stderr }) };
}

function redact(output: string, secrets: string[]): string {
  return secrets.reduce((value, secret) => secret ? value.replaceAll(secret, '[REDACTED]') : value, output);
}

test('actual service process starts with an empty durable catalog and sanitizes startup errors', async t => {
  const gitlab = await startGitLabFixture();
  t.after(gitlab.close);
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const startupSecret = 'test-only-cli-secret-long-enough-for-startup';
  const runtime = start({ PLAZA_LOCAL: '1', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
    GITLAB_URL: gitlab.url, DATABASE_URL: '', PLAZA_SECRET: startupSecret, PLAZA_DATA_DIR: await mkdtemp(join(tmpdir(), 'plaza-startup-')) });
  t.after(async () => { runtime.child.kill(); await runtime.closed; });
  const readiness = await waitForStartupReadiness({
    origin,
    isChildRunning: () => runtime.child.exitCode === null && runtime.child.signalCode === null,
    hasOwnStartupMarker: () => runtime.output().stdout.includes(`AI应用广场已启动：${origin}（`),
    timeoutMs: STARTUP_READINESS_TIMEOUT_MS,
  });
  const output = runtime.output();
  assert.equal(readiness.ready, true, JSON.stringify({
    elapsedMs: readiness.elapsedMs,
    timeoutMs: STARTUP_READINESS_TIMEOUT_MS,
    exitCode: runtime.child.exitCode,
    signal: runtime.child.signalCode,
    reason: readiness.ready ? undefined : readiness.reason,
    ownStartupMarker: readiness.ready ? true : readiness.ownStartupMarker,
    lastProbe: readiness.ready ? undefined : readiness.lastProbe,
    stdout: redact(output.stdout, [startupSecret]),
    stderr: redact(output.stderr, [startupSecret]),
  }));
  assert.equal(readiness.ready && readiness.health.loginRequired, false);
  assert.equal((await (await fetch(`${origin}/api/apps`)).json() as any).total, 0);
  assert.equal(gitlab.state.requests.length, 0, 'startup/list never read repositories without a publication');
  assert.equal(output.stderr, '');

  const invalid = start({ PLAZA_LOCAL: '1', NODE_ENV: 'production', DATABASE_URL: 'postgresql://secret-sentinel:password@invalid/db' });
  assert.equal(await invalid.closed, 1);
  assert.ok(invalid.output().stderr.includes('服务启动失败'));
  assert.ok(!invalid.output().stderr.includes('secret-sentinel') && !invalid.output().stderr.includes('password'));
});
