import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

type Usage = 'all' | 'platform' | 'agent';
type CardSnapshot = { name: string; usage: string | null; formats: string[]; hasDirectUse: boolean; hasPlatformLink: boolean };
type ListResponse = { items: Array<{ id: string; manifest: { name: string; entries: Array<{ kind: string }> } }>; total: number; page: number; pageSize: number; usageCounts: { platform: number; agent: number } };

const reportPath = fileURLToPath(new URL('../artifacts/catalog-usage-browser.json', import.meta.url));
const report: { status: string; checks: string[]; viewports: unknown[]; externalRequests: string[]; errors: string[]; error?: string } = {
  status: 'RUNNING',
  checks: [],
  viewports: [],
  externalRequests: [],
  errors: [],
};
const harness = await startHarness();
let browser: any;
const apiQueries: string[] = [];

async function seedApp(
  usage: 'platform' | 'agent' | 'dual',
  name: string,
  entryFormat: 'Skill' | 'CLI' | 'MCP' | '插件' | 'Web' = 'Web',
  options: { comboTag?: boolean; searchText?: string; dualMarker?: boolean } = {},
) {
  const index = 200 + seededApps.length;
  const tags = options.comboTag ? ['组合筛选'] : [usage === 'agent' ? `${entryFormat}能力` : '平台应用'];
  const seeded = await seedTagCatalog(harness.db, harness.config.audience, tags, index);
  const web = { id: 'web', kind: 'web', label: '打开平台', url: `https://example.invalid/catalog/${index}` };
  const formatLabel = entryFormat === '插件' ? '插件扩展能力' : `${entryFormat} 接入能力`;
  const agent = {
    id: `${entryFormat.toLowerCase()}-${index}`,
    kind: 'agent',
    label: formatLabel,
    instructionsPath: `docs/agent-${index}.md`,
    compatibility: ['Codex'],
  };
  const entries = usage === 'platform' ? [web] : usage === 'agent' ? [agent] : [web, agent];
  const source = {
    ...seeded.source,
    name,
    summary: `用于浏览器目录回归的 ${name}。`,
    tags,
    entries,
    primaryEntry: usage === 'agent' ? agent.id : web.id,
  };
  const searchText = [options.searchText || 'ordinary', options.dualMarker ? 'dualmarker' : ''].filter(Boolean).join(' ');
  await harness.db.query(
    'UPDATE published_snapshots SET manifest = $2::jsonb, search_text = $3 WHERE id = $1',
    [seeded.snapshotId, JSON.stringify(source), searchText],
  );
  const app = { id: seeded.appId, name, usage };
  seededApps.push(app);
  return app;
}

const seededApps: Array<{ id: string; name: string; usage: 'platform' | 'agent' | 'dual' }> = [];
const webApps = [];
for (let index = 1; index <= 5; index++) {
  webApps.push(await seedApp('platform', `Web 平台应用 ${String(index).padStart(2, '0')}`, 'Web', {
    comboTag: index <= 2,
    searchText: index === 1 ? 'needle webentry1' : index === 3 ? 'needle webentry3' : 'ordinary',
  }));
}
const agentApps = [];
for (const format of ['Skill', 'CLI', 'MCP', '插件'] as const) {
  for (let index = 1; index <= 2; index++) {
    const isSearchMatch = format === 'Skill' && index === 1;
    agentApps.push(await seedApp('agent', `Agent ${format} ${String(index).padStart(2, '0')}`, format, {
      comboTag: isSearchMatch,
      searchText: isSearchMatch ? 'needle' : 'ordinary',
    }));
  }
}
const dualApp = await seedApp('dual', '双入口 Skill 应用', 'Skill', { comboTag: true, searchText: 'needle', dualMarker: true });

async function waitForCatalog(page: any) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const results = document.querySelector('.catalog-results');
    return !results || results.getAttribute('aria-busy') === 'false';
  });
}

