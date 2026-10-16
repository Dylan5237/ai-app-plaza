import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import { createApp } from '../server/app.js';
import { openDatabase, type Database, type Queryable } from '../server/domain/database.js';
import { GitLabSourceReader } from '../server/domain/gitlab-source.js';
import { DEFAULT_TAG, SHA, TOKEN, startGitLabFixture } from './helpers/gitlab-fixture.js';
import { bundle, performanceHarness } from './helpers/managed-performance.js';

const input = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };

test('source reads share each directory page only within one authorized check and cap per-check concurrency', async t => {
  const fixture = await startGitLabFixture(); t.after(fixture.close);
  fixture.state.delayMs = 20;
  const reader = new GitLabSourceReader(fixture.url);
  await reader.withAuthor(input, TOKEN, async (_actor, load) => load());
  const trees = fixture.state.requests.filter(request => request.path.endsWith('/repository/tree'));
  assert.equal(trees.length, 2, 'root and docs are read once despite three declared paths');
  assert.equal(new Set(trees.map(request => request.query)).size, 2);
  assert.ok(fixture.state.peak >= 2 && fixture.state.peak <= 3);
  const count = fixture.state.requests.length;
  await reader.withAuthor(input, TOKEN, async (_actor, load) => load());
  assert.equal(fixture.state.requests.length - count, count, 'a new authorization check gets entirely fresh reads');
  fixture.state.role = 10;
  const before = fixture.state.requests.length;
  await assert.rejects(reader.withAuthor(input, TOKEN, async (_actor, load) => load()), /Maintainer/);
  assert.equal(fixture.state.requests.length - before, 2, 'no version/content reads before permission passes');
});

test('source checks share an instance capacity bound and settle cancelled sibling reads on failure', async t => {
  const fixture = await startGitLabFixture(); t.after(fixture.close); fixture.state.delayMs = 20;
  const reader = new GitLabSourceReader(fixture.url);
  await Promise.all(Array.from({ length: 8 }, () => reader.withAuthor(input, TOKEN, async (_actor, load) => load())));
  assert.ok(fixture.state.peak <= 6, 'all authorization scopes share the instance bound');
  fixture.state.tagSha = 'b'.repeat(40);
  await assert.rejects(reader.load(input, TOKEN), /可能已移动/);
  fixture.state.tagSha = SHA; fixture.state.role = 40;
  await reader.load(input, TOKEN);
  await pause(20);
  assert.equal(fixture.state.active, 0, 'all sockets and capacity are recovered');
});

test('publication insert wait does not consume the later source-read deadline', async t => {
  let gateNextPublicationInsert = false;
  let enterGate!: () => void;
  let releaseGate!: () => void;
  const entered = new Promise<void>(resolve => { enterGate = resolve; });
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const factories = {
    createApp,
    async openDatabase(options: Parameters<typeof openDatabase>[0]) {
      const db = await openDatabase(options);
      const gated = Object.create(db) as Database;
      gated.transaction = <T>(work: (tx: Queryable) => Promise<T>) => db.transaction(async tx => {
        const gatedTx = Object.create(tx) as Queryable;
        gatedTx.query = async <Row extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
          if (gateNextPublicationInsert && /^\s*INSERT INTO publications\b/i.test(sql)) {
            gateNextPublicationInsert = false;
            enterGate();
            await gate;
          }
          return tx.query<Row>(sql, params);
        };
        return work(gatedTx);
      });
      return gated;
    },
  };
  const h = await performanceHarness(0, factories);
  t.after(async () => { releaseGate(); await h.close(); });

  const realNow = performance.now;
  let controlledNow = realNow.call(performance);
  t.mock.method(performance, 'now', () => controlledNow);

  gateNextPublicationInsert = true;
  const submitted = h.submit(bundle());
  let gateTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => {
        gateTimeout = setTimeout(() => reject(new Error('managed submit did not reach the gated publication insert')), 20_000);
      }),
    ]);
  } finally {
    if (gateTimeout) clearTimeout(gateTimeout);
  }
  for (let attempt = 0; attempt < 100 && h.fixture.state.active > 0; attempt++) await pause(5);
  assert.equal(h.fixture.state.active, 0, 'authorization HTTP requests finish while the real DB transaction is held at its statement boundary');
  const authPaths = h.fixture.state.requests.slice(-2).map(request => request.path).sort();
  assert.deepEqual(authPaths, ['/api/v4/projects/100', '/api/v4/user']);
  const requestCountBeforeContentLoad = h.fixture.state.requests.length;

  // Hold an actual PGlite transaction at the publication insert and advance only
  // the monotonic deadline clock; no 30-second wall-clock sleep or product hook.
  controlledNow += 30_001;
  releaseGate();

  const first = await submitted;
  assert.equal(first.response.status, 201);
  assert.equal(first.result.status, 'preview_ready');
  assert.ok(h.fixture.state.requests.slice(requestCountBeforeContentLoad).length > 0, 'source HTTP reads start after the DB wait');
  assert.ok(h.fixture.state.requests.slice(requestCountBeforeContentLoad).some(request => {
    const requestUrl = new URL(request.path, h.fixture.url);
    return requestUrl.pathname.endsWith('/repository/tree') && requestUrl.searchParams.has('ref');
  }));
  const operation = (await h.db.query('SELECT status FROM managed_publish_operations')).rows[0]!;
  assert.equal(operation.status, 'submitted');

  const writesBeforeRetry = h.fixture.state.writes.length;
  const requestsBeforeRetry = h.fixture.state.requests.length;
  const retry = await h.submit(bundle(), first.key, first.idempotency);
  assert.equal(retry.result.id, first.result.id);
  assert.equal(retry.result.status, 'preview_ready');
  assert.equal(h.fixture.state.writes.length, writesBeforeRetry);
  assert.equal(h.fixture.state.requests.length, requestsBeforeRetry, 'same-key receipt retry does not repeat GitLab reads');
});

test('confirmation refreshes actor, permissions and original-byte content independently of preview caches', async t => {
  const h = await performanceHarness(); t.after(h.close);
  const first = await h.submit(bundle()); assert.equal(first.result.status, 'preview_ready');
  h.fixture.state.role = 10;
  assert.equal((await h.confirm(first.result)).error.code, 'PERMISSION_DENIED');
  assert.equal((await h.service.list()).total, 0);
  h.fixture.state.role = 40; h.fixture.state.userId = 99;
  const actorFailure = await h.service.retry(first.result.id, first.result.ticket);
  assert.equal(actorFailure.error?.code, 'PERMISSION_DENIED');
  h.fixture.state.userId = 35;
  const restored = await h.service.retry(first.result.id, first.result.ticket);
  assert.equal(restored.status, 'registered');
  const next = await h.submit({ ...bundle('1.1.0'), managedAppId: first.result.managedAppId, expectedAppRevision: 1 }, first.key);
  assert.equal(next.result.status, 'preview_ready');
  const project = [...h.fixture.state.projects.values()][0]!;
  const commit = project.commits.get(project.tags.get('v1.1.0')!)!;
  commit.files.set('README.md', Buffer.from('\ufeff# 协议测试应用'));
  assert.equal((await h.confirm(next.result)).error.code, 'SOURCE_MISMATCH');
  assert.equal((await h.service.list()).items[0]!.version, '1.0.0');
});
