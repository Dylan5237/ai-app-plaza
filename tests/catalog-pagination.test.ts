import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('catalog supports bounded page sizes with consistent offsets and filters', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  for (let i = 1; i <= 13; i++) await seedTagCatalog(h.db, h.config.audience, [i <= 9 ? 'MCP' : '文档解析'], i);
  const get = async (query = '') => {
    const response = await fetch(`${h.origin}/api/apps${query}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ items: { id: string }[]; page: number; pageSize: number; total: number }>;
  };
  assert.equal((await get()).items.length, 8, 'omitting pageSize preserves existing callers');
  const first = await get('?pageSize=12');
  const last = await get('?pageSize=12&page=2');
  assert.equal(first.total, 13);
  assert.equal(first.pageSize, 12);
  assert.equal(first.items.length, 12);
  assert.equal(last.items.length, 1);
  assert.equal(new Set([...first.items, ...last.items].map(app => app.id)).size, 13);
  assert.equal((await get('?pageSize=100')).items.length, 13);
  assert.equal((await get('?pageSize=1&page=13')).items[0].id, last.items[0].id);
  const filtered = await get('?pageSize=12&tags=MCP&query=MCP');
  assert.equal(filtered.total, 9);
  assert.equal(filtered.items.length, 9);
  for (const value of ['0', '-1', '1.5', '101', 'NaN', '']) {
    assert.equal((await fetch(`${h.origin}/api/apps?pageSize=${value}`)).status, 400, value);
  }
  for (const pageSize of [0, -1, 1.5, 101, NaN]) {
    await assert.rejects(h.service.list({ pageSize }), /pageSize/);
  }
});