async function visibleCards(page: any): Promise<CardSnapshot[]> {
  return page.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => ({
    name: card.querySelector('.app-title')?.textContent?.trim() || '',
    usage: card.dataset.usage || null,
    formats: Array.from(card.querySelectorAll<HTMLElement>('[data-testid="app-format"]')).map(format => format.textContent?.trim() || ''),
    hasDirectUse: Boolean(card.querySelector('[data-testid="use-agent"]')),
    hasPlatformLink: Boolean(card.querySelector('[data-testid="open-platform"]')),
  })));
}

async function collectPages(page: any, usage: Usage, payload: ListResponse): Promise<CardSnapshot[]> {
  const cards: CardSnapshot[] = [];
  while (true) {
    await waitForCatalog(page);
    const groups = await page.locator('[data-testid^="catalog-group-"]').evaluateAll((sections: HTMLElement[]) => sections.map(section => ({
      testId: section.dataset.testid || '',
      cardUsages: Array.from(section.querySelectorAll<HTMLElement>('[data-testid="app-card"]')).map(card => card.dataset.usage || ''),
    }))) as Array<{ testId: string; cardUsages: string[] }>;
    if (usage === 'all') {
      assert.equal(groups.length, 1, 'all applications share one result section');
      assert.equal(groups[0].testId, 'catalog-group-all');
      assert.equal(await page.locator('.app-grid').count(), 1, 'all applications share one grid');
      assert.equal(await page.locator('.catalog-group-heading').count(), 0, 'all results have no category headings');
    } else {
      assert.equal(groups.length, 1);
      assert.equal(groups[0].testId, `catalog-group-${usage}`);
      assert.ok(groups[0].cardUsages.every(value => value === usage), 'the category section contains only its matching apps');
    }
    const currentCards = await visibleCards(page);
    assert.deepEqual(currentCards.map(card => card.name), payload.items.map(app => app.manifest.name), 'cards preserve the server page order');
    assert.ok(currentCards.every(card => card.usage === 'platform' || card.usage === 'agent'), 'every card declares its rendered category');
    assert.ok(currentCards.every(card => card.usage !== 'platform' || card.hasPlatformLink), 'platform cards keep their direct links in every view');
    assert.ok(currentCards.every(card => card.usage !== 'agent' || (!card.hasDirectUse && !card.hasPlatformLink)), 'Agent cards keep setup in details in every view');
    if (usage !== 'all') assert.ok(currentCards.every(card => card.usage === usage), `${usage} filtering is applied to each server page`);
    if (usage === 'agent') assert.ok(currentCards.every(card => !card.hasDirectUse && !card.hasPlatformLink), 'Agent cards keep use actions in details');
    cards.push(...currentCards);

    const pagination = page.getByTestId('pagination');
    const next = pagination.locator('button.btn-next');
    if (!(await next.count()) || await next.isDisabled()) break;
    const activePage = Number(await pagination.locator('.number.is-active').innerText());
    const nextPage = activePage + 1;
    const responsePromise = page.waitForResponse((response: any) => {
      const url = new URL(response.url());
      return url.pathname === '/api/apps' && url.searchParams.get('usage') === usage && url.searchParams.get('page') === String(nextPage);
    });
    await next.click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    payload = await response.json() as ListResponse;
  }
  return cards;
}

async function clickUsage(page: any, usage: Usage): Promise<ListResponse> {
  const responsePromise = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && url.searchParams.get('usage') === usage && url.searchParams.get('page') === '1';
  });
  await page.getByTestId(`usage-${usage}`).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const payload = await response.json() as ListResponse;
  await waitForCatalog(page);
  return payload;
}

async function search(page: any, query: string, usage: Usage): Promise<ListResponse> {
  const responsePromise = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
      return url.pathname === '/api/apps' && url.searchParams.get('usage') === usage
        && (url.searchParams.get('query') || '') === query && url.searchParams.get('page') === '1';
    }).then((response: any) => ({ response }), (error: Error) => ({ error }));
  const actionPromise = (async () => {
    const input = page.getByRole('textbox', { name: '搜索应用名称、用途或能力' });
    await input.fill(query);
    const inputValue = await input.inputValue();
    const button = page.getByTestId('search-button');
    const buttonVisible = await button.isVisible();
    const buttonDisabled = await button.isDisabled();
    await button.click();
    return { inputValue, buttonVisible, buttonDisabled };
  })();
  const [responseResult, actionResult] = await Promise.allSettled([responsePromise, actionPromise]);
  if (actionResult.status === 'rejected') throw actionResult.reason;
  if (responseResult.status === 'rejected') throw responseResult.reason;
  if ('error' in responseResult.value) {
    throw new Error(`${responseResult.value.error.message}; action=${JSON.stringify(actionResult.value)}; requests=${apiQueries.join(' | ')}`);
  }
  const response = responseResult.value.response;
  assert.equal(response.status(), 200);
  const payload = await response.json() as ListResponse;
  await waitForCatalog(page);
  return payload;
}

