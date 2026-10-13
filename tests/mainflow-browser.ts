import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers/harness.js';
import { DEFAULT_TAG, SHA, TOKEN } from './helpers/gitlab-fixture.js';

await mkdir('artifacts', { recursive: true });
const report: any = { status: 'RUNNING', boundary: 'Local browser + real service + PostgreSQL engine + controlled GitLab protocol fixture; not company GitLab/Host acceptance', views: [], errors: [], unexpectedRequests: [] };

function withDenseDetail(app: any) {
  const manifest = app.manifest || {};
  const documentPaths = Object.values(manifest.docs || {}).filter((value: any) => typeof value === 'string');
  const documentPath = String(documentPaths[0] || 'docs/usage.md');
  const longDocument = Array.from({ length: 18 }, (_, index) => `## 完整资料第 ${index + 1} 节\n\n本文用于验证较长的应用说明在按需阅读时仍可访问。请准备必要材料，按当前任务核对处理结果，并遵循作者提供的适用条件与使用边界。`).join('\n\n') + '\n\nDOC-TAIL-END';
  const longRequest = `${'请根据任务目标整理输入材料，保留关键事实、来源和需要复核的内容。'.repeat(18)}\nEXAMPLE-END-1`;
  return {
    ...app,
    manifest: {
      ...manifest,
      maintainers: [{ name: '张明', nameEn: 'Ming Zhang' }],
      summary: '面向团队文档处理的应用，支持根据任务整理材料、提取重点并生成可复核的结果。'.repeat(2).slice(0, 95),
      capabilities: {
        ...(manifest.capabilities || {}),
        scenarios: [
          '长篇技术材料快速整理与重点提取',
          '将多来源会议记录归并为结构化摘要',
          '为交接、评审或复盘准备可追溯结论',
        ],
      },
      requirements: [
        '需提供待处理的 Word 文档及当前任务目标。',
        '输入材料应具备必要的读取权限。',
        '涉及专有数据时需先完成内部授权。',
        '对关键结论提供可核对的上下文。',
        '复杂任务应明确期望输出的结构。',
      ],
      limitations: [
        '输出仍需由使用者核对后再采用。',
        '不替代专业审核与业务决策。',
        '扫描件质量可能影响识别结果。',
        '不应输入未获授权的敏感资料。',
        '跨文档结论需要回看原始出处。',
        '无法保证第三方工具持续可用。',
      ],
      examples: [
        { request: longRequest, expectedResult: '生成可核对的结构化摘要。' },
        { request: '整理本次任务结果并列出待核对事项。', expectedResult: '给出结论和核对清单。' },
      ],
    },
    documents: { ...(app.documents || {}), [documentPath]: longDocument },
  };
}

async function installDetailFixtureRoute(page: any) {
  const appKeyById = new Map<string, string>();
  await page.route('**/api/apps**', async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.continue();

    if (pathname === '/api/apps') {
      const response = await route.fetch();
      const payload = await response.json();
      const items = (Array.isArray(payload.items) ? payload.items : []).map((item: any) => {
        const appKey = item.manifest?.appKey;
        if (item.id && appKey) appKeyById.set(String(item.id), String(appKey));
        if (appKey === 'sample-2') return { ...item, version: '快照 1234abcd', manifest: { ...item.manifest, schemaVersion: '1', maintainers: ['Dylan5237'] } };
        return item;
      });
      return route.fulfill({ response, body: JSON.stringify({ ...payload, items }) });
    }

    const detailMatch = pathname.match(/^\/api\/apps\/([^/]+)$/);
    if (!detailMatch) return route.continue();
    const id = decodeURIComponent(detailMatch[1]);
    const response = await route.fetch();
    const app = await response.json();
    const appKey = app.manifest?.appKey || appKeyById.get(id);
    if (appKey === 'sample-1') return route.fulfill({ response, body: JSON.stringify(withDenseDetail(app)) });
    if (appKey === 'sample-2') {
      return route.fulfill({
        response,
        body: JSON.stringify({ ...app, version: '快照 1234abcd', manifest: { ...app.manifest, schemaVersion: '1', maintainers: ['Dylan5237'], entries: app.manifest.entries.filter((entry: any) => entry.kind === 'web') } }),
      });
    }
    return route.fulfill({ response, body: JSON.stringify(app) });
  });
}

