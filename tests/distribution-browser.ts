import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_TAG, manifest, SHA, TOKEN } from './helpers/gitlab-fixture.js';
import { startHarness } from './helpers/harness.js';

// Everything here is loopback-only synthetic data; it never contacts the real GitLab.
const tempRoot = resolve('artifacts', 'distribution-tests');
await mkdir(tempRoot, { recursive: true });
const temp = await mkdtemp(join(tempRoot, 'plaza-distribution-browser-'));
const harness = await startHarness(3, 'memory://', { dataDir: temp } as any);
const inputs = (index: number) => ({
  projectId: 1, appKey: `sample-${index}`, manifestPath: index === 1 ? 'ai-app.json' : `.ai-apps/sample-${index}/ai-app.json`, commitSha: SHA, tag: DEFAULT_TAG,
});
const sourceFiles = ['demo/main.mjs', 'demo/readme.md'];
for (const index of [1, 2, 3]) {
  const value: any = manifest(index);
  value.name = index === 1 ? '统一分发示例（模拟）' : index === 2 ? '历史应用缺包示例（模拟）' : '作者确认示例（模拟）';
  value.summary = '仅用于本机验收的模拟资料，不连接业务系统。';
  value.entries = value.entries.filter((entry: any) => entry.kind === 'agent');
  value.primaryEntry = 'agent';
  if (index !== 2) value.entries[0].distribution = { type: 'source', files: sourceFiles };
  harness.gitlab.state.files.set(inputs(index).manifestPath, JSON.stringify(value));
  harness.gitlab.state.files.set(`docs/agent-${index}.md`, index === 2
    ? '旧指引：git clone https://example.invalid/private.git'
    : '# 安装示例\n下载并校验广场分发包，解压后执行 node demo/main.mjs。此示例不连接业务系统。');
}
harness.gitlab.state.files.set('docs/usage-2.md', '旧资料：git clone https://example.invalid/private.git');
harness.gitlab.state.files.set('demo/main.mjs', 'console.log("统一分发模拟程序运行成功")\n');
harness.gitlab.state.files.set('demo/readme.md', '# 模拟文件\n解压广场包后运行 demo/main.mjs。\n');

async function submit(index: number, confirm: boolean) {
  const publication = await harness.service.submit(inputs(index), TOKEN, randomUUID());
  assert.equal(publication.status, 'preview_ready', JSON.stringify(publication.error));
  if (!confirm) return publication;
  const result = await harness.service.confirm(publication.id, publication.ticket, { revision: publication.revision, digest: publication.digest! });
  assert.equal(result.status, 'registered', JSON.stringify(result.error));
  return { ...publication, appId: result.appId };
}
const ready = await submit(1, true);
await submit(2, true);
const candidate = await submit(3, false);
harness.gitlab.state.offline = true;
const initialRequests = harness.gitlab.state.requests.length;

if (process.argv.includes('--serve')) {
  // The console output contains only a loopback URL, no preview ticket or credentials.
  console.log(`PREVIEW_ORIGIN=${harness.origin}`);
} else {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedText = text; } } });" });
    await context.route('**/*', route => /^https?:/.test(route.request().url()) && new URL(route.request().url()).origin !== harness.origin ? route.abort() : route.continue());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(candidate.previewUrl);
    await page.getByTestId('confirm-publication').waitFor();
    const preview = page.locator('.publication-preview .public-app-entry-info');
    assert.match(await preview.innerText(), /广场分发包/);
    assert.match(await preview.innerText(), new RegExp(candidate.preview!.distributions![0]!.sha256));
    await preview.getByText('查看确认的分享文件（2 项）').click();
    assert.match(await preview.innerText(), /demo\/main\.mjs/);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/distribution-browser-author-preview.png', fullPage: true });

    await page.goto(harness.origin);
    await page.getByRole('button', { name: '查看 统一分发示例（模拟） 详情' }).click();
    await page.getByTestId('use-agent').click();
    await page.getByTestId('copy-agent-prompt').click();
    const copied = String(await page.evaluate(() => (window as any).copiedText));
    assert.match(copied, /广场固定分发包/);
    assert.match(copied, /SHA-256/);
    assert.doesNotMatch(copied, /git clone/i);
    const guide = await harness.service.instructions(ready.appId!, 'agent');
    const response = await context.request.get(String(guide.distribution.url));
    assert.equal(response.status(), 200);
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), guide.distribution.sha256);
    await page.screenshot({ path: 'artifacts/distribution-browser-ready.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByTestId('agent-instruction-content').waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    await page.getByTestId('app-detail').waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: '查看 历史应用缺包示例（模拟） 详情' }).click();
    await page.getByTestId('use-agent').click();
    await page.getByTestId('copy-agent-prompt').click();
    const missing = String(await page.evaluate(() => (window as any).copiedText));
    assert.match(missing, /安装暂不可用/);
    assert.match(missing, /停止安装和升级/);
    assert.doesNotMatch(missing, /git clone|example\.invalid\/private/i);
    assert.equal(harness.gitlab.state.requests.length, initialRequests, 'consumer and author-preview browsing must not contact GitLab');
    assert.deepEqual(errors, []);
    console.log('PASS: author preview, fixed package download, copied instructions, and legacy fail-closed flow (local fixtures).');
    await context.close();
  } finally {
    await browser?.close();
    await harness.close();
    assert.ok(resolve(temp).startsWith(tempRoot + sep));
    assert.ok(temp.split(/[\\/]/).at(-1)?.startsWith('plaza-distribution-browser-'));
    await rm(temp, { recursive: true, force: true });
  }
}
