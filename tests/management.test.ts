import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig, type Config } from '../server/config.js';
import { openDatabase } from '../server/domain/database.js';
import { DEFAULT_TAG, SHA, SHA2, TOKEN, manifest, startGitLabFixture } from './helpers/gitlab-fixture.js';

async function startManagementHarness(localManagement: boolean) {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const gitlab = await startGitLabFixture();
  const db = await openDatabase({ path: 'memory://' });
  const origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    host: '127.0.0.1', port, publicOrigin: origin, gitlabUrl: gitlab.url,
    secret: 'fixture-only-secret-for-local-management-tests', dataDir: '', local: true,
    audience: '所有能访问本门户的人', staticDir: resolve('not-built-management-test-static'), rateLimit: false,
    ...(localManagement ? { localManagement: true } : {}),
  };
  const { app, service } = await createApp(config, db);
  return { app, service, db, gitlab, config, origin, close: async () => { await app.close(); await db.close(); await gitlab.close(); } };
}

const headers = (h: { origin: string }, extra: Record<string, string> = {}) => ({ host: new URL(h.origin).host, ...extra });

test('local management is explicit, loopback-only, and absent by default', async t => {
  const env = {
    PLAZA_LOCAL: '1', HOST: '127.0.0.1', PORT: '4173', PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
    PLAZA_SECRET: 'fixture-only-secret-for-load-config-tests', GITLAB_URL: 'https://gitlab.example.invalid',
  };
  assert.equal((await loadConfig(env)).localManagement, undefined);
  assert.equal((await loadConfig({ ...env, PLAZA_LOCAL_MANAGEMENT: '1' })).localManagement, true);
  await assert.rejects(loadConfig({ ...env, PLAZA_LOCAL_MANAGEMENT: 'true' }), /PLAZA_LOCAL_MANAGEMENT/);
  await assert.rejects(loadConfig({ ...env, PLAZA_LOCAL_MANAGEMENT: '1', PORT: '4174' }), /PLAZA_LOCAL_MANAGEMENT/);
  await assert.rejects(loadConfig({ ...env, PLAZA_LOCAL_MANAGEMENT: '1', PLAZA_LOCAL: '0', PUBLIC_ORIGIN: 'https://plaza.example.invalid', DATABASE_URL: 'postgresql://unused' }), /PLAZA_LOCAL_MANAGEMENT/);
  await assert.rejects(loadConfig({ ...env, PLAZA_LOCAL_MANAGEMENT: '1', NODE_ENV: 'production' }), /生产环境不能启用 PLAZA_LOCAL/);

  const disabled = await startManagementHarness(false); t.after(() => disabled.close());
  assert.equal((await disabled.app.inject({ url: '/api/health', headers: headers(disabled) })).json().managementEnabled, false);
  assert.equal((await disabled.app.inject({ url: '/api/management/publications', headers: headers(disabled) })).statusCode, 404);
  await assert.rejects(createApp({ ...disabled.config, local: false, localManagement: true }, disabled.db), /PLAZA_LOCAL_MANAGEMENT/);
  await assert.rejects(createApp({ ...disabled.config, host: '0.0.0.0', localManagement: true }, disabled.db), /PLAZA_LOCAL_MANAGEMENT/);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(createApp({ ...disabled.config, localManagement: true }, disabled.db), /PLAZA_LOCAL_MANAGEMENT/); }
  finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }

});