async function verifyResponseIsolation(page: any, harness: any) {
  const apps = (await harness.service.list({ query: 'Word', tags: ['知识整理'] })).items;
  const [first, second] = apps;
  const open = (app: any) => page.getByRole('button', { name: `查看 ${app.manifest.name} 详情`, exact: true }).click();
  const waitForPaint = () => page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.keyboard.press('Escape');
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });

  const detailUrl = `${harness.origin}/api/apps/${first.id}`;
  let releaseDetail!: () => void;
  let detailRequested!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const detailStarted = new Promise<void>(resolve => { detailRequested = resolve; });
  await page.route(detailUrl, async (route: any) => {
    const response = await route.fetch();
    detailRequested();
    await detailGate;
    await route.fulfill({ response });
  });
  await open(first);
  await detailStarted;
  await page.keyboard.press('Escape');
  await page.locator('.app-detail-dialog').waitFor({ state: 'hidden' });
  await open(second);
  await page.getByTestId('app-detail').waitFor();
  const staleDetailResponse = page.waitForResponse(detailUrl);
  releaseDetail();
  await staleDetailResponse;
  await waitForPaint();
  assert.equal(await page.locator('.overview-title-row h2').innerText(), second.manifest.name, 'late closed-app detail cannot replace the current app');
  await page.unroute(detailUrl);
  await page.keyboard.press('Escape');
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });

  const instructionUrl = `${harness.origin}/api/apps/${first.id}/instructions/agent`;
  let releaseInstructions!: () => void;
  let instructionsRequested!: () => void;
  const instructionGate = new Promise<void>(resolve => { releaseInstructions = resolve; });
  const instructionStarted = new Promise<void>(resolve => { instructionsRequested = resolve; });
  await page.route(instructionUrl, async (route: any) => {
    const response = await route.fetch();
    instructionsRequested();
    await instructionGate;
    await route.fulfill({ response });
  });
  await open(first);
  await page.getByTestId('use-agent').click();
  await instructionStarted;
  await page.keyboard.press('Escape');
  await page.getByTestId('agent-instruction-content').waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await page.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await open(second);
  await page.getByTestId('use-agent').click();
  await page.getByTestId('copy-agent-prompt').click();
  const secondPrompt = await page.evaluate(() => (window as any).copiedText);
  assert.ok(secondPrompt.includes(second.manifest.name));
  const staleInstructionResponse = page.waitForResponse(instructionUrl);
  releaseInstructions();
  await staleInstructionResponse;
  await waitForPaint();
  await page.getByTestId('copy-agent-prompt').click();
  assert.equal(await page.evaluate(() => (window as any).copiedText), secondPrompt, 'late instructions cannot replace another app prompt');
  await page.unroute(instructionUrl);
}

