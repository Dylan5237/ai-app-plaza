import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { catalogAppSelect, sampleCatalog } from '../server/domain/service.js';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

test('updated order uses the active snapshot before pagination, with stable name/id ties', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const seeded = [];
  for (let i = 0; i < 15; i++) {
    const app = await seedTagCatalog(h.db, h.config.audience, [i % 2 ? 'MCP' : '文档解析'], i + 1);
    const date = `2026-02-${String(1 + (i * 7) % 5).padStart(2, '0')}T00:00:00.000Z`;
    const name = i % 3 ? 'A 同名' : 'Z 应用';
    const source = { ...app.source, name, entries: i % 2 ? app.source.entries : [{ id: 'web', kind: 'web', label: 'Web', url: 'https://example.invalid' }] };
    await h.db.query('UPDATE published_snapshots SET created_at = $2, manifest = $3::jsonb, search_text = $4 WHERE id = $1', [app.snapshotId, date, JSON.stringify(source), 'needle']);
    // Mutable application timestamps must not outrank the effective snapshot date.
    await h.db.query('UPDATE catalog_apps SET updated_at = $2 WHERE id = $1', [app.appId, '2026-12-01T00:00:00Z']);
    seeded.push({ id: app.appId, date, name, tag: i % 2 ? 'MCP' : '文档解析' });
  }
  const expected = seeded.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const get = async (query: string) => {
    const res = await fetch(`${h.origin}/api/apps?${query}`);
    assert.equal(res.status, 200);
    return res.json() as Promise<any>;
  };
  const first = await get('sort=updated&usage=all&pageSize=8');
  const second = await get('sort=updated&usage=all&pageSize=8&page=2');
  assert.deepEqual([...first.items, ...second.items].map(x => x.id), expected.map(x => x.id));
  assert.deepEqual([...first.items, ...second.items].map(x => x.updatedAt), expected.map(x => x.date));
  const filtered = await get('sort=updated&tags=MCP&query=needle&pageSize=3&page=2');
  assert.equal(filtered.total, 7);
  assert.deepEqual(filtered.items.map((x: any) => x.id), expected.filter(x => x.tag === 'MCP').slice(3, 6).map(x => x.id));
  const legacy = await get('pageSize=100');
  assert.deepEqual(legacy.items.map((x: any) => x.id), [...seeded].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(x => x.id));
  assert.ok(legacy.items.every((x: any) => x.updatedAt === '2026-12-01T00:00:00.000Z'));
  assert.equal((await fetch(`${h.origin}/api/apps?sort=invalid`)).status, 400);
  await assert.rejects(h.service.list({ sort: 'invalid' as never }), /sort/);
});

test('random sampling is equal weight without replacement and prioritizes the other pool', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
  const firstCounts = Array(7).fill(0), omittedCounts = Array(7).fill(0);
  let permutations = 0;
  function enumerate(choices: number[]) {
    if (choices.length === 6) {
      let cursor = 0;
      const batch = sampleCatalog(items, [], max => {
        assert.equal(max, 7 - cursor);
        return choices[cursor++]!;
      });
      assert.equal(new Set(batch.map(x => x.id)).size, 6);
      firstCounts[Number(batch[0]!.id)]++;
      omittedCounts[Number(items.find(x => !batch.includes(x))!.id)]++;
      permutations++;
      return;
    }
    for (let i = 0; i < 7 - choices.length; i++) enumerate([...choices, i]);
  }
  enumerate([]);
  assert.equal(permutations, 5040);
  assert.deepEqual(firstCounts, Array(7).fill(720));
  assert.deepEqual(omittedCounts, Array(7).fill(720));
  const previous = items.slice(0, 6).map(x => x.id);
  assert.equal(sampleCatalog(items, previous, () => 0)[0]!.id, '6');
  assert.deepEqual(items.map(x => x.id), ['0', '1', '2', '3', '4', '5', '6'], 'sampling does not mutate the candidate list');
});

