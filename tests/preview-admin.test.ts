import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { loadConfig } from '../server/config.js';
import { startHarness } from './helpers/harness.js';
import { SHA, TOKEN, DEFAULT_TAG } from './helpers/gitlab-fixture.js';

const PASSWORD = 'test@123';
const BASE = '/api/preview-admin';
const tables = ['catalog_apps', 'published_snapshots', 'publications', 'catalog_tag_overrides', 'catalog_tag_cleanup_operations', 'managed_app_bindings', 'managed_publish_operations'];
const cookieFrom = (response: any) => String(response.headers['set-cookie']).split(';')[0];
const headers = (h: any, cookie?: string) => ({ host: new URL(h.origin).host, origin: h.origin, ...(cookie ? { cookie } : {}) });
async function login(h: any) {
  const response = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().expiresInMs, 30 * 60 * 1000);
  return cookieFrom(response);
}
async function snapshot(h: any) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}

test('preview administration is opt-in and accepts an independent fixed configured password', async () => {
  const base = { PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused', PLAZA_SECRET: 'fixture-only-publication-secret-at-least-32', PLAZA_PREVIEW_ADMIN_PROXY_IP: '127.0.0.1' };
  assert.equal((await loadConfig(base)).previewAdmin, undefined);
  for (const password of ['x'.repeat(7), '中'.repeat(7), 'x'.repeat(513), 'x'.repeat(8) + '\n', 'x'.repeat(8) + '\u0000', base.PLAZA_SECRET]) {
    await assert.rejects(loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: password }), /管理员口令|PLAZA_PREVIEW_ADMIN_PASSWORD/);
  }
  assert.equal((await loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD })).previewAdmin?.password, PASSWORD);
  for (const proxy of ['', '127.0.0.1, 192.0.2.1', 'localhost', '0.0.0.0/0', 'fe80::1%eth0']) {
    await assert.rejects(loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD, PLAZA_PREVIEW_ADMIN_PROXY_IP: proxy }), /PLAZA_PREVIEW_ADMIN_PROXY_IP/);
  }
  await assert.rejects(loadConfig({ ...base, PUBLIC_ORIGIN: 'http://192.168.2.145:16090', ALLOW_INSECURE_PORTAL: '1', PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD }), /需要 HTTPS/);
  assert.equal((await loadConfig({ PLAZA_LOCAL: '1', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:4173', GITLAB_URL: base.GITLAB_URL, PLAZA_SECRET: base.PLAZA_SECRET, PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD })).previewAdmin?.password, PASSWORD);
});

test('unconfigured, unauthenticated and cross-origin callers cannot enumerate or read private previews', async t => {
  const disabled = await startHarness(); t.after(() => disabled.close());
  for (const path of ['/session', '/publications', `/publications/${randomUUID()}`]) {
    const response = await disabled.app.inject({ url: BASE + path, headers: headers(disabled) });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'PREVIEW_ADMIN_DISABLED');
  }
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
  for (const path of ['/session', '/publications', '/publications/not-a-uuid']) {
    const response = await h.app.inject({ url: BASE + path, headers: headers(h) });
    assert.equal(response.statusCode, 401, 'authorization must precede lookup and id parsing');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const wrong = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: 'wrong' } });
  assert.equal(wrong.statusCode, 401); assert.ok(!wrong.headers['set-cookie']);
  for (const origin of ['https://attacker.example.invalid', undefined]) {
    const requestHeaders: Record<string, string> = headers(h);
    if (origin) requestHeaders.origin = origin; else delete requestHeaders.origin;
    const response = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: requestHeaders, payload: { password: PASSWORD } });
    assert.equal(response.statusCode, 403);
    assert.ok(!response.headers['set-cookie']);
  }
  const host = await h.app.inject({ url: `${BASE}/publications`, headers: { ...headers(h), host: 'attacker.example.invalid' } });
  assert.equal(host.statusCode, 403);
});

