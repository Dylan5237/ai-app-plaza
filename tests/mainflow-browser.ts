import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers/harness.js';
import { SHA, TOKEN } from './helpers/gitlab-fixture.js';

await mkdir('artifacts', { recursive: true });
const report: any = { status: 'RUNNING', boundary: 'Local browser + real service + PostgreSQL engine + controlled GitLab protocol fixture; not company GitLab/Host acceptance', views: [], errors: [], unexpectedRequests: [] };
const harness = await startHarness(9);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
  const publication = await harness.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA }, TOKEN, randomUUID());
  assert.equal(publication.status, 'preview_ready');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    const context = await browser.newContext({ viewport });
    context.on('page', page => page.on('pageerror', error => report.errors.push(error.message)));
    await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedText = text; } } });" });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (/^https?:/.test(url) && new URL(url).origin !== harness.origin) { report.unexpectedRequests.push(url); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    if (viewport.width === 1440) {
      await page.goto(harness.origin);
      await page.getByTestId('share-button').click();
      await page.getByTestId('copy-publish-prompt').click();
      assert.ok((await page.evaluate(() => (window as any).copiedText)).includes('/api/publications'));
      await page.goto(publication.previewUrl);
      await page.getByTestId('confirm-publication').waitFor();
      assert.ok(!page.url().includes('key='), 'publication key remains in location');
      await page.reload();
      await page.getByTestId('confirm-publication').waitFor();
      assert.equal(await page.evaluate(() => (window as any).fixtureXss), undefined);
      harness.gitlab.state.offline = true;
      await page.getByTestId('confirm-publication').click();
      await page.getByText('收录未完成', { exact: true }).waitFor();
      harness.gitlab.state.offline = false;
      await page.getByTestId('retry-publication').click();
      await page.getByText('应用已收录', { exact: true }).waitFor();
      const actual = await harness.service.publication(publication.id, publication.ticket);
      assert.equal(actual.status, 'registered');
      for (let i = 2; i <= 9; i++) {
        const draft = await harness.service.submit({ projectId: 1, appKey: `sample-${i}`, manifestPath: `.ai-apps/sample-${i}/ai-app.json`, commitSha: SHA }, TOKEN, randomUUID());
        assert.equal(draft.status, 'preview_ready');
        assert.equal((await harness.service.confirm(draft.id, draft.ticket, { revision: draft.revision, digest: draft.digest! })).status, 'registered');
      }
    }
    await page.goto(harness.origin);
    await page.getByTestId('app-card').first().waitFor();
    assert.equal(await page.getByTestId('app-card').count(), 8);
    const boxes = await page.getByTestId('app-card').evaluateAll(cards => cards.map(card => { const r = card.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height }; }));
    assert.equal(new Set(boxes.map(box => box.y)).size, 2, 'eight cards must occupy two rows');
    assert.equal(new Set(boxes.map(box => box.x)).size, 4, 'four cards per row');
    const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth, vertical: document.documentElement.scrollHeight > innerHeight }));
    assert.equal(overflow.horizontal, false);
    assert.equal(overflow.vertical, false, 'catalog must fit desktop viewport');
    const catalogOverflow = await page.locator('.directory-shell').evaluate(el => ({ horizontal: el.scrollWidth > el.clientWidth, vertical: el.scrollHeight > el.clientHeight }));
    assert.deepEqual(catalogOverflow, { horizontal: false, vertical: false }, 'catalog scroll container must also fit desktop viewport');
    await page.getByRole('textbox', { name: '搜索应用名称、用途或能力' }).fill('Word');
    await page.getByTestId('search-button').click();
    await page.getByTestId('app-card').first().waitFor();
    await page.getByTestId('tag-chip').filter({ hasText: '知识整理' }).first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="app-card"]').length === 5);
    await page.getByTestId('app-card').first().getByRole('button', { name: /查看.*详情/ }).click();
    await page.getByTestId('app-detail').waitFor();
    await page.getByTestId('use-agent').first().click();
    await page.getByTestId('copy-agent-prompt').click();
    const copied = await page.evaluate(() => (window as any).copiedText);
    assert.ok(copied.includes('最小验证') && copied.includes(SHA), 'copied prompt must retain fixed source and verification');
    assert.equal(await page.evaluate(() => (window as any).fixtureXss), undefined);
    assert.equal(await page.locator('img[src*="example.invalid"]').count(), 0, 'shared markdown must not fetch external images');
    const web = page.getByTestId('use-web').first();
    assert.equal(await web.getAttribute('href'), 'https://example.invalid/docpilot');
    assert.ok((await web.getAttribute('rel'))?.includes('noopener'));
    await page.screenshot({ path: `artifacts/mainflow-detail-${viewport.width}.png` });
    report.views.push({ viewport, cards: boxes.length, columns: 4, rows: 2, overflow, publicationReload: viewport.width === 1440 });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.status = 'PASS';
} catch (error: any) { report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; }
finally {
  await browser?.close(); await harness.close();
  await writeFile('artifacts/mainflow-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