test('random API covers 0/1/6/7/13, visibility, exclusions and public entry availability', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const get = async (ids: string[] = []) => {
    const params = new URLSearchParams(ids.map(id => ['exclude', id]));
    const res = await fetch(`${h.origin}/api/apps/random?${params}`);
    assert.equal(res.status, 200);
    return res.json() as Promise<{ items: any[]; allShown: boolean }>;
  };
  assert.deepEqual(await get(), { items: [], allShown: true });
  const ids: string[] = [];
  for (let i = 1; i <= 13; i++) {
    ids.push((await seedTagCatalog(h.db, h.config.audience, ['MCP'], i)).appId);
    if (![1, 6, 7, 13].includes(i)) continue;
    const batch = await get();
    assert.equal(batch.items.length, Math.min(i, 6));
    assert.equal(batch.allShown, i <= 6);
    assert.equal(new Set(batch.items.map(x => x.id)).size, batch.items.length);
    assert.ok(batch.items.every(x => ids.includes(x.id) && Object.keys(x.documents).length === 0));
    const previous = batch.items.map(x => x.id);
    const next = await get(previous);
    assert.equal(next.items.filter(x => !previous.includes(x.id)).length, Math.min(6, i - previous.length));
  }
  const offline = await seedTagCatalog(h.db, h.config.audience, ['MCP'], 14);
  const deleted = await seedTagCatalog(h.db, h.config.audience, ['MCP'], 15);
  const foreign = await seedTagCatalog(h.db, 'other-audience', ['MCP'], 16);
  const pending = await seedTagCatalog(h.db, h.config.audience, ['MCP'], 17);
  await h.db.query("INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) VALUES ($1, 'offline', 2, now()), ($2, 'deleted', 2, now())", [offline.appId, deleted.appId]);
  await h.db.query('UPDATE catalog_apps SET current_snapshot_id = NULL WHERE id = $1', [pending.appId]);
  // Leaving one visible item makes leakage checks deterministic, including allShown.
  for (const id of ids.slice(1)) await h.db.query("INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) VALUES ($1, 'offline', 2, now())", [id]);
  assert.deepEqual((await get()).items.map(x => x.id), ids.slice(0, 1));
  assert.equal((await get()).allShown, true);
  for (const app of [offline, deleted, foreign, pending]) {
    assert.equal((await fetch(`${h.origin}/api/apps/${app.appId}`)).status, 404);
    assert.equal((await fetch(`${h.origin}/api/apps/${app.appId}/instructions/agent`)).status, 404);
  }
  assert.equal((await fetch(`${h.origin}/api/apps/random?exclude=invalid`)).status, 400);
  assert.equal((await fetch(`${h.origin}/api/apps/random?${new URLSearchParams(ids.slice(0, 7).map(id => ['exclude', id]))}`)).status, 400);
  assert.equal((await get([ids[0]!, ids[0]!])).items.length, 1);
  await assert.rejects(h.service.random(['invalid']), /exclude/);

  const profile = JSON.parse(await readFile(new URL('../server/contracts/legacy-distribution-profiles.json', import.meta.url), 'utf8')).disabledEntries[0];
  const blocked = await seedTagCatalog(h.db, h.config.audience, ['MCP'], 18);
  const manifest = { ...blocked.source, appKey: profile.appKey, primaryEntry: profile.entryId, entries: [{ id: profile.entryId, kind: 'agent', label: '接入', instructionsPath: 'docs/agent-18.md', compatibility: [] }] };
  await h.db.query('UPDATE catalog_apps SET instance_id = $2, project_id = $3, app_key = $4 WHERE id = $1', [blocked.appId, profile.instanceId, profile.projectId, profile.appKey]);
  await h.db.query('UPDATE published_snapshots SET commit_sha = $2, manifest = $3::jsonb WHERE id = $1', [blocked.snapshotId, profile.commitSha, JSON.stringify(manifest)]);
  const detail = await h.service.app(blocked.appId);
  for (const result of [await get(), await h.service.list({ sort: 'updated' })]) {
    assert.deepEqual(result.items.find(x => x.id === blocked.appId)!.entryAvailability, detail.entryAvailability);
  }
  assert.equal((await h.service.list()).items.find(x => x.id === blocked.appId)!.entryAvailability, undefined, 'legacy response stays unchanged');
});

