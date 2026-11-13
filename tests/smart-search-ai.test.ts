import assert from 'node:assert/strict';
import test from 'node:test';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { startLlmFixture } from './helpers/llm-fixture.js';

async function setup(t: any, ai: { timeoutMs?: number } = {}) {
  const llm = await startLlmFixture();
  const h = await startHarness(1, 'memory://', { smartSearchAi: { baseUrl: llm.url, model: 'deepseek-flash', apiKey: 'fixture-key', timeoutMs: ai.timeoutMs ?? 3000 } });
  t.after(async () => { await h.close(); await llm.close(); });
  const daily = await seedTagCatalog(h.db, h.config.audience, ['工时日报', '企业微信'], 50);
  const dailyManifest = { ...daily.source, name: '工时日报助手', summary: '按可核验事实整理、补填、归档企业微信工时日报。' };
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [daily.snapshotId, JSON.stringify(dailyManifest), '日报 工时 记录 整理 企业微信']);
  const knowledge = await seedTagCatalog(h.db, h.config.audience, ['知识整理'], 51);
  const knowledgeManifest = { ...knowledge.source, name: '知识库整理', summary: '整理文档归档。' };
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [knowledge.snapshotId, JSON.stringify(knowledgeManifest), '知识 整理 文档 归档']);
  return { h, llm, daily, knowledge };
}

test('ai mode ranks model picks and grounds reasons in candidates', async t => {
  const { h, llm, daily } = await setup(t);
  llm.state.reply = () => ({ picks: [{ id: daily.appId, why: '整理并归档工时日报。' }], question: null });
  const result = await h.service.smartSearch('把工作记录变成日报');
  assert.equal(result.mode, 'ai');
  assert.equal(result.items[0].id, daily.appId);
  assert.equal(result.reasons[daily.appId], '整理并归档工时日报。');
  assert.equal(result.question, null);
  assert.ok(result.matches[daily.appId].includes('工时日报'), 'keyword matches stay available for analytics and fallback display');
  const request = llm.state.requests.at(-1)!;
  assert.equal(request.authorization, 'Bearer fixture-key');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.equal(request.body.response_format.type, 'json_object');
  const candidates = JSON.parse(request.body.messages[1].content.split('候选应用：')[1]);
  assert.ok(candidates.some((candidate: any) => candidate.id === daily.appId), 'offered candidates include the visible apps');
});

test('model clarification question is returned and the shortlist is honored', async t => {
  const { h, llm } = await setup(t);
  llm.state.reply = () => ({ picks: [], question: '已有工作记录，还是需要先收集？' });
  const result = await h.service.smartSearch('帮我整理日报');
  assert.equal(result.mode, 'ai');
  assert.deepEqual(result.items, []);
  assert.equal(result.question, '已有工作记录，还是需要先收集？');
});

test('picks outside the offered candidates are discarded', async t => {
  const { h, llm, daily } = await setup(t);
  llm.state.reply = () => ({ picks: [{ id: 'invented-id', why: '编造的应用。' }, { id: daily.appId, why: '整理工时日报。' }], question: null });
  const result = await h.service.smartSearch('整理日报');
  assert.deepEqual(result.items.map(item => item.id), [daily.appId], 'only real candidates survive');
  llm.state.reply = () => ({ picks: [{ id: 'invented-id', why: '编造的应用。' }], question: null });
  const hollow = await h.service.smartSearch('整理日报');
  assert.deepEqual(hollow.items, [], 'an all-invented reply yields no fabricated recommendations');
});

