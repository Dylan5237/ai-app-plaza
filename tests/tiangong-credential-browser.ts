import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { loadFuxiTestProfile } from '../server/fuxi-entry.js';

const fixtureRoot = process.env.PLAZA_FUXI_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('请配置仅供本地测试的PLAZA_FUXI_FIXTURE_ROOT');
const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const evidence = resolve('artifacts/fuxi-test-bridge', channel);
await mkdir(evidence, { recursive: true });
const certificate = await mkdtemp(join(tmpdir(), 'plaza-test-portal-tls-'));
const openssl = process.env.PLAZA_TEST_OPENSSL || (existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
  '-keyout', join(certificate, 'key.pem'), '-out', join(certificate, 'cert.pem'), '-days', '1'], { stdio: 'ignore', windowsHide: true });
const h = await startHarness();
const html = await readFile('ops/integration/tiangong-test/fuxi-entry-test.html', 'utf8');
const bridge = await readFile('ops/integration/tiangong-test/fuxi-entry-test-bridge.js', 'utf8');
let portalOrigin = '';
const server = createServer({ key: await readFile(join(certificate, 'key.pem')), cert: await readFile(join(certificate, 'cert.pem')) }, (req, res) => {
  const path = new URL(req.url || '/', 'https://localhost').pathname;
  if (path === '/fuxi-entry-test-bridge.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bridge); return; }
  if (path === '/fixture-bootstrap.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`import{createPortalTestBridge}from'./fuxi-entry-test-bridge.js';createPortalTestBridge(window,{portalOrigin:${JSON.stringify(portalOrigin)},plazaOrigin:${JSON.stringify(h.origin)},credentialKey:'sky-token',ttlMs:location.pathname==='/expired.html'?100:120000});`); return;
  }
  if (['/portal.html', '/expired.html', '/coop.html'].includes(path)) {
    if (path === '/coop.html') res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html.replace('./fuxi-entry-test-bridge.js', './fixture-bootstrap.js')); return;
  }
  res.writeHead(404); res.end();
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
portalOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
const child = spawn(process.execPath, ['backend/tests/fixtures/tiangong-browser-server.js'], {
  cwd: fixtureRoot, env: { ...process.env, FUXI_TIANGONG_FIXTURE_PLAZA_ORIGINS: h.origin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let fixtureLog = '';
child.stdout.on('data', chunk => { fixtureLog += String(chunk); }); child.stderr.on('data', chunk => { fixtureLog += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [], errors: string[] = [], forbidden: string[] = [];
const network: Array<{ url: string; credentialInUrl: boolean; credentialInBody: boolean; allowedBody: boolean }> = [];
try {
  const f = await new Promise<any>((accept, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('伏羲隔离fixture启动超时')), 25_000);
    child.stdout.on('data', chunk => {
      buffer += String(chunk); const line = buffer.split(/\r?\n/).find(value => value.startsWith('{"fixture":true,'));
      if (line) { clearTimeout(timer); accept(JSON.parse(line)); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`伏羲fixture退出 ${code}`)); });
  });
  assert.equal(f.fixture, true); assert.equal(new URL(f.fuxiOrigin).hostname, '127.0.0.1');
  const tokens: string[] = Object.values(f.testTokens);
  h.config.fuxiTest = loadFuxiTestProfile({ PLAZA_FUXI_TEST_ENABLED: '1', PLAZA_FUXI_TEST_ORIGIN: f.fuxiOrigin,
    PLAZA_FUXI_TEST_PORTAL_ORIGIN: portalOrigin }, { local: true, publicOrigin: h.origin });
  const enabled = { ...h.config.fuxiTest };
  const catalog = await seedTagCatalog(h.db, h.config.audience, ['原型制作'], 790);
  catalog.source.name = '伏羲正式入口保持';
  catalog.source.primaryEntry = 'platform-web';
  catalog.source.entries = [{ id: 'platform-web', kind: 'web', label: '正式入口', url: 'http://192.168.2.145:16088/' }];
  await h.db.query('UPDATE published_snapshots SET manifest=$2::jsonb WHERE id=$1', [catalog.snapshotId, JSON.stringify(catalog.source)]);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : { channel }) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => {
    (window as any).__tokenReads = 0; (window as any).__bridgeRequests = 0; (window as any).__lastRequestId = '';
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) { if (key === 'sky-token') (window as any).__tokenReads++; return get.call(this, key); };
    const open = window.open;
    window.open = function (...args) { const result = open.apply(window, args); (window as any).__lastChild = result; return result; };
    window.addEventListener('message', event => {
      if (event.data?.type === 'plaza:tiangong:credential-request') {
        (window as any).__bridgeRequests++; (window as any).__lastRequestId = event.data.requestId;
      }
    });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { forbidden.push(url.origin); return route.abort(); }
    return route.continue();
  });
  context.on('request', request => {
    const url = new URL(request.url()), body = request.postData() || '';
    network.push({ url: request.url(), credentialInUrl: tokens.some(token => request.url().includes(token)),
      credentialInBody: tokens.some(token => body.includes(token)),
      allowedBody: url.origin === f.fuxiOrigin && url.pathname === '/api/auth/tiangong/exchange' && request.method() === 'POST' });
  });
  const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
  const calls = async () => (await (await context.request.get(`${f.fuxiOrigin}/_test/observations`)).json()).portalCalls;
  const portal = await context.newPage(); await portal.goto(`${portalOrigin}/portal.html`);
  await portal.evaluate(token => localStorage.setItem('sky-token', token), f.testTokens.validA);
  const openPlaza = async (parent = portal) => {
    const [page] = await Promise.all([context.waitForEvent('page'), parent.locator('#open-test').click()]);
    await page.waitForLoadState('domcontentloaded');
    await page.getByTestId('enter-fuxi-test').waitFor(); return page;
  };
  const enter = async (plaza: Page) => {
    const [page] = await Promise.all([context.waitForEvent('page'), plaza.getByTestId('enter-fuxi-test').click()]);
    await page.waitForLoadState('domcontentloaded'); return page;
  };
  const confirmExisting = async (popup: Page, confirm = true) => {
    await popup.waitForFunction(() => location.pathname === '/' || Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === '切换账号') || document.querySelector('[role=alert]'));
    if (await popup.getByRole('button', { name: '切换账号', exact: true }).count()) {
      await popup.getByRole('button', { name: confirm ? '切换账号' : '保持当前账号', exact: true }).click();
    }
  };
  const user = (page: Page) => page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    return (await r.json()).data;
  });
  await check('共享目录正式16088入口和默认policy保持，不读取门户凭证', async () => {
    const page = await context.newPage(); await page.goto(h.origin);
    assert.equal(await page.getByTestId('open-platform').getAttribute('href'), 'http://192.168.2.145:16088/');
    assert.deepEqual(await (await context.request.get(`${h.origin}/api/entry-policies`)).json(), { policies: [] });
    assert.equal(await portal.evaluate(() => (window as any).__tokenReads), 0); assert.equal(await calls(), 0); await page.close();
  });
  await check('没有门户opener时测试页拒绝直接进入', async () => {
    const page = await context.newPage(); await page.goto(`${h.origin}/integration/fuxi-test`);
    await page.getByRole('alert').filter({ hasText: '请从已登录天宫' }).waitFor();
    assert.equal(await page.getByTestId('enter-fuxi-test').isDisabled(), true); await page.close();
  });
  const plaza = await openPlaza();
  await check('HTTPS门户打开HTTP广场顶层窗口；加载和悬停零读取', async () => {
    await plaza.getByTestId('enter-fuxi-test').hover();
    assert.equal(new URL(portal.url()).protocol, 'https:'); assert.equal(new URL(plaza.url()).protocol, 'http:');
    assert.equal(await plaza.evaluate(() => Boolean(window.opener)), true);
    assert.equal(await portal.evaluate(() => (window as any).__tokenReads), 0);
  });
  let first: Page, firstUser: any;
  await check('点击后完整三方链路一次读取，甲用户普通权限登录', async () => {
    first = await enter(plaza); await first.waitForURL(`${f.fuxiOrigin}/`); firstUser = await user(first);
    assert.equal(firstUser.nickname, '天宫测试甲'); assert.deepEqual(firstUser.role, ['uploader']);
    assert.equal(await portal.evaluate(() => (window as any).__tokenReads), 1); assert.equal(await calls(), 1);
    await first.screenshot({ path: resolve(evidence, 'three-party-login.png'), fullPage: true });
  });
  await check('已消费的门户授权不能再次取凭证或重放给伏羲', async () => {
    const before = await calls();
    await portal.evaluate(({ origin, token }) => (window as any).__lastChild.postMessage({ type: 'plaza:tiangong:credential-result',
      requestId: (window as any).__lastRequestId, token }, origin), { origin: h.origin, token: f.testTokens.validB });
    await plaza.evaluate(() => new Promise(accept => setTimeout(accept, 0)));
    assert.equal(await calls(), before); assert.equal(await portal.evaluate(() => (window as any).__tokenReads), 1);
  });
  await check('新授权下失效身份被伏羲拒绝并保留甲会话', async () => {
    await portal.evaluate(token => localStorage.setItem('sky-token', token), f.testTokens.invalid);
    const page = await openPlaza(), popup = await enter(page); await confirmExisting(popup);
    await popup.getByRole('alert').filter({ hasText: '身份验证失败' }).waitFor(); assert.equal((await user(popup)).id, firstUser.id);
    await popup.close(); await page.close();
  });
  await check('乙用户经确认后映射独立账号，不与甲串号', async () => {
    await portal.evaluate(token => localStorage.setItem('sky-token', token), f.testTokens.validB);
    const page = await openPlaza(), popup = await enter(page); await confirmExisting(popup); await popup.waitForURL(`${f.fuxiOrigin}/`);
    const second = await user(popup); assert.notEqual(second.id, firstUser.id); assert.equal(second.nickname, '天宫测试乙');
    await popup.close(); await page.close();
  });
  await check('COOP切断opener时明确拒绝，不降低安全头或回退登录', async () => {
    const parent = await context.newPage(); await parent.goto(`${portalOrigin}/coop.html`);
    const page = await openPlaza(parent); await page.getByRole('alert').filter({ hasText: '请从已登录天宫' }).waitFor();
    assert.equal(await page.getByTestId('enter-fuxi-test').isDisabled(), true); assert.equal(await parent.evaluate(() => (window as any).__tokenReads), 0);
    await page.close(); await parent.close();
  });
  await check('短时门户授权过期后，新的关联请求超时且不读取token', async () => {
    const parent = await context.newPage(); await parent.goto(`${portalOrigin}/expired.html`); const page = await openPlaza(parent);
    await parent.getByText('本次测试授权已过期，请重新打开广场测试入口。', { exact: true }).waitFor();
    const before = await calls(); await enter(page);
    await parent.waitForFunction(() => (window as any).__bridgeRequests > 0);
    await page.getByRole('alert').filter({ hasText: '未取得本次天宫凭证' }).waitFor();
    assert.equal(await parent.evaluate(() => (window as any).__tokenReads), 0); assert.equal(await calls(), before); await page.close(); await parent.close();
  });
  await check('读到凭证后的最终开关重检仍能阻止交给伏羲', async () => {
    const page = await openPlaza(); let reads = 1;
    await page.route('**/api/integration/fuxi-test/config', route => { reads++; if (reads >= 3) h.config.fuxiTest = { ...enabled, enabled: false }; return route.continue(); });
    const before = await calls(), popup = await enter(page);
    await page.getByRole('alert').filter({ hasText: '伏羲测试接入已停用' }).waitFor(); assert.equal(await calls(), before);
    if (!popup.isClosed()) await popup.close(); await page.close(); h.config.fuxiTest = enabled;
  });
  await check('URL、Network、日志和广场/伏羲新增存储无门户凭证', async () => {
    assert.ok(network.every(row => !row.credentialInUrl && (!row.credentialInBody || row.allowedBody)));
    for (const page of context.pages().filter(page => page.url().startsWith(h.origin) || page.url().startsWith(f.fuxiOrigin))) {
      const values = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
      assert.ok(values.every(value => tokens.every(token => !value.includes(token))));
    }
    const logs = fixtureLog.split(/\r?\n/).filter(line => !line.startsWith('{"fixture":true,')).join('\n');
    assert.ok(tokens.every(token => !logs.includes(token))); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  });
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ channel, passed: checks.length, checks, fixture: true,
    realPortalVerified: false, transport: { portal: 'https loopback with synthetic certificate', plaza: 'http loopback', fuxi: 'http loopback' },
    network, errors, forbidden, fuxiCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim() }, null, 2));
  console.log(JSON.stringify({ channel, passed: checks.length, evidence }));
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    await page.screenshot({ path: resolve(evidence, `failure-${Date.now()}-${index}.png`), fullPage: true }).catch(() => {});
  }
  await writeFile(resolve(evidence, 'failure.txt'), String(error)); throw error;
} finally {
  await browser?.close(); child.stdin.write('stop\n');
  await new Promise<void>(accept => { if (child.exitCode !== null) return accept(); const timer = setTimeout(() => { child.kill(); accept(); }, 8000); child.once('exit', () => { clearTimeout(timer); accept(); }); });
  await new Promise<void>(accept => server.close(() => accept())); await h.close();
}
