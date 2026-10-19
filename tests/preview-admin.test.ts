import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { startHarness } from './helpers/harness.js';
import { SHA, TOKEN, DEFAULT_TAG } from './helpers/gitlab-fixture.js';

const PASSWORD = 'fixture-only-preview-admin-password-53';
const BASE = '/api/preview-admin';
const tables = ['catalog_apps', 'published_snapshots', 'publications', 'catalog_tag_overrides', 'catalog_tag_cleanup_operations', 'managed_app_bindings', 'managed_publish_operations'];
const cookieFrom = (response: any) => String(response.headers['set-cookie']).split(';')[0];
const headers = (h: any, cookie?: string) => ({ host: new URL(h.origin).host, origin: h.origin, ...(cookie ? { cookie } : {}) });
async function login(h: any) {
  const response = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  return cookieFrom(response);
}
async function snapshot(h: any) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}

test('preview administration is opt-in and requires an independent strong configured password', async () => {
  const base = { PUBLIC_ORIGIN: 'https://plaza.example.invalid', GITLAB_URL: 'https://gitlab.example.invalid', DATABASE_URL: 'postgresql://unused', PLAZA_SECRET: 'fixture-only-publication-secret-at-least-32' };
  assert.equal((await loadConfig(base)).previewAdmin, undefined);
  for (const password of ['short', '中'.repeat(16), 'x'.repeat(513), 'x'.repeat(32) + '\n', base.PLAZA_SECRET]) {
    await assert.rejects(loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: password }), /管理员口令|PLAZA_PREVIEW_ADMIN_PASSWORD/);
  }
  assert.equal((await loadConfig({ ...base, PLAZA_PREVIEW_ADMIN_PASSWORD: PASSWORD })).previewAdmin?.password, PASSWORD);
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

test('admin sessions are HttpOnly, expire, rotate and revoke on logout without granting author-ticket powers', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
  const response = await h.app.inject({ method: 'POST', url: `${BASE}/session`, headers: headers(h), payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  const setCookie = String(response.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/preview-admin/); assert.match(setCookie, /Max-Age=1800/);
  assert.ok(!response.body.includes(PASSWORD));
  const first = cookieFrom(response);
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
  const secure = await createApp({ ...h.config, publicOrigin: 'https://plaza.example.invalid' }, h.db);
  t.after(() => secure.app.close());
  const response = await secure.app.inject({ method: 'POST', url: `${BASE}/session`, headers: { host: 'plaza.example.invalid', origin: 'https://plaza.example.invalid' }, payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200); assert.match(String(response.headers['set-cookie']), /; Secure/);
});

test('all-author enumeration filters confirmed records, paginates, hides credentials and performs zero business writes', async t => {
  const h = await startHarness(1, 'memory://', { previewAdmin: { password: PASSWORD } }); t.after(() => h.close());
  const publication = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  assert.equal(publication.status, 'preview_ready');
  async function seed(status: string, owner: string, expired = false, confirmed = false, withPreview = true) {
    const id = randomUUID();
    const preview = withPreview ? { ...publication.preview, ticket: 'must-not-forward-stored-ticket', digest: 'must-not-forward-digest', manifest: { ...publication.preview!.manifest, name: `私有-${owner}`, maintainers: [{ name: owner, nameEn: 'Fixture' }] } } : null;
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