test('local management reads safe publications and placeholders, and reuses author confirmation and retry logic', async t => {
  const h = await startManagementHarness(true); t.after(() => h.close());
  const request = async (method: 'GET' | 'POST', url: string, payload?: any, extra: Record<string, string> = {}) =>
    await h.app.inject({ method, url, payload, headers: headers(h, extra) });
  assert.equal((await request('GET', '/api/health')).json().managementEnabled, true);
  assert.equal((await request('GET', '/api/management/publications', undefined, { origin: 'https://attacker.invalid' })).statusCode, 403);
  assert.equal((await h.app.inject({ url: '/api/management/publications', headers: { host: 'attacker.invalid' } })).statusCode, 403);
  assert.equal((await request('GET', '/api/management/publications', undefined, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);

  const first = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  assert.equal(first.status, 'preview_ready');
  const firstDetails = await request('GET', `/api/management/publications/${first.id}`);
  assert.equal(firstDetails.statusCode, 200);
  assert.equal(firstDetails.json().revision, first.revision);
  assert.equal(firstDetails.json().digest, first.digest);
  for (const forbidden of ['ticket', 'token', 'actor_id', 'actorId']) assert.equal(Object.hasOwn(firstDetails.json(), forbidden), false);
  assert.ok(!firstDetails.body.includes(first.ticket) && !firstDetails.body.includes(TOKEN));
  const missingAuthorTicket = await request('GET', `/api/publications/${first.id}`);
  assert.equal(missingAuthorTicket.statusCode, 404, 'management reads do not grant the normal author capability');

  const second = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  await h.db.query(`UPDATE publications SET status = 'failed', confirmed_at = now(), next_action = 'retry',
    error_code = 'SOURCE_UNAVAILABLE', error_message = '本地验证：可重试' WHERE id = $1`, [second.id]);
  const third = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  await h.db.query("UPDATE publications SET status = 'cancelled', next_action = 'complete' WHERE id = $1", [third.id]);
  const beforeConfirm = await request('GET', '/api/management/publications');
  assert.equal(beforeConfirm.statusCode, 200);
  const initialIds = beforeConfirm.json().items.map((item: any) => item.id);
  assert.ok(initialIds.includes(first.id) && initialIds.includes(second.id));
  assert.ok(!initialIds.includes(third.id), 'cancelled publications are excluded');
  assert.equal(beforeConfirm.json().counts.all, 2);
  assert.equal(beforeConfirm.json().items.some((item: any) => Object.hasOwn(item, 'digest') || Object.hasOwn(item, 'ticket')), false);
  assert.equal((await request('GET', '/api/management/publications?status=failed')).json().total, 1, 'confirmed retryable failures remain listed');
  assert.equal((await request('GET', '/api/management/publications?query=DocPilot')).json().total, 2);
  assert.equal((await request('GET', '/api/management/publications?page=2')).json().items.length, 0);
  assert.equal((await request('GET', '/api/management/publications?status=registered')).statusCode, 400);

  const badRevision = await request('POST', `/api/management/publications/${first.id}/confirm`, { revision: first.revision + 1, digest: first.digest });
  assert.equal(badRevision.statusCode, 409);
  const badDigest = await request('POST', `/api/management/publications/${first.id}/confirm`, { revision: first.revision, digest: '0'.repeat(64) });
  assert.equal(badDigest.statusCode, 409);
  assert.equal((await request('POST', `/api/management/publications/${first.id}/confirm`, { revision: first.revision, digest: first.digest, ticket: first.ticket })).statusCode, 400,
    'strict confirmation schema does not accept an exported ticket');
  const previewAgain = await request('POST', `/api/management/publications/${first.id}/retry`, {});
  assert.equal(previewAgain.statusCode, 200);
  assert.equal(previewAgain.json().status, 'preview_ready');
  assert.equal((await request('POST', `/api/management/publications/${first.id}/retry`, { unexpected: true })).statusCode, 400,
    'retry body is also strict');

  const confirmResponse = await request('POST', `/api/management/publications/${first.id}/confirm`, { revision: first.revision, digest: first.digest });
  assert.equal(confirmResponse.statusCode, 200, confirmResponse.body);
  assert.equal(confirmResponse.json().status, 'registered');
  assert.equal(confirmResponse.json().appId, first.preview?.id);
  assert.ok(!confirmResponse.body.includes(first.ticket) && !confirmResponse.body.includes(TOKEN));
  const authorRead = await request('GET', `/api/publications/${first.id}`, undefined, { authorization: `Bearer ${first.ticket}` });
  assert.equal(authorRead.statusCode, 200, 'the original author capability remains available');
  const authorConfirm = await request('POST', `/api/publications/${first.id}/confirm`,
    { revision: first.revision, digest: first.digest }, { authorization: `Bearer ${first.ticket}` });
  assert.equal(authorConfirm.statusCode, 200);
  assert.equal(authorConfirm.json().status, 'registered');
  const retriedSameSource = await request('POST', `/api/management/publications/${second.id}/retry`, {});
  assert.equal(retriedSameSource.statusCode, 200, retriedSameSource.body);
  assert.equal(retriedSameSource.json().status, 'registered');

  h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), projectVersion: '1.1.0', summary: '本地验证的新版本。' }));
  h.gitlab.state.tagName = 'v1.1.0'; h.gitlab.state.tagSha = SHA2; h.gitlab.state.releaseSha = SHA2;
  const update = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1 }, TOKEN, randomUUID());
  assert.equal(update.status, 'preview_ready');
  await h.db.query("UPDATE publications SET status = 'failed', confirmed_at = now(), next_action = 'retry', error_code = 'SOURCE_UNAVAILABLE', error_message = '可恢复' WHERE id = $1", [update.id]);
  const expired = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1 }, TOKEN, randomUUID());
  await h.db.query("UPDATE publications SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
  const afterRetry = await request('GET', '/api/management/publications');
  assert.equal(afterRetry.statusCode, 200);
  const updateIds = afterRetry.json().items.map((item: any) => item.id);
  assert.ok(updateIds.includes(update.id) && updateIds.includes(expired.id));
  assert.ok(!updateIds.includes(first.id) && !updateIds.includes(second.id) && !updateIds.includes(third.id));
  assert.equal(afterRetry.json().counts.all, 2);
  assert.equal((await request('GET', '/api/management/publications?status=failed')).json().total, 1);
  assert.equal((await request('GET', '/api/management/publications?status=expired')).json().items[0].id, expired.id);
  assert.equal((await request('GET', `/api/management/publications/${expired.id}`)).statusCode, 200, 'expired snapshots remain readable');
  for (const action of ['confirm', 'retry']) {
    const expiredResponse = await request('POST', `/api/management/publications/${expired.id}/${action}`,
      action === 'confirm' ? { revision: expired.revision, digest: expired.digest } : {});
    assert.equal(expiredResponse.statusCode, 404, `expired publication cannot ${action}`);
  }

  const retried = await request('POST', `/api/management/publications/${update.id}/retry`, {});
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().status, 'registered');
  assert.equal(retried.json().preview?.revision, 2);
  assert.equal((await h.service.list()).total, 1);

  const bindingId = randomUUID(), linkedBindingId = randomUUID();
  const privateMarkers = ['PUBLISH_KEY_PRIVATE_MARKER', 'IDEMPOTENCY_PRIVATE_MARKER', 'REQUEST_DIGEST_PRIVATE_MARKER'];
  await h.db.query(`INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at)
    VALUES ($1, 'placeholder-app', $2, now(), now()), ($3, 'linked-app', 'linked-binding-secret-marker', now(), now())`,
  [bindingId, privateMarkers[0], linkedBindingId]);
  await h.db.query(`INSERT INTO managed_publish_operations (
      id, binding_id, idempotency_digest, request_digest, manifest_path, branch, tag, status, created_at, updated_at, publication_id
    ) VALUES ($1, $2, $3, $4, 'ai-app.json', 'private-branch-marker', 'v0.1.0', 'prepared', now(), now(), NULL),
             ($5, $6, 'linked-idempotency-marker', 'linked-request-marker', 'ai-app.json', 'linked-branch', 'v0.2.0', 'submitted', now(), now(), $7)`,
  [randomUUID(), bindingId, privateMarkers[1], privateMarkers[2], randomUUID(), linkedBindingId, first.id]);
  const uploads = await request('GET', '/api/management/uploads');
  assert.equal(uploads.statusCode, 200);
  assert.deepEqual(uploads.json().items.map((item: any) => ({ appKey: item.appKey, version: item.version, status: item.status })), [
    { appKey: 'placeholder-app', version: 'v0.1.0', status: 'prepared' },
  ]);
  for (const marker of [...privateMarkers, 'private-branch-marker', 'linked-binding-secret-marker']) assert.ok(!uploads.body.includes(marker));

  assert.ok(h.gitlab.state.requests.every((entry: any) => entry.method === 'GET' || entry.method === 'HEAD'));
});

