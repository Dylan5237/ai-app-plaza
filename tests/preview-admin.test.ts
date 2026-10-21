import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { loadConfig } from '../server/config.js';
import { startHarness } from './helpers/harness.js';
import { SHA, TOKEN, DEFAULT_TAG } from './helpers/gitlab-fixture.js';

const BASE = '/api/preview-admin';
const tables = ['catalog_apps', 'published_snapshots', 'publications', 'catalog_tag_overrides', 'catalog_tag_cleanup_operations', 'managed_app_bindings', 'managed_publish_operations'];
const headers = (h: any) => ({ host: new URL(h.origin).host, origin: h.origin });

async function snapshot(h: any) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}

test('preview administration has no password gate and only validates an optional trusted proxy IP', async () => {
  const base = { PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused', PLAZA_SECRET: 'fixture-only-publication-secret-at-least-32' };
  assert.equal((await loadConfig(base)).previewAdmin, undefined);
  assert.equal((await loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: 'legacy-password-is-ignored' })).previewAdmin, undefined);
  const withProxy = await loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PROXY_IP: '127.0.0.1' });
  assert.deepEqual(withProxy.previewAdmin, { trustedProxyIp: '127.0.0.1' });
  for (const proxy of ['127.0.0.1, 192.0.2.1', 'localhost', '0.0.0.0/0', 'fe80::1%eth0']) {
    await assert.rejects(loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PROXY_IP: proxy }), /PLAZA_PREVIEW_ADMIN_PROXY_IP/);
  }

  const privateHttp = { ...base, HOST: '192.168.2.145', PORT: '16090', PUBLIC_ORIGIN: 'http://192.168.2.145:16090', ALLOW_INSECURE_PORTAL: '1' };
  assert.equal((await loadConfig(privateHttp)).previewAdmin, undefined, 'preview reads inherit the portal HTTP setting without an admin-specific switch');
  await assert.rejects(loadConfig({ ...privateHttp, ALLOW_INSECURE_PORTAL: '0' }), /需要 HTTPS/);
});

test('any portal visitor can read the private preview list without cookies; session routes are absent and Host/Origin checks remain', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: {} }); t.after(() => h.close());
  const list = await h.app.inject({ url: `${BASE}/publications`, headers: headers(h) });
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.equal(list.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(list.headers['set-cookie'], undefined);
  const detail = await h.app.inject({ url: `${BASE}/publications/${randomUUID()}`, headers: headers(h) });
  assert.equal(detail.statusCode, 404);

  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    const response = await h.app.inject({ method, url: `${BASE}/session`, headers: headers(h), ...(method === 'POST' ? { payload: { password: 'ignored' } } : {}) });
    assert.equal(response.statusCode, 404, `${method} session endpoint must not exist`);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const foreignOrigin = await h.app.inject({ url: `${BASE}/publications`, headers: { ...headers(h), origin: 'https://attacker.example.invalid' } });
  assert.equal(foreignOrigin.statusCode, 403);
  const foreignHost = await h.app.inject({ url: `${BASE}/publications`, headers: { ...headers(h), host: 'attacker.example.invalid' } });
  assert.equal(foreignHost.statusCode, 403);
});