test('intranet HTTP administration requires both explicit switches and the exact private listener', async () => {
  const base = { HOST: '192.168.2.145', PORT: '16090', PUBLIC_ORIGIN: 'http://192.168.2.145:16090', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused', PLAZA_SECRET: 'fixture-only-publication-secret-at-least-32', PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD, ALLOW_INSECURE_PORTAL: '1', ALLOW_INSECURE_PREVIEW_ADMIN: '1' };
  assert.equal((await loadConfig(base)).previewAdmin?.allowInsecureIntranet, true);
  for (const key of ['ALLOW_INSECURE_PORTAL', 'ALLOW_INSECURE_PREVIEW_ADMIN']) {
    for (const value of ['', '0', 'true']) await assert.rejects(loadConfig({ ...base, [key]: value }), /HTTPS/);
  }
  for (const ip of ['10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.0.1']) {
    assert.equal((await loadConfig({ ...base, HOST: ip, PUBLIC_ORIGIN: `http://${ip}:16090` })).previewAdmin?.allowInsecureIntranet, true);
  }
  for (const ip of ['example.invalid', 'localhost', '127.0.0.1', '0.0.0.0', '169.254.1.1', '100.64.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', '3232236177', '0xc0a80291', '192.168.002.145', '[::1]']) {
    await assert.rejects(loadConfig({ ...base, HOST: ip, PUBLIC_ORIGIN: `http://${ip}:16090` }), /HTTPS/);
  }
  for (const host of ['0.0.0.0', '127.0.0.1', '192.168.2.146', '::']) await assert.rejects(loadConfig({ ...base, HOST: host }), /HTTPS/);
  await assert.rejects(loadConfig({ ...base, PORT: '16091' }), /HTTPS/);
  await assert.rejects(loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PROXY_IP: '192.168.2.1' }), /直连模式不能配置/);
  const secure = { ...base, PUBLIC_ORIGIN: 'https://plaza.example.invalid' };
  await assert.rejects(loadConfig(secure), /PLAZA_PREVIEW_ADMIN_PROXY_IP/);
  assert.equal((await loadConfig({ ...secure, PLAZA_PREVIEW_ADMIN_PROXY_IP: '127.0.0.1' })).previewAdmin?.allowInsecureIntranet, undefined);
});

test('direct intranet HTTP keeps authentication and uses socket identity despite spoofed forwarding headers', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const { createApp } = await import('../server/app.js');
  const origin = 'http://192.168.2.145:16090';
  const config = { ...h.config, local: false, host: '192.168.2.145', port: 16090, publicOrigin: origin, rateLimit: true, previewAdmin: { password: PASSWORD, allowInsecureIntranet: true } };
  for (const invalid of [
    { publicOrigin: 'http://8.8.8.8:16090', host: '8.8.8.8' },
    { publicOrigin: 'http://192.168.002.145:16090' },
    { host: '0.0.0.0' }, { port: 16091 },
    { publicOrigin: 'https://plaza.example.invalid' }
  ]) await assert.rejects(createApp({ ...config, ...invalid }, h.db), /HTTPS|PLAZA_PREVIEW_ADMIN_PROXY_IP/);
  await assert.rejects(createApp({ ...config, previewAdmin: { ...config.previewAdmin, trustedProxyIp: '192.168.2.1' } }, h.db), /直连模式不能配置/);
  const direct = await createApp(config, h.db); t.after(() => direct.app.close());
  const reqHeaders = { host: new URL(origin).host, origin };
  const post = (ip: string, password: string, suffix: number) => direct.app.inject({ method: 'POST', url: `${BASE}/session`, remoteAddress: ip, headers: { ...reqHeaders, 'x-real-ip': `192.0.2.${suffix}`, 'x-forwarded-for': `192.0.2.${suffix}` }, payload: { password } });
  assert.equal((await direct.app.inject({ url: `${BASE}/publications`, headers: reqHeaders })).statusCode, 401);
  for (let i = 0; i < 5; i++) assert.equal((await post('192.168.2.10', 'wrong', i + 1)).statusCode, 401);
  assert.equal((await post('192.168.2.10', PASSWORD, 99)).statusCode, 429, 'forwarded identity cannot evade the socket login lock');
  const response = await post('192.168.2.20', PASSWORD, 1);
  assert.equal(response.statusCode, 200, 'different socket client remains usable');
  assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Strict; Max-Age=1800/);
  assert.doesNotMatch(String(response.headers['set-cookie']), /; Secure/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const cookie = cookieFrom(response);
  assert.equal((await direct.app.inject({ url: `${BASE}/publications`, headers: { ...reqHeaders, cookie }, remoteAddress: '192.168.2.20' })).statusCode, 200);
  assert.equal((await direct.app.inject({ method: 'POST', url: `${BASE}/session`, headers: { ...reqHeaders, origin: 'http://attacker.invalid' }, payload: { password: PASSWORD } })).statusCode, 403);
  assert.equal((await direct.app.inject({ url: `${BASE}/session`, headers: { ...reqHeaders, host: 'attacker.invalid', cookie } })).statusCode, 403);
  for (let i = 0; i < 120; i++) assert.equal((await direct.app.inject({ url: `${BASE}/session`, remoteAddress: '192.168.2.30', headers: { ...reqHeaders, 'x-real-ip': `192.0.2.${i + 1}` } })).statusCode, 401);
  assert.equal((await direct.app.inject({ url: `${BASE}/session`, remoteAddress: '192.168.2.30', headers: { ...reqHeaders, 'x-real-ip': '192.0.2.200' } })).statusCode, 429);
  assert.equal((await direct.app.inject({ method: 'DELETE', url: `${BASE}/session`, headers: { ...reqHeaders, cookie }, remoteAddress: '192.168.2.20' })).statusCode, 200);
  assert.equal((await direct.app.inject({ url: `${BASE}/publications`, headers: { ...reqHeaders, cookie }, remoteAddress: '192.168.2.20' })).statusCode, 401);
});

