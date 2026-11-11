import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { DEFAULT_TAG, manifest, SHA, SHA2, TOKEN } from './helpers/gitlab-fixture.js';

await mkdir('artifacts', { recursive: true });
const report: any = { status: 'RUNNING', boundary: 'Local Chrome + real portal service + PostgreSQL engine + controlled GitLab protocol fixture; no real repository writes or Agent installation', views: [], errors: [], unexpectedRequests: [] };
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    const h = await startHarness(1, 'memory://', { localManagement: true });
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedText = text; } } });" });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (/^https?:/.test(url) && new URL(url).origin !== h.origin) { report.unexpectedRequests.push(url); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => report.errors.push(error.message));
      const base = { projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG };
      const first = await h.service.submit(base, TOKEN, randomUUID());
      const saved = await h.service.confirm(first.id, first.ticket, { revision: first.revision, digest: first.digest! });
      const appUrl = `${h.origin}/?app=${saved.appId}`;
      await page.goto(appUrl);
      await page.getByTestId('app-detail').waitFor();
      assert.equal(await page.getByTestId('publish-update').count(), 0, 'public detail does not expose author updates');
      await page.goto(h.origin + '/admin');
      await page.getByTestId(`management-detail-${saved.appId}`).click();
      await page.getByTestId('publish-update').click();
      await page.getByTestId('update-target').waitFor();
      assert.match(await page.getByTestId('update-target').innerText(), /当前 v1\.0\.0/);
      assert.equal(await page.getByTestId('publish-contract-dialog').locator('input, textarea').count(), 0, 'authors do not fill a form');
      await page.getByTestId('copy-publish-prompt').click();
      const updatePrompt = await page.evaluate(() => (window as any).copiedText);
      for (const text of [saved.appId!, '"expectedAppRevision": 1', '不要调用确认接口', '任一缺失时先向我询问']) assert.ok(updatePrompt.includes(text), text);
      await page.keyboard.press('Escape');
      await page.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' });
      await page.getByTestId('use-agent').click();
      await page.getByTestId('copy-agent-prompt').click();
      const guide = await page.evaluate(() => (window as any).copiedText);
      for (const text of [appUrl, SHA, '未安装', '已安装旧版', '已是目标版本', '本地修改', '备份', '不自动降级']) assert.ok(guide.includes(text), text);
      await page.keyboard.press('Escape');
      await page.getByTestId('agent-instruction-content').waitFor({ state: 'hidden' });
      await page.screenshot({ path: `artifacts/update-detail-${viewport.width}.png`, fullPage: true });

      h.gitlab.state.files.set('ai-app.json', JSON.stringify({ ...manifest(), projectVersion: '1.1.0', summary: '文档转换新增批量处理能力。' }));
      h.gitlab.state.files.set('docs/agent-1.md', '# 新版升级说明\n保留用户配置与本地修改，升级程序文件后执行最小验证。');
      h.gitlab.state.tagName = 'v1.1.0'; h.gitlab.state.tagSha = SHA2; h.gitlab.state.releaseSha = SHA2;
      const update = await h.service.submit({ ...base, commitSha: SHA2, tag: 'v1.1.0', expectedAppRevision: 1 }, TOKEN, randomUUID());
      assert.equal(update.status, 'preview_ready');
      await page.goto(`${h.origin}/admin#publish=${update.id}`);
      await page.getByTestId('update-preview').waitFor();
      const preview = await page.getByTestId('update-preview').innerText();
      assert.match(preview, /v1\.0\.0\s*→\s*v1\.1\.0/);
      assert.ok(preview.includes('应用简介') && preview.includes('使用文档'));
      assert.equal(await page.getByTestId('confirm-publication').innerText(), '确认更新');
      const colors = await page.locator('.publication-change p,.publication-change span').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).color, getComputedStyle(node.closest('.publication-change')!).backgroundColor]));
      const luminance = (color: string) => color.match(/[0-9.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrasts = colors.map(([foreground, surface]) => {
          const text = luminance(foreground), background = luminance(surface);
          return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
      });
      assert.ok(contrasts.length >= 2 && contrasts.every(ratio => ratio >= 4.5), `publication change text contrast: ${contrasts}`);
      report.contrasts = [...(report.contrasts || []), { viewport: viewport.width, ratios: contrasts }];
      await page.reload();
      await page.getByTestId('confirm-publication').waitFor();
      assert.equal((await h.service.app(saved.appId!)).version, '1.0.0');
      await page.screenshot({ path: `artifacts/update-preview-${viewport.width}.png`, fullPage: true });
      h.gitlab.state.offline = true;
      await page.getByTestId('confirm-publication').click();
      await page.getByText('本次更新未完成', { exact: true }).waitFor();
      await page.getByTestId('retry-publication').waitFor();
      assert.equal((await h.service.app(saved.appId!)).version, '1.0.0', 'failed update leaves the published app intact');
      h.gitlab.state.offline = false;
      await page.getByTestId('retry-publication').click();
      await page.getByText('应用已更新', { exact: true }).waitFor();
      assert.equal((await h.service.list()).total, 1);
      assert.equal((await h.service.app(saved.appId!)).version, '1.1.0');
      await page.reload();
      await page.getByText('应用已更新', { exact: true }).waitFor();
      assert.ok((await page.getByTestId('update-preview').innerText()).includes('v1.1.0'));

      await page.goto(appUrl);
      await page.getByTestId('use-agent').click();
      await page.getByTestId('copy-agent-prompt').click();
      // Public copying revalidates the current entry before writing to the clipboard.
      await page.waitForFunction(() => typeof (window as any).copiedText === 'string');
      const latestGuide = await page.evaluate(() => (window as any).copiedText);
      assert.ok(latestGuide.includes(SHA2) && latestGuide.includes('# 新版升级说明') && !latestGuide.includes(SHA));
      await page.keyboard.press('Escape');
      await page.getByTestId('agent-instruction-content').waitFor({ state: 'hidden' });
      await page.goto(h.origin + '/admin');
      await page.getByTestId(`management-detail-${saved.appId}`).click();
      await page.getByTestId('publish-update').click();
      await page.getByTestId('update-target').waitFor();
      assert.match(await page.getByTestId('update-target').innerText(), /当前 v1\.1\.0/);
      await page.keyboard.press('Escape');
      await page.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
      await page.goto(h.origin);
      await page.getByTestId('share-button').click();
      await page.getByTestId('copy-publish-prompt').waitFor();
      assert.equal(await page.getByTestId('update-target').count(), 0, 'first publication does not retain a previously selected update target');
      assert.equal(await page.getByTestId('copy-publish-prompt').innerText(), '复制发布提示词');
      const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth }));
      assert.equal(overflow.horizontal, false);
      report.views.push({ viewport, updatePreview: true, failurePreservedOldApp: true, retried: true, stableLink: true, latestGuide: true, authorFormFields: 0 });
    } finally { await context.close(); await h.close(); }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile('artifacts/update-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