test('proxy identity validation is optional, rejects spoofing and repeated identity headers', async t => {
  const direct = await startHarness(); t.after(() => direct.close());
  const withoutProxy = await direct.app.inject({ url: `${BASE}/publications`, remoteAddress: '192.0.2.10', headers: { ...headers(direct), 'x-real-ip': '203.0.113.90', 'x-forwarded-for': '203.0.113.90' } });
  assert.equal(withoutProxy.statusCode, 200, 'direct access remains available when no trusted proxy is configured');

  const h = await startHarness(1, 'memory://', { previewAdmin: { trustedProxyIp: '127.0.0.1' } }); t.after(() => h.close());
  const get = (ip: string | undefined, remoteAddress = '127.0.0.1') => h.app.inject({ url: `${BASE}/publications`, remoteAddress,
    headers: { ...headers(h), ...(ip === undefined ? {} : { 'x-real-ip': ip }) } });
  assert.equal((await get('192.0.2.20')).statusCode, 200);
  for (const ip of ['not-an-ip', '192.0.2.20, 192.0.2.21', '', 'fe80::1%eth0']) assert.equal((await get(ip)).statusCode, 403);
  assert.equal((await get('192.0.2.20', '::ffff:127.0.0.1')).statusCode, 200, 'mapped loopback is the same configured proxy');
  assert.equal((await get('192.0.2.20', '192.0.2.99')).statusCode, 403, 'direct callers cannot forge a trusted header');
  assert.equal((await get(undefined)).statusCode, 403, 'a configured proxy must supply the client identity');

  const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(h.origin + `${BASE}/publications`, { headers: { ...headers(h), 'x-real-ip': ['192.0.2.20', '192.0.2.20'] } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(duplicateStatus, 403, 'duplicate identity headers are rejected on real HTTP');
});

test('preview administration has per-client limits isolated from the public proxy bucket', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { trustedProxyIp: '127.0.0.1' } }); t.after(() => h.close());
  const { createApp } = await import('../server/app.js');
  const limited = await createApp({ ...h.config, rateLimit: true }, h.db); t.after(() => limited.app.close());
  const adminGet = (ip: string) => limited.app.inject({ url: `${BASE}/publications`, remoteAddress: '127.0.0.1', headers: { ...headers(h), 'x-real-ip': ip } });
  for (let count = 0; count < 120; count++) assert.equal((await adminGet('192.0.2.10')).statusCode, 200);
  assert.equal((await adminGet('192.0.2.10')).statusCode, 429);
  assert.equal((await adminGet('192.0.2.11')).statusCode, 200, 'a different validated client has its own management bucket');

  for (let count = 0; count < 120; count++) assert.equal((await limited.app.inject({ url: '/api/health', headers: headers(h) })).statusCode, 200);
  assert.equal((await limited.app.inject({ url: '/api/health', headers: headers(h) })).statusCode, 429);
  assert.equal((await adminGet('192.0.2.11')).statusCode, 200, 'public proxy traffic must not consume the preview-admin bucket');
});

