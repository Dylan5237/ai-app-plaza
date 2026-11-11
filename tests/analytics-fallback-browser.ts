import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';

const h = await startIdentityHarness('/plaza', { analytics: true });
const owner = await h.login('fixture-admin');
const privateApp = await seedTagCatalog(h.db, h.config.audience, ['仅本人标签']);
await seedTagCatalog(h.db, h.config.audience, ['公开标签'], 2);
await h.db.query("INSERT INTO plaza_app_access(app_id,owner_id,scope) VALUES($1,$2,'self')", [privateApp.appId, owner.user.id]);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${h.origin}/plaza/fixture/portal`);
  await page.getByRole('button', { name: '以测试名册管理员进入', exact: true }).click();
  await page.getByRole('button', { name: '退出广场', exact: true }).waitFor();
  await page.getByTestId('app-card').first().waitFor();
  for (const failure of [401, 503]) {
    const requests = new Map<string, { token: string | undefined; payload: any }[]>();
    await page.route('**/api/analytics/events', async route => {
      const request = route.request(), payload = request.postDataJSON();
      const token = request.headers()['x-plaza-portal-token'];
      const attempts = requests.get(payload.eventId) || [];
      attempts.push({ token, payload }); requests.set(payload.eventId, attempts);
      if (token) return route.fulfill({ status: failure, contentType: 'application/json', body: JSON.stringify({ error: { code: failure === 401 ? 'LOGIN_REQUIRED' : 'IDENTITY_UNAVAILABLE' } }) });
      return route.continue();
    });
    const fallbackResponse = page.waitForResponse(response => response.url().endsWith('/api/analytics/events') && !response.request().headers()['x-plaza-portal-token'] && response.request().postDataJSON()?.eventName === 'catalog_results_viewed');
    await page.getByRole('textbox', { name: '搜索应用名称、用途或能力' }).fill(failure === 401 ? 'fixture' : 'application');
    await page.getByTestId('search-button').click();
    const response = await fallbackResponse;
    assert.equal(response.status(), 200);
    const eventId = response.request().postDataJSON().eventId;
    const attempts = requests.get(eventId)!;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].token, 'fixture-admin');
    assert.equal(attempts[1].token, undefined);
    assert.deepEqual(attempts[0].payload, attempts[1].payload, 'retry keeps the original event id and timestamp');
    await page.waitForFunction(() => document.querySelector('.catalog-results')?.getAttribute('aria-busy') === 'false');
    for (let attempt = 0; attempt < 30; attempt++) {
      const row = (await h.db.query('SELECT app_id,snapshot_id FROM analytics_events WHERE event_id=ANY($1::uuid[]) AND event_name=$2 AND app_id IS NULL', [[...requests.keys()], 'app_card_exposed'])).rows[0];
      if (row) { assert.equal(row.snapshot_id, null); break; }
      assert.ok(attempt < 29, 'restricted application exposure survives without private attribution');
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(2200);
    assert.ok([...requests.values()].every(attempts => attempts.length <= 2), 'fallback does not start another retry chain');
    assert.equal(await page.getByRole('button', { name: '退出广场', exact: true }).count(), 1);
    await page.unroute('**/api/analytics/events');
  }
  await page.route('**/api/analytics/events', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  let failedAttempts = 0;
  page.on('request', request => { if (request.url().endsWith('/api/analytics/events') && request.postDataJSON()?.eventName === 'catalog_results_viewed') failedAttempts++; });
  await page.getByRole('textbox', { name: '搜索应用名称、用途或能力' }).fill('fixture application');
  await page.getByTestId('search-button').click();
  await page.waitForTimeout(2500);
  assert.equal(failedAttempts, 2, 'failed anonymous fallback stops after one attempt');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'PASS', cases: ['401 fallback', '503 fallback', 'private attribution removed', 'bounded retries'], boundary: 'loopback fixtures only' }));
} finally { await browser.close(); await h.close(); }
