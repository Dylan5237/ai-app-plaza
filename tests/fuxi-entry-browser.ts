import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';

// Explicit local cross-repository integration, never a live service URL.
const fixtureRoot = process.env.PLAZA_FUXI_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('请配置 PLAZA_FUXI_FIXTURE_ROOT 指向伏羲本地测试工作树');
const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const evidence = resolve('artifacts/fuxi-entry', channel);
await mkdir(evidence, { recursive: true });
const checks: string[] = [];
const observations: Array<{ method: string; url: string; credentialInUrl: boolean; credentialBody: boolean; allowedBody: boolean }> = [];
const pageErrors: string[] = [];
const harness = await startHarness();
let browser: Browser | undefined;
const fixture = spawn(process.execPath, ['backend/tests/fixtures/tiangong-browser-server.js'], {
  cwd: fixtureRoot, env: { ...process.env, FUXI_TIANGONG_FIXTURE_PLAZA_ORIGINS: harness.origin },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let fixtureLog = '';
fixture.stderr.on('data', chunk => { fixtureLog += String(chunk); });
fixture.stdout.on('data', chunk => { fixtureLog += String(chunk); });

try {
  const config = await new Promise<any>((accept, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('伏羲本地fixture启动超时')), 25_000);
    fixture.stdout.on('data', chunk => {
      output += String(chunk);
      const line = output.split(/\r?\n/).find(value => value.startsWith('{"fixture":true,'));
      if (line) { clearTimeout(timeout); accept(JSON.parse(line)); }
    });
    fixture.once('exit', code => { clearTimeout(timeout); reject(new Error(`伏羲本地fixture提前退出 ${code}`)); });
    fixture.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(config.fixture, true);
  assert.equal(new URL(config.fuxiOrigin).hostname, '127.0.0.1');
  assert.ok(config.allowedOrigins.includes(harness.origin));
  const tokens: Record<string, string> = config.testTokens;
  assert.equal(tokens.validA, 'fixture-valid-a');
  const rawTokens = Object.values(tokens);
  const fuxi = await seedTagCatalog(harness.db, harness.config.audience, ['原型制作'], 780);
  fuxi.source.name = '伏羲联合测试';
  fuxi.source.entries = [{ id: 'web', kind: 'web', label: '打开伏羲', url: 'https://unapproved.invalid/manifest-target?fuxiOrigin=evil' }];
  fuxi.source.primaryEntry = 'web';
  const ordinary = await seedTagCatalog(harness.db, harness.config.audience, ['普通应用'], 781);
  ordinary.source.name = '普通应用联合测试';
  ordinary.source.entries = [{ id: 'web', kind: 'web', label: '打开应用', url: 'https://ordinary.example.invalid/' }];
  ordinary.source.primaryEntry = 'web';
  for (const seed of [fuxi, ordinary]) {
    await harness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb WHERE id = $1', [seed.snapshotId, JSON.stringify(seed.source)]);
  }
  const policy = loadFuxiEntryPolicy({
    PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: fuxi.appId, PLAZA_FUXI_ENTRY_ID: 'web',
    PLAZA_FUXI_ORIGIN: config.fuxiOrigin, PLAZA_FUXI_CREDENTIAL_STORAGE: 'sessionStorage',
    PLAZA_FUXI_CREDENTIAL_KEY: 'fixture-existing-sky-token',
  }, { local: true, publicOrigin: harness.origin })!;
  harness.config.fuxiEntry = policy;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : { channel }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__portalReads = 0;
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'fixture-existing-sky-token') (window as any).__portalReads++;
      return read.call(this, key);
    };
  });
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  context.on('request', request => {
    const url = new URL(request.url());
    const body = request.postData() || '';
    observations.push({ method: request.method(), url: request.url(),
      credentialInUrl: rawTokens.some(token => request.url().includes(token)),
      credentialBody: rawTokens.some(token => body.includes(token)),
      allowedBody: url.origin === config.fuxiOrigin && url.pathname === '/api/auth/tiangong/exchange' && request.method() === 'POST',
    });
  });
  await context.route('https://ordinary.example.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>普通外链fixture</title><p>普通应用</p>' }));
  await context.route('https://unapproved.invalid/**', route => route.abort());
  const plaza = await context.newPage();
  await plaza.goto(`${harness.origin}/?userId=forged&fuxiOrigin=https%3A%2F%2Funapproved.invalid`);
  const card = plaza.getByTestId('app-card').filter({ hasText: fuxi.source.name });
  await card.getByTestId('open-platform').waitFor();
  const check = async (name: string, action: () => Promise<void>) => {
    await action(); checks.push(name); console.log(`PASS ${name}`);
  };
  const setToken = (token: string | null) => plaza.evaluate(value => {
    if (value === null) sessionStorage.removeItem('fixture-existing-sky-token');
    else sessionStorage.setItem('fixture-existing-sky-token', value);
    // Forging browser user JSON must not affect server identity.
    sessionStorage.setItem('sky-design-userInfo', JSON.stringify({ userId: 'forged', isAdministrator: true }));
  }, token);
  const calls = async () => (await (await context.request.get(`${config.fuxiOrigin}/_test/observations`)).json()).portalCalls as number;
  const openFrom = async (detail = false) => {
    const pending = plaza.waitForEvent('popup');
    await (detail ? plaza.getByTestId('use-web') : card.getByTestId('open-platform')).click();
    const popup = await pending;
    await popup.waitForLoadState('domcontentloaded');
    return popup;
  };
  const finishLogin = async (popup: Page, confirm = true) => {
    await popup.waitForFunction(() => location.pathname === '/' || Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === '切换账号'));
    const switchButton = popup.getByRole('button', { name: '切换账号', exact: true });
    if (await switchButton.count()) {
      await popup.getByRole('button', { name: confirm ? '切换账号' : '保持当前账号', exact: true }).click();
    }
    if (confirm) await popup.waitForURL(`${config.fuxiOrigin}/`);
  };
  const user = (popup: Page) => popup.evaluate(async () => {
    const result = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!result.ok) throw new Error('合成用户身份读取失败');
    return (await result.json()).data;
  });
  await check('目录加载、悬停及查看详情不读凭证或调用门户', async () => {
    await setToken(tokens.validA);
    await card.hover();
    await card.getByRole('button', { name: `查看 ${fuxi.source.name} 详情`, exact: true }).click();
    await plaza.getByTestId('use-web').waitFor();
    assert.equal(await calls(), 0);
    assert.equal(await plaza.evaluate(() => (window as any).__portalReads), 0);
    await plaza.getByRole('dialog').getByRole('button', { name: 'Close this dialog' }).click();
    await plaza.getByRole('dialog').waitFor({ state: 'hidden' });
  });
  let first: Page;
  let firstUser: any;
  await check('卡片从固定伏羲地址开通甲用户，Manifest目标及前端角色无法影响身份', async () => {
    await plaza.screenshot({ path: resolve(evidence, 'directory.png'), fullPage: true });
    first = await openFrom();
    await finishLogin(first);
    firstUser = await user(first);
    assert.equal(firstUser.nickname, '天宫测试甲');
    assert.deepEqual(firstUser.role, ['uploader']);
    assert.equal(await calls(), 1);
    assert.equal(observations.some(row => row.url.startsWith('https://unapproved.invalid')), false);
    await first.screenshot({ path: resolve(evidence, 'card-login.png'), fullPage: true });
  });
  await check('详情入口复用协议，同一甲用户映射不重复', async () => {
    await card.getByRole('button', { name: `查看 ${fuxi.source.name} 详情`, exact: true }).click();
    await plaza.getByTestId('use-web').waitFor();
    const popup = await openFrom(true);
    await finishLogin(popup);
    assert.equal((await user(popup)).id, firstUser.id);
    await popup.close();
  });
  for (const scenario of ['invalid', 'disabled', 'mock']) {
    await check(`${scenario}身份被拒绝，保留甲会话且不自动访客登录`, async () => {
      await setToken(tokens[scenario]);
      const before = await first!.evaluate(() => localStorage.getItem('token'));
      const popup = await openFrom(true);
      await popup.getByRole('alert').filter({ hasText: '身份验证失败' }).waitFor();
      assert.equal(await popup.evaluate(() => localStorage.getItem('token')), before);
      assert.equal(new URL(popup.url()).pathname, '/auth/tiangong');
      await popup.close();
    });
  }
  await check('取消乙身份切换保留甲，确认后乙与甲分别映射', async () => {
    await setToken(tokens.validB);
    let popup = await openFrom(true);
    await finishLogin(popup, false);
    await popup.getByRole('alert').filter({ hasText: '已取消切换' }).waitFor();
    assert.equal((await user(popup)).id, firstUser.id);
    await popup.close();
    popup = await openFrom(true);
    await finishLogin(popup);
    const second = await user(popup);
    assert.notEqual(second.id, firstUser.id);
    assert.equal(second.nickname, '天宫测试乙');
    assert.deepEqual(second.role, ['uploader']);
    await popup.close();
    await plaza.getByRole('dialog').getByRole('button', { name: 'Close this dialog' }).click();
  });
  await check('普通应用继续noopener外链，不读取或发送身份', async () => {
    const beforeCalls = await calls();
    const beforeReads = await plaza.evaluate(() => (window as any).__portalReads);
    const link = plaza.getByTestId('app-card').filter({ hasText: ordinary.source.name }).getByTestId('open-platform');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const pending = context.waitForEvent('page');
    await link.click();
    const popup = await pending;
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(await calls(), beforeCalls);
    assert.equal(await plaza.evaluate(() => (window as any).__portalReads), beforeReads);
    await popup.close();
  });
  await check('缺凭证明确失败，不打开伏羲或发起门户请求', async () => {
    await setToken(null);
    const beforeCalls = await calls();
    const beforePages = context.pages().length;
    await card.getByTestId('open-platform').click();
    await plaza.getByText('当前页面未取得天宫登录凭证，请从已登录的天宫入口进入。', { exact: true }).waitFor();
    assert.equal(context.pages().length, beforePages);
    assert.equal(await calls(), beforeCalls);
  });
  await check('停用开关约束已打开旧页面，不转交凭证或访问门户', async () => {
    await setToken(tokens.validA);
    const beforeCalls = await calls();
    harness.config.fuxiEntry = { ...policy, enabled: false };
    const pending = plaza.waitForEvent('popup');
    await card.getByTestId('open-platform').click();
    const popup = await pending;
    await plaza.getByText('伏羲入口配置已停用或发生变化，请刷新广场后重试。', { exact: true }).waitFor();
    if (!popup.isClosed()) await popup.waitForEvent('close');
    assert.equal(await calls(), beforeCalls);
    await plaza.reload();
    await card.getByTestId('open-platform').click();
    await plaza.getByText('伏羲身份接入暂未启用，请联系广场维护者。', { exact: true }).waitFor();
    assert.equal(await calls(), beforeCalls);
  });
  await check('Network、浏览器存储及页面错误检查无凭证泄露', async () => {
    assert.ok(observations.every(row => !row.credentialInUrl && (!row.credentialBody || row.allowedBody)));
    for (const popup of context.pages().filter(page => page.url().startsWith(config.fuxiOrigin))) {
      const storage = await popup.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
      assert.ok(storage.every(value => rawTokens.every(token => !value.includes(token))));
    }
    assert.deepEqual(pageErrors, []);
    const runtimeLog = fixtureLog.split(/\r?\n/).filter(line => !line.startsWith('{"fixture":true,')).join('\n');
    assert.ok(rawTokens.every(token => !runtimeLog.includes(token)));
  });
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ passed: checks.length, checks, channel,
    fuxiCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim(),
    plazaBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim(),
    fixture: true, realPortalVerified: false, observations, pageErrors,
  }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, channel, evidence }));
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    await page.screenshot({ path: resolve(evidence, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  await writeFile(resolve(evidence, 'failure.txt'), String(error));
  throw error;
} finally {
  await browser?.close();
  fixture.stdin.write('stop\n');
  await new Promise<void>(accept => {
    if (fixture.exitCode !== null) return accept();
    const timer = setTimeout(() => { fixture.kill(); accept(); }, 8000);
    fixture.once('exit', () => { clearTimeout(timer); accept(); });
  });
  await harness.close();
}