test('all-author enumeration filters confirmed records, paginates, preserves source and performs zero business writes', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: {} }); t.after(() => h.close());
  const publication = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  assert.equal(publication.status, 'preview_ready');
  async function seed(status: string, owner: string, expired = false, confirmed = false, withPreview = true) {
    const id = randomUUID();
    const preview = withPreview ? { ...publication.preview, ticket: 'must-not-forward-stored-ticket', digest: 'must-not-forward-digest', manifest: { ...publication.preview!.manifest, name: `私有-${owner}`, maintainers: [{ name: owner, nameEn: 'Fixture' }, 'Literal String Author'] } } : null;
    await h.db.query(`INSERT INTO publications (id, actor_id, idempotency_digest, request_hash, submission, status, candidate_app_id,
      preview_jsonb, next_action, expires_at, created_at, updated_at, confirmed_at, error_code, error_message, token_ciphertext)
      VALUES ($1, $2, $3, 'fixture', $4::jsonb, $5, $6, $7::jsonb, 'confirm', $8, now(), now(), $9, $10, $11, 'must-not-forward-encrypted-credential')`,
    [id, `actor-${owner}`, randomUUID(), JSON.stringify({ appKey: `fixture-${id}` }), status, randomUUID(), JSON.stringify(preview), new Date(Date.now() + (expired ? -3600000 : 3600000)), confirmed ? new Date() : null, status === 'failed' ? 'SOURCE_UNAVAILABLE' : null, status === 'failed' ? '测试来源暂不可用' : null]);
    return id;
  }
  const other = await seed('preview_ready', '另一作者');
  const expired = await seed('preview_ready', '过期作者', true);
  const failed = await seed('failed', '失败作者');
  const checking = await seed('checking', '核验作者', false, false, false);
  const excluded = [await seed('registered', '已收录'), await seed('cancelled', '已取消'), await seed('preview_ready', '已确认', false, true)];
  for (let i = 0; i < 21; i++) await seed('preview_ready', `分页作者${i}`);
  const before = await snapshot(h);
  const get = (path: string) => h.app.inject({ url: BASE + path, headers: headers(h) });
  const first = await get('/publications'); assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().counts, { all: 26, preview_ready: 23, expired: 1, checking: 1, failed: 1 });
  assert.equal(first.json().items.length, 20); assert.equal(first.json().total, 26);
  const second = await get('/publications?page=2'); assert.equal(second.json().items.length, 6);
  assert.equal(new Set([...first.json().items, ...second.json().items].map((x: any) => x.id)).size, 26);
  for (const status of ['expired', 'failed', 'checking']) {
    const response = await get(`/publications?status=${status}`); assert.equal(response.json().total, 1);
    assert.equal(response.json().items[0].id, ({ expired, failed, checking } as any)[status]);
  }
  const search = await get('/publications?query=' + encodeURIComponent('另一作者'));
  assert.equal(search.json().total, 1); assert.equal(search.json().items[0].id, other);
  for (const property of ['name', 'nameEn']) assert.equal((await get('/publications?query=' + property)).json().total, 0, 'maintainer JSON keys must not be searched');
  assert.ok((await get('/publications?query=Fixture')).json().total > 0, 'English maintainer values remain searchable');
  assert.ok((await get('/publications?query=String%20Author')).json().total > 0, 'string maintainers remain searchable');
  assert.equal((await get('/publications?query=' + encodeURIComponent('%'))).json().total, 0, 'search wildcard must be literal');
  for (const id of excluded) assert.equal((await get(`/publications/${id}`)).statusCode, 404);
  const detail = await get(`/publications/${other}`); assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().preview.manifest.maintainers[0].name, '另一作者');
  assert.ok(Object.keys(detail.json().preview.documents).length > 0);
  assert.deepEqual(detail.json().preview.source, publication.preview!.source, 'the source projection remains available to readers');
  for (const forbidden of ['ticket', 'digest', 'submission', 'token_ciphertext', 'actor_id']) assert.equal(Object.hasOwn(detail.json().preview, forbidden), false);
  for (const response of [first, second, detail]) for (const marker of [TOKEN, publication.ticket, 'must-not-forward', 'actor-', 'idempotency_digest', 'token_ciphertext']) {
    assert.ok(!response.body.includes(marker), `${marker} must not reach administration output`);
  }
  assert.equal((await get(`/publications/${expired}`)).json().expired, true);
  assert.ok(!(await get(`/publications/${checking}`)).json().preview);
  assert.equal((await get('/publications?page=0')).statusCode, 400);
  assert.equal((await get('/publications?status=registered')).statusCode, 400);
  const noAuthorTicket = await h.app.inject({ url: `/api/publications/${publication.id}`, headers: headers(h) });
  assert.equal(noAuthorTicket.statusCode, 404, 'management reads do not grant author-ticket access');
  for (const action of ['confirm', 'retry', 'cancel', 'delete']) assert.equal((await h.app.inject({ method: 'POST', url: `${BASE}/publications/${other}/${action}`, headers: headers(h), payload: {} })).statusCode, 404);
  for (const method of ['POST', 'PATCH', 'DELETE'] as const) assert.equal((await h.app.inject({ method, url: `${BASE}/publications/${other}`, headers: headers(h) })).statusCode, 404);
  assert.deepEqual(await snapshot(h), before, 'every business-table row must remain identical');
  assert.equal((await h.service.list()).total, 0);
  assert.equal(h.gitlab.state.requests.some((request: any) => !['GET', 'HEAD'].includes(request.method)), false);
});
