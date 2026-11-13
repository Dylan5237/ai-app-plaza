import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startManagementFixture } from './helpers/management-fixture.js';

await mkdir('artifacts/management-browser', { recursive: true });
const h = await startManagementFixture();
const report: any = { checks: [], errors: [], unexpectedRequests: [], requests: [], boundary: 'Real local Fastify/PGlite with controlled GitLab protocol fixture; synthetic applications only; no production/GitLab/Host operations' };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text } } })" });
await context.route('**/*', route => { const u = new URL(route.request().url()); if (/^https?:/.test(u.protocol) && u.origin !== h.origin) { report.unexpectedRequests.push(u.origin + u.pathname); return route.abort() } return route.continue() });
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on('pageerror', e => report.errors.push(e.message));
page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) report.requests.push({ method: r.method(), path: u.pathname }) });
const seeds = h.seeds;
const postCount = () => report.requests.filter((r: any) => r.method === 'POST').length;
try {
  const writesBefore = h.gitlab.state.writes.length;
  await page.goto(h.origin + '/admin'); await page.getByText('本地集成版本', { exact: true }).waitFor();
  await page.getByTestId(`management-detail-${seeds.update.appId}`).waitFor();
  const previousTotal = await page.getByTestId('management-pagination').innerText();
  await page.route('**/api/management/apps?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '管理列表暂不可用' } }) }));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '管理列表暂不可用' }).waitFor();
  assert.equal(await page.getByTestId(`management-detail-${seeds.update.appId}`).count(), 1, 'failed refresh retains the management rows');
  assert.equal(await page.getByTestId('management-pagination').innerText(), previousTotal, 'failed refresh retains the matching total');
  await page.unroute('**/api/management/apps?*');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '管理列表暂不可用' }).waitFor({ state: 'hidden' });
  await page.getByTestId(`management-detail-${seeds.update.appId}`).click(); await page.getByTestId('app-detail').waitFor();
  await page.getByTestId('read-full-docs').click(); await page.getByTestId('detail-documents-dialog').waitFor(); await page.getByTestId('detail-documents-dialog').locator('.el-dialog__headerbtn').click();
  await page.getByTestId('read-source').click(); await page.getByTestId('detail-source-dialog').waitFor(); await page.getByTestId('detail-source-dialog').locator('.el-dialog__headerbtn').click();
  await page.getByTestId('use-agent').click(); await page.getByTestId('copy-agent-prompt').click(); assert.match(await page.evaluate(() => (window as any).copiedText), /Agent/); await page.keyboard.press('Escape'); await page.getByTestId('agent-instruction-dialog').waitFor({ state: 'hidden' });
  await page.getByTestId('publish-update').click(); await page.getByTestId('update-target').waitFor(); assert.match(await page.getByTestId('update-target').innerText(), /当前 v1\.0\.0/); await page.getByTestId('copy-publish-prompt').click(); assert.match(await page.evaluate(() => (window as any).copiedText), /fixture-docpilot-update/);
  await page.keyboard.press('Escape'); await page.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' }); await page.keyboard.press('Escape'); await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  report.checks.push('admin details, full documents, source, Agent instructions and update prompt all use the existing components and dialogs');

  await page.goto(`${h.origin}/?discover=catalog&app=${seeds.update.appId}`); await page.getByTestId('app-detail').waitFor(); assert.equal(await page.getByTestId('publish-update').count(), 0); await page.keyboard.press('Escape'); await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await page.getByTestId('share-button').click(); await page.getByTestId('copy-publish-prompt').waitFor(); assert.equal(await page.getByTestId('update-target').count(), 0); assert.equal(await page.getByTestId('publish-contract-dialog').locator('input,textarea').count(), 0);
  assert.equal(await page.getByTestId('publish-contract-dialog').getByRole('link', { name: '查看 GitLab 仓库（统一托管空间）', exact: true }).count(), 1, 'the managed hosting link names its GitLab destination');
  report.checks.push('public plaza has no author update action and first sharing retains the original prompt flow');

  await page.goto(h.origin + '/admin'); await page.getByTestId('management-tab-uploads').click(); await page.getByText('fixture-prepared-placeholder', { exact: true }).first().waitFor(); assert.equal(await page.getByRole('button', { name: '收录', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'artifacts/management-browser/placeholder.png', fullPage: true });
  report.checks.push('real prepared upload placeholder is shown with collection disabled until a preview exists');

  await page.getByTestId('management-tab-publications').click(); await page.getByTestId('management-search-input').fill('fixture-docpilot-update'); await page.getByTestId('management-search').click();
  await page.getByTestId(`management-preview-${seeds.update.publicationId}`).click(); await page.getByTestId('update-preview').waitFor();
  assert.match(await page.getByTestId('update-preview').innerText(), /v1\.0\.0[\s\S]*v1\.1\.0/);
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('ai-app-plaza:publication:')).length), 0);
  assert.equal((await h.service.app(seeds.update.appId)).version, '1.0.0'); await page.screenshot({ path: 'artifacts/management-browser/update-preview.png', fullPage: true });
  h.gitlab.state.role = 10;
  await page.getByTestId('confirm-publication').click(); await page.getByText('本次更新未完成', { exact: true }).waitFor(); await page.getByTestId('retry-publication').waitFor(); assert.equal((await h.service.app(seeds.update.appId)).version, '1.0.0');
  h.gitlab.state.role = 40;
  await page.getByTestId('retry-publication').click(); await page.getByText('应用已更新', { exact: true }).waitFor(); assert.equal((await h.service.app(seeds.update.appId)).version, '1.1.0'); assert.equal((await h.service.list()).total, 2);
  await page.getByTestId('return-management').click(); await page.waitForURL(h.origin + '/admin'); await page.getByText('待收录与更新', { exact: true }).first().waitFor(); assert.equal(await page.getByTestId('management-search-input').inputValue(), 'fixture-docpilot-update');
  assert.equal(await page.getByTestId('management-tab-publications').evaluate(el => el.classList.contains('active')), true); await page.getByTestId('management-search-input').fill(''); await page.getByTestId('management-search').click();
  report.checks.push('same preview/confirmation/retry flow keeps the old version on failure, then updates the same app, without author tickets or losing list context');

  const initialPosts = postCount();
  await page.route(`**/api/management/publications/${seeds.firstUpload.publicationId}`, async route => {
    const response = await route.fetch(); const data = await response.json(); await route.fulfill({ response, json: { ...data, expiresAt: '2000-01-01T00:00:00.000Z' } });
  });
  await page.getByTestId(`management-preview-${seeds.firstUpload.publicationId}`).click(); await page.getByTestId('confirm-publication').waitFor(); assert.equal(await page.getByTestId('confirm-publication').isDisabled(), true); assert.equal(postCount(), initialPosts); await page.getByTestId('return-management').click(); await page.waitForURL(h.origin + '/admin'); await page.unroute(`**/api/management/publications/${seeds.firstUpload.publicationId}`);
  report.checks.push('expired view disables collection in the shared UI without a write request; real expired writes are separately API-tested');

  let releaseOld!: () => void; const held = new Promise<void>(resolve => { releaseOld = resolve }); let requestArrived!: () => void; const arrived = new Promise<void>(resolve => { requestArrived = resolve });
  await page.route(`**/api/management/publications/${seeds.update.publicationId}`, async route => { const response = await route.fetch(); requestArrived(); await held; await route.fulfill({ response }) });
  await page.goto(`${h.origin}/admin#publish=${seeds.update.publicationId}`); await arrived; await page.getByTestId('return-management').click(); await page.waitForURL(h.origin + '/admin'); await page.getByTestId('management-tab-publications').click(); await page.getByTestId(`management-preview-${seeds.firstUpload.publicationId}`).click(); await page.getByTestId('confirm-publication').waitFor(); releaseOld();
  await page.waitForTimeout(120); assert.match(await page.locator('.publication-preview .public-app-title-row').innerText(), /首次上传待确认/); await page.unroute(`**/api/management/publications/${seeds.update.publicationId}`);
  await page.getByTestId('confirm-publication').click(); await page.getByText('应用已收录', { exact: true }).waitFor(); assert.equal((await h.service.list()).total, 3);
  assert.equal(h.gitlab.state.writes.length, writesBefore, 'confirmation and retry only read the fixed GitLab sources');
  report.checks.push('a late response cannot replace another selected publication; first collection persists through the same service and introduces no GitLab writes');

  await page.goto(h.origin + '/private-previews'); await page.waitForURL('**/admin'); await page.getByTestId('management-table').waitFor(); await page.screenshot({ path: 'artifacts/management-browser/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: 'artifacts/management-browser/mobile.png', fullPage: true });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []); report.checks.push('legacy address redirects, mobile layout has no page overflow and no JavaScript or cross-origin browser requests occurred'); report.status = 'PASS';
} catch (error: any) { report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; await page.screenshot({ path: 'artifacts/management-browser/failure.png', fullPage: true }).catch(() => {}); }
finally { await context.close(); await browser.close(); await h.close(); await writeFile('artifacts/management-browser/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
