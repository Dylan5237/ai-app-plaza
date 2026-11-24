import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { createApp } from '../server/app.js';
import { createAppAccessService } from '../server/domain/app-access.js';
import { openDatabase } from '../server/domain/database.js';
import { tiangongConfig } from '../server/domain/tiangong-identity.js';
import { manifest } from './helpers/gitlab-fixture.js';
import { MANAGED_GITLAB_TOKEN, startManagedGitLabFixture } from './helpers/managed-gitlab-fixture.js';

await mkdir('artifacts', { recursive: true });
const report: any = { status: 'RUNNING', checks: [], errors: [], unexpectedRequests: [] };

async function startManagedIdentityServer() {
  const users: Record<string, any> = {
    'fixture-admin': { userId: '9223372036854775807', tenantId: null, userName: '测试名册管理员', account: 'fixture.admin', enabled: true, isAnonymous: false, userTypeCode: '03' },
    'fixture-member': { userId: '9223372036854775806', tenantId: '12', userName: '测试普通成员', account: 'fixture.member', enabled: true, isAnonymous: false, userTypeCode: '04' },
  };
  const portal = createServer(async (req, res) => {
    if (req.url !== '/findByToken' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = users[JSON.parse(body).token] ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: '00000000', success: true, data }).replace(/"userId":"(\d+)"/, '"userId":$1'));
  });
  await new Promise<void>(done => portal.listen(0, '127.0.0.1', done));
  const tiangong = tiangongConfig({
    TIANGONG_AUTH_ENABLED: 'true',
    TIANGONG_USERINFO_URL: `http://127.0.0.1:${(portal.address() as AddressInfo).port}/findByToken`,
    TIANGONG_SUCCESS_CODE: '00000000',
    TIANGONG_TOKEN_STORAGE_KEY: 'fixture-sky-token',
    PLAZA_IDENTITY_ADMIN_SUBJECTS: users['fixture-admin'].userId,
    PLAZA_SUPER_ADMIN_ACCOUNT: 'fixture.admin',
  })!;
  const probe = createNetServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));

  const gitlab = await startManagedGitLabFixture('main');
  const db = await openDatabase({ path: 'memory://' });
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    host: '127.0.0.1', port, publicOrigin: origin, gitlabUrl: gitlab.url,
    secret: 'fixture-only-issue120-browser-secret-000', dataDir: '', local: true,
    audience: '所有能访问本门户的人', staticDir: resolve('dist'), rateLimit: false,
    tiangong, publicBasePath: '/plaza',
    managedPublishing: { groupId: '63', groupPath: 'fixture/apps', token: MANAGED_GITLAB_TOKEN },
  };
  const { app, service, managed } = await createApp(config, db);
  app.get('/fixture/portal', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="zh"><head><meta charset="UTF-8"><title>合成天宫测试门户</title></head><body>
    <h1>合成天宫测试门户</h1>
    <button onclick="localStorage.setItem('fixture-sky-token','fixture-admin');location.href='/plaza/?discover=catalog'">以测试名册管理员进入</button>
    <button onclick="localStorage.setItem('fixture-sky-token','fixture-member');location.href='/plaza/?discover=catalog'">以测试普通成员进入</button>
    <button onclick="localStorage.removeItem('fixture-sky-token');location.href='/plaza/?discover=catalog'">以访客进入</button></body></html>`));
  await app.listen({ port, host: '127.0.0.1' });
  const headers = (extra: Record<string, string> = {}) => ({ host: new URL(origin).host, origin, ...extra });
  const loginApi = async (token: string) => {
    const challenge = await app.inject({ method: 'POST', url: '/plaza/api/auth/tiangong/requests', headers: headers(), payload: {} });
    const requestCookie = String(challenge.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'POST', url: '/plaza/api/auth/tiangong/exchange',
      headers: headers({ cookie: requestCookie }),
      payload: { requestId: challenge.json().requestId, token },
    });
    return { user: response.json().user };
  };
  return {
    app, service, managed: managed!, db, gitlab, origin, config, loginApi,
    close: async () => { await app.close(); await db.close(); await gitlab.close(); await new Promise<void>(done => portal.close(() => done())); },
  };
}

function makeBundle(options: { appKey: string; name: string; summary: string; entry: 'agent' | 'web'; version?: string }) {
  const m = {
    ...manifest(1),
    appKey: options.appKey,
    name: options.name,
    summary: options.summary,
    projectVersion: options.version ?? '1.0.0',
    docs: { readme: 'README.md', usage: 'docs/usage.md' },
    entries: options.entry === 'web'
      ? [{ id: 'web', kind: 'web', label: '打开平台', url: 'https://example.invalid/web-app' }]
      : [{ id: 'agent', kind: 'agent', label: '接入我的Agent', instructionsPath: 'docs/agent.md', compatibility: ['Codex'], distribution: { type: 'source', files: ['src/runtime.js'] } }],
    primaryEntry: options.entry,
  };
  const files = [
    { path: 'ai-app.json', text: JSON.stringify(m) },
    { path: 'README.md', text: `# ${options.name}\n\n初始项目说明。` },
    { path: 'docs/usage.md', text: '# 使用说明\n\n初始使用说明。' },
    { path: 'src/runtime.js', text: 'export const ok = true;' },
    ...(options.entry === 'agent' ? [{ path: 'docs/agent.md', text: '# Agent 接入说明\n\n核对分发包后安装。' }] : []),
  ];
  return {
    appKey: options.appKey,
    manifestPath: 'ai-app.json',
    files: files.map(f => ({ path: f.path, content: Buffer.from(f.text, 'utf8').toString('base64') })),
  };
}