test('directory reads leave expired publication credentials to the scheduled cleanup', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const app = await seedTagCatalog(h.db, h.config.audience, ['MCP']);
  const entry = app.source.entries.find((item: any) => item.kind === 'agent');
  assert.ok(entry, 'fixture includes an Agent entry');
  const publicationId = randomUUID();
  await h.db.query(`INSERT INTO publications(id,actor_id,idempotency_digest,request_hash,submission,status,candidate_app_id,
    token_ciphertext,token_iv,token_auth_tag,next_action,expires_at,created_at,updated_at)
    VALUES($1,'fixture',$2,'request','{}'::jsonb,'failed',$3,'ciphertext','iv','auth-tag','none',now()-interval '1 minute',now(),now())`,
  [publicationId, randomUUID(), randomUUID()]);

  await h.service.list();
  await h.service.app(app.appId);
  await h.service.instructions(app.appId, entry.id);
  assert.equal((await h.db.query('SELECT token_ciphertext FROM publications WHERE id=$1', [publicationId])).rows[0].token_ciphertext, 'ciphertext',
    'list, detail and instructions reads do not perform the periodic token cleanup');
  await h.service.cleanupExpiredTokens();
  assert.equal((await h.db.query('SELECT token_ciphertext FROM publications WHERE id=$1', [publicationId])).rows[0].token_ciphertext, null,
    'the scheduled cleanup still removes expired credentials');
});

test('catalog document selection fails closed on an unrecognized projection', () => {
  assert.throws(() => catalogAppSelect('mismatched' as any), /Unknown catalog document selection/);
  assert.match(catalogAppSelect('full'), /s\.documents/);
  assert.doesNotMatch(catalogAppSelect('omit'), /s\.documents/);
});

test('random sampling returns at most six card rows without transferring catalog documents', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const ids: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const seeded = await seedTagCatalog(h.db, h.config.audience, ['MCP'], i);
    ids.push(seeded.appId);
    await h.db.query('UPDATE published_snapshots SET documents=$2::jsonb WHERE id=$1', [seeded.snapshotId, JSON.stringify({ 'large.md': 'x'.repeat(80 * 1024) })]);
  }

  let returnedBytes = 0;
  const db = h.db as any;
  const query = db.query.bind(db);
  db.query = async (sql: string, params?: readonly unknown[]) => {
    const result = await query(sql, params);
    returnedBytes += Buffer.byteLength(JSON.stringify(result.rows));
    return result;
  };
  const previous = ids.slice(0, 6);
  const batch = await h.service.random(previous);
  assert.equal(batch.items.length, 6);
  assert.equal(batch.allShown, false);
  assert.equal(new Set(batch.items.map(item => item.id)).size, 6);
  assert.equal(batch.items[0]?.id, ids[6], 'the sole never-shown app is selected before the previous batch');
  assert.ok(batch.items.slice(1).every(item => previous.includes(item.id)), 'the previous batch fills the remaining slots without duplicates');
  assert.ok(batch.items.every(item => Object.keys(item.documents).length === 0));
  assert.ok(returnedBytes < 256 * 1024, `small card selection transferred ${returnedBytes} bytes instead of catalog documents`);
});