function assertNoViewportOverflow(metrics: { horizontal: boolean; vertical: boolean; cardsBelowFooter: boolean }, label: string) {
  assert.equal(metrics.horizontal, false, `${label}: no horizontal overflow`);
  assert.equal(metrics.vertical, false, `${label}: no vertical overflow`);
  assert.equal(metrics.cardsBelowFooter, false, `${label}: visible cards fit before pagination`);
  report.viewports.push({ label, ...metrics });
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  let signalExternalRequest!: () => void;
  const externalRequest = new Promise<void>(resolve => { signalExternalRequest = resolve; });
  await context.route('**/*', async (route: any) => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== harness.origin) {
      report.externalRequests.push(url);
      signalExternalRequest();
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error: Error) => report.errors.push(error.message));
  page.on('request', (request: any) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/apps') apiQueries.push(url.search);
  });
  await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });" });

  const initialResponsePromise = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && url.searchParams.get('usage') === 'all' && url.searchParams.get('page') === '1';
  });
  await page.goto(harness.origin);
  const initialResponse = await initialResponsePromise;
  assert.equal(initialResponse.status(), 200);
  const initial = await initialResponse.json() as ListResponse;
  await waitForCatalog(page);
  assert.equal(await page.getByTestId('usage-all').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(initial.usageCounts, { platform: 6, agent: 8 });
  assert.equal(initial.total, 14, 'fixture contains five web-only, eight Agent-only, and one dual-entry application');

  const allPages = await collectPages(page, 'all', initial);
  const allNames = allPages.map(card => card.name);
  assert.equal(new Set(allNames).size, 14, 'paging does not repeat an application');
  assert.deepEqual(new Set(allNames), new Set([...webApps, ...agentApps, dualApp].map(app => app.name)), 'all applications remain reachable across all pages');
  const firstAgent = allPages.findIndex(card => card.usage === 'agent');
  assert.ok(firstAgent >= 0 && allPages.slice(0, firstAgent).every(card => card.usage === 'platform'), 'platform cards precede Agent cards across pages');
  assert.equal(allPages.filter(card => card.usage === 'platform').length, 6);
  assert.equal(allPages.filter(card => card.usage === 'agent').length, 8);
  for (const format of ['Skill', 'CLI', 'MCP', '插件']) assert.ok(allPages.some(card => card.usage === 'agent' && card.formats.includes(format)), `Agent format ${format} is identified`);
  const dualCard = allPages.find(card => card.name === dualApp.name);
  assert.equal(dualCard?.usage, 'platform', 'dual-entry applications take the platform category');
  assert.ok(dualCard?.formats.includes('Web平台') && dualCard.formats.includes('Skill'), 'classification retains both entry formats');
  report.checks.push('one flat all-results grid without category headings, in API order across all pages; all 14 apps retained without duplicates');

  const overflowMetrics = async () => page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector('.directory-shell') as HTMLElement;
    const footer = document.querySelector('[data-testid="pagination"]') as HTMLElement;
    const footerTop = footer.getBoundingClientRect().top;
    const cardBottom = Math.max(0, ...Array.from(document.querySelectorAll<HTMLElement>('[data-testid="app-card"]')).map(card => card.getBoundingClientRect().bottom));
    return {
      horizontal: root.scrollWidth > innerWidth || shell.scrollWidth > shell.clientWidth,
      vertical: shell.scrollHeight > shell.clientHeight + 1,
      cardsBelowFooter: cardBottom > footerTop + 1,
    };
  });
  assertNoViewportOverflow(await overflowMetrics(), '1280x720');

  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCatalog(page);
  assertNoViewportOverflow(await overflowMetrics(), '1440x900');
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForCatalog(page);
  const mobileOverflow = await page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector('.directory-shell') as HTMLElement;
    return root.scrollWidth > innerWidth || shell.scrollWidth > shell.clientWidth;
  });
  assert.equal(mobileOverflow, false, '390px viewport has no horizontal overflow');
  report.viewports.push({ label: '390x844', horizontal: mobileOverflow });
  report.checks.push('catalog layout fits at 1440x900 and 1280x720, with no horizontal overflow at 390px');

  await page.setViewportSize({ width: 1280, height: 720 });
  await waitForCatalog(page);
  const platformResponse = await clickUsage(page, 'platform');
  assert.equal(platformResponse.total, 6, 'platform filtering reports the full server-side category count');
  assert.deepEqual(platformResponse.usageCounts, { platform: 6, agent: 0 });
  const platformPages = await collectPages(page, 'platform', platformResponse);
  assert.equal(new Set(platformPages.map(card => card.name)).size, 6);
  assert.deepEqual(new Set(platformPages.map(card => card.name)), new Set([...webApps, dualApp].map(app => app.name)));
  assert.ok(platformPages.every(card => !card.hasDirectUse), 'platform cards do not expose Agent setup');

  const webSearch = await search(page, 'webentry1', 'platform');
  assert.equal(webSearch.total, 1);
  await waitForCatalog(page);
  const webCard = page.getByTestId('app-card').filter({ has: page.getByRole('button', { name: `查看 ${webApps[0].name} 详情`, exact: true }) });
  assert.equal(await webCard.count(), 1);
  const platformLink = webCard.getByTestId('open-platform');
  assert.equal(await platformLink.getAttribute('target'), '_blank');
  const relTokens = (await platformLink.getAttribute('rel') || '').split(/\s+/);
  assert.ok(relTokens.includes('noopener') && relTokens.includes('noreferrer'));
  const platformHref = await platformLink.getAttribute('href');
  assert.ok(platformHref?.startsWith('https://example.invalid/'));
  const popupPromise = page.waitForEvent('popup');
  const originalUrl = page.url();
  await platformLink.click();
  const popup = await popupPromise;
  await externalRequest;
  await popup.close();
  assert.equal(page.url(), originalUrl, 'the catalog page stays open after the platform link click');
  assert.equal(await page.getByTestId('app-detail').count(), 0, 'platform link click does not bubble into the app detail');
  assert.ok(report.externalRequests.includes(platformHref!), 'the external target was intercepted before network access');
  report.checks.push('platform link opens a protected new tab and does not trigger card detail');

  const filteredAgentResponse = await clickUsage(page, 'agent');
  assert.equal(filteredAgentResponse.total, 0, 'switching categories preserves the active search query');
  const agentResponse = await search(page, '', 'agent');
  assert.equal(agentResponse.total, 8, 'Agent filtering reports every matching app, not only the preceding all page');
  assert.deepEqual(agentResponse.usageCounts, { platform: 0, agent: 8 });
  const agentPages = await collectPages(page, 'agent', agentResponse);
  assert.equal(new Set(agentPages.map(card => card.name)).size, 8);
  assert.deepEqual(new Set(agentPages.map(card => card.name)), new Set(agentApps.map(app => app.name)));
  assert.ok(agentPages.every(card => !card.hasDirectUse && !card.hasPlatformLink), 'Agent cards have no direct setup or platform action');

  const agentSearch = await search(page, 'needle', 'agent');
  assert.equal(agentSearch.total, 1);
  await waitForCatalog(page);
  const agentCard = page.getByTestId('app-card').filter({ has: page.getByRole('button', { name: `查看 ${agentApps[0].name} 详情`, exact: true }) });
  assert.equal(await agentCard.count(), 1);
  await agentCard.locator('.app-summary').click();
  const detail = page.getByTestId('app-detail');
  await detail.waitFor();
  assert.equal(await page.getByTestId('use-agent').count(), 1, 'Agent setup is available from the detail');
  await page.getByTestId('use-agent').click();
  const instructions = page.getByTestId('agent-instruction-content');
  await instructions.waitFor();
  assert.match(await instructions.innerText(), /SOURCE-INSTRUCTIONS-UNCHANGED/);
  await page.keyboard.press('Escape');
  await instructions.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  report.checks.push('Agent card opens details, and the detail flow loads its Agent instructions');

  await clickUsage(page, 'platform');
  const dualSearch = await search(page, 'dualmarker', 'platform');
  assert.equal(dualSearch.total, 1);
  await waitForCatalog(page);
  const dualLocator = page.getByTestId('app-card').filter({ has: page.getByRole('button', { name: `查看 ${dualApp.name} 详情`, exact: true }) });
  assert.equal(await dualLocator.getAttribute('data-usage'), 'platform');
  assert.ok((await dualLocator.getByTestId('app-format').allTextContents()).includes('Web平台'));
  assert.ok((await dualLocator.getByTestId('app-format').allTextContents()).includes('Skill'));
  await dualLocator.getByRole('button', { name: `查看 ${dualApp.name} 详情`, exact: true }).click();
  await detail.waitFor();
  assert.equal(await page.getByTestId('use-web').count(), 1, 'dual-entry details retain the Web action');
  assert.equal(await page.getByTestId('use-agent').count(), 1, 'dual-entry details retain the Agent action');
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  report.checks.push('dual-entry application remains platform-classified while both detail actions remain available');

  await clickUsage(page, 'all');
  const allNeedle = await search(page, 'needle', 'all');
  assert.equal(allNeedle.total, 4, 'search results include a matching application without the selected tag');
  const tagResponsePromise = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && url.searchParams.get('usage') === 'all'
      && url.searchParams.get('query') === 'needle' && url.searchParams.getAll('tags').includes('组合筛选')
      && url.searchParams.get('page') === '1';
  });
  await page.getByTestId('tag-chip').filter({ hasText: '组合筛选' }).click();
  const tagResponse = await tagResponsePromise;
  assert.equal(tagResponse.status(), 200);
  const combined = await tagResponse.json() as ListResponse;
  await waitForCatalog(page);
  assert.equal(combined.total, 3, 'search and tag filters apply together on the server');
  assert.deepEqual(combined.usageCounts, { platform: 2, agent: 1 });
  const mixedCards = await visibleCards(page);
  assert.ok(mixedCards.some(card => card.usage === 'platform') && mixedCards.some(card => card.usage === 'agent'), 'mixed search results share the same all-results page');
  const combinedPages = await collectPages(page, 'all', combined);
  assert.deepEqual(new Set(combinedPages.map(card => card.name)), new Set([webApps[0].name, agentApps[0].name, dualApp.name]));
  assert.equal(new Set(combinedPages.map(card => card.name)).size, 3);
  report.checks.push('search and tag combination returns only the matching platform and Agent applications');

  await clickUsage(page, 'agent');
  const clearResponsePromise = page.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && url.searchParams.get('usage') === 'all'
      && !url.searchParams.has('query') && !url.searchParams.has('tags') && url.searchParams.get('page') === '1';
  });
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  const clearResponse = await clearResponsePromise;
  assert.equal(clearResponse.status(), 200);
  const cleared = await clearResponse.json() as ListResponse;
  await waitForCatalog(page);
  assert.equal(cleared.total, 14, 'clearing category, search and tag filters restores the full catalog');
  assert.equal(await page.getByTestId('usage-all').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('textbox', { name: '搜索应用名称、用途或能力' }).inputValue(), '');
  const clearedPages = await collectPages(page, 'all', cleared);
  assert.equal(new Set(clearedPages.map(card => card.name)).size, 14);
  report.checks.push('clear filters returns from the Agent category to the flat all-results grid, preserving API order and full pagination');

  assert.deepEqual(report.errors, [], 'browser reports no uncaught page errors');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = `${error instanceof Error ? error.stack || error.message : String(error)}\nAPI queries: ${apiQueries.join(' | ')}`;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await harness.close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks, viewports: report.viewports, externalRequests: report.externalRequests, error: report.error }));
}
