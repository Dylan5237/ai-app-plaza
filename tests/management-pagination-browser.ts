import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { startManagementFixture } from './helpers/management-fixture.js';
import { seedManagementPagination } from './helpers/management-pagination.js';

const artifactDir = 'artifacts/management-pagination-browser';
await mkdir(artifactDir, { recursive: true });
const fixture = await startManagementFixture();
const report: any = {
  checks: [], errors: [], unexpectedRequests: [], requests: [], viewTotals: {}, viewports: [],
  boundary: 'Real local Fastify/PGlite and Chromium with loopback-only fixtures; synthetic records only; no production, GitLab, or Host operation',
};
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL as any }
      : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })" });
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/api/')) report.requests.push({ method: request.method(), path: url.pathname });
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (/^https?:/.test(url.protocol) && url.origin !== fixture.origin) {
    report.unexpectedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort();
  }
  return route.continue();
});

const views = ['apps', 'publications', 'uploads', 'trash'] as const;
type View = typeof views[number];
const titles: Record<View, string> = {
  apps: '应用管理', publications: '待收录与更新', uploads: '上传占位', trash: '回收站',
};
let releaseSlowRequest: (() => void) | undefined;

async function waitListReady() {
  await page.waitForFunction(() => document.querySelector('.management-records')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function currentPage(): Promise<number> {
  const active = page.getByTestId('management-pagination').locator('.el-pager .is-active');
  return await active.count() ? Number((await active.innerText()).trim()) : 1;
}

async function currentTotal(): Promise<number> {
  const label = await page.getByTestId('management-pagination').locator(':scope > span').first().innerText();
  const match = label.match(/共\s*(\d+)\s*项/);
  assert.ok(match, `Unexpected total label: ${label}`);
  return Number(match[1]);
}

async function visibleKeys(): Promise<string[]> {
  return page.getByTestId('management-table').locator('.el-table__body tr').evaluateAll(rows => rows
    .map(row => row.querySelector('.record-app span')?.textContent?.trim() || '')
    .filter(Boolean));
}

async function visibleAppIds(): Promise<string[]> {
  return page.getByTestId('management-table').locator('.el-table__body tr').evaluateAll(rows => rows.flatMap(row => {
    const detail = row.querySelector<HTMLElement>('[data-testid^="management-detail-"]');
    const id = detail?.dataset.testid?.slice('management-detail-'.length);
    return id ? [id] : [];
  }));
}

async function switchView(view: View) {
  await page.getByTestId(`management-tab-${view}`).click();
  await page.getByRole('heading', { name: titles[view], exact: true }).waitFor();
  await waitListReady();
}

async function apiDataset(view: View) {
  const appsView = view === 'apps' || view === 'trash';
  const path = appsView ? '/api/management/apps' : `/api/management/${view}`;
  const items: any[] = [];
  let total: number | undefined;
  let pageNo = 1;
  let pageSize = 20;
  while (total === undefined || items.length < total) {
    const url = new URL(path, fixture.origin);
    url.searchParams.set('page', String(pageNo));
    if (appsView) {
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('status', view === 'trash' ? 'deleted' : 'all');
      pageSize = 100;
    }
    const response = await page.request.get(url.toString());
    assert.equal(response.ok(), true, `API list request failed for ${view} page ${pageNo}`);
    const data = await response.json();
    if (total === undefined) {
      total = Number(data.total);
      if (!appsView) pageSize = Number(data.pageSize);
    }
    assert.equal(Number(data.total), total, `${view} API total changed during a read-only page walk`);
    assert.equal(Number(data.page), pageNo);
    items.push(...data.items);
    if (items.length >= total) break;
    assert.ok(data.items.length > 0, `${view} API returned an empty page before its total was reached`);
    pageNo += 1;
    assert.ok(pageNo < 1000, `${view} API page walk did not converge`);
  }
  assert.equal(items.length, total, `${view} API pagination did not return its exact total`);
  assert.ok(pageSize > 0);
  const keys = items.map(item => view === 'apps' || view === 'trash' ? item.manifest?.appKey : item.appKey);
  assert.ok(keys.every((key: unknown) => typeof key === 'string' && key.length > 0), `${view} API is missing a stable application key`);
  assert.equal(new Set(keys).size, total, `${view} API contains duplicate synthetic keys`);
  return { total, items, keys: keys as string[] };
}

async function nextPage() {
  const before = await currentPage();
  const next = page.getByTestId('management-pagination').locator('.btn-next');
  assert.equal(await next.isDisabled(), false, 'Expected another management page');
  await next.click();
  await page.waitForFunction(expected => {
    const active = document.querySelector('[data-testid="management-pagination"] .el-pager .is-active');
    return Number(active?.textContent?.trim()) === expected;
  }, before + 1);
  await waitListReady();
}

async function previousPage(expected: number) {
  const previous = page.getByTestId('management-pagination').locator('.btn-prev');
  assert.equal(await previous.isDisabled(), false, 'Expected a previous management page');
  await previous.click();
  await page.waitForFunction(value => {
    const active = document.querySelector('[data-testid="management-pagination"] .el-pager .is-active');
    return Number(active?.textContent?.trim()) === value;
  }, expected);
  await waitListReady();
}

async function goToLastPage() {
  while (!(await page.getByTestId('management-pagination').locator('.btn-next').isDisabled())) await nextPage();
  return currentPage();
}

async function walkView(view: View, expected: Awaited<ReturnType<typeof apiDataset>>) {
  await switchView(view);
  assert.equal(await currentTotal(), expected.total, `${view} footer total does not match the complete API result`);
  const forward: string[][] = [];
  while (true) {
    assert.equal(await currentPage(), forward.length + 1, `${view} page number advanced unexpectedly`);
    const keys = await visibleKeys();
    assert.ok(keys.length > 0, `${view} page ${forward.length + 1} is empty`);
    forward.push(keys);
    const next = page.getByTestId('management-pagination').locator('.btn-next');
    if (await next.isDisabled()) break;
    await nextPage();
  }
  const flattened = forward.flat();
  assert.equal(flattened.length, expected.total, `${view} browser pages have the wrong combined row count`);
  assert.equal(new Set(flattened).size, expected.total, `${view} browser pages repeat a row`);
  assert.deepEqual([...flattened].sort(), [...expected.keys].sort(), `${view} browser pages omit or add a row`);

  for (let index = forward.length - 2; index >= 0; index -= 1) {
    await previousPage(index + 1);
    assert.deepEqual(await visibleKeys(), forward[index], `${view} backward pagination changed page ${index + 1}`);
  }
  assert.equal(await currentPage(), 1);
  report.checks.push(`${view}: footer total matches the full API result; forward/backward page traversal has no duplicates or omissions`);
}

async function lifecycleAction(id: string, action: 'delete' | 'restore') {
  await page.getByTestId(`management-${action}-${id}`).click();
  const confirmText = action === 'delete' ? '移入回收站' : '恢复为下架';
  const saved = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/management/apps/${id}/lifecycle`);
  await page.locator('.el-message-box').getByRole('button', { name: confirmText, exact: true }).click();
  const response = await saved;
  assert.equal(response.ok(), true, `The ${action} lifecycle request should succeed`);
  await waitListReady();
}

async function checkLastRowFallback(view: 'apps' | 'trash', action: 'delete' | 'restore') {
  await switchView(view);
  const initialTotal = await currentTotal();
  const lastPage = await goToLastPage();
  assert.ok(lastPage > 1, `${view} needs multiple pages for last-row fallback`);
  let ids = await visibleAppIds();
  assert.ok(ids.length > 0);
  for (const id of ids.slice(0, -1)) {
    await lifecycleAction(id, action);
    assert.equal(await currentPage(), lastPage, `${view} fell back before the last row was removed`);
  }
  ids = await visibleAppIds();
  assert.equal(ids.length, 1, `${view} should have one row left on its last page`);
  const totalBeforeFinalAction = await currentTotal();
  await lifecycleAction(ids[0]!, action);
  await page.waitForFunction(expected => {
    const active = document.querySelector('[data-testid="management-pagination"] .el-pager .is-active');
    return Number(active?.textContent?.trim()) === expected;
  }, lastPage - 1);
  assert.equal(await currentTotal(), totalBeforeFinalAction - 1, `${view} total should fall by one after its last-row action`);
  assert.equal(await currentPage(), lastPage - 1);
  report.checks.push(`${view}: ${action} on the only last-page row decrements the total and returns to the prior page`);
}

try {
  const seeded = await seedManagementPagination(fixture, 23);
  const expected = Object.fromEntries(await Promise.all(views.map(async view => [view, await apiDataset(view)]))) as Record<View, Awaited<ReturnType<typeof apiDataset>>>;
  report.seeded = { apps: seeded.apps.length, trash: seeded.trash.length, publications: seeded.publications.length, uploads: seeded.uploads.length };
  report.viewTotals = Object.fromEntries(views.map(view => [view, expected[view].total]));
  await page.goto(`${fixture.origin}/admin`);
  await page.getByTestId('management-table').waitFor();
  await waitListReady();
  for (const view of views) await walkView(view, expected[view]);

  await page.goto(`${fixture.origin}/admin`);
  await page.getByTestId('management-table').waitFor();
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const view of views) {
      await switchView(view);
      const footer = page.getByTestId('management-pagination');
      const box = await footer.boundingBox();
      assert.ok(box, `${view} footer is not visible at ${viewport.width}x${viewport.height}`);
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height + 1, `${view} footer is outside the ${viewport.width}x${viewport.height} viewport`);
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `${view} footer is outside the horizontal viewport bounds`);
      const pager = await footer.locator('.el-pagination').boundingBox();
      assert.ok(pager && Math.abs(pager.x + pager.width / 2 - box.x - box.width / 2) <= 1, `${view} pagination must be centered in the footer`);
      const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, window: window.innerWidth }));
      assert.ok(widths.document <= widths.window, `${view} has horizontal page overflow at ${viewport.width}x${viewport.height}`);
      const create = await page.getByTestId('management-create').boundingBox();
      assert.ok(create && create.x >= 0 && create.x + create.width <= viewport.width, 'The create button must remain fully visible');
      report.viewports.push({ ...viewport, view, footer: { x: box.x, y: box.y, width: box.width, height: box.height }, documentWidth: widths.document });
    }
    await page.screenshot({ path: `${artifactDir}/${viewport.width}x${viewport.height}.png` });
  }
  report.checks.push('all four views keep the pagination footer inside the viewport at 1280x720, 1440x900 and 390x844 without horizontal page overflow');

  await switchView('apps');
  await nextPage();
  await page.getByTestId('management-status').click();
  await page.getByRole('option', { name: '已上架', exact: true }).click();
  await waitListReady();
  assert.equal(await currentPage(), 1, 'Changing the application status filter should return to page one');
  assert.ok((await currentTotal()) < expected.apps.total, 'The published filter should exclude the offline fixture app');
  await nextPage();
  await page.getByTestId('management-search-input').fill('fixture pagination app 0002');
  await page.getByTestId('management-search').click();
  await waitListReady();
  assert.equal(await currentPage(), 1, 'A new query should return to page one');
  assert.equal(await currentTotal(), 1, 'The focused query should return one synthetic app');
  assert.deepEqual(await visibleKeys(), ['fixture-pagination-app-0002']);
  await switchView('publications');
  assert.equal(await currentPage(), 1, 'Changing views should return to page one');
  assert.equal(await page.getByTestId('management-search-input').inputValue(), '', 'Changing views should clear the query');
  report.checks.push('status filtering, query changes, and view changes reset page/query context as expected');

  await switchView('apps');
  await page.getByTestId('management-search-input').fill('fixture pagination app');
  await page.getByTestId('management-search').click();
  await waitListReady();
  await nextPage();
  const detailId = (await visibleAppIds())[0];
  assert.ok(detailId);
  const detailPage = await currentPage();
  const detailQuery = await page.getByTestId('management-search-input').inputValue();
  await page.getByTestId(`management-detail-${detailId}`).click();
  await page.getByTestId('app-detail').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await waitListReady();
  assert.equal(await currentPage(), detailPage);
  assert.equal(await page.getByTestId('management-search-input').inputValue(), detailQuery);
  report.checks.push('closing an app detail returns to the same management page and query');

  await switchView('publications');
  await page.getByTestId('management-search-input').fill('fixture-pagination-publication');
  await page.getByTestId('management-search').click();
  await waitListReady();
  await nextPage();
  const previewPage = await currentPage();
  const previewKeys = await visibleKeys();
  await page.getByTestId('management-table').locator('[data-testid^="management-preview-"]').first().click();
  await page.getByTestId('confirm-publication').waitFor();
  await page.getByTestId('return-management').click();
  await waitListReady();
  assert.equal(await currentPage(), previewPage, 'Returning from a publication preview must preserve the page after the list remounts');
  assert.equal(await page.getByTestId('management-search-input').inputValue(), 'fixture-pagination-publication');
  assert.deepEqual(await visibleKeys(), previewKeys);
  report.checks.push('returning from publication preview preserves the current page, query and rows across list remounts');
  await switchView('apps');

  const slowQuery = 'pagination slow old request';
  let resolveOldRequest!: () => void;
  const oldRequestArrived = new Promise<void>(resolve => { resolveOldRequest = resolve; });
  await page.route('**/api/management/apps?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('query') !== slowQuery) return route.continue();
    const response = await route.fetch();
    resolveOldRequest();
    await new Promise<void>(done => { releaseSlowRequest = done; });
    await route.fulfill({ response });
  });
  await page.getByTestId('management-search-input').fill(slowQuery);
  await page.getByTestId('management-search').click();
  await oldRequestArrived;
  await page.getByTestId('management-search-input').fill('fixture pagination app 0002');
  await page.getByTestId('management-search').click();
  await waitListReady();
  assert.deepEqual(await visibleKeys(), ['fixture-pagination-app-0002']);
  const staleResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('query') === slowQuery);
  releaseSlowRequest?.();
  await staleResponse;
  await waitListReady();
  assert.deepEqual(await visibleKeys(), ['fixture-pagination-app-0002'], 'A late earlier response must not replace the latest query result');
  assert.equal(await currentTotal(), 1);
  await page.unroute('**/api/management/apps?*');
  report.checks.push('a delayed old search response cannot overwrite a newer query result');

  await page.getByTestId('management-search-input').fill('');
  await page.getByTestId('management-search').click();
  await waitListReady();
  await nextPage();
  await page.route('**/api/management/apps?*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, total: 1, items: data.items.slice(0, 1) } });
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await waitListReady();
  assert.equal(await currentPage(), 1, 'Refresh should back up to the last page when the result total shrinks');
  assert.equal(await currentTotal(), 1);
  assert.equal((await visibleKeys()).length, 1);
  await page.unroute('**/api/management/apps?*');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await waitListReady();
  assert.equal(await currentTotal(), expected.apps.total);
  report.checks.push('refresh observes a smaller result set and automatically backs up from an out-of-range page');

  await checkLastRowFallback('apps', 'delete');
  await checkLastRowFallback('trash', 'restore');

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.status = 'PASS';
} catch (error: any) {
  report.status = 'FAIL';
  report.error = error.stack;
  process.exitCode = 1;
  await page.screenshot({ path: `${artifactDir}/failure.png`, fullPage: true }).catch(() => {});
} finally {
  releaseSlowRequest?.();
  await context.close();
  await browser.close();
  await fixture.close();
  await writeFile(`${artifactDir}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
