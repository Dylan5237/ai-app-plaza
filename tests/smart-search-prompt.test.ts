import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { startLlmFixture } from './helpers/llm-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { setAdministrator } from '../server/domain/platform-access.js';

async function setup(t: any) {
  const llm = await startLlmFixture();
  const h = await startIdentityHarness('', { superAdminAccount: 'fixture.admin', smartSearchAi: { baseUrl: llm.url, model: 'deepseek-flash', apiKey: 'fixture-key', timeoutMs: 3000 } });
  t.after(async () => { await h.close(); await llm.close(); });
  const admin = await h.login('fixture-admin');
  const member = await h.login('fixture-member');
  const seeded = await seedTagCatalog(h.db, h.config.audience, ['工时日报'], 60);
  const manifest = { ...seeded.source, name: '工时日报助手', summary: '整理并归档工时日报。' };
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [seeded.snapshotId, JSON.stringify(manifest), '日报 工时 整理']);
  const as = (who: { cookie: string }, method: 'GET' | 'PUT', body?: object) => h.app.inject({
    method, url: '/api/access/smart-search-prompt',
    headers: h.headers({ cookie: who.cookie, 'x-plaza-portal-token': who === admin ? 'fixture-admin' : 'fixture-member' }),
    ...(body ? { payload: body } : {}),
  });
  return { h, llm, admin, member, seeded, as };
}

test('the smart-search prompt is readable only by super administrators', async t => {
  const { h, admin, member, as } = await setup(t);
  const deniedMember = await as(member, 'GET');
  assert.equal(deniedMember.statusCode, 403);
  // A plain administrator is still not enough: the prompt shapes model behaviour for everyone.
  await setAdministrator(h.db, admin.user.id, { userId: member.user.id, role: 'administrator', revision: 0, requestId: randomUUID() });
  const deniedAdmin = await as(member, 'GET');
  assert.equal(deniedAdmin.statusCode, 403);
  const initial = await as(admin, 'GET');
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().template, null);
  assert.match(initial.json().defaultPrompt, /最多 3 个/);
  assert.equal(initial.json().limit, 6000);
});

test('a saved prompt overrides the default, takes effect immediately and replays idempotently', async t => {
  const { h, llm, admin, as } = await setup(t);
  const custom = '自定义检索提示：你是测试检索员。只输出 JSON {"picks":[],"question":null}。';
  const requestId = randomUUID();
  const save = (body: object) => as(admin, 'PUT', { confirmed: true, requestId, ...body });
  assert.equal((await save({ template: custom })).statusCode, 200);
  assert.deepEqual((await save({ template: custom })).json(), { recovered: true }, 'the same request replays without a second write');
  const viewed = await as(admin, 'GET');
  assert.equal(viewed.json().template, custom);
  assert.ok(viewed.json().updatedAt);
  llm.state.reply = () => ({ picks: [], question: null });
  await h.service.smartSearch('整理日报');
  assert.equal(llm.state.requests.at(-1)!.body.messages[0].content, custom, 'the model call uses the configured prompt');

  // A conflicting reuse of the same request id is refused.
  const conflict = await as(admin, 'PUT', { confirmed: true, requestId, template: '另一个提示词。' });
  assert.equal(conflict.statusCode, 409);

  // Resetting returns to the default template for subsequent searches.
  assert.equal((await as(admin, 'PUT', { confirmed: true, requestId: randomUUID(), template: null })).statusCode, 200);
  assert.equal((await as(admin, 'GET')).json().template, null);
  await h.service.smartSearch('整理日报');
  assert.match(llm.state.requests.at(-1)!.body.messages[0].content, /最多 3 个/);
  const audit = (await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE action='smart_search_prompt_changed'")).rows[0].n;
  assert.equal(Number(audit), 2, 'save and reset are both audited');
});

test('prompt payloads are validated and cleaned', async t => {
  const { admin, as } = await setup(t);
  assert.equal((await as(admin, 'PUT', { confirmed: true, requestId: randomUUID(), template: '' })).statusCode, 400);
  assert.equal((await as(admin, 'PUT', { confirmed: true, requestId: randomUUID(), template: 'x'.repeat(6001) })).statusCode, 400);
  const dirty = await as(admin, 'PUT', { confirmed: true, requestId: randomUUID(), template: `保留换行\n剥离\u0001控制字符` });
  assert.equal(dirty.statusCode, 200);
  const stored = (await as(admin, 'GET')).json().template;
  assert.equal(stored, '保留换行\n剥离控制字符', 'control characters are stripped, normal text is untouched');
});