test('smart search returns basic-mode results ranked by matched terms', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const daily = await seedTagCatalog(h.db, h.config.audience, ['工时日报', '企业微信'], 20);
  const dailyManifest = { ...daily.source, name: '工时日报助手', summary: '按可核验事实整理、补填、归档企业微信工时日报。' };
  await h.db.query('UPDATE published_snapshots SET search_text = $2, manifest = $3::jsonb WHERE id = $1', [daily.snapshotId, '日报 工时 记录 整理 归档 企业微信 helper', JSON.stringify(dailyManifest)]);
  const mcp = await seedTagCatalog(h.db, h.config.audience, ['MCP', '禅道'], 21);
  const mcpManifest = { ...mcp.source, name: 'zentao-mcp', summary: '让 AI 工作流通过 MCP 与 CLI 管理禅道需求。' };
  await h.db.query('UPDATE published_snapshots SET search_text = $2, manifest = $3::jsonb WHERE id = $1', [mcp.snapshotId, 'mcp 禅道 需求 需求管理 zentao workflow', JSON.stringify(mcpManifest)]);
  const offline = await seedTagCatalog(h.db, h.config.audience, ['日报'], 22);
  await h.db.query("INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) VALUES ($1, 'offline', 2, now())", [offline.appId]);
  await seedTagCatalog(h.db, 'other-audience', ['工时日报'], 23);

  const search = async (query: string) => {
    const res = await fetch(`${h.origin}/api/apps/smart-search?${new URLSearchParams({ query })}`);
    return { status: res.status, body: res.status === 200 ? await res.json() as any : null };
  };

  const dailyResult = await search('把已有工作记录整理成日报');
  assert.equal(dailyResult.status, 200);
  assert.ok(dailyResult.body.items.length >= 1, 'the daily-report app matches the natural-language task');
  assert.ok(dailyResult.body.items.some((item: any) => item.id === daily.appId), '工时日报助手 is returned');
  assert.equal(dailyResult.body.items[0].id, daily.appId, 'the best-matching app ranks first');
  const dailyMatches = dailyResult.body.matches[daily.appId] || [];
  assert.ok(dailyMatches.length > 0, 'matched terms are returned for the daily-report app');
  assert.ok(dailyMatches.includes('工时日报') || dailyMatches.includes('企业微信'), `matched terms include a tag: ${JSON.stringify(dailyMatches)}`);
  assert.ok(!dailyResult.body.items.some((item: any) => item.id === offline.appId), 'offline apps are excluded');
  assert.ok(!dailyResult.body.items.some((item: any) => item.id === mcp.appId), 'unrelated apps are not returned for a daily-report task');

  const mcpResult = await search('通过 MCP 管理禅道需求');
  assert.equal(mcpResult.status, 200);
  assert.ok(mcpResult.body.items.some((item: any) => item.id === mcp.appId));
  assert.ok((mcpResult.body.matches[mcp.appId] || []).some((term: string) => term.includes('MCP') || term.includes('禅道')));

  const noMatch = await search('完全不相关的查询词组 xyzabc');
  assert.equal(noMatch.status, 200);
  assert.equal(noMatch.body.items.length, 0);

  // A query with no usable keyword (single character) must not degenerate into an
  // unfiltered recency list presented as matches.
  assert.deepEqual(await h.service.smartSearch('图'), { mode: 'basic', items: [], matches: {}, reasons: {}, question: null }, 'single-character queries return no fabricated matches');
  assert.deepEqual((await search('？？？')).body.items, [], 'punctuation-only queries return no fabricated matches');

  assert.equal((await fetch(`${h.origin}/api/apps/smart-search`)).status, 400);
  assert.equal((await fetch(`${h.origin}/api/apps/smart-search?query=${encodeURIComponent('a'.repeat(501))}`)).status, 400);
  await assert.rejects(h.service.smartSearch(''), /query/);
});

test('smart search ranks older relevant apps above newer generic matches and normalizes full-width tags', async t => {
  const h = await startHarness();
  t.after(() => h.close());
  const relevant = await seedTagCatalog(h.db, h.config.audience, ['ＡＩ日报'], 30);
  const relevantManifest = { ...relevant.source, name: 'ＡＩ日报助手', summary: '整理已有工作记录并生成日报。' };
  await h.db.query("UPDATE published_snapshots SET search_text = $2, manifest = $3::jsonb, created_at = '2026-01-01T00:00:00Z' WHERE id = $1",
    [relevant.snapshotId, '日报 整理 记录', JSON.stringify(relevantManifest)]);
  // Nine newer apps that each match only the generic bigram 整理.
  for (let index = 31; index <= 39; index++) {
    const generic = await seedTagCatalog(h.db, h.config.audience, ['其他能力'], index);
    await h.db.query("UPDATE published_snapshots SET search_text = $2, created_at = $3 WHERE id = $1",
      [generic.snapshotId, '通用整理材料', `2026-02-${String(index - 30).padStart(2, '0')}T00:00:00Z`]);
  }

  const result = await h.service.smartSearch('整理日报');
  assert.ok(result.items.some(item => item.id === relevant.appId), 'the older highly relevant app is not truncated away by newer generic matches');
  assert.equal(result.items[0].id, relevant.appId, 'relevance outranks recency');
  assert.ok(result.items.length <= 8, 'at most eight results are returned');
  assert.ok((result.matches[relevant.appId] || []).includes('ＡＩ日报'), 'full-width tags match half-width queries via NFKC');
});