test('admin sessions are HttpOnly, expire, rotate and revoke on logout without granting author-ticket powers', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
  const response = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  const setCookie = String(response.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/preview-admin/); assert.match(setCookie, /Max-Age=1800/);
  assert.ok(!response.body.includes(PASSWORD));
  const first = cookieFrom(response);
  const checked = await h.app.inject({ url: `${BASE}/session`, headers: headers(h, first) });
  assert.ok(checked.json().expiresInMs > 0 && checked.json().expiresInMs <= response.json().expiresInMs);
  const secondResponse = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h, first), payload: { password: PASSWORD } });
  const second = cookieFrom(secondResponse); assert.notEqual(first, second);
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, first) })).statusCode, 401);
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, second) })).statusCode, 200);
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, `${second}; ${second}`) })).statusCode, 401);
  const realNow = Date.now;
  try {
    const time = realNow() + 31 * 60 * 1000;
    Date.now = () => time;
    assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, second) })).statusCode, 401);
  } finally { Date.now = realNow; }
  const third = await login(h);
  const foreign = await h.app.inject({ method: 'DELETE', url: `${BASE}/session`, headers: { ...headers(h, third), origin: 'https://attacker.example.invalid' } });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, third) })).statusCode, 200);
  const logout = await h.app.inject({ method: 'DELETE', url: `${BASE}/session`, headers: headers(h, third) });
  assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await h.app.inject({ url: `${BASE}/publications`, headers: headers(h, third) })).statusCode, 401);
});

test('repeated incorrect admin passwords are rate limited and HTTPS sessions are Secure', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
  for (let i = 0; i < 5; i++) assert.equal((await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: 'wrong' } })).statusCode, 401);
  const blocked = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: PASSWORD } });
  assert.equal(blocked.statusCode, 429); assert.ok(Number(blocked.headers['retry-after']) > 0);
  const { createApp } = await import('../server/app.js');
  await assert.rejects(createApp({ ...h.config, local: false, host: '0.0.0.0', publicOrigin: 'http://192.168.2.145:16090' }, h.db), /需要 HTTPS/);
  await assert.rejects(createApp({ ...h.config, publicOrigin: 'https://plaza.example.invalid' }, h.db), /PLAZA_PREVIEW_ADMIN_PROXY_IP/);
  const secure = await createApp({ ...h.config, publicOrigin: 'https://plaza.example.invalid', previewAdmin: { password: PASSWORD, trustedProxyIp: '127.0.0.1' } }, h.db);
  t.after(() => secure.app.close());
  const response = await secure.app.inject({ method: 'POST', url: `${BASE}/session`, headers: { host: 'plaza.example.invalid', origin: 'https://plaza.example.invalid', 'x-real-ip': '192.0.2.20' }, payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200); assert.match(String(response.headers['set-cookie']), /; Secure/);
});

test('only the configured proxy supplies client identity and one client cannot lock out another', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD, trustedProxyIp: '127.0.0.1' } }); t.after(() => h.close());
  const post = (ip: string, password: string, remoteAddress = '127.0.0.1') => h.app.inject({ method: 'POST', url: `${BASE}/session`, remoteAddress,
    headers: { ...headers(h), 'x-real-ip': ip }, payload: { password } });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await post('192.0.2.10', 'wrong')).statusCode, 401);
  assert.equal((await post('192.0.2.10', PASSWORD)).statusCode, 429);
  const admin = await post('192.0.2.20', PASSWORD); assert.equal(admin.statusCode, 200);
  for (const ip of ['not-an-ip', '192.0.2.20, 192.0.2.21', '', 'fe80::1%eth0']) assert.equal((await post(ip, PASSWORD)).statusCode, 403);
  assert.equal((await post('192.0.2.21', PASSWORD, '::ffff:127.0.0.1')).statusCode, 200, 'mapped loopback is the same proxy');
  assert.equal((await post('192.0.2.20', PASSWORD, '192.0.2.99')).statusCode, 403, 'direct callers cannot forge a trusted header');
  const cookie = cookieFrom(admin);
  assert.equal((await h.app.inject({ url: `${BASE}/publications`, headers: { ...headers(h, cookie), 'x-real-ip': '192.0.2.20' }, remoteAddress: '192.0.2.99' })).statusCode, 403);
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: headers(h, cookie) })).statusCode, 403, 'proxy must supply the client identity');
  assert.equal((await h.app.inject({ url: `${BASE}/session`, headers: { ...headers(h, cookie), 'x-real-ip': '192.0.2.20' } })).statusCode, 200);
  const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(h.origin + BASE + '/session', { headers: { ...headers(h, cookie), 'x-real-ip': ['192.0.2.20', '192.0.2.20'] } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(duplicateStatus, 403, 'duplicate identity headers are rejected on real HTTP');
});

