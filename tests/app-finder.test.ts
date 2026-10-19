import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createAppFinder, type FinderMessage } from '../server/app-finder.js';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/domain/database.js';
import type { AppView, PlazaService } from '../server/domain/service.js';
import type { Config } from '../server/config.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const messages: FinderMessage[] = [{ role: 'user', content: '我想对接禅道，有什么 MCP 应用？' }];

function item(id: string, name: string, summary: string): AppView {
  return {
    id, version: '0.1.2', revision: 1,
    createdAt: '', updatedAt: '',
    source: { projectUrl: 'https://example.invalid', commitSha: 'a'.repeat(40) },
    documents: { 'private.md': 'DO_NOT_SEND_THIS_CONTENT_TO_MODEL' },
    manifest: {
      schemaVersion: '2', appKey: 'test-app', name, summary, projectVersion: '0.1.2',
      tags: ['MCP'], maintainers: [{ name: '测试作者', nameEn: 'Example Tester' }],
      capabilities: { scenarios: [summary], inputs: ['禅道任务'], outputs: ['查询结果'] },
      examples: [{ request: '查询禅道任务', expectedResult: '返回工单' }],
      requirements: ['授权访问禅道'], limitations: ['需要授权'],
      docs: { readme: 'README.md', usage: 'usage.md' },
      entries: [{ id: 'agent', kind: 'agent', label: '接入 Agent', instructionsPath: 'usage.md', compatibility: ['Codex'] }],
      primaryEntry: 'agent',
    },
  } as AppView;
}

function catalog(items: AppView[]): Pick<PlazaService, 'list'> {
  return {
    async list(options) {
      const page = options?.page ?? 1;
      return { items: items.slice((page - 1) * 8, page * 8), total: items.length, page, pageSize: 8 as const, tags: [] };
    },
  };
}

const apps = [
  item(ID, '禅道 MCP', '帮助 Agent 对接禅道并查询任务'),
  item(OTHER_ID, 'Word 助手', '处理 Word 文档和排版'),
];

test('base discovery only recommends relevant published items', async () => {
  const run = createAppFinder(catalog(apps));
  const result = await run(messages);
  assert.equal(result.mode, 'basic');
  assert.equal(result.cards[0]?.id, ID);
  assert.ok(result.notice?.includes('基础检索'));
  assert.ok(result.cards.every(card => apps.some(app => app.id === card.id)));
});

test('empty published catalog yields no cards and does not call model', async () => {
  const run = createAppFinder(catalog([]), { endpoint: 'https://example.invalid/v1/chat/completions', model: 'example', apiKey: 'example' }, async () => { throw Error('must not be called'); });
  const result = await run(messages);
  assert.deepEqual(result.cards, []);
  assert.match(result.answer, /还没有/);
});

test('model sees public manifest subset; forged app IDs cannot escape catalog', async () => {
  let body = '';
  const fakeFetch: typeof fetch = async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ appIds: ['00000000-0000-4000-8000-000000000000', ID] }) } }] }), { status: 200 });
  };
  const run = createAppFinder(catalog(apps), { endpoint: 'https://example.invalid/v1/chat/completions', model: 'example', apiKey: 'test-secret' }, fakeFetch);
  const result = await run(messages);
  assert.equal(result.mode, 'ai');
  assert.deepEqual(result.cards.map(card => card.id), [ID]);
  assert.ok(!body.includes('DO_NOT_SEND_THIS_CONTENT_TO_MODEL'));
  assert.ok(!body.includes('test-secret'));
  assert.ok(result.cards[0]?.matchedCapability.includes('禅道'));
});

test('provider errors explicitly downgrade to basic search without fake AI success', async () => {
  const fakeFetch: typeof fetch = async () => { throw new Error('internal provider failure'); };
  const run = createAppFinder(catalog(apps), { endpoint: 'https://example.invalid/v1/chat/completions', model: 'example', apiKey: 'example' }, fakeFetch);
  const result = await run(messages);
  assert.equal(result.mode, 'basic');
  assert.equal(result.cards[0]?.id, ID);
  assert.ok(result.notice?.includes('暂不可用'));
});

test('invalid model response downgrades instead of inventing result', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"appIds":"fake"}' } }] }), { status: 200 });
  const run = createAppFinder(catalog(apps), { endpoint: 'https://example.invalid/v1/chat/completions', model: 'example', apiKey: 'example' }, fakeFetch);
  const result = await run(messages);
  assert.equal(result.mode, 'basic');
  assert.ok(result.cards.every(card => apps.some(app => app.id === card.id)));
});

test('HTTP finder validates input and returns only published catalog entries', async t => {
  const db = await openDatabase({ path: 'memory://' });
  const config: Config = {
    host: '127.0.0.1', port: 4173, publicOrigin: 'http://127.0.0.1:4173',
    gitlabUrl: 'https://example.invalid', secret: 'finder-local-test-secret-with-more-than-32-chars',
    dataDir: '', local: true, audience: '所有能访问本门户的人',
    staticDir: resolve('not-built-test-static'), rateLimit: false,
  };
  const { app } = await createApp(config, db);
  t.after(async () => { await app.close(); await db.close(); });
  const call = (payload: unknown, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/app-finder/chat', payload,
    headers: { host: '127.0.0.1:4173', ...headers },
  });
  assert.equal((await call({ messages: [] })).statusCode, 400);
  assert.equal((await call({ messages: [{ role: 'user', content: 'x'.repeat(501) }] })).statusCode, 400);
  assert.equal((await call({ messages }, { origin: 'https://attacker.invalid' })).statusCode, 403);
  const found = await call({ messages });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json().cards, []);
});
