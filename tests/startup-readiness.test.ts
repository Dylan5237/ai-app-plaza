import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForStartupReadiness,
  type StartupReadinessProbe,
} from './helpers/startup-readiness.js';

const healthy: StartupReadinessProbe = {
  httpStatus: 200,
  body: { status: 'ok', mode: 'local', loginRequired: false },
};

function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (milliseconds: number) => { time += milliseconds; },
    pause: async (milliseconds: number) => { time += milliseconds; },
  };
}

test('the default startup wait uses the finite 30-second test budget', async () => {
  const clock = virtualClock();
  const probeTimeouts: number[] = [];
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => true,
    hasOwnStartupMarker: () => false,
    now: clock.now,
    pause: clock.pause,
    probe: async timeoutMs => {
      probeTimeouts.push(timeoutMs);
      return { httpStatus: 503, body: {} };
    },
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'deadline');
  assert.equal(result.elapsedMs, 30_000);
  assert.equal(probeTimeouts.at(-1), 100);
  assert.ok(probeTimeouts.every(timeoutMs => timeoutMs <= 500));
});

test('early child exit fails before probing', async () => {
  const clock = virtualClock();
  let probes = 0;
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => false,
    hasOwnStartupMarker: () => false,
    now: clock.now,
    pause: clock.pause,
    probe: async () => { probes++; return healthy; },
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'early-exit');
  assert.equal(probes, 0);
});

test('child exit during a probe cannot be mistaken for readiness', async () => {
  const clock = virtualClock();
  let runningChecks = 0;
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => ++runningChecks === 1,
    hasOwnStartupMarker: () => true,
    now: clock.now,
    pause: clock.pause,
    probe: async () => healthy,
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'early-exit');
  assert.equal(result.childRunning, false);
});

test('never-ready child fails at the total deadline with probe time bounded by remaining time', async () => {
  const clock = virtualClock();
  const probeTimeouts: number[] = [];
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => true,
    hasOwnStartupMarker: () => true,
    timeoutMs: 250,
    now: clock.now,
    pause: clock.pause,
    probe: async timeoutMs => {
      probeTimeouts.push(timeoutMs);
      return { httpStatus: 503, body: { status: 'starting', mode: 'local', loginRequired: false } };
    },
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'deadline');
  assert.equal(result.elapsedMs, 250);
  assert.deepEqual(probeTimeouts, [250, 150, 50]);
  assert.equal(result.lastProbe && 'httpStatus' in result.lastProbe ? result.lastProbe.httpStatus : undefined, 503);
});

test('a healthy unrelated service cannot pass without the child startup marker', async () => {
  const clock = virtualClock();
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => true,
    hasOwnStartupMarker: () => false,
    timeoutMs: 200,
    now: clock.now,
    pause: clock.pause,
    probe: async () => healthy,
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'deadline');
  assert.equal(result.ownStartupMarker, false);
  assert.deepEqual(result.lastProbe, { httpStatus: 200, healthStatus: 'ok', mode: 'local', loginRequired: false });
});

for (const [name, probe] of [
  ['non-200 HTTP response', { httpStatus: 503, body: healthy.body }],
  ['health status other than ok', { httpStatus: 200, body: { status: 'starting', mode: 'local', loginRequired: false } }],
  ['non-local mode', { httpStatus: 200, body: { status: 'ok', mode: 'configured', loginRequired: false } }],
  ['login required', { httpStatus: 200, body: { status: 'ok', mode: 'local', loginRequired: true } }],
] as const) {
  test(`startup readiness rejects ${name}`, async () => {
    const clock = virtualClock();
    const result = await waitForStartupReadiness({
      origin: 'http://127.0.0.1:1',
      isChildRunning: () => true,
      hasOwnStartupMarker: () => true,
      timeoutMs: 100,
      now: clock.now,
      pause: clock.pause,
      probe: async () => probe,
    });

    assert.equal(result.ready, false);
    if (result.ready) return;
    assert.equal(result.reason, 'deadline');
  });
}

test('a correct probe that completes at the total deadline cannot pass', async () => {
  const clock = virtualClock();
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => true,
    hasOwnStartupMarker: () => true,
    timeoutMs: 300,
    now: clock.now,
    pause: clock.pause,
    probe: async () => {
      clock.advance(300);
      return healthy;
    },
  });

  assert.equal(result.ready, false);
  if (result.ready) return;
  assert.equal(result.reason, 'deadline');
  assert.equal(result.ownStartupMarker, true);
  assert.equal(result.lastProbe && 'healthStatus' in result.lastProbe ? result.lastProbe.healthStatus : undefined, 'ok');
});

test('a healthy probe with the child startup marker passes', async () => {
  const clock = virtualClock();
  const result = await waitForStartupReadiness({
    origin: 'http://127.0.0.1:1',
    isChildRunning: () => true,
    hasOwnStartupMarker: () => true,
    now: clock.now,
    pause: clock.pause,
    probe: async () => healthy,
  });

  assert.deepEqual(result, { ready: true, health: healthy.body, elapsedMs: 0 });
});
