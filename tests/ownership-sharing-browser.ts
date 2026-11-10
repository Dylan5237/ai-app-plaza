import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { startIdentityHarness } from './helpers/identity-fixture.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { DEFAULT_TAG, SHA, TOKEN } from './helpers/gitlab-fixture.js';

const h = await startIdentityHarness('/plaza', { analytics: true, superAdminAccount: 'fixture.admin' });
const admin = await h.login('fixture-admin'), member = await h.login('fixture-member');
const target = await seedTagCatalog(h.db, h.config.audience, ['受限标签']);
await seedTagCatalog(h.db, h.config.audience, ['公开标签'], 2);
const groupId = randomUUID();
await h.db.query('INSERT INTO plaza_groups(id,name) VALUES($1,$2)', [groupId, '浏览器分享小组']);
await h.db.query('INSERT INTO plaza_group_members(group_id,user_id) VALUES($1,$2)', [groupId, member.user.id]);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const adminContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const memberContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await adminContext.newPage(), receiver = await memberContext.newPage();
const errors: string[] = [];
for (const surface of [page, receiver]) surface.on('pageerror', error => errors.push(error.message));
const memberLabel = '测试普通成员（fixture.member）', adminLabel = '测试名册管理员（fixture.admin）';
async function select(surface: Page, name: string, option: string) {
  await surface.getByRole('combobox', { name, exact: true }).press('ArrowDown');
  await surface.getByRole('option', { name: option, exact: true }).click();
  await surface.keyboard.press('Escape');
}
async function login(surface: Page, button: string) {
  await surface.goto(`${h.origin}/plaza/fixture/portal`);
  await surface.getByRole('button', { name: button, exact: true }).click();
  await surface.getByRole('link', { name: '我的应用', exact: true }).waitFor();
}
async function role(value: string, reason: string) {
  const row = page.getByRole('row').filter({ hasText: memberLabel });
  await row.getByRole('button', { name: '调整角色', exact: true }).click();
  await select(page, '平台角色', value);
  await page.getByRole('textbox', { name: '核验依据或变更原因' }).fill(reason);
  await page.getByRole('button', { name: '确认更改角色', exact: true }).click();
  await page.getByRole('dialog', { name: '调整平台角色', exact: true }).waitFor({ state: 'hidden' });
  await row.getByRole('cell', { name: value, exact: true }).waitFor();
}
try {
  await login(page, '以测试名册管理员进入');
  await page.getByText('超级管理员 · 天宫身份', { exact: true }).waitFor();
  await page.getByRole('link', { name: '应用归属核验', exact: true }).click();
  await page.getByRole('heading', { name: '应用归属核验', exact: true }).waitFor();
  const appRow = page.getByRole('row').filter({ hasText: target.source.name });
  await appRow.getByRole('button', { name: '核验并指定负责人', exact: true }).click();
  await select(page, '核验后的负责人', adminLabel);
  await page.getByRole('textbox', { name: '核验依据或变更原因' }).fill('已核对固定来源、维护责任和原公开授权');
  await page.getByText('我已核对该应用的来源授权及原公开授权', { exact: true }).click();
  await page.getByRole('button', { name: '确认指定负责人', exact: true }).click();
  await appRow.getByText('已归属', { exact: true }).waitFor();
  assert.equal((await h.service.list()).total, 2, 'adoption preserves original public visibility');
  await page.screenshot({ path: 'artifacts/ownership-governance.png', fullPage: true });
  await page.getByRole('link', { name: '我的应用', exact: true }).click();
  await page.getByRole('row').filter({ hasText: target.source.name }).getByRole('button', { name: '归属与权限', exact: true }).click();
  await page.getByRole('dialog', { name: '应用归属与权限', exact: true }).waitFor();
  await select(page, '分享范围', '指定小组');
  await select(page, '指定小组', '浏览器分享小组');
  const sharingBodies: string[] = [];
  await page.route('**/api/access/apps/*/sharing', async route => {
    sharingBodies.push(route.request().postData()!);
    if (sharingBodies.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '确认更改分享范围', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存结果尚未确认' }).waitFor();
  await page.getByRole('button', { name: '核对并重试原操作', exact: true }).click();
  await page.getByText('配置已保存，已回读当前结果。', { exact: true }).waitFor();
  assert.equal(sharingBodies.length, 2); assert.equal(sharingBodies[0], sharingBodies[1]);
  assert.equal((await h.db.query("SELECT count(*) AS n FROM plaza_access_operations WHERE resource_id=$1 AND action='sharing_changed'", [target.appId])).rows[0].n, 1);
  await page.getByText('维护授权', { exact: true }).click();
  await select(page, '应用维护者', memberLabel);
  await page.getByRole('button', { name: '确认更改维护授权', exact: true }).click();
  await page.getByText('配置已保存，已回读当前结果。', { exact: true }).waitFor();
  await page.locator('.application-access-dialog .el-loading-mask').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/ownership-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  await login(receiver, '以测试普通成员进入');
  assert.equal(await receiver.getByRole('link', { name: '运营看板', exact: true }).count(), 0);
  await receiver.goto(`${h.origin}/plaza/?app=${target.appId}`);
  await receiver.getByTestId('app-detail').waitFor();
  await h.db.query('DELETE FROM plaza_group_members WHERE group_id=$1', [groupId]);
  await receiver.evaluate(() => dispatchEvent(new Event('focus')));
  await receiver.getByTestId('app-detail').waitFor({ state: 'hidden' });
  await receiver.getByText('应用不存在。', { exact: false }).waitFor();
  assert.equal((await receiver.locator('body').innerText()).includes(target.source.name), false, 'revoked group access clears displayed private material');
  await receiver.getByRole('link', { name: '我的应用', exact: true }).click();
  await receiver.getByRole('row').filter({ hasText: target.source.name }).getByRole('button', { name: '归属与权限', exact: true }).click();
  await receiver.getByText('当前范围：指定小组。你可维护此应用，归属、分享及委派由负责人调整。', { exact: true }).waitFor();
  assert.equal(await receiver.getByRole('button', { name: '确认更改分享范围', exact: true }).count(), 0);
  await receiver.getByRole('dialog', { name: '应用归属与权限' }).getByRole('button', { name: '关闭', exact: true }).click();
  await receiver.goto(`${h.origin}/plaza/?space=operations`);
  await receiver.getByRole('heading', { name: '当前身份没有此页面权限', exact: true }).waitFor();

  await page.getByRole('dialog', { name: '应用归属与权限' }).getByText('负责人交接', { exact: true }).click();
  await select(page, '交接接收人', memberLabel);
  await page.getByRole('button', { name: '确认发起交接', exact: true }).click();
  await page.getByText('交接请求已发送，等待接收人接受。', { exact: true }).waitFor();
  await page.getByRole('dialog', { name: '应用归属与权限' }).getByRole('button', { name: '关闭', exact: true }).click();
  await receiver.getByRole('link', { name: '负责人交接', exact: true }).click();
  await receiver.getByRole('button', { name: '接受负责人职责', exact: true }).click();
  await receiver.getByText('已接受负责人职责。', { exact: true }).waitFor();
  const access = (await h.db.query('SELECT * FROM plaza_app_access WHERE app_id=$1', [target.appId])).rows[0];
  assert.equal(access.owner_id, member.user.id); assert.equal(access.scope, 'groups');
  assert.equal((await h.db.query('SELECT revision FROM catalog_apps WHERE id=$1', [target.appId])).rows[0].revision, 1);
  await page.goto(`${h.origin}/plaza/?app=${target.appId}`);
  await page.getByText('应用不存在。', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('app-detail').count(), 0, 'super administrator is not a private-content bypass after handoff');

  await page.getByRole('link', { name: '管理员配置', exact: true }).click();
  await role('管理员', '授权运营看板与治理职责');
  await receiver.goto(`${h.origin}/plaza/?space=operations`);
  await receiver.getByRole('heading', { name: '看见应用的发现与增长', exact: true }).waitFor();
  await receiver.getByRole('heading', { name: '应用发现表现', exact: true }).waitFor();
  assert.equal((await receiver.locator('body').innerText()).includes(target.source.name), false);
  await receiver.screenshot({ path: 'artifacts/operations-integrated.png', fullPage: true });
  await receiver.setViewportSize({ width: 390, height: 844 });
  assert.equal(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await receiver.screenshot({ path: 'artifacts/operations-integrated-mobile.png', fullPage: true });
  await role('普通成员', '回收运营看板权限');
  await receiver.evaluate(() => dispatchEvent(new Event('focus')));
  await receiver.getByRole('heading', { name: '当前身份没有此页面权限', exact: true }).waitFor();
  assert.equal(await receiver.getByRole('heading', { name: '应用发现表现', exact: true }).count(), 0);
  assert.equal(await receiver.getByRole('link', { name: '运营看板', exact: true }).count(), 0);
  const forbidden = await receiver.evaluate(async () => (await fetch('/plaza/api/operations/dashboard', {
    headers: { 'X-Plaza-Portal-Token': 'fixture-member', 'X-Plaza-Role': 'super_administrator' },
  })).status);
  assert.equal(forbidden, 403);

  const source = JSON.parse(h.gitlab.state.files.get('ai-app.json')!);
  source.name = '受限包浏览器夹具';
  source.entries.find((entry: any) => entry.kind === 'agent').distribution = { type: 'source', files: ['docs/agent-1.md'] };
  h.gitlab.state.files.set('ai-app.json', JSON.stringify(source));
  const submitted = await h.service.submit({ projectId: 1, appKey: 'sample-1', manifestPath: 'ai-app.json', commitSha: SHA, tag: DEFAULT_TAG }, TOKEN, randomUUID());
  const registered = await h.service.confirm(submitted.id, submitted.ticket, { revision: submitted.revision, digest: submitted.digest! }, admin.user.id);
  const packageApp = await h.service.app(registered.appId!, { viewerId: admin.user.id });
  const pack = packageApp.distributions![0];
  assert.equal((await h.app.inject({ url: new URL(pack.url!).pathname, headers: h.headers() })).statusCode, 404);
  await page.goto(`${h.origin}/plaza/?app=${packageApp.id}`);
  await page.getByTestId('read-full-docs').click();
  let delivered = 0;
  page.on('download', () => delivered++);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载安装包', exact: true }).click();
  const file = await downloaded;
  assert.equal(createHash('sha256').update(await readFile((await file.path())!)).digest('hex'), pack.sha256);

  let allowResponse!: () => void, requestEntered!: () => void;
  const responseGate = new Promise<void>(resolve => { allowResponse = resolve });
  const entered = new Promise<void>(resolve => { requestEntered = resolve });
  await page.route(pack.url!, async route => {
    const response = await route.fetch(); requestEntered(); await responseGate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '下载安装包', exact: true }).click();
  await entered;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '退出广场', exact: true }).click();
  await page.getByText('访客浏览', { exact: true }).waitFor();
  allowResponse();
  await page.getByText('身份状态已变化，已停止下载。', { exact: true }).waitFor();
  assert.equal(delivered, 1, 'a late package response cannot download after logout');
  assert.deepEqual(errors, []);
  await writeFile('artifacts/ownership-sharing-browser.json', JSON.stringify({ status: 'PASS', environment: 'synthetic Tiangong and local PostgreSQL engine', checks: ['explicit legacy assignment preserves public audience', 'same-request recovery for uncertain sharing', 'current group membership', 'maintenance cannot delegate', 'receiver-confirmed ownership handoff', 'super administrator cannot read private body implicitly', 'administrator-only real dashboard', 'revocation clears displayed data and navigation', 'authenticated private package download and logout race', '390px layout'], errors }, null, 2));
  console.log('PASS: ownership, sharing, maintenance, role administration and real dashboard integration (synthetic Tiangong).');
} catch (error) {
  await page.screenshot({ path: 'artifacts/ownership-failure.png', fullPage: true });
  await receiver.screenshot({ path: 'artifacts/ownership-member-failure.png', fullPage: true });
  console.error({ adminUrl: page.url(), adminText: await page.locator('body').innerText(), memberUrl: receiver.url(), memberText: await receiver.locator('body').innerText(), errors });
  throw error;
} finally { await browser.close(); await h.close(); }
