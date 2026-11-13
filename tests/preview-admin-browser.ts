import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreviewAdminFixture } from './helpers/preview-admin-fixture.js';

await mkdir('artifacts/preview-admin-browser', { recursive: true });
const h = await startPreviewAdminFixture();
const report: any = { checks: [], errors: [], requests: [], boundary: 'Local controlled fixture; legacy read APIs retained, UI redirected to unified admin; management writes disabled by default' };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
page.on('pageerror', e => report.errors.push(e.message));
page.on('request', r => report.requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
const snapshot = async () => {
  const result: any = {};
  for (const table of ['catalog_apps', 'published_snapshots', 'publications', 'catalog_tag_overrides', 'catalog_tag_cleanup_operations', 'managed_app_bindings', 'managed_publish_operations', 'catalog_app_lifecycle']) result[table] = (await h.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
};
try {
  const before = await snapshot();
  const first = await (await fetch(h.origin + '/api/preview-admin/publications')).json() as any;
  assert.equal(first.total, 25); assert.equal(first.items.length, 20);
  const second = await (await fetch(h.origin + '/api/preview-admin/publications?page=2')).json() as any;
  assert.equal(second.items.length, 5);
  const detail = await (await fetch(h.origin + '/api/preview-admin/publications/' + first.items[0].id)).json() as any;
  for (const field of ['ticket', 'digest', 'submission', 'token_ciphertext', 'actor_id']) assert.equal(Object.hasOwn(detail, field), false);
  const expired = await (await fetch(h.origin + '/api/preview-admin/publications?status=expired')).json() as any;
  assert.equal(expired.total, 1);
  report.checks.push('legacy read API still paginates 25 records, projects safe details, filters expired items');
  await page.goto(`${h.origin}/?discover=catalog`); await page.getByTestId('app-card').first().waitFor();
  assert.equal(await page.getByTestId('search-button').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(62, 88, 206)');
  const logo = page.getByRole('link', { name: 'AI 应用广场首页', exact: true });
  await logo.click(); assert.equal(new URL(page.url()).pathname, '/');
  await page.getByRole('link', { name: '管理中心', exact: true }).click(); await page.waitForURL('**/admin');
  await page.getByTestId('management-table').waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '发布新版本', exact: true }).isDisabled(), true);
  assert.equal((await page.request.get(h.origin + '/api/management/publications')).status(), 404);
  report.checks.push('explicit management navigation opens unified admin; local write capability remains disabled by default without a password page');
  await page.goto(h.origin + '/private-previews'); await page.waitForURL('**/admin');
  await page.getByTestId('management-table').waitFor();
  await page.screenshot({ path: 'artifacts/preview-admin-browser/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/preview-admin-browser/mobile.png', fullPage: true });
  report.checks.push('old private-preview address redirects to admin; mobile has no page overflow');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(report.errors, []); assert.equal(report.requests.every((r: any) => r.method === 'GET'), true);
  report.checks.push('all observed requests are GET and all eight business tables are unchanged'); report.status = 'PASS';
} catch (error: any) { report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; await page.screenshot({ path: 'artifacts/preview-admin-browser/failure.png', fullPage: true }).catch(() => {}); }
finally { await browser.close(); await h.close(); await writeFile('artifacts/preview-admin-browser/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