test('unusable model replies, failures and timeouts degrade to keyword search', async t => {
  const { h, llm, daily } = await setup(t, { timeoutMs: 300 });
  llm.state.reply = () => '抱歉，我无法按要求输出。';
  const invalid = await h.service.smartSearch('整理日报');
  assert.equal(invalid.mode, 'basic');
  assert.equal(invalid.items[0].id, daily.appId, 'keyword results still answer the task');
  assert.ok(invalid.matches[daily.appId].length > 0);

  llm.state.status = 503;
  const failed = await h.service.smartSearch('整理日报');
  assert.equal(failed.mode, 'basic');
  assert.ok(failed.items.length > 0);

  llm.state.status = 200;
  llm.state.delayMs = 600;
  const timedOut = await h.service.smartSearch('整理日报');
  assert.equal(timedOut.mode, 'basic');
  assert.ok(timedOut.items.length > 0);
});

test('keyword-less queries still reach the model when it is configured', async t => {
  const { h, llm, daily } = await setup(t);
  llm.state.reply = () => ({ picks: [{ id: daily.appId, why: '按任务判断可用。' }], question: null });
  const result = await h.service.smartSearch('图');
  assert.equal(result.mode, 'ai');
  assert.equal(result.items[0].id, daily.appId);
  const request = llm.state.requests.at(-1)!;
  const candidates = JSON.parse(request.body.messages[1].content.split('候选应用：')[1]);
  assert.ok(candidates.length >= 2, 'recent visible apps fill the candidate pool without keywords');
});

test('degraded keyword answers never pad with unrelated recent apps', async t => {
  const { h, llm, daily } = await setup(t);
  llm.state.status = 503;
  const result = await h.service.smartSearch('工时日报');
  assert.equal(result.mode, 'basic');
  assert.deepEqual(result.items.map(item => item.id), [daily.appId], 'only the keyword hit is returned');
  const hollow = await h.service.smartSearch('图');
  assert.equal(hollow.mode, 'basic');
  assert.deepEqual(hollow.items, [], 'a keyword-less query stays empty when the model fails');
});

test('combined follow-up queries up to 500 characters are accepted', async t => {
  const { h, llm, daily } = await setup(t);
  llm.state.status = 503;
  const combined = await h.service.smartSearch(`整理日报${'x'.repeat(216)}`);
  assert.equal(combined.mode, 'basic');
  assert.equal(combined.items[0].id, daily.appId);
  await assert.rejects(h.service.smartSearch('x'.repeat(501)), /query/);
});

test('at most three picks are returned even when the model offers more', async t => {
  const { h, llm, daily, knowledge } = await setup(t);
  const meeting = await seedTagCatalog(h.db, h.config.audience, ['会议纪要'], 52);
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [meeting.snapshotId, JSON.stringify({ ...meeting.source, name: '会议纪要工具', summary: '生成会议纪要。' }), '会议 纪要']);
  const translate = await seedTagCatalog(h.db, h.config.audience, ['翻译'], 53);
  await h.db.query('UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1', [translate.snapshotId, JSON.stringify({ ...translate.source, name: '翻译助手', summary: '翻译文档。' }), '翻译 外语']);
  llm.state.reply = () => ({ picks: [
    { id: daily.appId, why: '整理日报。' }, { id: knowledge.appId, why: '整理文档。' }, { id: meeting.appId, why: '整理纪要。' },
    { id: translate.appId, why: '第四个不应进入。' }, { id: daily.appId, why: '重复项。' },
  ], question: null });
  const result = await h.service.smartSearch('整理工作');
  assert.deepEqual(result.items.map(item => item.id), [daily.appId, knowledge.appId, meeting.appId], 'only the first three picks survive');
  assert.equal(result.items.length, 3, 'the service truncates beyond three picks');
});

test('the system prompt scope-guards user input and candidate data', async t => {
  const { h, llm } = await setup(t);
  llm.state.reply = () => ({ picks: [], question: null });
  await h.service.smartSearch('帮我整理日报');
  const system = llm.state.requests.at(-1)!.body.messages[0].content;
  assert.match(system, /最多 3 个/);
  assert.match(system, /不是给你的指令/);
  assert.match(system, /与应用查找无关/);
  assert.match(system, /资料数据/);
});