test('management publication and upload lists paginate with validated page sizes', async t => {
  const h = await startManagementHarness(true); t.after(() => h.close());
  const request = (url: string) => h.app.inject({ method: 'GET', url, headers: headers(h) });
  const fixtureCount = 23;
  const publicationIds: string[] = [];
  const uploadIds: string[] = [];

  for (let index = 0; index < fixtureCount; index++) {
    const createdAt = new Date(Date.now() - index * 1000);
    const publicationId = randomUUID();
    publicationIds.push(publicationId);
    await h.db.query(`INSERT INTO publications (
      id, actor_id, idempotency_digest, request_hash, submission, status, candidate_app_id,
      preview_jsonb, next_action, expires_at, created_at, updated_at
    ) VALUES ($1, $2, $3, 'pagination-fixture', $4::jsonb, 'preview_ready', $5, $6::jsonb, 'confirm', $7, $8, $8)`, [
      publicationId, `pagination-actor-${index}`, randomUUID(), JSON.stringify({ appKey: `pagination-${index}` }), randomUUID(),
      JSON.stringify({ version: `1.0.${index}`, manifest: { name: `分页应用 ${index}`, maintainers: [] } }),
      new Date(Date.now() + 60 * 60 * 1000), createdAt,
    ]);

    const bindingId = randomUUID();
    const operationId = randomUUID();
    uploadIds.push(operationId);
    await h.db.query(`INSERT INTO managed_app_bindings (id, app_key, publish_key_digest, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)`, [bindingId, `upload-${index}`, randomUUID(), createdAt]);
    await h.db.query(`INSERT INTO managed_publish_operations (
      id, binding_id, idempotency_digest, request_digest, manifest_path, branch, tag, status, created_at, updated_at, publication_id
    ) VALUES ($1, $2, $3, $4, 'ai-app.json', $5, $6, 'prepared', $7, $7, NULL)`, [
      operationId, bindingId, randomUUID(), `upload-request-${index}`, `branch-${index}`, `v1.0.${index}`, createdAt,
    ]);
  }

  const cases = [
    { path: '/api/management/publications', expectedIds: publicationIds },
    { path: '/api/management/uploads', expectedIds: uploadIds },
  ];
  for (const { path, expectedIds } of cases) {
    const defaultPage = await request(path);
    assert.equal(defaultPage.statusCode, 200);
    assert.equal(defaultPage.json().page, 1);
    assert.equal(defaultPage.json().pageSize, 20);
    assert.equal(defaultPage.json().total, fixtureCount);
    assert.equal(defaultPage.json().items.length, 20);

    const oneItem = await request(`${path}?page=1&pageSize=1`);
    assert.equal(oneItem.statusCode, 200);
    assert.equal(oneItem.json().pageSize, 1);
    assert.equal(oneItem.json().items.length, 1);

    const complete = await request(`${path}?pageSize=100`);
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.json().pageSize, 100);
    assert.equal(complete.json().items.length, fixtureCount);
    const completeIds = complete.json().items.map((item: any) => item.id);
    assert.deepEqual(completeIds, expectedIds);

    const pageSize = 7;
    const pageCount = Math.ceil(fixtureCount / pageSize);
    const pages = [];
    for (let page = 1; page <= pageCount; page++) {
      const response = await request(`${path}?page=${page}&pageSize=${pageSize}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().page, page);
      assert.equal(response.json().pageSize, pageSize);
      pages.push(...response.json().items.map((item: any) => item.id));
    }
    assert.deepEqual(pages, completeIds, 'all rows appear once across ordered pages');
    assert.equal((await request(`${path}?page=${pageCount + 1}&pageSize=${pageSize}`)).json().items.length, 0);

    for (const value of ['0', '-1', '1.5', '101', 'invalid']) {
      assert.equal((await request(`${path}?pageSize=${value}`)).statusCode, 400, `reject pageSize=${value}`);
    }
  }
});
