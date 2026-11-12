import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

if (process.argv.includes('--serve')) {
  console.log(`PREVIEW_ORIGIN=${harness.origin}`);
  await new Promise(() => {});
}

async function waitForCatalog(page: any) {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const results = document.querySelector('.catalog-results');
    return !results || results.getAttribute('aria-busy') === 'false';
  });
}

async function assertCardActions(card: any, { lift = false, compact = false } = {}) {
  const action = card.locator('.app-primary-action').first();
  await action.evaluate(async (el: HTMLElement) => {
    const deadline = performance.now() + 1500;
    while (getComputedStyle(el).opacity !== '1' || getComputedStyle(el).pointerEvents !== 'auto') {
      if (performance.now() > deadline) throw new Error('Card action did not finish appearing and accepting pointer input');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  const layout = await card.evaluate((el: HTMLElement) => {
    const action = el.querySelector('.app-primary-action')!;
    const dates = el.querySelector('.app-dates')!;
    const footer = el.querySelector('.app-card-footer')!;
    const summary = el.querySelector('.app-summary')!;
    const tags = el.querySelector('.app-tags')!;
    const { top, bottom, height } = el.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return {
      cardHeight: height,
      actionHeight: actionBox.height,
      actionOpacity: getComputedStyle(action).opacity,
      actionHit: action.contains(document.elementFromPoint(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2)),
      datesOpacity: getComputedStyle(dates).opacity,
      datesPointerEvents: getComputedStyle(dates).pointerEvents,
      maskCount: el.querySelectorAll('.card-actions').length,
      transform: getComputedStyle(el).transform,
      translateY: getComputedStyle(el).transform === 'none' ? 0 : new DOMMatrix(getComputedStyle(el).transform).m42,
      summaryHeight: summary.getBoundingClientRect().height,
      summaryToTags: tags.getBoundingClientRect().top - summary.getBoundingClientRect().bottom,
      actionInsideFooter: actionBox.top >= footerBox.top - 1 && actionBox.bottom <= footerBox.bottom + 1,
      footerInsideCard: footerBox.top >= top && footerBox.bottom <= bottom + 1,
      actionLabel: action.textContent?.trim() || '',
    };
  });
  assert.equal(layout.actionOpacity, '1', 'hover/focus reveals the primary text action');
  assert.equal(layout.actionHit, true, 'the revealed primary action accepts pointer input');
  assert.ok(layout.actionHeight >= 24, `the desktop primary action has a 24px target (${layout.actionHeight}px)`);
  assert.equal(layout.datesOpacity, '0', 'dates make room for the primary action');
  assert.equal(layout.datesPointerEvents, 'none', 'faded dates stop catching pointer tooltips');
  assert.equal(layout.maskCount, 0, 'the card no longer draws a full-card mask');
  assert.ok(layout.actionInsideFooter, 'the primary action sits in the footer meta slot');
  assert.ok(layout.footerInsideCard, 'the footer stays inside the card');
  if (lift) assert.ok(layout.translateY <= -1, 'hover lifts the card');
  if (compact) {
    assert.ok(layout.summaryHeight <= 20, `the short-screen summary stays on one line (${layout.summaryHeight}px)`);
    assert.ok(layout.summaryToTags <= 28, `compact cards leave no blank middle (${layout.summaryToTags}px)`);
  }
  return layout;
}

async function visibleCards(page: any): Promise<CardSnapshot[]> {
  return page.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => ({
    name: card.querySelector('.app-title')?.textContent?.trim() || '',
    usage: card.dataset.usage || null,
    formats: Array.from(card.querySelectorAll<HTMLElement>('[data-testid="app-format"]')).map(format => format.textContent?.trim() || ''),
    hasDirectUse: Boolean(card.querySelector('[data-testid="card-primary-agent"]')),
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
    assert.equal(await page.locator('.catalog-group-heading').count(), 0, 'filters never add another navigation or heading level');
    const currentCards = await visibleCards(page);
    assert.deepEqual(currentCards.map(card => card.name), payload.items.map(app => app.manifest.name), 'cards preserve the server page order');
    assert.ok(currentCards.every(card => card.usage === 'platform' || card.usage === 'agent'), 'every card declares its rendered category');
    assert.ok(currentCards.every(card => card.usage !== 'platform' || card.hasPlatformLink), 'platform cards keep their direct links in every view');
    assert.ok(currentCards.every(card => card.usage !== 'agent' || (card.hasDirectUse && !card.hasPlatformLink)), 'Agent cards expose the author primary setup action in every view');
    if (usage !== 'all') assert.ok(currentCards.every(card => card.usage === usage), `${usage} filtering is applied to each server page`);
    if (usage === 'agent') assert.ok(currentCards.every(card => card.hasDirectUse && !card.hasPlatformLink), 'Agent primary setup is directly available');
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
  const browserOptions = {
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}),
  };
  browser = await chromium.launch(browserOptions);
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
  assert.ok(apiQueries.every(query => new URLSearchParams(query).get('sort') === 'updated'), 'web explicitly requests updated ordering');
  const expectedOrder = await (await fetch(`${harness.origin}/api/apps?sort=updated&pageSize=100`)).json() as ListResponse;
  assert.deepEqual(allNames, expectedOrder.items.map(app => app.manifest.name), 'updated order is preserved across all web pages');
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

  // Paging above ends on the last page; an equal-capacity resize preserves that page.
  await page.getByTestId('pagination').getByText('1', { exact: true }).click();
  await waitForCatalog(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCatalog(page);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="app-card"]').length === 6
    && document.querySelector('.catalog-results')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.pagination-row .number.is-active')?.textContent?.trim() === '1');
  assertNoViewportOverflow(await overflowMetrics(), '1440x900');
  assert.ok((await page.getByTestId('app-card').first().boundingBox())!.y <= 300, 'desktop first row starts within the UI/UX limit');
  const desktopCard = await page.getByTestId('app-card').first().evaluate((el: HTMLElement) => {
    const summary = el.querySelector('.app-summary')!.getBoundingClientRect();
    const tags = el.querySelector('.app-tags')!.getBoundingClientRect();
    return { height: el.getBoundingClientRect().height, gap: tags.top - summary.bottom, category: getComputedStyle(el.querySelector('.app-category')!).backgroundColor };
  });
  assert.ok(desktopCard.height <= 210, `desktop cards keep the compact height (${desktopCard.height}px)`);
  assert.ok(desktopCard.gap <= 28, `desktop cards leave no blank middle (${desktopCard.gap}px)`);
  assert.notEqual(desktopCard.category, 'rgba(0, 0, 0, 0)', 'the category uses a soft pill');
  assert.equal(await page.getByRole('heading', { name: '发现好用的 AI 应用', exact: true }).count(), 1);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await waitForCatalog(page);
  assertNoViewportOverflow(await overflowMetrics(), '1920x1080');
  assert.equal(await page.locator('.app-grid').evaluate((el: HTMLElement) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 4, 'wide screens use four columns');
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

  const touchLayoutContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 920 } });
  const touchLayout = await touchLayoutContext.newPage();
  touchLayout.on('pageerror', (error: Error) => report.errors.push(error.message));
  const touchLayoutReads: string[] = [];
  touchLayout.on('request', (request: any) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/apps') touchLayoutReads.push(url.search);
  });
  await touchLayout.goto(harness.origin);
  await waitForCatalog(touchLayout);
  const touchLayoutMetrics = await touchLayout.evaluate(() => {
    const shell = document.querySelector('.directory-shell')!;
    const footer = document.querySelector('[data-testid="pagination"]')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid="app-card"]')];
    return { count: cards.length, cardHeight: cards[0].getBoundingClientRect().height, footerBottom: footer.bottom, viewportHeight: innerHeight, overflow: shell.scrollHeight - shell.clientHeight };
  });
  assert.ok(touchLayoutMetrics.cardHeight > 200, 'touch controls make the actual card taller than the desktop estimate');
  assert.equal(touchLayoutMetrics.count, 4, 'the touch viewport renders two complete rows');
  assert.ok(touchLayoutMetrics.footerBottom <= touchLayoutMetrics.viewportHeight + 1, 'touch pagination stays completely inside the viewport');
  assert.ok(touchLayoutMetrics.overflow <= 1, 'touch pagination needs no extra scroll');
  const firstTouchIds = await touchLayout.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.appId));
  const readsBeforePaging = touchLayoutReads.length;
  await touchLayout.getByTestId('pagination').locator('button.btn-next').click();
  await waitForCatalog(touchLayout);
  assert.equal(await touchLayout.locator('.pagination-row .number.is-active').innerText(), '2', 'measuring the next page preserves page two');
  const secondTouchIds = await touchLayout.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.appId));
  assert.equal(secondTouchIds.length, 4);
  assert.ok(secondTouchIds.every((id: string) => !firstTouchIds.includes(id)), 'touch pages have no repeated applications');
  assert.equal(touchLayoutReads.length, readsBeforePaging + 1, 'touch pagination has no measurement reload loop');
  await touchLayoutContext.close();
  report.checks.push('touch pagination uses actual card height, fits the viewport and keeps page two without repeated reads or duplicate cards');

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
  const originalUrl = page.url();
  await page.mouse.move(0, 0);
  assert.equal(await webCard.locator('.app-primary-action').evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '0', 'desktop primary action is hidden until hover or focus');
  // A click aimed at the visible date must retain the card-detail action while the CTA fades in.
  const datePopups: any[] = [];
  const recordDatePopup = (popup: any) => datePopups.push(popup);
  page.on('popup', recordDatePopup);
  const dateBox = await webCard.locator('.app-dates time').last().boundingBox();
  await page.mouse.click(dateBox!.x + dateBox!.width / 2, dateBox!.y + dateBox!.height / 2);
  await page.waitForTimeout(200);
  assert.equal(datePopups.length, 0, 'clicking a date before the CTA appears cannot open the external platform');
  await page.getByTestId('app-detail').waitFor();
  await page.getByTestId('return-discovery').click();
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  page.off('popup', recordDatePopup);
  report.checks.push('a fast native mouse click on the visible update date opens detail without opening a platform tab');
  await webCard.hover();
  const hoverLayout = await assertCardActions(webCard, { lift: true, compact: true });
  assert.ok(hoverLayout.cardHeight <= 190, `the short-screen card uses its compact height (${hoverLayout.cardHeight}px)`);
  assert.match(hoverLayout.actionLabel, /打开平台/);
  await page.screenshot({ path: 'artifacts/catalog-card-hover.png' });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const restLayout = await webCard.evaluate((el: HTMLElement) => ({
    action: getComputedStyle(el.querySelector('.app-primary-action')!).opacity,
    dates: getComputedStyle(el.querySelector('.app-dates')!).opacity,
  }));
  assert.equal(restLayout.action, '0', 'leaving the card hides the primary action again');
  assert.equal(restLayout.dates, '1', 'leaving the card restores the dates');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await webCard.hover();
  const reducedLayout = await webCard.evaluate((el: HTMLElement) => ({
    transform: getComputedStyle(el).transform,
    action: getComputedStyle(el.querySelector('.app-primary-action')!).opacity,
  }));
  assert.equal(reducedLayout.transform, 'none', 'reduced motion disables the card lift');
  assert.equal(reducedLayout.action, '1', 'reduced motion still reveals the primary action');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(0, 0);
  await platformLink.focus();
  await assertCardActions(webCard, { compact: true });
  const popupPromise = page.waitForEvent('popup');
  await platformLink.click();
  const popup = await popupPromise;
  await externalRequest;
  await popup.close();
  assert.equal(page.url(), originalUrl, 'the catalog page stays open after the platform link click');
  assert.equal(await page.getByTestId('app-detail').count(), 0, 'platform link click does not bubble into the app detail');
  assert.ok(report.externalRequests.includes(platformHref!), 'the external target was intercepted before network access');
  report.checks.push('platform link opens a protected new tab and does not trigger card detail');

  // A device whose primary input cannot hover but which has another hover-capable input keeps the desktop behavior.
  const hybridContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const hybridPage = await hybridContext.newPage();
  const hybridCdp = await hybridContext.newCDPSession(hybridPage);
  await hybridCdp.send('Emulation.setEmulatedMedia', { features: [
    { name: 'hover', value: 'none' },
    { name: 'any-hover', value: 'hover' },
  ] });
  await hybridPage.goto(harness.origin);
  await hybridPage.getByTestId('app-card').first().waitFor();
  await hybridPage.mouse.move(0, 0);
  const hybridRest = await hybridPage.getByTestId('app-card').first().evaluate((el: HTMLElement) => ({
    actionOpacity: getComputedStyle(el.querySelector('.app-primary-action')!).opacity,
    datesDisplay: getComputedStyle(el.querySelector('.app-dates')!).display,
  }));
  assert.equal(hybridRest.actionOpacity, '0', 'a hover-capable hybrid device keeps the action hidden at rest');
  assert.notEqual(hybridRest.datesDisplay, 'none', 'a hover-capable hybrid device keeps the dates visible');
  await hybridContext.close();
  report.checks.push('hybrid pointers with a hover-capable input keep the desktop hover behavior');

  const filteredAgentResponse = await clickUsage(page, 'agent');
  assert.equal(filteredAgentResponse.total, 0, 'switching categories preserves the active search query');
  const agentResponse = await search(page, '', 'agent');
  assert.equal(agentResponse.total, 8, 'Agent filtering reports every matching app, not only the preceding all page');
  assert.deepEqual(agentResponse.usageCounts, { platform: 0, agent: 8 });
  const agentPages = await collectPages(page, 'agent', agentResponse);
  assert.equal(new Set(agentPages.map(card => card.name)).size, 8);
  assert.deepEqual(new Set(agentPages.map(card => card.name)), new Set(agentApps.map(app => app.name)));
  assert.ok(agentPages.every(card => card.hasDirectUse && !card.hasPlatformLink), 'Agent cards expose setup without a platform action');

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
  await page.getByLabel('按作者标签筛选').getByRole('button', { name: '清除筛选', exact: true }).click();
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


  // S4: preserve the exact filtered page and scroll position, without re-querying on return.
  await page.setViewportSize({ width: 390, height: 500 });
  await search(page, 'needle', 'all');
  if (!await page.getByTestId('tag-chip').filter({ hasText: '组合筛选' }).isVisible()) await page.getByTestId('tag-more').click();
  await page.getByTestId('tag-chip').filter({ hasText: '组合筛选' }).click();
  await waitForCatalog(page);
  await page.getByTestId('pagination').locator('button.btn-next').click();
  await waitForCatalog(page);
  await page.evaluate(() => { document.querySelector('.directory-shell')!.scrollTop = 80; });
  await page.getByTestId('app-card').first().getByTestId('card-title').focus();
  // Keyboard focus may scroll an action into view; restore the actual state immediately before opening.
  const returnState = await page.evaluate(() => {
    const shell = document.querySelector('.directory-shell')!;
    return { scroll: shell.scrollTop, page: document.querySelector('.number.is-active')?.textContent, names: Array.from(document.querySelectorAll('.app-title')).map(x => x.textContent) };
  });
  assert.ok(returnState.scroll > 0, 'exercise nonzero scroll restoration');
  const queriesBeforeDetail = apiQueries.length;
  await page.keyboard.press('Enter');
  await detail.waitFor();
  assert.equal(await page.locator('.public-detail').count(), 1, 'public detail is a standalone view');
  assert.equal(await page.locator('.app-detail-dialog').count(), 0);
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  assert.equal(apiQueries.length, queriesBeforeDetail, 'return reuses the original list, not a newly paginated result');
  assert.deepEqual(await page.evaluate(() => ({ scroll: document.querySelector('.directory-shell')!.scrollTop, page: document.querySelector('.number.is-active')?.textContent, names: Array.from(document.querySelectorAll('.app-title')).map(x => x.textContent) })), returnState);
  assert.equal(await page.getByRole('textbox', { name: '搜索应用名称、用途或能力' }).inputValue(), 'needle');
  assert.equal(await page.getByTestId('tag-chip').filter({ hasText: '组合筛选' }).getAttribute('aria-pressed'), 'true');
  await page.goForward();
  await detail.waitFor();
  await page.goBack();
  await detail.waitFor({ state: 'hidden' });
  report.checks.push('standalone detail and browser Back/Forward preserve filtered page, sort and nonzero scroll position');

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel('按作者标签筛选').getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForCatalog(page);
  await page.screenshot({ path: 'artifacts/catalog-discovery-directory.png' });

  const directRandom = await context.newPage();
  await directRandom.goto(`${harness.origin}/?discover=random`);
  await directRandom.getByTestId('wheel-current').waitFor();
  const directName = (await directRandom.getByTestId('wheel-current').locator('.app-title').innerText()).trim();
  await directRandom.getByTestId('wheel-current').locator('.app-title').click();
  await directRandom.getByTestId('app-detail').waitFor();
  const directDetailUrl = new URL(directRandom.url());
  assert.equal(directDetailUrl.searchParams.get('discover'), 'random', 'random detail keeps the wheel as its return destination');
  assert.ok(directDetailUrl.searchParams.get('app'), 'random detail carries a refreshable app id');
  await directRandom.reload();
  await directRandom.getByTestId('app-detail').waitFor();
  assert.ok((await directRandom.getByTestId('app-detail').innerText()).includes(directName), 'refreshing a random detail restores the same app');
  await directRandom.getByTestId('return-discovery').click();
  await directRandom.getByTestId('wheel-current').waitFor();
  const directCatalogRequests: string[] = [];
  directRandom.on('request', (request: any) => { if (new URL(request.url()).pathname === '/api/apps') directCatalogRequests.push(request.url()); });
  await directRandom.getByTestId('tab-catalog').click();
  await directRandom.getByTestId('app-card').first().waitFor();
  assert.ok(await directRandom.getByTestId('app-card').count() > 0, 'the first switch from a direct wheel loads the catalog');
  assert.equal(directCatalogRequests.length > 0, true, 'the first catalog view performs a catalog read');
  assert.equal(new URL(directRandom.url()).searchParams.has('discover'), false, 'switching to the catalog refreshes back into the catalog');
  await directRandom.reload();
  await directRandom.getByTestId('app-card').first().waitFor();
  await directRandom.close();

  // A slow wheel response must not reopen its detail after the user has already returned to the catalog.
  const slowRandom = await context.newPage();
  slowRandom.setDefaultTimeout(10000);
  slowRandom.on('pageerror', (error: Error) => report.errors.push(error.message));
  let releaseWheel: (() => void) | undefined;
  let noteWheelRequest: (() => void) | undefined;
  const wheelGate = new Promise<void>(resolve => { releaseWheel = resolve; });
  const wheelRequested = new Promise<void>(resolve => { noteWheelRequest = resolve; });
  await slowRandom.route('**/api/apps/random**', async (route: any) => {
    noteWheelRequest!();
    await wheelGate;
    await route.continue();
  });
  await slowRandom.goto(`${harness.origin}/?discover=random&app=${encodeURIComponent(webApps[0].id)}`);
  await wheelRequested;
  await slowRandom.getByTestId('tab-catalog').click();
  await slowRandom.getByTestId('app-card').first().waitFor();
  releaseWheel!();
  await slowRandom.waitForTimeout(600);
  assert.equal(await slowRandom.getByTestId('app-detail').count(), 0, 'a slow wheel response does not reopen a stale detail after navigating away');
  assert.equal(new URL(slowRandom.url()).searchParams.has('app'), false, 'the abandoned wheel detail does not write its app id back to the URL');
  await slowRandom.close();

  // Returning from the wheel after a viewport change refetches with the new capacity.
  const capacityPage = await context.newPage();
  capacityPage.setDefaultTimeout(10000);
  capacityPage.on('pageerror', (error: Error) => report.errors.push(error.message));
  await capacityPage.setViewportSize({ width: 1440, height: 900 });
  const capacityRequests: string[] = [];
  capacityPage.on('request', (request: any) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/apps') capacityRequests.push(url.search);
  });
  await capacityPage.goto(harness.origin);
  await capacityPage.getByTestId('app-card').first().waitFor();
  await capacityPage.waitForLoadState('networkidle');
  const initialPageSize = Number(new URLSearchParams(capacityRequests.at(-1)!).get('pageSize'));
  assert.equal(await capacityPage.getByTestId('app-card').count(), initialPageSize, 'the initial catalog page fills the measured capacity');
  await capacityPage.getByTestId('tab-random').click();
  await capacityPage.getByTestId('wheel-current').waitFor();
  await capacityPage.setViewportSize({ width: 1024, height: 720 });
  const resizedResponsePromise = capacityPage.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && Number(url.searchParams.get('pageSize')) !== initialPageSize;
  });
  await capacityPage.getByTestId('tab-catalog').click();
  const resizedResponse = await resizedResponsePromise;
  const resizedPageSize = Number(new URL(resizedResponse.url()).searchParams.get('pageSize'));
  assert.ok(resizedPageSize < initialPageSize, `a smaller viewport lowers the page capacity: ${initialPageSize} -> ${resizedPageSize}`);
  const expectedFirstPage = Math.min(resizedPageSize, 14);
  await capacityPage.waitForFunction((size: number) => {
    const results = document.querySelector('.catalog-results');
    return results?.getAttribute('aria-busy') === 'false' && results.querySelectorAll('[data-testid="app-card"]').length === size;
  }, expectedFirstPage);
  const firstPageIds = await capacityPage.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.appId));
  assert.equal(new Set(firstPageIds).size, firstPageIds.length, 'the refetched first page has no duplicate rows');
  const secondPageResponse = capacityPage.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.pathname === '/api/apps' && url.searchParams.get('page') === '2';
  });
  await capacityPage.getByTestId('pagination').locator('button.btn-next').click();
  await secondPageResponse;
  await capacityPage.waitForFunction((size: number) => {
    const results = document.querySelector('.catalog-results');
    return results?.getAttribute('aria-busy') === 'false' && results.querySelectorAll('[data-testid="app-card"]').length === size;
  }, expectedFirstPage);
  const secondPageIds = await capacityPage.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.appId));
  assert.equal(secondPageIds.filter((id: string | undefined) => firstPageIds.includes(id)).length, 0, 'paging after a capacity change does not repeat rows from the refetched first page');
  await capacityPage.close();

  // Browser Back from a detail opened through the rail restores the catalog body, highlight and URL together.
  const historyPage = await context.newPage();
  historyPage.setDefaultTimeout(10000);
  historyPage.on('pageerror', (error: Error) => report.errors.push(error.message));
  await historyPage.setViewportSize({ width: 1280, height: 720 });
  await historyPage.goto(harness.origin);
  await historyPage.getByTestId('app-card').first().waitFor();
  await historyPage.getByTestId('app-card').first().locator('.app-title').click();
  await historyPage.getByTestId('app-detail').waitFor();
  await historyPage.getByTestId('tab-random').click();
  await historyPage.getByTestId('wheel-current').waitFor();
  assert.equal(new URL(historyPage.url()).searchParams.get('discover'), 'random');
  await historyPage.goBack();
  await historyPage.getByTestId('app-card').first().waitFor();
  assert.equal(await historyPage.getByTestId('random-discovery').count(), 0, 'Back from the wheel shows the catalog body again');
  assert.equal(await historyPage.getByTestId('tab-catalog').getAttribute('aria-current'), 'page', 'Back moves the rail highlight to the catalog');
  const restoredUrl = new URL(historyPage.url());
  assert.equal(restoredUrl.searchParams.has('discover'), false, 'Back restores a catalog URL without the wheel parameter');
  assert.equal(restoredUrl.searchParams.has('app'), false, 'Back does not leave a stale detail id in the URL');
  await historyPage.close();

  // A suspended Forward handler must not close a newer detail when its wheel request finishes.
  const interruptedHistory = await context.newPage();
  interruptedHistory.setDefaultTimeout(10000);
  interruptedHistory.on('pageerror', (error: Error) => report.errors.push(error.message));
  let releaseHistoryWheel!: () => void;
  const historyWheelGate = new Promise<void>(resolve => { releaseHistoryWheel = resolve; });
  await interruptedHistory.route('**/api/apps/random**', async (route: any) => {
    await historyWheelGate;
    await route.continue();
  });
  await interruptedHistory.goto(harness.origin);
  await waitForCatalog(interruptedHistory);
  const historyCards = await interruptedHistory.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.slice(0, 2).map(card => ({
    id: card.dataset.appId!, name: card.querySelector('.app-title')!.textContent!.trim(), summary: card.querySelector('.app-summary')!.textContent!.trim(),
  })));
  assert.equal(historyCards.length, 2, 'the history race uses two distinct catalog details');
  const [earlierDetail, newerDetail] = historyCards;
  assert.notEqual(earlierDetail.id, newerDetail.id);
  await interruptedHistory.locator(`[data-app-id="${earlierDetail.id}"] .app-title`).click();
  await interruptedHistory.getByTestId('app-detail').waitFor();
  const initialHistoryWheel = interruptedHistory.waitForRequest((request: any) => new URL(request.url()).pathname === '/api/apps/random');
  await interruptedHistory.getByTestId('tab-random').click();
  await initialHistoryWheel;
  await interruptedHistory.goBack();
  await interruptedHistory.locator(`[data-app-id="${newerDetail.id}"]`).waitFor();
  await interruptedHistory.goForward();
  await interruptedHistory.getByTestId('random-discovery').waitFor();
  assert.equal(await interruptedHistory.getByTestId('tab-random').getAttribute('aria-current'), 'page', 'Forward has resumed the wheel view while its read remains pending');
  await interruptedHistory.goBack();
  await interruptedHistory.locator(`[data-app-id="${newerDetail.id}"] .app-title`).click();
  const latestDetail = interruptedHistory.getByTestId('app-detail');
  await latestDetail.waitFor();
  assert.equal(await latestDetail.locator('.overview-title-row h2').innerText(), newerDetail.name, 'the newer detail is open before releasing the old requests');
  const oldWheelResponse = interruptedHistory.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/apps/random');
  releaseHistoryWheel();
  const completedWheelResponse = await oldWheelResponse;
  assert.equal(completedWheelResponse.status(), 200);
  await completedWheelResponse.finished();
  await interruptedHistory.waitForLoadState('networkidle');
  await interruptedHistory.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const latestDetailUrl = new URL(interruptedHistory.url());
  assert.equal(latestDetailUrl.searchParams.get('app'), newerDetail.id, 'the newer app id remains in the URL after the old Forward completes');
  assert.equal(latestDetailUrl.searchParams.has('discover'), false, 'the newer detail retains its catalog return destination');
  assert.equal(await latestDetail.isVisible(), true, 'the old Forward completion must not close the newer detail');
  assert.equal(await latestDetail.locator('.overview-title-row h2').innerText(), newerDetail.name, 'detail content still belongs to the newer app');
  assert.equal(await latestDetail.locator('.overview-summary').innerText(), newerDetail.summary, 'the newer app body remains visible');
  assert.equal(await interruptedHistory.getByTestId('tab-catalog').getAttribute('aria-current'), 'page', 'the rail remains selected on the newer detail return destination');
  assert.equal(await interruptedHistory.getByTestId('tab-random').getAttribute('aria-current'), null);
  await interruptedHistory.close();
  report.checks.push('Back/Forward/Back while wheel reads are pending preserves the newer detail URL, body and catalog rail selection after the old reads finish');

  let randomRequests = 0;
  page.on('request', (request: any) => { if (new URL(request.url()).pathname === '/api/apps/random') randomRequests++; });
  await page.getByTestId('tab-random').click();
  await page.getByTestId('wheel-current').waitFor();
  await page.waitForLoadState('networkidle');
  const wheel = page.getByTestId('catalog-wheel');
  const wheelDots = page.getByTestId('random-discovery').locator('.wheel-dots button');
  assert.equal(await wheelDots.count(), 6);
  assert.equal(await wheelDots.evaluateAll((buttons: HTMLElement[]) => buttons.every(button => {
    const box = button.getBoundingClientRect(); return box.width >= 24 && box.height >= 24;
  })), true, 'wheel selectors have at least a 24px target');
  assert.ok(await page.getByTestId('random-discovery').locator('.wheel-dots button[aria-pressed="true"]').evaluate((button: HTMLElement) => parseFloat(getComputedStyle(button).outlineWidth) >= 2), 'the current wheel item has a shape cue beyond color');
  const batchIds = () => wheel.getByTestId('app-card').evaluateAll((cards: HTMLElement[]) => cards.map(card => card.dataset.appId));
  const refreshRandom = async () => {
    const response = page.waitForResponse((res: any) => new URL(res.url()).pathname === '/api/apps/random');
    await page.getByTestId('random-refresh').click();
    await response;
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="random-refresh"]')!.disabled);
  };
  const currentId = () => page.getByTestId('wheel-current').getByTestId('app-card').getAttribute('data-app-id');
  const batch = await batchIds();
  assert.equal(batch.length, 6);
  assert.equal(new Set(batch).size, 6);
  assert.equal(randomRequests, 1);
  assert.equal(await page.getByTestId('random-all-shown').count(), 0);
  await page.getByRole('button', { name: '下一个应用', exact: true }).click();
  assert.equal(await currentId(), batch[1]);
  await wheel.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await currentId(), batch[2]);
  const side = page.getByTestId('wheel-side').filter({ has: page.locator(`[data-app-id="${batch[1]}"]`) });
  await side.getByRole('button', { name: /切换到/ }).click();
  assert.equal(await currentId(), batch[1]);
  assert.equal(randomRequests, 1, 'buttons, keyboard and side cards never resample');
  assert.equal(await page.getByTestId('app-detail').count(), 0, 'side card only selects');
  const wheelBox = await wheel.boundingBox();
  await page.mouse.move(wheelBox!.x + wheelBox!.width / 2, wheelBox!.y + 12);
  const beforeWheel = await currentId();
  await page.mouse.wheel(0, 110);
  await page.waitForFunction((id: string) => document.querySelector('[data-testid="wheel-current"] [data-app-id]')?.getAttribute('data-app-id') !== id, beforeWheel);
  const middleOffset = await page.getByTestId('wheel-current').evaluate((el: HTMLElement) => Math.abs(Number(el.style.getPropertyValue('--offset'))));
  assert.ok(middleOffset > .002 && middleOffset < 1.01, 'wheel advances through intermediate positions instead of jumping');
  await page.waitForFunction(() => Number((document.querySelector('[data-testid="wheel-current"]') as HTMLElement).style.getPropertyValue('--offset')) === 0);
  assert.deepEqual(await batchIds(), batch);
  assert.equal(randomRequests, 1, 'mouse wheel movement never requests another batch');
  const currentOffset = await page.getByTestId('wheel-current').evaluate((el: HTMLElement) => el.style.getPropertyValue('--offset'));
  await wheel.dispatchEvent('wheel', { deltaY: 110, ctrlKey: true });
  assert.equal(await page.getByTestId('wheel-current').evaluate((el: HTMLElement) => el.style.getPropertyValue('--offset')), currentOffset, 'Ctrl-wheel remains a browser zoom gesture');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '下一个应用', exact: true }).click();
  assert.equal(await page.getByTestId('wheel-current').evaluate((el: HTMLElement) => Number(el.style.getPropertyValue('--offset'))), 0, 'reduced motion changes cards without animation');
  assert.equal(randomRequests, 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const selected = await currentId();
  await page.keyboard.press('Tab');
  await page.getByTestId('wheel-current').getByTestId('card-title').focus();
  assert.equal(await page.getByTestId('wheel-current').getByTestId('card-title').evaluate((button: HTMLElement) => {
    const sample = document.createElement('i'); sample.style.color = 'var(--plaza-brand)'; document.body.append(sample);
    const brand = getComputedStyle(sample).color; sample.remove();
    const style = getComputedStyle(button); return style.outlineColor === brand && parseFloat(style.outlineWidth) >= 2;
  }), true, 'keyboard focus uses the accessible brand ring');
  await assertCardActions(page.getByTestId('wheel-current').getByTestId('app-card'));
  await page.screenshot({ path: 'artifacts/catalog-wheel-card-focus.png' });
  await page.keyboard.press('Enter');
  await detail.waitFor();
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  assert.deepEqual(await batchIds(), batch);
  assert.equal(await currentId(), selected);
  await page.getByTestId('tab-catalog').click();
  await page.getByTestId('tab-random').click();
  assert.deepEqual(await batchIds(), batch);
  assert.equal(await currentId(), selected);
  assert.equal(randomRequests, 1);
  await page.screenshot({ path: 'artifacts/catalog-discovery-wheel.png' });

  await page.route('**/api/apps/random?**', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '抽样服务暂时不可用' } }) }));
  await refreshRandom();
  await page.getByRole('alert').filter({ hasText: '当前批次已保留' }).waitFor();
  assert.deepEqual(await batchIds(), batch);
  assert.equal(await currentId(), selected);
  await page.unroute('**/api/apps/random?**');
  await refreshRandom();
  await page.waitForLoadState('networkidle');
  const nextBatch = await batchIds();
  assert.ok(nextBatch.every((id: string) => !batch.includes(id)), '14 candidates allow disjoint batches');
  assert.equal(await currentId(), nextBatch[0]);
  assert.equal(await page.getByTestId('random-all-shown').count(), 0, 'allShown does not accumulate across batches');
  report.checks.push('wheel buttons, side cards and arrows reuse one batch; return restores batch/current item; failed refresh retains it; successful refresh excludes the previous six');

  // Actual touch gestures and taps use the same card actions.
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touchPage = await touchContext.newPage();
  touchPage.on('pageerror', (error: Error) => report.errors.push(error.message));
  let touchSamples = 0;
  touchPage.on('request', (request: any) => { if (new URL(request.url()).pathname === '/api/apps/random') touchSamples++; });
  await touchPage.goto(harness.origin);
  await waitForCatalog(touchPage);
  const touchCatalogLayout = await touchPage.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="app-card"]'));
    const footer = document.querySelector('[data-testid="pagination"]')!.getBoundingClientRect();
    return { cardBottom: Math.max(...cards.map(card => card.getBoundingClientRect().bottom)), footerTop: footer.top, horizontal: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(touchCatalogLayout.horizontal, false, 'visible touch actions do not create horizontal overflow');
  assert.ok(touchCatalogLayout.cardBottom <= touchCatalogLayout.footerTop, 'touch cards fit above pagination');
  await touchPage.getByTestId('tab-random').tap();
  await touchPage.getByTestId('wheel-current').waitFor();
  const touchFirst = await touchPage.getByTestId('wheel-current').getByTestId('app-card').getAttribute('data-app-id');
  const box = await touchPage.getByTestId('catalog-wheel').boundingBox();
  const cdp = await touchContext.newCDPSession(touchPage);
  const y = box!.y + 70;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 170, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForFunction((id: string) => document.querySelector('[data-testid="wheel-current"] [data-app-id]')?.getAttribute('data-app-id') !== id, touchFirst);
  assert.equal(touchSamples, 1);
  assert.equal(await touchPage.getByTestId('app-detail').count(), 0, 'swiping cannot open a card');
  await touchPage.waitForFunction(() => Number((document.querySelector('[data-testid="wheel-current"]') as HTMLElement).style.getPropertyValue('--offset')) === 0);
  await touchPage.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  const touchTitle = touchPage.getByTestId('wheel-current').getByTestId('card-title');
  const touchAction = touchPage.getByTestId('wheel-current').locator('.app-primary-action').first();
  assert.equal(await touchAction.evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '1', 'touch primary action is visible without hover');
  const touchActions = await touchPage.getByTestId('wheel-current').getByTestId('app-card').evaluate((el: HTMLElement) => {
    const action = el.querySelector('.app-primary-action')!.getBoundingClientRect();
    const footer = el.querySelector('.app-card-footer')!.getBoundingClientRect();
    const dates = el.querySelector('.app-dates') as HTMLElement;
    return { actionHeight: action.height, actionTop: action.top, actionBottom: action.bottom, footerTop: footer.top, footerBottom: footer.bottom, datesDisplay: getComputedStyle(dates).display };
  });
  assert.equal(touchActions.datesDisplay, 'none', 'touch cards hide the dates to make room for the primary action');
  assert.ok(touchActions.actionHeight >= 44, 'touch primary action has a usable tap target');
  assert.ok(touchActions.actionTop >= touchActions.footerTop - 1 && touchActions.actionBottom <= touchActions.footerBottom + 1, 'the touch primary action stays inside the footer');
  await touchTitle.tap();
  await touchPage.getByTestId('app-detail').waitFor();
  await touchPage.getByTestId('return-discovery').tap();
  await touchPage.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await touchContext.close();
  report.checks.push('real touch swipe changes the current item without resampling or opening details; the visible 44px primary action and card title remain tappable');

  // A secondary touchscreen must not pin the action while the desktop mouse remains the primary pointer.
  const hybridBrowser = await chromium.launch({ ...browserOptions, args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=6'] });
  try {
    const hybridContext = await hybridBrowser.newContext({ viewport: { width: 1440, height: 900 } });
    const hybridPage = await hybridContext.newPage();
    hybridPage.setDefaultTimeout(10000);
    await hybridPage.goto(harness.origin);
    await waitForCatalog(hybridPage);
    await clickUsage(hybridPage, 'platform');
    await hybridPage.mouse.move(0, 0);
    const hybridCard = hybridPage.getByTestId('app-card').first();
    const hybridRest = await hybridCard.evaluate((el: HTMLElement) => ({
      fine: matchMedia('(pointer: fine)').matches,
      touchAvailable: matchMedia('(any-pointer: coarse)').matches,
      hoverAvailable: matchMedia('(any-hover: hover)').matches,
      actionOpacity: getComputedStyle(el.querySelector('.app-primary-action')!).opacity,
      datesDisplay: getComputedStyle(el.querySelector('.app-dates')!).display,
    }));
    assert.equal(hybridRest.fine, true, 'the mixed-input fixture keeps the mouse as its primary pointer');
    assert.equal(hybridRest.touchAvailable, true, 'the mixed-input fixture also exposes a touchscreen');
    assert.equal(hybridRest.hoverAvailable, true, 'the mixed-input fixture exposes a hover-capable input');
    assert.equal(hybridRest.actionOpacity, '0', 'a hybrid device keeps the action on hover instead of pinning it');
    assert.notEqual(hybridRest.datesDisplay, 'none', 'a hybrid device keeps the dates at rest');
    await hybridCard.hover();
    const hybridHover = await hybridCard.evaluate((el: HTMLElement) => ({
      actionOpacity: getComputedStyle(el.querySelector('.app-primary-action')!).opacity,
      actionHeight: el.querySelector('.app-primary-action')!.getBoundingClientRect().height,
      datesOpacity: getComputedStyle(el.querySelector('.app-dates')!).opacity,
    }));
    assert.equal(hybridHover.actionOpacity, '1', 'hover reveals the action on a hybrid device');
    assert.equal(hybridHover.datesOpacity, '0', 'hover still swaps the dates on a hybrid device');
    assert.ok(hybridHover.actionHeight >= 24, 'the hybrid desktop action keeps its 24px target');
    report.checks.push('mixed-input devices keep the desktop hover behavior even when a touchscreen is available');
  } finally {
    await hybridBrowser.close();
  }

  // S3: a mixed app remains a platform while its author changes the primary action.
  await page.getByTestId('tab-catalog').click();
  await search(page, 'dualmarker', 'all');
  const mixedCard = page.getByTestId('app-card');
  const mixed = await harness.service.app(dualApp.id);
  const agentEntry = mixed.manifest.entries.find(entry => entry.kind === 'agent')!;
  const setPrimary = async (id: string) => harness.db.query("UPDATE published_snapshots SET manifest = jsonb_set(manifest, '{primaryEntry}', $2::jsonb) WHERE app_id = $1", [dualApp.id, JSON.stringify(id)]);
  await setPrimary(agentEntry.id);
  await search(page, 'dualmarker', 'all');
  assert.equal(await mixedCard.getAttribute('data-usage'), 'platform');
  assert.equal(await mixedCard.getByTestId('open-platform').count(), 0);
  await mixedCard.getByTestId('card-primary-agent').focus();
  await page.keyboard.press('Space');
  await page.getByTestId('copy-agent-prompt').waitFor();
  assert.equal(await detail.count(), 0, 'primary Agent action does not open detail');
  assert.match(await page.getByTestId('agent-instruction-content').innerText(), /SOURCE-INSTRUCTIONS-UNCHANGED/);
  await page.keyboard.press('Escape');
  await page.getByTestId('agent-instruction-dialog').waitFor({ state: 'hidden' });
  // The hover action must not swallow a real mouse drag over the summary.
  await page.mouse.move(0, 0);
  const summaryBox = await mixedCard.locator('.app-summary').boundingBox();
  await page.mouse.move(summaryBox!.x + 1, summaryBox!.y + 10);
  await page.mouse.down();
  await page.mouse.move(summaryBox!.x + 95, summaryBox!.y + 10, { steps: 10 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => Boolean(window.getSelection()?.toString().trim())), 'text remains selectable while the card action is available');
  assert.equal(await detail.count(), 0, 'text selection does not navigate');
  await mixedCard.locator('.app-tag').first().focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await mixedCard.getByTestId('card-title').evaluate((el: HTMLElement) => document.activeElement === el), true);
  assert.ok(await page.evaluate(() => Boolean(window.getSelection()?.toString().trim())), 'keyboard navigation preserves the earlier text selection');
  await page.keyboard.press('Enter');
  await detail.waitFor();
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  report.checks.push('after real text selection, Shift+Tab to the title and Enter still open detail');
  // A later click on selected text must not turn into navigation either.
  await mixedCard.locator('.app-summary').evaluate((el: HTMLElement) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await detail.count(), 0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const tagRequest = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/apps' && new URL(response.url()).searchParams.has('tags'));
  await mixedCard.getByRole('button', { name: '按标签 组合筛选 筛选', exact: true }).click();
  await tagRequest;
  assert.equal(await detail.count(), 0, 'tag only changes filters');
  await waitForCatalog(page);

  // Public details fetch the current snapshot instead of rendering the card snapshot.
  await harness.db.query("UPDATE published_snapshots SET manifest = jsonb_set(manifest, '{name}', $2::jsonb) WHERE app_id = $1", [dualApp.id, JSON.stringify('当前公开快照名称')]);
  await mixedCard.getByTestId('card-title').focus();
  await page.keyboard.press('Enter');
  await detail.waitFor();
  assert.equal(await page.locator('.overview-title-row h2').innerText(), '当前公开快照名称');
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  await harness.db.query("UPDATE published_snapshots SET manifest = jsonb_set(manifest, '{name}', $2::jsonb) WHERE app_id = $1", [dualApp.id, JSON.stringify(dualApp.name)]);

  await setPrimary('missing');
  await search(page, 'dualmarker', 'all');
  await mixedCard.hover();
  assert.equal(await mixedCard.locator('.app-primary-action').count(), 0, 'a missing primary renders no action');
  assert.equal(await mixedCard.getByTestId('primary-disabled-reason').isVisible(), true, 'the blocked reason stays visible in the footer');
  assert.match(await mixedCard.getByTestId('primary-disabled-reason').innerText(), /缺失/);
  await mixedCard.getByTestId('card-title').click();
  await detail.waitFor();
  assert.equal(await detail.getByTestId('use-web').count(), 1);
  assert.equal(await detail.getByTestId('use-agent').count(), 1);
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  await setPrimary('web');
  await harness.db.query("UPDATE published_snapshots SET manifest = jsonb_set(manifest, '{entries,0,url}', $2::jsonb) WHERE app_id = $1", [dualApp.id, JSON.stringify('javascript:alert(1)')]);
  await search(page, 'dualmarker', 'all');
  await mixedCard.hover();
  assert.equal(await mixedCard.locator('.app-primary-action').count(), 0, 'an unsafe primary renders no action');
  assert.match(await mixedCard.getByTestId('primary-disabled-reason').innerText(), /不安全/);
  await harness.db.query("UPDATE published_snapshots SET manifest = $2::jsonb WHERE app_id = $1", [dualApp.id, JSON.stringify({ ...mixed.manifest, primaryEntry: agentEntry.id })]);
  await search(page, 'dualmarker', 'all');
  await page.route(`**/api/apps/${dualApp.id}/instructions/*`, (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '指引读取失败' } }) }));
  await mixedCard.getByTestId('card-primary-agent').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: '指引读取失败' }).waitFor();
  assert.equal(await page.getByTestId('copy-agent-prompt').count(), 0);
  assert.ok(!(await page.getByTestId('agent-instruction-content').innerText()).includes('SOURCE-INSTRUCTIONS-UNCHANGED'));
  await page.keyboard.press('Escape');
  await page.getByTestId('agent-instruction-dialog').waitFor({ state: 'hidden' });
  await page.unroute(`**/api/apps/${dualApp.id}/instructions/*`);
  await mixedCard.getByTestId('card-primary-agent').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('copy-agent-prompt').waitFor();
  await harness.db.query("INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) VALUES ($1, 'offline', 2, now())", [dualApp.id]);
  await page.getByTestId('copy-agent-prompt').click();
  await page.getByRole('alert').filter({ hasText: '应用不存在' }).waitFor();
  assert.equal(await page.getByTestId('copy-agent-prompt').count(), 0, 'copy revalidates the current lifecycle');
  assert.ok(!(await page.getByTestId('agent-instruction-content').innerText()).includes('SOURCE-INSTRUCTIONS-UNCHANGED'));
  await page.keyboard.press('Escape');
  await page.getByTestId('agent-instruction-dialog').waitFor({ state: 'hidden' });
  await mixedCard.getByTestId('card-title').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: '请返回刷新' }).waitFor();
  assert.equal(await detail.count(), 0, 'offline detail does not disclose stale content');
  await page.getByTestId('return-discovery').click();
  await page.locator('.public-detail').waitFor({ state: 'hidden' });
  await waitForCatalog(page);
  assert.equal(await page.locator('.catalog-section [data-testid="app-card"]').count(), 0, 'return-and-refresh removes the offline card');
  report.checks.push('mixed Web/Agent primary actions, keyboard, selection, tags, current public snapshot, missing/unsafe primary and failure/offline instruction clearing');
  report.checks.push('catalog and wheel lift the card and swap dates for a primary text action on hover/focus; real text selection, independent tags and visible touch actions remain usable');


  // A known disabled fixed entry is projected by the real service into both card and detail.
  const profile = JSON.parse(await readFile(new URL('../server/contracts/legacy-distribution-profiles.json', import.meta.url), 'utf8')).disabledEntries[0];
  const disabledApp = await seedApp('dual', '停用主入口测试应用', 'Skill', { searchText: 'disabledmarker' });
  const disabledSource = await harness.service.app(disabledApp.id);
  const disabledManifest = { ...disabledSource.manifest, appKey: profile.appKey, primaryEntry: profile.entryId,
    entries: disabledSource.manifest.entries.map(entry => entry.kind === 'agent' ? { ...entry, id: profile.entryId } : entry) };
  await harness.db.query('UPDATE catalog_apps SET instance_id = $2, project_id = $3, app_key = $4 WHERE id = $1', [disabledApp.id, profile.instanceId, profile.projectId, profile.appKey]);
  await harness.db.query('UPDATE published_snapshots SET commit_sha = $2, manifest = $3::jsonb WHERE app_id = $1', [disabledApp.id, profile.commitSha, JSON.stringify(disabledManifest)]);
  await page.getByLabel('按作者标签筛选').getByRole('button', { name: '清除筛选', exact: true }).click();
  await waitForCatalog(page);
  await search(page, 'disabledmarker', 'all');
  const disabledCard = page.getByTestId('app-card');
  await page.setViewportSize({ width: 1130, height: 900 });
  await waitForCatalog(page);
  await disabledCard.hover();
  assert.equal(await disabledCard.locator('.app-primary-action').count(), 0, 'a disabled Agent primary renders no action');
  assert.equal(await disabledCard.getByTestId('open-platform').count(), 0, 'disabled Agent primary must not fall back to the available Web entry');
  assert.equal(await disabledCard.getByTestId('primary-disabled-reason').innerText(), profile.reason);
  const disabledFooter = await disabledCard.evaluate((el: HTMLElement) => {
    const author = el.querySelector('.app-author-name')!;
    const authorBox = author.getBoundingClientRect();
    const authorText = document.createRange(); authorText.selectNodeContents(author);
    const reason = el.querySelector('.app-primary-reason')!;
    const reasonBox = reason.getBoundingClientRect();
    const footerBox = el.querySelector('.app-card-footer')!.getBoundingClientRect();
    return { authorWidth: authorBox.width, authorTextWidth: authorText.getBoundingClientRect().width,
      authorRight: authorBox.right, reasonLeft: reasonBox.left, reasonWidth: reasonBox.width,
      reasonRight: reasonBox.right, footerRight: footerBox.right,
      cardBottom: el.getBoundingClientRect().bottom, footerBottom: footerBox.bottom };
  });
  assert.ok(disabledFooter.authorWidth >= disabledFooter.authorTextWidth, 'the narrow disabled card still shows its registered author');
  assert.ok(disabledFooter.reasonWidth >= 80, 'the disabled reason keeps enough width for readable wrapped text');
  assert.ok(disabledFooter.authorRight <= disabledFooter.reasonLeft, 'the author and disabled reason do not overlap');
  assert.ok(disabledFooter.reasonRight <= disabledFooter.footerRight + 1 && disabledFooter.footerBottom <= disabledFooter.cardBottom + 1, 'the disabled reason stays inside the card');
  assert.ok((await disabledCard.ariaSnapshot()).includes(profile.reason), 'assistive technology receives the full disabled reason');
  await disabledCard.getByTestId('card-title').click();
  await detail.waitFor();
  assert.equal(await detail.getByTestId('use-agent').isDisabled(), true);
  assert.equal(await detail.getByTestId('agent-disabled-reason').innerText(), profile.reason);
  assert.equal(await detail.getByTestId('use-web').count(), 1, 'other entries remain accessible in detail');
  await page.getByTestId('return-discovery').click();
  await detail.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await waitForCatalog(page);
  report.checks.push('real disabled-entry projection disables the author primary with its reason, preserves detail and never substitutes an alternate Web entry');

  // Random empty/single states use the same real service; no duplicate fillers.
  await harness.db.query("INSERT INTO catalog_app_lifecycle (app_id, status, revision, updated_at) SELECT id, 'offline', 2, now() FROM catalog_apps ON CONFLICT (app_id) DO UPDATE SET status = 'offline'");
  await harness.db.query("UPDATE catalog_app_lifecycle SET status = 'published' WHERE app_id = $1", [webApps[0].id]);
  await page.getByTestId('tab-random').click();
  await refreshRandom();
  await page.waitForLoadState('networkidle');
  assert.equal(await wheel.getByTestId('app-card').count(), 1);
  assert.equal(await page.getByRole('button', { name: '下一个应用', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '上一个应用', exact: true }).isDisabled(), true);
  assert.equal(await page.getByTestId('random-all-shown').innerText(), ' · 已展示全部');
  await harness.db.query("UPDATE catalog_app_lifecycle SET status = 'offline' WHERE app_id = $1", [webApps[0].id]);
  await refreshRandom();
  await page.getByText('目录中还没有可展示的应用。', { exact: true }).waitFor();
  assert.equal(await wheel.count(), 0);
  await page.route('**/api/apps/random?**', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '抽样服务暂时不可用' } }) }));
  await refreshRandom();
  await page.getByRole('alert').filter({ hasText: '抽样服务暂时不可用' }).waitFor();
  assert.equal(await page.getByText('目录中还没有可展示的应用。', { exact: true }).count(), 0, 'error is not presented as empty');
  report.checks.push('single-item wheel disables switching and says all shown; zero items and service errors have separate states');

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
