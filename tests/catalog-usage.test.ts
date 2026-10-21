import assert from 'node:assert/strict';
import test from 'node:test';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

type CatalogItem = { id: string; manifest: { name: string; entries: { kind: string }[] } };
type CatalogResult = {
  items: CatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  usageCounts: { platform: number; agent: number };
};

async function seedUsageCatalog(h: Awaited<ReturnType<typeof startHarness>>) {
  const apps: Array<{ appId: string; usage: 'platform' | 'agent'; index: number }> = [];
  for (const usage of ['platform', 'agent'] as const) {
    for (let index = 1; index <= 10; index++) {
      const isPlatform = usage === 'platform';
      const tags = index % 2 === 0 ? ['MCP'] : ['文档解析'];
      const seeded = await seedTagCatalog(h.db, h.config.audience, tags, apps.length + 1);
      const hasWeb = isPlatform;
      const entries = [
        ...(hasWeb ? [{ id: 'web', kind: 'web', label: '打开平台', url: 'https://example.invalid/app' }] : []),
        { id: 'agent', kind: 'agent', label: '接入 Agent', instructionsPath: `docs/agent-${apps.length + 1}.md`, compatibility: ['Codex'] },
      ];
      const name = isPlatform ? `Z 平台 ${String(index).padStart(2, '0')}` : `A Agent ${String(index).padStart(2, '0')}`;
      const source = { ...seeded.source, name, tags, entries, primaryEntry: hasWeb ? 'web' : 'agent' };
      const searchText = (index === 2 || (isPlatform && index === 4)) ? 'needle catalog fixture' : 'ordinary catalog fixture';
      await h.db.query(
        'UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1',
        [seeded.snapshotId, JSON.stringify(source), searchText],
      );
      apps.push({ appId: seeded.appId, usage, index });
    }
  }

  const offline = apps.find(app => app.usage === 'platform' && app.index === 10)!;
  const deleted = apps.find(app => app.usage === 'agent' && app.index === 10)!;
  await h.db.query(
    "INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) VALUES ($1, 'offline', 2, now()), ($2, 'deleted', 2, now())",
    [offline.appId, deleted.appId],
  );
  return apps;
}

test('catalog usage filters before count and pagination while preserving legacy ordering and visibility', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const seeded = await seedUsageCatalog(h);
  const foreign = await seedTagCatalog(h.db, '另一个发布范围', ['MCP'], 21);
  await h.db.query('UPDATE published_snapshots SET search_text = $2 WHERE id = $1', [foreign.snapshotId, 'needle catalog fixture']);
  const get = async (query = '') => {
    const response = await fetch(`${h.origin}/api/apps${query}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<CatalogResult>;
  };

  const legacy = await get('?pageSize=100');
  assert.equal(legacy.total, 18, 'offline and deleted applications remain hidden');
  assert.deepEqual(legacy.usageCounts, { platform: 9, agent: 9 });
  assert.match(legacy.items[0].manifest.name, /^A Agent /, 'omitting usage keeps the original name ordering');

  const all = await get('?usage=all&pageSize=100');
  assert.equal(all.total, 18);
  assert.deepEqual(all.usageCounts, { platform: 9, agent: 9 });
  assert.ok(!all.items.some(item => item.id === foreign.appId), 'usage classification does not weaken audience isolation');
  assert.deepEqual(all.items.slice(0, 9).map(item => item.manifest.name), Array.from({ length: 9 }, (_, i) => `Z 平台 ${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(all.items.slice(9).map(item => item.manifest.name), Array.from({ length: 9 }, (_, i) => `A Agent ${String(i + 1).padStart(2, '0')}`));

  for (const usage of ['platform', 'agent'] as const) {
    const first = await get(`?usage=${usage}&pageSize=6&page=1`);
    const second = await get(`?usage=${usage}&pageSize=6&page=2`);
    assert.equal(first.total, 9);
    assert.equal(second.total, 9);
    assert.deepEqual(first.usageCounts, usage === 'platform' ? { platform: 9, agent: 0 } : { platform: 0, agent: 9 });
    assert.equal(first.items.length, 6);
    assert.equal(second.items.length, 3);
    const pages = [...first.items, ...second.items];
    assert.equal(new Set(pages.map(item => item.id)).size, 9, 'filtered pages are disjoint');
    assert.ok(pages.every(item => item.manifest.entries.some(entry => (entry.kind === 'web') === (usage === 'platform'))));
  }

  const firstCombinationPage = await get('?usage=platform&query=needle&tags=MCP&pageSize=1&page=1');
  const secondCombinationPage = await get('?usage=platform&query=needle&tags=MCP&pageSize=1&page=2');
  assert.equal(firstCombinationPage.total, 2, 'search and tag constraints both apply to the filtered count');
  assert.deepEqual(firstCombinationPage.usageCounts, { platform: 2, agent: 0 });
  assert.equal(secondCombinationPage.total, 2);
  assert.deepEqual([...firstCombinationPage.items, ...secondCombinationPage.items].map(item => item.manifest.name), ['Z 平台 02', 'Z 平台 04']);
  const allCombination = await get('?usage=all&query=needle&tags=MCP&pageSize=100');
  assert.equal(allCombination.total, 3);
  assert.deepEqual(allCombination.usageCounts, { platform: 2, agent: 1 }, 'all reports both categories after search and tag filtering');
  const matchingAgent = await get('?usage=agent&query=needle&tags=MCP');
  assert.equal(matchingAgent.total, 1, 'the same search and tag match remains isolated to the agent category');

  const dualEntry = seeded.find(app => app.usage === 'platform' && app.index === 1)!;
  assert.ok(all.items.find(item => item.id === dualEntry.appId)?.manifest.entries.some(entry => entry.kind === 'agent'), 'dual-entry details remain intact');
  assert.ok((await get('?usage=platform&pageSize=100')).items.some(item => item.id === dualEntry.appId), 'a dual-entry app is classified as platform');
  assert.ok(!(await get('?usage=agent&pageSize=100')).items.some(item => item.id === dualEntry.appId), 'a dual-entry app is excluded from agent');

  assert.equal((await fetch(`${h.origin}/api/apps?usage=invalid`)).status, 400);
  await assert.rejects(h.service.list({ usage: 'invalid' as never }), error => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    return true;
  });
});