const h = await startManagedIdentityServer();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const anonCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const ctx of [adminCtx, memberCtx, anonCtx]) {
  await ctx.addInitScript({ content: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text; } } });" });
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (/^https?:/.test(u.protocol) && u.origin !== h.origin) { report.unexpectedRequests.push(u.href); return route.abort(); }
    return route.continue();
  });
}

const adminPage = await adminCtx.newPage();
const memberPage = await memberCtx.newPage();
const anonPage = await anonCtx.newPage();
for (const p of [adminPage, memberPage, anonPage]) {
  p.setDefaultTimeout(10000);
  p.on('pageerror', err => report.errors.push(err.message));
}

async function loginBrowser(page: Page, buttonName: string) {
  await page.goto(`${h.origin}/plaza/fixture/portal`);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await page.getByRole('button', { name: '退出广场', exact: true }).waitFor();
}

async function selectOption(page: Page, comboboxName: string, optionName: string) {
  await page.getByRole('combobox', { name: comboboxName, exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: optionName, exact: true }).click();
  await page.keyboard.press('Escape');
}

try {
  // Seed one public Agent app and one public Platform app owned by admin for Req 1 & Req 2.
  const adminApi = await h.loginApi('fixture-admin');
  const agentPub = await h.managed.submit(makeBundle({
    appKey: 'demo-agent-share',
    name: 'WorkBuddy企微机器人权限主动续期',
    summary: '自动为已绑定的企业微信机器人安排权限续期提醒。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  const agentRaw = await h.service.publication(agentPub.id, agentPub.ticket, adminApi.user.id);
  const agentReg = await h.service.confirm(agentPub.id, agentPub.ticket, { revision: agentRaw.revision, digest: agentRaw.digest! }, adminApi.user.id);

  const webPub = await h.managed.submit(makeBundle({
    appKey: 'demo-web-share',
    name: '周报汇总平台',
    summary: '在线汇总与导出团队周报。',
    entry: 'web',
  }), randomBytes(32).toString('base64url'), randomUUID());
  const webRaw = await h.service.publication(webPub.id, webPub.ticket, adminApi.user.id);
  const webReg = await h.service.confirm(webPub.id, webPub.ticket, { revision: webRaw.revision, digest: webRaw.digest! }, adminApi.user.id);

  const access = createAppAccessService(h.db, h.config.audience);
  await access.update(adminApi.user.id, agentReg.appId!, { revision: 1, requestId: randomUUID(), scope: 'all', memberIds: [], groupIds: [] });
  await access.update(adminApi.user.id, webReg.appId!, { revision: 1, requestId: randomUUID(), scope: 'all', memberIds: [], groupIds: [] });

  await loginBrowser(adminPage, '以测试名册管理员进入');

  // --- Req 1: Default publish prompt removes redundant paragraph & is maintainable ---
  await adminPage.getByTestId('share-button').click();
  await adminPage.getByTestId('copy-publish-prompt').waitFor();
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await adminPage.getByTestId('copy-publish-prompt').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  const defaultPublishPrompt: string = await adminPage.evaluate(() => (window as any).__copied);
  assert.equal(defaultPublishPrompt.includes('首次收录默认仅自己；最终确认需要有效天宫身份'), false);
  assert.equal(defaultPublishPrompt.includes('不要复制天宫 Token 或浏览器会话到 Host'), false);
  assert.ok(defaultPublishPrompt.includes('请在当前项目上下文中把我的 AI 应用发布到 AI应用广场'));
  await adminPage.keyboard.press('Escape');
  await adminPage.getByTestId('publish-contract-dialog').waitFor({ state: 'hidden' });

  await adminPage.goto(`${h.origin}/plaza/?space=smart-search`);
  await adminPage.getByRole('tab', { name: '发布提示词', exact: true }).click();
  const newPublishEditor = adminPage.getByTestId('template-editor-publish_managed_new');
  await newPublishEditor.fill('自定义发布提示词：门户={{origin}} 工具={{publisherUrl}} SHA={{publisherSha256}}');
  await adminPage.getByTestId('template-save-publish_managed_new').click();
  await adminPage.getByText('模板已保存，后续操作立即生效。').waitFor();

  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  await adminPage.getByTestId('share-button').click();
  await adminPage.getByTestId('copy-publish-prompt').waitFor();
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await adminPage.getByTestId('copy-publish-prompt').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  const customPublishPrompt: string = await adminPage.evaluate(() => (window as any).__copied);
  assert.match(customPublishPrompt, /^自定义发布提示词：门户=http/);

  await adminPage.goto(`${h.origin}/plaza/?space=smart-search`);
  await adminPage.getByRole('tab', { name: '发布提示词', exact: true }).click();
  await adminPage.getByTestId('template-reset-publish_managed_new').click();
  await adminPage.locator('.el-message-box').getByRole('button', { name: '恢复默认', exact: true }).click();
  await adminPage.getByText('已恢复默认模板，后续操作立即使用默认内容。').waitFor();
  report.checks.push('req1-publish-prompt-trimmed-and-maintainable');

  // --- Req 2: Share template (3 lines, Agent/Platform split, maintainable) ---
  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  const agentCard = adminPage.locator('.catalog-results').getByTestId('app-card').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' });
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await agentCard.getByTestId('card-share').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  assert.equal(
    await adminPage.evaluate(() => (window as any).__copied),
    `[AI应用分享]【WorkBuddy企微机器人权限主动续期】\n自动为已绑定的企业微信机器人安排权限续期提醒。\n在应用广场查看并一键安装：${h.origin}/plaza/?app=${agentReg.appId}`,
  );

  const webCard = adminPage.locator('.catalog-results').getByTestId('app-card').filter({ hasText: '周报汇总平台' });
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await webCard.getByTestId('card-share').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  assert.equal(
    await adminPage.evaluate(() => (window as any).__copied),
    `[AI应用分享]【周报汇总平台】\n在线汇总与导出团队周报。\n在应用广场查看并立即使用：${h.origin}/plaza/?app=${webReg.appId}`,
  );

  // Detail share button also uses latest template.
  await agentCard.getByTestId('card-title').click();
  await adminPage.getByTestId('app-detail').waitFor();
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await adminPage.getByTestId('detail-share').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  assert.ok((await adminPage.evaluate(() => (window as any).__copied)).startsWith('[AI应用分享]【WorkBuddy企微机器人权限主动续期】\n'));

  // Super admin edits share_agent template -> directory & detail immediately use updated template.
  await adminPage.goto(`${h.origin}/plaza/?space=smart-search`);
  await adminPage.getByRole('tab', { name: '应用分享模板', exact: true }).click();
  await adminPage.getByTestId('template-editor-share_agent').fill('【定制分享】{{name}} | {{url}}');
  await adminPage.getByTestId('template-save-share_agent').click();
  await adminPage.getByText('模板已保存，后续操作立即生效。').waitFor();

  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await adminPage.locator('.catalog-results').getByTestId('app-card').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).getByTestId('card-share').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  assert.equal(
    await adminPage.evaluate(() => (window as any).__copied),
    `【定制分享】WorkBuddy企微机器人权限主动续期 | ${h.origin}/plaza/?app=${agentReg.appId}`,
  );
  report.checks.push('req2-share-templates-split-and-maintainable');

  // --- Req 3: Direct editing on private preview page ---
  await loginBrowser(memberPage, '以测试普通成员进入');
  const memberDraft = await h.managed.submit(makeBundle({
    appKey: 'member-private-app',
    name: '私有待编辑应用',
    summary: '首次提交的原始简介。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());

  await memberPage.goto(memberDraft.previewUrl);
  await memberPage.getByTestId('confirm-publication').waitFor();
  await memberPage.getByTestId('edit-publication').click();
  await memberPage.getByTestId('metadata-editor').waitFor();
  await memberPage.getByTestId('editor-name').fill('预览页修订后的应用名');
  await memberPage.getByTestId('editor-summary').fill('作者在确认收录前直接修改的简介。');
  await memberPage.getByRole('tab', { name: '入口与完整说明', exact: true }).click();
  await memberPage.getByTestId('editor-doc-README.md').fill('# 预览页修订后的应用名\n\n已保存的最新说明。');
  await memberPage.getByTestId('editor-save').click();
  await memberPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // Preview immediately reflects edited content & incremented patch version.
  await memberPage.locator('.publication-preview .public-app-title-row h2').filter({ hasText: '预览页修订后的应用名' }).waitFor();
  await memberPage.locator('.publication-preview .public-app-summary').filter({ hasText: '作者在确认收录前直接修改的简介。' }).waitFor();
  assert.match(await memberPage.locator('.publication-preview .public-app-version').first().innerText(), /v1\.0\.1/);

  await memberPage.getByTestId('confirm-publication').click();
  await memberPage.getByText('应用已收录', { exact: true }).waitFor();
  await memberPage.getByRole('link', { name: '在广场中打开', exact: true }).click();
  await memberPage.getByTestId('app-detail').waitFor();
  const detailUrl = memberPage.url();
  assert.equal(await memberPage.locator('.overview-title-row h2').innerText(), '预览页修订后的应用名');
  assert.equal(await memberPage.locator('.overview-summary').innerText(), '作者在确认收录前直接修改的简介。');
  await memberPage.getByTestId('read-full-docs').click();
  assert.ok((await memberPage.getByTestId('detail-documents-content').innerText()).includes('已保存的最新说明。'));
  await memberPage.keyboard.press('Escape');
  await memberPage.getByTestId('detail-documents-dialog').waitFor({ state: 'hidden' });
  report.checks.push('req3-private-preview-direct-edit');

  // --- Req 4: Detail visibility indicator, direct access adjustment, and actionable restricted prompt ---
  const visBanner = memberPage.getByTestId('detail-visibility');
  await visBanner.waitFor();
  assert.match(await visBanner.innerText(), /仅自己可见/);
  await memberPage.getByTestId('detail-manage-access').waitFor();

  // Unauthorized logged-in user (admin) and anonymous user both see actionable prompt without leaking app data.
  await anonPage.goto(detailUrl);
  await anonPage.getByTestId('detail-restricted').waitFor();
  const anonRestrictedText = await anonPage.getByTestId('detail-restricted').innerText();
  assert.match(anonRestrictedText, /当前无法访问此应用/);
  assert.match(anonRestrictedText, /联系作者将应用设为公开/);
  assert.match(anonRestrictedText, /登录天宫/);
  assert.equal(await anonPage.getByTestId('app-detail').count(), 0);
  assert.equal((await anonPage.locator('body').innerText()).includes('预览页修订后的应用名'), false);

  await adminPage.goto(detailUrl);
  await adminPage.getByTestId('detail-restricted').waitFor();
  const adminRestrictedText = await adminPage.getByTestId('detail-restricted').innerText();
  assert.match(adminRestrictedText, /当前无法访问此应用/);
  assert.match(adminRestrictedText, /联系作者将应用设为公开/);
  assert.equal(await adminPage.getByTestId('app-detail').count(), 0);
  assert.equal((await adminPage.locator('body').innerText()).includes('预览页修订后的应用名'), false);

  // Author adjusts sharing scope directly from detail page -> visibility updates and others gain access.
  await memberPage.getByTestId('detail-manage-access').click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  await selectOption(memberPage, '分享范围', '全体成员（公开，可未登录浏览）');
  await memberPage.getByRole('button', { name: '确认更改分享范围', exact: true }).click();
  await memberPage.getByText('配置已保存，已回读当前结果。', { exact: true }).waitFor();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor({ state: 'hidden' });

  assert.match(await memberPage.getByTestId('detail-visibility').innerText(), /全体成员公开/);

  await anonPage.reload();
  await anonPage.getByTestId('app-detail').waitFor();
  assert.equal(await anonPage.locator('.overview-title-row h2').innerText(), '预览页修订后的应用名');
  assert.equal(await anonPage.getByTestId('detail-visibility').count(), 0, 'public visitors do not see author visibility bar');
  report.checks.push('req4-detail-visibility-and-restricted-prompt');

  await memberPage.screenshot({ path: 'artifacts/issue-120-detail-visibility.png', fullPage: true });
  await adminPage.screenshot({ path: 'artifacts/issue-120-templates-admin.png', fullPage: true });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpectedRequests, []);
  report.status = 'PASS';
} catch (error: any) {
  report.status = 'FAIL';
  report.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  await adminCtx.close();
  await memberCtx.close();
  await anonCtx.close();
  await browser.close();
  await h.close();
  await writeFile('artifacts/issue-120-browser.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
