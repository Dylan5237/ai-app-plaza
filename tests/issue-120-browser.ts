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
  const updatePublishEditor = adminPage.getByTestId('template-editor-publish_managed_update');
  await updatePublishEditor.fill('尚未保存的更新模板草稿 {{origin}}');
  const newPublishEditor = adminPage.getByTestId('template-editor-publish_managed_new');
  await newPublishEditor.fill('自定义发布提示词：门户={{origin}} 工具={{publisherUrl}} SHA={{publisherSha256}}');
  await adminPage.getByTestId('template-save-publish_managed_new').click();
  await adminPage.getByText('模板已保存，后续操作立即生效。').waitFor();
  assert.equal(await updatePublishEditor.inputValue(), '尚未保存的更新模板草稿 {{origin}}', 'saving one template preserves unsaved draft on sibling template');

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
  await adminPage.screenshot({ path: 'artifacts/issue-120-templates-admin.png', fullPage: true });

  const initialTemplatesLoaded = adminPage.waitForResponse(
    res => res.url().includes('/plaza/api/share-templates') && res.request().method() === 'GET' && res.status() === 200,
  );
  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  await initialTemplatesLoaded;
  await adminPage.locator('.catalog-results').getByTestId('app-card').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).waitFor();
  // Hold /api/share-templates in-flight to verify cached Share copies without waiting on network.
  let releaseShare!: () => void;
  const shareGate = new Promise<void>(resolve => { releaseShare = resolve; });
  const shareRefreshPromise = adminPage.waitForResponse(
    res => res.url().includes('/plaza/api/share-templates') && res.request().method() === 'GET',
  );
  await adminPage.route('**/plaza/api/share-templates', async route => {
    await shareGate;
    await route.continue();
  }, { times: 1 });
  await adminPage.evaluate(() => { (window as any).__copied = null; });
  await adminPage.locator('.catalog-results').getByTestId('app-card').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).getByTestId('card-share').click();
  await adminPage.waitForFunction(() => (window as any).__copied !== null);
  assert.equal(
    await adminPage.evaluate(() => (window as any).__copied),
    `【定制分享】WorkBuddy企微机器人权限主动续期 | ${h.origin}/plaza/?app=${agentReg.appId}`,
  );
  releaseShare();
  await shareRefreshPromise;
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
  await memberPage.screenshot({ path: 'artifacts/issue-120-detail-visibility.png', fullPage: true });

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

  // Management detail also wires "调整分享范围" directly to the access dialog without stacking two modals.
  await memberPage.goto(`${h.origin}/plaza/admin`);
  await memberPage.getByRole('button', { name: '预览页修订后的应用名', exact: true }).click();
  await memberPage.getByTestId('app-detail').waitFor();
  await memberPage.getByTestId('detail-manage-access').click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  await memberPage.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor({ state: 'hidden' });
  await memberPage.getByTestId('app-detail').waitFor();
  await memberPage.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'detail-manage-access');
  report.checks.push('req4-detail-visibility-and-restricted-prompt');

  // --- Publication ticket sessionStorage isolation across logout & first login ---
  const ticketClearDraft = await h.managed.submit(makeBundle({
    appKey: 'ticket-logout-clear',
    name: '退出清空会话票据测试',
    summary: '验证退出广场后同步清除 sessionStorage 预览票据。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await memberPage.goto(ticketClearDraft.previewUrl);
  await memberPage.getByTestId('confirm-publication').waitFor();
  assert.ok(
    await memberPage.evaluate(id => window.sessionStorage.getItem(`ai-app-plaza:publication:/plaza:${id}`), ticketClearDraft.id),
    'ticket persisted in sessionStorage under mount-scoped key for current user',
  );
  await memberPage.evaluate(() => window.sessionStorage.setItem('ai-app-plaza:publication:/other-plaza:keep', 'other-mount-ticket'));
  await memberPage.goto(`${h.origin}/plaza/?discover=catalog`);
  await memberPage.getByRole('button', { name: '退出广场', exact: true }).click();
  await memberPage.getByRole('button', { name: '使用天宫身份登录', exact: true }).waitFor();
  await memberPage.waitForFunction(id => window.sessionStorage.getItem(`ai-app-plaza:publication:/plaza:${id}`) === null, ticketClearDraft.id);
  assert.equal(
    await memberPage.evaluate(() => window.sessionStorage.getItem('ai-app-plaza:publication:/other-plaza:keep')),
    'other-mount-ticket',
    'logging out of /plaza does not clear tickets belonging to another mount path',
  );

  // Pre-login link ticket still works after logging in via the portal for the first time.
  const preLoginDraft = await h.managed.submit(makeBundle({
    appKey: 'ticket-prelogin-preserve',
    name: '登录前链接保留票据测试',
    summary: '验证首次登录前打开的预览票据在登录后仍可用。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await anonPage.goto(preLoginDraft.previewUrl);
  await anonPage.waitForFunction(id => Boolean(window.sessionStorage.getItem(`ai-app-plaza:publication:/plaza:${id}`)), preLoginDraft.id);
  await anonPage.getByText('登录', { exact: false }).first().waitFor();
  await anonPage.evaluate(() => window.localStorage.setItem('fixture-sky-token', 'fixture-admin'));
  await anonPage.goto(`${h.origin}/plaza/?publish_check=1#publish=${preLoginDraft.id}`);
  await anonPage.getByRole('button', { name: '退出广场', exact: true }).waitFor();
  await anonPage.locator('.publication-preview').getByRole('heading', { level: 2, name: '登录前链接保留票据测试', exact: true }).waitFor();
  await anonPage.waitForFunction(() => {
    const button = document.querySelector('[data-testid="confirm-publication"]');
    return Boolean(button && !(button as HTMLButtonElement).disabled);
  });
  report.checks.push('publication-ticket-sessionstorage-isolation');

  // --- Req 3 regression guards: auth-gated cache recovery, entry key isolation, TAG_CONFLICT unlock ---
  await memberPage.getByRole('button', { name: '使用天宫身份登录', exact: true }).click();
  await memberPage.getByRole('button', { name: '退出广场', exact: true }).waitFor();
  const recoverGuardDraft = await h.managed.submit(makeBundle({
    appKey: 'recover-auth-guard',
    name: '待恢复权限校验测试应用',
    summary: '验证失权与读上下文失败时不泄露本地缓存正文。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await memberPage.goto(recoverGuardDraft.previewUrl);
  await memberPage.getByTestId('edit-publication').click();
  await memberPage.getByTestId('metadata-editor').waitFor();
  await memberPage.getByTestId('editor-name').fill('涉密待恢复名称');
  await memberPage.getByRole('tab', { name: '入口与完整说明', exact: true }).click();
  await memberPage.getByTestId('editor-doc-README.md').fill('# 私有待恢复正文');

  let abortNextSave = true;
  const saveAbortHandler = (route: any) => {
    if (abortNextSave && route.request().method() === 'POST') {
      abortNextSave = false;
      return route.abort('failed');
    }
    return route.continue();
  };
  await memberPage.route(`**/api/publications/${recoverGuardDraft.id}/editor*`, saveAbortHandler);
  await memberPage.getByTestId('editor-save').click();
  await memberPage.getByRole('button', { name: '重试本次保存', exact: true }).waitFor();
  await memberPage.unroute(`**/api/publications/${recoverGuardDraft.id}/editor*`, saveAbortHandler);

  await memberPage.getByRole('button', { name: '取消', exact: true }).click();
  await memberPage.locator('.el-message-box').getByRole('button', { name: '关闭', exact: true }).click();
  await memberPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // Cancelled preview with saved pending edit exposes "恢复上次编辑结果".
  const pubCancelledHandler = async (route: any) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      const body = await response.json();
      if (!body.requiresIdentity) {
        body.status = 'cancelled';
        body.nextAction = 'complete';
      }
      return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.continue();
  };
  await memberPage.route(`**/api/publications/${recoverGuardDraft.id}`, pubCancelledHandler);
  await memberPage.reload();
  await memberPage.getByTestId('recover-publication-edit').waitFor();
  await memberPage.unroute(`**/api/publications/${recoverGuardDraft.id}`, pubCancelledHandler);

  // If editor GET fails with 503/network error, cached private manifest/docs stay hidden until reload succeeds.
  let failEditorGetOnce = true;
  const editorGet503Handler = (route: any) => {
    if (failEditorGetOnce && route.request().method() === 'GET') {
      failEditorGetOnce = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '编辑上下文暂时不可用' } }),
      });
    }
    return route.continue();
  };
  await memberPage.route(`**/api/publications/${recoverGuardDraft.id}/editor*`, editorGet503Handler);
  await memberPage.getByTestId('recover-publication-edit').click();
  await memberPage.getByTestId('metadata-editor').waitFor();
  await memberPage.getByTestId('metadata-editor').getByText('编辑上下文暂时不可用').waitFor();
  assert.equal(await memberPage.getByTestId('editor-name').count(), 0);
  assert.equal((await memberPage.getByTestId('metadata-editor').innerText()).includes('涉密待恢复名称'), false);
  assert.equal((await memberPage.getByTestId('metadata-editor').innerText()).includes('私有待恢复正文'), false);
  await memberPage.unroute(`**/api/publications/${recoverGuardDraft.id}/editor*`, editorGet503Handler);

  await memberPage.getByTestId('metadata-editor').getByRole('button', { name: '重新读取', exact: true }).click();
  await memberPage.getByTestId('editor-name').waitFor();
  assert.equal(await memberPage.getByTestId('editor-name').inputValue(), '涉密待恢复名称');
  await memberPage.getByRole('button', { name: '重试本次保存', exact: true }).waitFor();
  await memberPage.getByRole('button', { name: '取消', exact: true }).click();
  await memberPage.locator('.el-message-box').getByRole('button', { name: '关闭', exact: true }).click();
  await memberPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // When publication GET fails with 404 (access revoked), recovery button is hidden and pending cache is purged.
  const pubGet404Handler = (route: any) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PUBLICATION_NOT_FOUND', message: '未找到本次发布。' } }),
      });
    }
    return route.continue();
  };
  await memberPage.route(`**/api/publications/${recoverGuardDraft.id}`, pubGet404Handler);
  await memberPage.reload();
  await memberPage.getByText('未找到本次发布。').waitFor();
  assert.equal(await memberPage.getByTestId('recover-publication-edit').count(), 0);
  assert.equal(await memberPage.getByTestId('edit-publication').count(), 0);
  await memberPage.waitForFunction(
    id => window.sessionStorage.getItem(`ai-app-plaza:pending-edit:/plaza:pub:${id}`) === null,
    recoverGuardDraft.id,
  );
  await memberPage.unroute(`**/api/publications/${recoverGuardDraft.id}`, pubGet404Handler);

  // Entry key isolation (pub vs mgmt-pub) + TAG_CONFLICT unlocks version input without trapping draft.
  const isolationPublishKey = randomBytes(32).toString('base64url');
  const isolationV1 = await h.managed.submit(makeBundle({
    appKey: 'entry-isolation-tag-conflict',
    name: '入口隔离与冲突解锁测试',
    summary: '验证管理后台与私有链接待恢复隔离，以及 TAG_CONFLICT 后改版本保存。',
    entry: 'agent',
    version: '1.0.0',
  }), isolationPublishKey, randomUUID());
  const isolationV1Raw = await h.service.publication(isolationV1.id, isolationV1.ticket, adminApi.user.id);
  await h.service.confirm(isolationV1.id, isolationV1.ticket, { revision: isolationV1Raw.revision, digest: isolationV1Raw.digest! }, adminApi.user.id);

  const crossEntryDraft = await h.managed.submit({
    ...makeBundle({
      appKey: 'entry-isolation-tag-conflict',
      name: '入口隔离与冲突解锁测试',
      summary: '验证管理后台与私有链接待恢复隔离，以及 TAG_CONFLICT 后改版本保存。',
      entry: 'agent',
      version: '1.1.0',
    }),
    managedAppId: isolationV1.managedAppId,
    expectedAppRevision: 1,
  }, isolationPublishKey, randomUUID());
  await adminPage.goto(crossEntryDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('editor-name').fill('私有链接待恢复草稿');

  let abortPublicPost = true;
  const publicAbortHandler = (route: any) => {
    if (abortPublicPost && route.request().method() === 'POST') {
      abortPublicPost = false;
      return route.abort('failed');
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${crossEntryDraft.id}/editor*`, publicAbortHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByRole('button', { name: '重试本次保存', exact: true }).waitFor();
  await adminPage.unroute(`**/api/publications/${crossEntryDraft.id}/editor*`, publicAbortHandler);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.locator('.el-message-box').getByRole('button', { name: '关闭', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  await adminPage.goto(`${h.origin}/plaza/admin#publish=${crossEntryDraft.id}`);
  await adminPage.getByTestId('edit-publication').waitFor();
  assert.equal(await adminPage.getByTestId('recover-publication-edit').count(), 0, 'management entry ignores pub:<id> pending edit');

  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('editor-name').fill('版本冲突后改版本保存');
  await adminPage.getByTestId('editor-version').fill('1.1.1');

  let tagConflictOnce = true;
  const tagConflictHandler = (route: any) => {
    if (tagConflictOnce && route.request().method() === 'POST') {
      tagConflictOnce = false;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'TAG_CONFLICT', message: 'GitLab 中该版本 tag 已指向其他提交。' } }),
      });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/management/publications/${crossEntryDraft.id}/editor*`, tagConflictHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('metadata-editor').getByText('GitLab 中该版本 tag 已指向其他提交。').waitFor();
  await adminPage.unroute(`**/api/management/publications/${crossEntryDraft.id}/editor*`, tagConflictHandler);

  assert.equal(await adminPage.getByTestId('editor-version').isDisabled(), false, 'TAG_CONFLICT unlocks version input');
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '版本冲突后改版本保存');
  assert.equal(await adminPage.getByTestId('editor-save').innerText(), '保存并刷新预览');

  await adminPage.getByTestId('editor-version').fill('1.1.2');
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });
  await adminPage.locator('.publication-preview .public-app-title-row h2').filter({ hasText: '版本冲突后改版本保存' }).waitFor();
  assert.match(await adminPage.locator('.publication-preview .public-app-version').first().innerText(), /v1\.1\.2/);
  report.checks.push('req3-auth-gated-cache-isolation-and-tag-conflict-unlock');

  // --- Regression 5: POST 403 on editor save clears private editor content & refreshes parent ---
  const postRevokeDraft = await h.managed.submit(makeBundle({
    appKey: 'post-save-403-clear',
    name: '保存失权清资料测试',
    summary: '验证保存遇到 403 时立即清除编辑器私有资料并重读预览状态。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(postRevokeDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('失权保存立即清空名称');
  await adminPage.getByRole('tab', { name: '入口与完整说明', exact: true }).click();
  await adminPage.getByTestId('editor-doc-README.md').fill('# 失权立即隐藏正文');

  let markReloadSeen!: () => void;
  const reloadSeen = new Promise<void>(resolve => { markReloadSeen = resolve; });
  const countReloadHandler = (route: any) => {
    if (route.request().method() === 'GET') markReloadSeen();
    return route.continue();
  };
  let save403Once = true;
  const save403Handler = (route: any) => {
    if (save403Once && route.request().method() === 'POST') {
      save403Once = false;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: '无权继续修改此应用资料。' } }),
      });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${postRevokeDraft.id}`, countReloadHandler);
  await adminPage.route(`**/api/publications/${postRevokeDraft.id}/editor*`, save403Handler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('metadata-editor').getByText('无权继续修改此应用资料。').waitFor();
  assert.equal(await adminPage.getByTestId('editor-name').count(), 0, 'POST 403 clears manifest fields immediately');
  assert.equal((await adminPage.getByTestId('metadata-editor').innerText()).includes('失权立即隐藏正文'), false);
  await reloadSeen;
  assert.equal(
    await adminPage.evaluate(id => window.sessionStorage.getItem(`ai-app-plaza:pending-edit:/plaza:pub:${id}`), postRevokeDraft.id),
    null,
    'POST 403 purges pending edit from sessionStorage',
  );
  await adminPage.unroute(`**/api/publications/${postRevokeDraft.id}/editor*`, save403Handler);
  await adminPage.unroute(`**/api/publications/${postRevokeDraft.id}`, countReloadHandler);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // --- Regression 6: QuotaExceededError on pending-edit shows memory fallback warning ---
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('存储配额不足告警测试');
  await adminPage.evaluate(() => {
    const orig = Storage.prototype.setItem;
    (window as any).__restoreSetItem = () => { Storage.prototype.setItem = orig; };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (String(key).includes('pending-edit')) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return orig.call(this, key, value);
    };
  });
  let abortForQuota = true;
  const quotaAbortHandler = (route: any) => {
    if (abortForQuota && route.request().method() === 'POST') {
      abortForQuota = false;
      return route.abort('failed');
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${postRevokeDraft.id}/editor*`, quotaAbortHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('editor-storage-fallback').waitFor();
  await adminPage.evaluate(() => { (window as any).__restoreSetItem?.(); });
  await adminPage.unroute(`**/api/publications/${postRevokeDraft.id}/editor*`, quotaAbortHandler);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.locator('.el-message-box').getByRole('button', { name: '关闭', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // --- Regression 7: Unmounting editor during in-flight POST preserves pending edit for ticket recovery ---
  const unmountDraft = await h.managed.submit(makeBundle({
    appKey: 'unmount-during-save',
    name: '保存中途卸载护票据测试',
    summary: '验证在途保存期间组件卸载不会误删待恢复记录。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(unmountDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('卸载中断保留恢复记录');

  let releaseInflightPost!: () => void;
  let markPostIntercepted!: () => void;
  const postIntercepted = new Promise<void>(resolve => { markPostIntercepted = resolve; });
  const inflightGate = new Promise<void>(resolve => { releaseInflightPost = resolve; });
  const unmountPostHandler = async (route: any) => {
    if (route.request().method() === 'POST') {
      markPostIntercepted();
      await inflightGate;
      return route.continue();
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${unmountDraft.id}/editor*`, unmountPostHandler);
  await adminPage.getByTestId('editor-save').click();
  await postIntercepted;

  // Unmount ApplicationMetadataEditor via hash navigation away while POST is still in-flight.
  const backgroundPostFinished = adminPage.waitForResponse(
    res => res.url().includes(`/api/publications/${unmountDraft.id}/editor`) && res.request().method() === 'POST',
  );
  await adminPage.evaluate(() => { window.location.hash = ''; });
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'detached' });
  releaseInflightPost();
  await backgroundPostFinished;
  await adminPage.unroute(`**/api/publications/${unmountDraft.id}/editor*`, unmountPostHandler);

  // Returning to original publication shows it was cancelled, and pending recovery restores the new preview & ticket.
  await adminPage.goto(`${h.origin}/plaza/#publish=${unmountDraft.id}`);
  await adminPage.getByTestId('recover-publication-edit').waitFor();
  await adminPage.getByTestId('recover-publication-edit').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByRole('button', { name: '重试本次保存', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });
  await adminPage.locator('.publication-preview .public-app-title-row h2').filter({ hasText: '卸载中断保留恢复记录' }).waitFor();
  assert.match(await adminPage.locator('.publication-preview .public-app-version').first().innerText(), /v1\.0\.1/);
  await adminPage.getByTestId('confirm-publication').waitFor();
  report.checks.push('req3-round10-browser-regressions');

  // --- Regression R11-1: Changing visibility in SmartSearch detail syncs SmartSearch card share reminder ---
  await adminPage.goto(`${h.origin}/plaza/`);
  await adminPage.getByRole('textbox', { name: '描述你想完成的任务', exact: true }).fill('周报汇总平台');
  await adminPage.getByRole('button', { name: '发送', exact: true }).click();
  const smartCard = adminPage.locator('.smart-search [data-testid="app-card"]').filter({ hasText: '周报汇总平台' }).first();
  await smartCard.waitFor();
  await smartCard.getByTestId('card-title').click();
  await adminPage.getByTestId('app-detail').waitFor();
  await adminPage.getByTestId('detail-manage-access').click();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  await selectOption(adminPage, '分享范围', '仅自己');
  await adminPage.getByRole('button', { name: '确认更改分享范围', exact: true }).click();
  await adminPage.getByText('配置已保存，已回读当前结果。', { exact: true }).waitFor();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor({ state: 'hidden' });
  await adminPage.getByTestId('detail-visibility').getByText('仅自己可见').waitFor();
  await adminPage.getByTestId('return-discovery').click();
  await smartCard.waitFor();
  await smartCard.getByTestId('card-share').click();
  await adminPage.locator('.el-message').getByText(/当前仅自己可见/).first().waitFor();

  // --- Regression R11-2: Read-only draft after editable:false + PUBLICATION_STATE_CONFLICT locks form and disables save ---
  const readOnlyDraft = await h.managed.submit(makeBundle({
    appKey: 'readonly-conflict-draft',
    name: '只读冲突表单测试',
    summary: '验证 editable:false 冲突后表单与保存按钮只读。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(readOnlyDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('只读冲突保留草稿');

  let abortRoSave = true;
  const roAbortHandler = (route: any) => {
    if (abortRoSave && route.request().method() === 'POST') {
      abortRoSave = false;
      return route.abort('failed');
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${readOnlyDraft.id}/editor*`, roAbortHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByRole('button', { name: '重试本次保存', exact: true }).waitFor();
  await adminPage.unroute(`**/api/publications/${readOnlyDraft.id}/editor*`, roAbortHandler);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.locator('.el-message-box').getByRole('button', { name: '关闭', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  await h.db.query("UPDATE publications SET status = 'cancelled', next_action = 'complete' WHERE id = $1", [readOnlyDraft.id]);
  await adminPage.reload();
  await adminPage.getByTestId('recover-publication-edit').waitFor();
  await adminPage.getByTestId('recover-publication-edit').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByRole('button', { name: '重试本次保存', exact: true }).waitFor();

  let stateConflictOnce = true;
  const roConflictHandler = (route: any) => {
    if (stateConflictOnce && route.request().method() === 'POST') {
      stateConflictOnce = false;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PUBLICATION_STATE_CONFLICT', message: '该原预览已被其他修订替代。' } }),
      });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${readOnlyDraft.id}/editor*`, roConflictHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('editor-readonly-notice').waitFor();
  await adminPage.unroute(`**/api/publications/${readOnlyDraft.id}/editor*`, roConflictHandler);
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '只读冲突保留草稿');
  assert.equal(await adminPage.getByTestId('editor-name').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('editor-save').isDisabled(), true);
  report.checks.push('req2-req3-round11-browser-regressions');

  // --- Regression R12-1: PersonalSpace favorite card syncs updated visibility after detail access change ---
  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  const agentCardForFav = adminPage.locator('.catalog-results [data-testid="app-card"]').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).first();
  await agentCardForFav.waitFor();
  await agentCardForFav.getByRole('button', { name: '收藏应用', exact: true }).click();
  await agentCardForFav.getByRole('button', { name: '取消收藏', exact: true }).waitFor();

  await adminPage.getByRole('button', { name: '我的收藏', exact: true }).click();
  const favCard = adminPage.locator('.personal-space [data-testid="app-card"]').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).first();
  await favCard.waitFor();
  await favCard.getByTestId('card-title').click();
  await adminPage.getByTestId('app-detail').waitFor();
  await adminPage.getByTestId('detail-manage-access').click();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  await selectOption(adminPage, '分享范围', '仅自己');
  await adminPage.getByRole('button', { name: '确认更改分享范围', exact: true }).click();
  await adminPage.getByText('配置已保存，已回读当前结果。', { exact: true }).waitFor();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await adminPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor({ state: 'hidden' });
  await adminPage.getByTestId('detail-visibility').getByText('仅自己可见').waitFor();
  await adminPage.getByTestId('return-discovery').click();
  await favCard.waitFor();
  await favCard.getByTestId('card-share').click();
  await adminPage.locator('.el-message').getByText(/当前仅自己可见/).first().waitFor();

  // --- Regression R12-2: Syncing detail response into cards clears stale entryAvailability ---
  const staleDisabledHandler = async (route: any) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      const body = await response.json();
      body.items = body.items.map((item: any) => (
        item.id === agentReg.appId
          ? { ...item, entryAvailability: { agent: { status: 'disabled', reason: '旧版分发包待补齐' } } }
          : item
      ));
      return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.continue();
  };
  await adminPage.route('**/api/apps?*', staleDisabledHandler);
  await adminPage.goto(`${h.origin}/plaza/?discover=catalog`);
  const syncedCard = adminPage.locator('.catalog-results [data-testid="app-card"]').filter({ hasText: 'WorkBuddy企微机器人权限主动续期' }).first();
  await syncedCard.getByTestId('primary-disabled-reason').filter({ hasText: '旧版分发包待补齐' }).waitFor();
  await adminPage.unroute('**/api/apps?*', staleDisabledHandler);
  assert.equal(await syncedCard.getByTestId('card-primary-agent').count(), 0);

  await syncedCard.getByTestId('card-title').click();
  await adminPage.getByTestId('use-agent').waitFor();
  await adminPage.getByTestId('return-discovery').click();
  await syncedCard.getByTestId('card-primary-agent').waitFor();
  assert.equal(await syncedCard.getByTestId('primary-disabled-reason').count(), 0);
  report.checks.push('req2-req4-round12-browser-regressions');

  // --- Regression R13-1: Background status shift keeps open editor draft in read-only mode instead of closing ---
  const statusShiftDraft = await h.managed.submit(makeBundle({
    appKey: 'status-shift-readonly-draft',
    name: '状态变更保留未提交草稿应用',
    summary: '验证后台变为 cancelled 时已打开的编辑器保留草稿并切为只读。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(statusShiftDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('状态变更后保留的未提交草稿');
  await h.db.query("UPDATE publications SET status = 'cancelled', next_action = 'complete' WHERE id = $1", [statusShiftDraft.id]);
  await adminPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await adminPage.getByTestId('editor-readonly-notice').waitFor();
  assert.equal(await adminPage.getByTestId('metadata-editor').isVisible(), true);
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '状态变更后保留的未提交草稿');
  assert.equal(await adminPage.getByTestId('editor-name').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('editor-save').isDisabled(), true);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });
  report.checks.push('req3-req4-round13-browser-regressions');

  // --- Regression R14-1: Immediate read-only switch when save returns PUBLICATION_STATE_CONFLICT ---
  const conflictRoDraft = await h.managed.submit(makeBundle({
    appKey: 'conflict-immediate-readonly',
    name: '保存冲突立即切只读测试',
    summary: '验证保存遇到 PUBLICATION_STATE_CONFLICT 时立即切只读并保留草稿。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(conflictRoDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('直接冲突切换只读草稿');

  let stateConflictDirectOnce = true;
  const directRoConflictHandler = (route: any) => {
    if (stateConflictDirectOnce && route.request().method() === 'POST') {
      stateConflictDirectOnce = false;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PUBLICATION_STATE_CONFLICT', message: '该原预览已被其他修订替代。' } }),
      });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${conflictRoDraft.id}/editor*`, directRoConflictHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('editor-readonly-notice').waitFor();
  await adminPage.unroute(`**/api/publications/${conflictRoDraft.id}/editor*`, directRoConflictHandler);
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '直接冲突切换只读草稿');
  assert.equal(await adminPage.getByTestId('editor-name').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('editor-save').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('metadata-editor').getByRole('button', { name: '重新读取', exact: true }).count(), 0);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });
  report.checks.push('req3-round14-browser-regressions');

  // --- Regression R15: Access revalidation on closeAccessDialog, expiry auto-readonly, REVISION_CONFLICT readonly, isolated prompt retry ---
  await memberPage.goto(`${h.origin}/plaza/admin`);
  await memberPage.getByRole('button', { name: '预览页修订后的应用名', exact: true }).click();
  await memberPage.getByTestId('app-detail').waitFor();
  await memberPage.getByTestId('detail-manage-access').click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  const mgmt404Handler = (route: any) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (req.method() === 'GET' && /\/api\/management\/apps\/[^/]+$/.test(pathname)) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'APP_NOT_FOUND', message: '当前已无权访问此应用。' } }) });
    }
    return route.continue();
  };
  await memberPage.route('**/api/management/apps/*', mgmt404Handler);
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await memberPage.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor({ state: 'hidden' });
  await memberPage.getByRole('alert').getByText('当前已无权访问此应用。').waitFor();
  await memberPage.unroute('**/api/management/apps/*', mgmt404Handler);
  assert.equal(await memberPage.getByTestId('app-detail').count(), 0, 'stale cached management detail is never shown after access loss');
  await memberPage.keyboard.press('Escape');

  // Active expiry timer transitions open editor draft to read-only automatically without losing edits.
  const expiryTimerDraft = await h.managed.submit(makeBundle({
    appKey: 'expiry-timer-readonly-draft',
    name: '到期自动切只读测试应用',
    summary: '验证预览在打开编辑期间到期时自动切只读。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  const shortExpiryHandler = async (route: any) => {
    if (route.request().method() === 'GET' && !route.request().url().includes('/editor')) {
      const response = await route.fetch();
      const body = await response.json();
      body.expiresAt = new Date(Date.now() + 900).toISOString();
      return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${expiryTimerDraft.id}*`, shortExpiryHandler);
  await adminPage.goto(expiryTimerDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('即将过期自动只读草稿');
  await adminPage.getByTestId('editor-readonly-notice').waitFor();
  await adminPage.unroute(`**/api/publications/${expiryTimerDraft.id}*`, shortExpiryHandler);
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '即将过期自动只读草稿');
  assert.equal(await adminPage.getByTestId('editor-name').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('editor-save').isDisabled(), true);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // REVISION_CONFLICT in publication mode transitions open editor immediately to read-only.
  const revConflictDraft = await h.managed.submit(makeBundle({
    appKey: 'revision-conflict-readonly-draft',
    name: '修订冲突切只读测试应用',
    summary: '验证 REVISION_CONFLICT 后保留草稿且禁改禁用保存。',
    entry: 'agent',
  }), randomBytes(32).toString('base64url'), randomUUID());
  await adminPage.goto(revConflictDraft.previewUrl);
  await adminPage.getByTestId('edit-publication').click();
  await adminPage.getByTestId('metadata-editor').waitFor();
  await adminPage.getByTestId('editor-name').fill('修订冲突只读保留草稿');
  let revConflictOnce = true;
  const revConflictHandler = (route: any) => {
    if (revConflictOnce && route.request().method() === 'POST') {
      revConflictOnce = false;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: '应用修订已变化，请重新提交候选并查看新预览。' } }),
      });
    }
    return route.continue();
  };
  await adminPage.route(`**/api/publications/${revConflictDraft.id}/editor*`, revConflictHandler);
  await adminPage.getByTestId('editor-save').click();
  await adminPage.getByTestId('editor-readonly-notice').waitFor();
  await adminPage.unroute(`**/api/publications/${revConflictDraft.id}/editor*`, revConflictHandler);
  assert.equal(await adminPage.getByTestId('editor-name').inputValue(), '修订冲突只读保留草稿');
  assert.equal(await adminPage.getByTestId('editor-name').isDisabled(), true);
  assert.equal(await adminPage.getByTestId('editor-save').isDisabled(), true);
  await adminPage.getByRole('button', { name: '取消', exact: true }).click();
  await adminPage.getByTestId('metadata-editor').waitFor({ state: 'hidden' });

  // SmartSearchPromptAdmin preserves uncertain smart-search save retry button after saving a template in another tab.
  await adminPage.goto(`${h.origin}/plaza/?space=smart-search`);
  await adminPage.getByTestId('prompt-editor').waitFor();
  const originalPromptVal = await adminPage.getByTestId('prompt-editor').inputValue();
  let failPromptOnce = true;
  const prompt503Handler = (route: any) => {
    if (failPromptOnce && route.request().method() === 'PUT') {
      failPromptOnce = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '暂不可用' } }) });
    }
    return route.continue();
  };
  await adminPage.route('**/api/access/smart-search-prompt', prompt503Handler);
  await adminPage.getByTestId('prompt-editor').fill(`${originalPromptVal}\n补充规则`);
  await adminPage.getByTestId('prompt-save').click();
  await adminPage.getByRole('button', { name: '重试同一请求', exact: true }).waitFor();
  await adminPage.unroute('**/api/access/smart-search-prompt', prompt503Handler);

  await adminPage.getByRole('tab', { name: '应用分享模板', exact: true }).click();
  const origShareTpl = await adminPage.getByTestId('template-editor-share_agent').inputValue();
  await adminPage.getByTestId('template-editor-share_agent').fill(`${origShareTpl}\n[附注]`);
  await adminPage.getByTestId('template-save-share_agent').click();
  await adminPage.getByText('模板已保存，后续操作立即生效。', { exact: true }).waitFor();
  await adminPage.getByRole('tab', { name: '智能查找提示词', exact: true }).click();
  assert.equal(await adminPage.getByRole('button', { name: '重试同一请求', exact: true }).isVisible(), true);
  assert.equal(await adminPage.getByTestId('prompt-editor').isDisabled(), true);
  report.checks.push('req1-req3-req4-round15-browser-regressions');

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