test('production request limits isolate validated admin clients and the public proxy bucket', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD, trustedProxyIp: '127.0.0.1' } }); t.after(() => h.close());
  const { createApp } = await import('../server/app.js');
  const limited = await createApp({ ...h.config, rateLimit: true }, h.db); t.after(() => limited.app.close());
  const clientHeaders = (ip: string, cookie?: string) => ({ ...headers(h, cookie), 'x-real-ip': ip });
  const loggedIn = await limited.app.inject({ method: 'POST', url: `${BASE}/session`, headers: clientHeaders('192.0.2.20'), payload: { password: PASSWORD } });
  assert.equal(loggedIn.statusCode, 200); const cookie = cookieFrom(loggedIn);
  for (let count = 0; count < 120; count++) assert.equal((await limited.app.inject({ url: `${BASE}/session`, headers: clientHeaders('192.0.2.10') })).statusCode, 401);
  assert.equal((await limited.app.inject({ url: `${BASE}/session`, headers: clientHeaders('192.0.2.10') })).statusCode, 429);
  assert.equal((await limited.app.inject({ url: `${BASE}/session`, headers: clientHeaders('192.0.2.20', cookie) })).statusCode, 200, 'same route must have separate validated client buckets');
  for (let count = 0; count < 120; count++) assert.equal((await limited.app.inject({ url: '/api/health', headers: headers(h) })).statusCode, 200);
  assert.equal((await limited.app.inject({ url: '/api/health', headers: headers(h) })).statusCode, 429);
  assert.equal((await limited.app.inject({ url: `${BASE}/session`, headers: clientHeaders('192.0.2.20', cookie) })).statusCode, 200, 'public proxy traffic must not consume the admin bucket');
  assert.equal((await limited.app.inject({ url: `${BASE}/publications`, headers: clientHeaders('192.0.2.20', cookie) })).statusCode, 200);
  assert.equal((await limited.app.inject({ method: 'DELETE', url: `${BASE}/session`, headers: clientHeaders('192.0.2.20', cookie) })).statusCode, 200);
});

test('all-author enumeration filters confirmed records, paginates, hides credentials and performs zero business writes', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
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
  const cookie = await login(h);
  const before = await snapshot(h);
  const get = (path: string) => h.app.inject({ url: BASE + path, headers: headers(h, cookie) });
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
  for (const response of [first, second, detail]) for (const marker of [PASSWORD, TOKEN, publication.ticket, 'must-not-forward', 'actor-', 'idempotency_digest', 'token_ciphertext']) {
    assert.ok(!response.body.includes(marker), `${marker} must not reach administration output`);
  }
  assert.equal((await get(`/publications/${expired}`)).json().expired, true);
  assert.ok(!(await get(`/publications/${checking}`)).json().preview);
  assert.equal((await get('/publications?page=0')).statusCode, 400);
  assert.equal((await get('/publications?status=registered')).statusCode, 400);
  const noAuthorTicket = await h.app.inject({ url: `/api/publications/${publication.id}`, headers: headers(h, cookie) });
  assert.equal(noAuthorTicket.statusCode, 404);
  for (const action of ['confirm', 'retry', 'cancel', 'delete']) assert.equal((await h.app.inject({ method: 'POST', url: `${BASE}/publications/${other}/${action}`, headers: headers(h, cookie), payload: {} })).statusCode, 404);
  assert.deepEqual(await snapshot(h), before, 'every business-table row must remain identical');
  assert.equal((await h.service.list()).total, 0);
  assert.equal(h.gitlab.state.requests.some((request: any) => !['GET', 'HEAD'].includes(request.method)), false);
});
