import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle, performanceHarness } from './helpers/managed-performance.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args[args.indexOf(name) + 1] ?? fallback;
const samples = Number(args.includes('--samples') ? option('--samples', '5') : 5);
const delayMs = Number(args.includes('--delay-ms') ? option('--delay-ms', '40') : 40);
assert.ok(samples >= 3 && samples <= 10 && delayMs >= 0 && delayMs <= 100);
const output = resolve(args.includes('--output') ? option('--output', '') : 'artifacts/performance/results.json');
const variants = [
  { name: 'baseline', root: resolve('artifacts/performance/baseline') },
  { name: 'round1', root: resolve('artifacts/performance/round1') },
  { name: 'round2', root: resolve('.') },
];
async function sourceHash(root: string) {
  const hash = createHash('sha256');
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { hash.update(relative(root, file)); hash.update(await readFile(file)); }
    }
  }
  await walk(resolve(root, 'server')); return hash.digest('hex');
}
const runners: Array<{ name: string; root: string; sourceHash: string; h: Awaited<ReturnType<typeof performanceHarness>> }> = [];
for (const variant of variants) {
  const { createApp } = await import(pathToFileURL(resolve(variant.root, 'server/app.ts')).href);
  const { openDatabase } = await import(pathToFileURL(resolve(variant.root, 'server/domain/database.ts')).href);
  runners.push({ ...variant, sourceHash: await sourceHash(variant.root), h: await performanceHarness(delayMs, { createApp, openDatabase }) });
}
type Measurement = { variant: string; scenario: string; sample: number; phase: string; elapsedMs: number; requests: number; writes: number; treePages: number; recursiveTreePages: number; peak: number };
const measurements: Measurement[] = [];
function record(runner: typeof runners[number], scenario: string, sample: number, phase: string, start: number, before: number, writes: number) {
  const state = runner.h.fixture.state;
  const requests = state.requests.slice(before);
  measurements.push({ variant: runner.name, scenario, sample, phase, elapsedMs: performance.now() - start,
    requests: requests.length, writes: state.writes.length - writes,
    treePages: requests.filter(item => item.path.includes('/repository/tree?')).length,
    recursiveTreePages: requests.filter(item => item.path.includes('/repository/tree?') && item.path.includes('recursive=true')).length,
    peak: state.peak });
}
try {
  for (const runner of runners) {
    const warm = await runner.h.submit(bundle()); assert.equal(warm.result.status, 'preview_ready');
    assert.equal((await runner.h.confirm(warm.result)).status, 'registered');
  }
  for (const scenario of ['small', 'multi-batch', 'single-file-update', 'lost-middle-response']) {
    for (let sample = 0; sample < samples; sample++) {
      // Rotate variant order to reduce warmup/order bias. Preparation and seed writes are excluded.
      const order = [...runners.slice(sample % runners.length), ...runners.slice(0, sample % runners.length)];
      for (const runner of order) {
        const h = runner.h;
        let value: ReturnType<typeof bundle> & { managedAppId?: string; expectedAppRevision?: number } = bundle('1.0.0', scenario === 'small' ? 0 : 205);
        let key: string | undefined;
        if (scenario === 'single-file-update') {
          const seed = await h.submit(value); assert.equal(seed.result.status, 'preview_ready');
          assert.equal((await h.confirm(seed.result)).status, 'registered');
          value = { ...bundle('1.1.0', 205, '\n// one source-file update'), managedAppId: seed.result.managedAppId, expectedAppRevision: 1 };
          key = seed.key;
        }
        if (scenario === 'lost-middle-response') h.fixture.state.dropCommitResponseOnNumber = h.fixture.state.commitCreateCount + 2;
        let before = h.fixture.state.requests.length, writes = h.fixture.state.writes.length;
        h.fixture.state.peak = 0; let start = performance.now();
        const sent = await h.submit(value, key);
        record(runner, scenario, sample, 'preview', start, before, writes);
        assert.equal(sent.response.status, 201); assert.equal(sent.result.status, 'preview_ready');
        before = h.fixture.state.requests.length; writes = h.fixture.state.writes.length; h.fixture.state.peak = 0; start = performance.now();
        const confirmed = await h.confirm(sent.result);
        record(runner, scenario, sample, 'confirm', start, before, writes);
        assert.equal(confirmed.status, 'registered');
        before = h.fixture.state.requests.length; writes = h.fixture.state.writes.length; h.fixture.state.peak = 0; start = performance.now();
        const retried = await h.submit(value, sent.key, sent.idempotency);
        record(runner, scenario, sample, 'same-key-retry', start, before, writes);
        assert.equal(retried.response.status, 201); assert.equal(retried.result.id, sent.result.id);
        assert.equal(retried.result.status, 'registered'); assert.equal(h.fixture.state.writes.length, writes);
      }
      console.log(JSON.stringify({ scenario, completedSample: sample + 1, samples }));
    }
  }
} finally { for (const runner of runners) await runner.h.close(); }
const summary = [];
for (const scenario of [...new Set(measurements.map(value => value.scenario))]) {
  for (const phase of ['preview', 'confirm', 'same-key-retry']) {
    for (const variant of variants) {
      const values = measurements.filter(value => value.variant === variant.name && value.scenario === scenario && value.phase === phase);
      const durations = values.map(value => value.elapsedMs).sort((a, b) => a - b);
      summary.push({ scenario, phase, variant: variant.name, samples: values.length,
        medianMs: durations[Math.floor(durations.length / 2)], minMs: durations[0], maxMs: durations.at(-1),
        requests: [...new Set(values.map(value => value.requests))], writes: [...new Set(values.map(value => value.writes))],
        recursiveTreePages: [...new Set(values.map(value => value.recursiveTreePages))], peak: Math.max(...values.map(value => value.peak)) });
    }
  }
}
await writeFile(output, JSON.stringify({ kind: 'measured-local-http-integration', node: process.version, delayMs, samples,
  excludes: ['AI preparation', 'Python collection', 'database/server bootstrap', 'production GitLab latency'],
  fixtures: 'loopback GitLab protocol service, real Fastify HTTP, PGlite PostgreSQL engine',
  variants: runners.map(({ name, root, sourceHash }) => ({ name, root, sourceHash })), summary, measurements }, null, 2));
console.log(JSON.stringify({ output, measurements: measurements.length, completed: true }));