const harness = await startHarness(9);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
  const firstManifest = JSON.parse(harness.gitlab.state.files.get('ai-app.json')!);
  firstManifest.entries.find((entry: any) => entry.kind === 'agent').artifacts = [{ url: 'https://example.invalid/docpilot.zip', sha256: 'c'.repeat(64) }];
  harness.gitlab.state.files.set('ai-app.json', JSON.stringify(firstManifest));
  const publication = await harness.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
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
    await installDetailFixtureRoute(page);
    if (viewport.width === 1440) {
      await page.goto(harness.origin);
      await page.getByTestId('share-button').click();
      await page.getByTestId('copy-publish-prompt').click();
      assert.ok((await page.evaluate(() => (window as any).copiedText)).includes('/api/publications'));
      await page.goto(publication.previewUrl);
      await page.getByTestId('confirm-publication').waitFor();
      await page.locator('.publication-preview [data-testid="app-examples"]').waitFor();
      assert.equal(await page.locator('.publication-preview [data-testid="app-examples"] .example-card').count(), 1, 'publication preview must retain examples');
      assert.equal(await page.locator('.publication-preview .public-app-author').innerText(), '作者：张明');
      assert.ok(!(await page.locator('.publication-preview .public-app-author').innerText()).includes('Ming Zhang'));
      const previewEntries = page.locator('.publication-preview .public-app-entry-info');
      assert.ok((await previewEntries.innerText()).includes('https://example.invalid/docpilot'));
      assert.ok((await previewEntries.innerText()).includes('docs/agent-1.md'));
      assert.ok((await previewEntries.innerText()).includes('https://example.invalid/docpilot.zip'));
      assert.ok((await previewEntries.innerText()).includes('c'.repeat(64)));
      await previewEntries.locator('summary').click();
      assert.ok((await previewEntries.innerText()).includes('此为协议测试材料，不执行真实安装'));
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
        const draft = await harness.service.submit({ projectId: 1, appKey: `sample-${i}`, manifestPath: `.ai-apps/sample-${i}/ai-app.json`, commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
        assert.equal(draft.status, 'preview_ready');
        assert.equal((await harness.service.confirm(draft.id, draft.ticket, { revision: draft.revision, digest: draft.digest! })).status, 'registered');
      }
    }
    await page.goto(harness.origin);
    await page.getByTestId('app-card').first().waitFor();
    assert.equal(await page.getByTestId('app-card').count(), 8);
    const firstCard = page.getByTestId('app-card').filter({ hasText: 'DocPilot 文档助手 1' });
    const legacyCard = page.getByTestId('app-card').filter({ hasText: 'DocPilot 文档助手 2' });
    assert.equal(await firstCard.locator('.app-author').innerText(), '张明');
    assert.ok(!(await firstCard.locator('.app-author').innerText()).includes('Ming Zhang'), 'English maintainer name is data only');
    assert.equal(await legacyCard.locator('.app-author').innerText(), 'Dylan5237', 'legacy string snapshot author remains readable');
    assert.equal(await legacyCard.locator('.app-version').innerText(), '快照 1234abcd', 'historical snapshot version remains unchanged');
    await legacyCard.getByRole('button', { name: /查看.*详情/ }).click();
    await page.getByTestId('app-detail').waitFor();
    assert.equal(await page.getByTestId('detail-author').innerText(), '作者：Dylan5237');
    assert.equal(await page.locator('.overview-version').innerText(), '快照 1234abcd');
    assert.equal(await page.getByTestId('use-agent').count(), 0, 'pure platform apps do not require Agent setup');
    assert.ok((await page.locator('.overview-steps').innerText()).includes('打开右侧平台入口'));
    await page.keyboard.press('Escape');
    await page.getByTestId('app-detail').waitFor({ state: 'hidden' });

    await firstCard.getByRole('button', { name: /查看.*详情/ }).click();
    await page.getByTestId('app-detail').waitFor();
    assert.equal(await page.getByTestId('detail-author').innerText(), '作者：张明');
    assert.equal(await page.locator('.overview-version').innerText(), 'v1.0.0');
    assert.equal(await page.locator('.detail-overview .markdown-body').count(), 0, 'full documents stay out of the default overview');
    assert.equal(await page.locator('.detail-overview .public-app-source').count(), 0, 'source details stay out of the default overview');
    assert.equal(await page.locator('.detail-overview [data-testid="app-examples"]').count(), 0, 'examples appear only in the right column');
    assert.equal(await page.locator('.detail-overview .overview-use-list li').count(), 3);
    assert.ok((await page.locator('.detail-overview').innerText()).includes('使用条件'));
    assert.ok((await page.locator('.detail-overview').innerText()).includes('重要边界'));
    assert.ok((await page.locator('.detail-overview .overview-steps').innerText()).includes('复制右侧接入提示词'));
    assert.ok((await page.locator('.detail-overview').innerText()).includes('另有 7 项条件或边界'));

    await page.getByTestId('read-full-docs').click();
    const documentContent = page.getByTestId('detail-documents-content');
    await documentContent.waitFor();
    assert.ok((await documentContent.innerText()).includes('DOC-TAIL-END'), 'full documents remain accessible on demand');
    assert.equal(await documentContent.locator('.public-app-source').count(), 0);
    await page.keyboard.press('Escape');
    await page.getByTestId('detail-documents-content').waitFor({ state: 'hidden' });
    await page.getByTestId('read-source').click();
    const sourceContent = page.getByTestId('detail-source-content');
    await sourceContent.waitFor();
    assert.ok((await sourceContent.innerText()).includes('v1.0.0'));
    assert.ok((await sourceContent.innerText()).includes(SHA));
    await page.keyboard.press('Escape');
    await page.getByTestId('detail-source-content').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.getByTestId('app-detail').waitFor({ state: 'hidden' });

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
    assert.equal(await page.locator('.detail-overview .markdown-body').count(), 0, 'default overview has no README block');
    assert.equal(await page.locator('.detail-overview .public-app-source').count(), 0, 'default overview has no source block');
    assert.equal(await page.locator('.detail-overview [data-testid="app-examples"]').count(), 0, 'left column does not repeat examples');
    assert.equal(await page.locator('.detail-overview .overview-use-list li').count(), 3);
    assert.ok((await page.locator('.detail-overview .overview-steps').innerText()).includes('复制右侧接入提示词'));
    const actions = page.getByTestId('detail-actions');
    assert.equal(await actions.locator('[data-testid^="example-tab-"]').count(), 2);
    await actions.getByTestId('example-tab-1').click();
    assert.ok((await actions.locator('.example-request').innerText()).includes('整理本次任务结果'));
    await actions.getByTestId('copy-example').click();
    assert.equal(await page.evaluate(() => (window as any).copiedText), '整理本次任务结果并列出待核对事项。');
    await actions.getByTestId('example-tab-0').click();
    const longExample = actions.locator('.example-request');
    assert.ok((await longExample.innerText()).includes('EXAMPLE-END-1'));
    await longExample.evaluate((element: HTMLElement) => element.scrollIntoView({ block: 'end' }));
    const detailMeasurements = await page.evaluate(() => {
      const layout = document.querySelector('.detail-layout') as HTMLElement;
      const panel = document.querySelector('[data-testid="detail-actions"]') as HTMLElement;
      return {
        pageHorizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        layoutHorizontalOverflow: layout.scrollWidth > layout.clientWidth,
        actionHorizontalOverflow: panel.scrollWidth > panel.clientWidth,
        actionVerticalScroll: panel.scrollHeight > panel.clientHeight,
      };
    });
    assert.equal(detailMeasurements.pageHorizontalOverflow, false);
    assert.equal(detailMeasurements.layoutHorizontalOverflow, false);
    assert.equal(detailMeasurements.actionHorizontalOverflow, false);
    assert.equal(detailMeasurements.actionVerticalScroll, true, 'long example remains reachable in the right panel');
    await actions.getByTestId('copy-example').click();
    assert.ok(String(await page.evaluate(() => (window as any).copiedText)).includes('EXAMPLE-END-1'));
    await page.getByTestId('use-agent').first().click();
    await page.getByTestId('agent-instruction-content').waitFor();
    assert.equal(await page.locator('.detail-actions .instruction-markdown').count(), 0, 'Agent instructions use a separate reading dialog');
    await page.getByTestId('copy-agent-prompt').click();
    const copied = await page.evaluate(() => (window as any).copiedText);
    assert.ok(copied.includes('最小验证') && copied.includes(SHA), 'copied prompt must retain fixed source and verification');
    await page.keyboard.press('Escape');
    await page.getByTestId('agent-instruction-content').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => (window as any).fixtureXss), undefined);
    assert.equal(await page.locator('img[src*="example.invalid"]').count(), 0, 'shared markdown must not fetch external images');
    const web = page.getByTestId('use-web').first();
    assert.equal(await web.getAttribute('href'), 'https://example.invalid/docpilot');
    assert.ok((await web.getAttribute('rel'))?.includes('noopener'));
    await page.screenshot({ path: `artifacts/mainflow-detail-${viewport.width}.png` });
    report.views.push({ viewport, cards: boxes.length, columns: 4, rows: 2, overflow, publicationReload: viewport.width === 1440 });
    if (viewport.width === 1440) await verifyResponseIsolation(page, harness);
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
