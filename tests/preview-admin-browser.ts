import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Route } from 'playwright';
import { startPreviewAdminFixture } from './helpers/preview-admin-fixture.js';

await mkdir('artifacts/preview-admin-browser', { recursive: true });
const h = await startPreviewAdminFixture();
const report: any = { status: 'RUNNING', boundary: 'Local controlled GitLab protocol fixture, real Fastify and PGlite; no company GitLab, production previews or deployment', checks: [], errors: [], unexpectedRequests: [], requests: [] };
let browser: any;
let page: any;
function observePage(target: any) {
  target.on('pageerror', (error: any) => report.errors.push(error.message));
  target.on('request', (request: any) => {
    const url = new URL(request.url());
    if (url.origin !== h.origin) report.unexpectedRequests.push(url.origin + url.pathname);
    if (url.origin === h.origin && url.pathname.startsWith('/api/preview-admin')) report.requests.push({ method: request.method(), path: url.pathname });
  });
}
const snapshot = async () => {
  const result: any = {};
  for (const table of ['catalog_apps', 'published_snapshots', 'publications', 'catalog_tag_overrides', 'catalog_tag_cleanup_operations', 'managed_app_bindings', 'managed_publish_operations']) {
    result[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
};
try {
  const before = await snapshot();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  observePage(page);
  await page.goto(h.origin);
  await page.getByTestId('app-card').first().waitFor();
  const searchButton = page.getByTestId('search-button');
  assert.equal(await searchButton.evaluate((element: Element) => getComputedStyle(element).backgroundColor), 'rgb(22, 93, 255)');
  const logo = page.getByRole('button', { name: 'AI应用广场', exact: true });
  await logo.click(); assert.equal(new URL(page.url()).pathname, '/');
  await page.reload(); await logo.dblclick(); assert.equal(new URL(page.url()).pathname, '/');
  await page.reload(); await logo.click({ clickCount: 3 });
  await page.waitForURL('**/private-previews');
  assert.equal(await page.getByRole('heading', { name: '管理员登录' }).count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0, 'the page must not contain a password field');
  assert.equal(await page.getByLabel('管理员口令').count(), 0);
  await page.getByText('共 25 项', { exact: true }).waitFor();
  const adminQuery = page.getByRole('button', { name: '查询', exact: true });
  assert.equal(await adminQuery.evaluate((element: Element) => getComputedStyle(element).backgroundColor), 'rgb(22, 93, 255)');
  assert.equal(await page.locator('.publication-table .el-table__body-wrapper tbody tr').count(), 20);
  report.checks.push('single/double click stays in catalog; triple click opens read-only management directly; primary search buttons use #165dff');

  await page.locator('.private-preview-admin').hover();
  await page.mouse.wheel(0, 2200);
  await page.waitForFunction(() => document.querySelector('.private-preview-admin')!.scrollTop > 0);
  await page.getByRole('button', { name: 'Go to next page', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.publication-table .el-table__body-wrapper tbody tr').length === 5);
  await page.getByRole('button', { name: 'Go to previous page', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.publication-table .el-table__body-wrapper tbody tr').length === 20);
  await page.mouse.wheel(0, -3000);
  await page.waitForFunction(() => document.querySelector('.private-preview-admin')!.scrollTop === 0);
  await page.screenshot({ path: 'artifacts/preview-admin-browser/desktop.png', fullPage: true, animations: 'disabled' });
  report.checks.push('multi-author listing, wheel scrolling and first/last-page navigation');

  const search = page.getByLabel('搜索应用名称、应用标识或作者', { exact: true });
  await search.fill('验证作者甲');
  await adminQuery.click();
  await page.getByText('共 1 项', { exact: true }).waitFor();
  await page.getByRole('button', { name: '详情', exact: true }).click();
  await page.getByRole('heading', { name: '发布详情', exact: true }).waitFor();
  await page.getByRole('heading', { name: '应用预览与来源' }).waitFor();
  await page.getByText('使用步骤与说明', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: /确认收录|重试|恢复|取消|删除/ }).count(), 0);
  await page.screenshot({ path: 'artifacts/preview-admin-browser/detail.png', fullPage: true });
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await search.fill(''); await adminQuery.click();
  await page.getByText('共 25 项', { exact: true }).waitFor();
  await page.locator('.filter-control .el-select__wrapper').click();
  await page.getByRole('option', { name: '预览已过期', exact: true }).click();
  await page.getByText('共 1 项', { exact: true }).waitFor();
  await page.getByText('本地验证：过期预览', { exact: true }).waitFor();
  report.checks.push('author search, complete read-only preview with source, and expired filter');

  await page.getByRole('button', { name: '返回广场', exact: true }).click();
  await page.waitForURL(h.origin + '/');
  await page.getByRole('button', { name: 'AI应用广场', exact: true }).click({ clickCount: 3 });
  await page.waitForURL('**/private-previews');
  await page.getByText('共 25 项', { exact: true }).waitFor();
  await context.clearCookies();
  await page.reload();
  await page.getByText('共 25 项', { exact: true }).waitFor();
  assert.equal(await page.locator('.publication-table .el-table__body-wrapper tbody tr').count(), 20);
  report.checks.push('return to catalog and reopen; clearing cookies then refreshing still preserves read access');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page must not overflow');
  await page.screenshot({ path: 'artifacts/preview-admin-browser/mobile.png', fullPage: true });
  report.checks.push('mobile layout remains usable');

  await page.route('**/api/preview-admin/publications?**', async (route: Route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ORIGIN_DENIED', message: '受控验证：权限不可用' } }) }));
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByRole('heading', { name: '暂时无法读取发布记录', exact: true }).waitFor();
  assert.equal(await page.locator('.publication-table').count(), 0);
  assert.equal(await page.locator('.summary-grid').count(), 0, 'failed reads must clear private counts');
  assert.equal(await page.getByText('本地验证：待确认应用 A', { exact: true }).count(), 0, 'failed reads must clear private rows and details');
  report.checks.push('403 clears private rows and statistics and offers a retry');
  await page.unroute('**/api/preview-admin/publications?**');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByText('共 25 项', { exact: true }).waitFor();
  assert.equal(await page.locator('.publication-table .el-table__body-wrapper tbody tr').count(), 20);
  report.checks.push('removing the 403 response and reloading restores the records');

  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
  assert.equal(report.requests.every((request: any) => request.method === 'GET'), true, 'preview management must make GET requests only');
  assert.equal(report.requests.some((request: any) => request.path.endsWith('/session')), false, 'there is no preview-admin session request');
  assert.deepEqual(await snapshot(), before);
  report.checks.push('all preview-admin requests are GET; seven business tables are unchanged');
  report.status = 'PASS';
} catch (error: any) {
  report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({ path: 'artifacts/preview-admin-browser/failure.png', fullPage: true }).catch(() => {});
}
finally {
  await browser?.close(); await h.close();
  await writeFile('artifacts/preview-admin-browser/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
