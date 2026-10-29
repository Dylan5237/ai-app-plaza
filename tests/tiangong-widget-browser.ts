import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';

// Both servers and all identities are isolated local fixtures; never use a live URL.
const fixtureRoot = process.env.PLAZA_FUXI_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('请配置 PLAZA_FUXI_FIXTURE_ROOT 指向伏羲本地联合测试源码');
const moduleDir = process.env.PLAZA_FUXI_NODE_MODULES || resolve(fixtureRoot, 'backend/node_modules');
const requireFromFuxi = createRequire(resolve(moduleDir, '_fixture.cjs'));
const AdmZip = requireFromFuxi('adm-zip');
const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const html = await readFile('ops/integration/tiangong-widget/fuxi-portal-widget.html', 'utf8');
const js = await readFile('ops/integration/tiangong-widget/fuxi-portal-widget.js', 'utf8');
const css = await readFile('ops/integration/tiangong-widget/fuxi-portal-widget.css', 'utf8');
assert.equal(JSON.parse(await readFile('ops/integration/tiangong-widget/fuxi-widget-test-policy.json', 'utf8')).enabled, false);
const harness = await startHarness();
let portalOrigin = '', fuxiOrigin = '', appId = '', portalEnabled = true;
let portalPolicyRequests = 0, portalPolicyResponses = 0;
const entryId = 'web';
const portalServer = createServer((req, res) => {
  const pathname = new URL(req.url || '/', portalOrigin).pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/seed') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>synthetic portal</title>'); }
  if (pathname.endsWith('/fuxi-portal-widget.html')) { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (pathname.endsWith('/fuxi-portal-widget.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(js); }
  if (pathname.endsWith('/fuxi-portal-widget.css')) { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
  if (pathname.endsWith('/fuxi-widget-test-policy.json')) {
    portalPolicyRequests++;
    res.once('finish', () => { portalPolicyResponses++; });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ enabled: portalEnabled, portalOrigin, plazaOrigin: harness.origin, fuxiOrigin, appId, entryId }));
  }
  res.writeHead(404); res.end();
});
let browser: Browser | undefined;
let fixture: ChildProcessWithoutNullStreams | undefined;
const checks: string[] = [];
try {
  await new Promise<void>((accept, reject) => { portalServer.once('error', reject); portalServer.listen(0, '127.0.0.1', accept); });
  portalOrigin = `http://localhost:${(portalServer.address() as AddressInfo).port}`;
  fixture = spawn(process.execPath, ['backend/tests/fixtures/tiangong-browser-server.js'], {
    cwd: fixtureRoot,
    env: { ...process.env, NODE_PATH: [moduleDir, process.env.NODE_PATH].filter(Boolean).join(delimiter), FUXI_TIANGONG_FIXTURE_PLAZA_ORIGINS: portalOrigin },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let fixtureLog = '';
  fixture.stderr.on('data', chunk => { fixtureLog += String(chunk); });
  fixture.stdout.on('data', chunk => { fixtureLog += String(chunk); });
  const config = await new Promise<any>((accept, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('伏羲本地 fixture 启动超时')), 25_000);
    fixture!.stdout.on('data', chunk => {
      output += String(chunk);
      const line = output.split(/\r?\n/).find(value => value.startsWith('{"fixture":true,'));
      if (line) { clearTimeout(timeout); accept(JSON.parse(line)); }
    });
    fixture!.stderr.on('data', chunk => {
      if (String(chunk).includes('Local browser fixture failed:')) { clearTimeout(timeout); reject(new Error('伏羲本地 fixture 初始化失败')); }
    });
    fixture!.once('exit', code => { clearTimeout(timeout); reject(new Error(`伏羲本地 fixture 提前退出 ${code}`)); });
    fixture!.once('error', reject);
  });
  assert.equal(config.fixture, true);
  fuxiOrigin = config.fuxiOrigin;
  assert.equal(new URL(fuxiOrigin).hostname, '127.0.0.1');
  assert.ok(config.allowedOrigins.includes(portalOrigin));

  const fuxi = await seedTagCatalog(harness.db, harness.config.audience, ['原型制作'], 810);
  fuxi.source.name = '伏羲按钮联合测试';
  fuxi.source.entries = [{ id: entryId, kind: 'web', label: '打开伏羲', url: 'https://unapproved.invalid/not-fuxi' }];
  fuxi.source.primaryEntry = entryId; appId = fuxi.appId;
  const ordinary = await seedTagCatalog(harness.db, harness.config.audience, ['普通应用'], 811);
  ordinary.source.name = '普通应用联合测试';
  ordinary.source.entries = [{ id: entryId, kind: 'web', label: '打开应用', url: 'https://ordinary.example.invalid/' }];
  ordinary.source.primaryEntry = entryId;
  for (const seed of [fuxi, ordinary]) await harness.db.query('UPDATE published_snapshots SET manifest = $2::jsonb WHERE id = $1', [seed.snapshotId, JSON.stringify(seed.source)]);
  const policy = loadFuxiEntryPolicy({ PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: appId,
    PLAZA_FUXI_ENTRY_ID: entryId, PLAZA_FUXI_ORIGIN: fuxiOrigin, PLAZA_FUXI_MODE: 'portal-widget',
    PLAZA_FUXI_WIDGET_URL: `${portalOrigin}/fuxi-portal-widget.html`,
  }, { local: true, publicOrigin: harness.origin })!;
  harness.config.fuxiEntry = policy;

  // Playwright normally disables storage partitioning; undo that default and verify the actual command line.
  const probe = await chromium.launch({ channel, headless: true });
  const probePage = await probe.newPage(); await probePage.goto('chrome://version');
  const commandLine = await probePage.locator('#command_line').innerText();
  const disabled = (commandLine.match(/--disable-features=[^ ]+/g) || []).find(value => value.includes('ThirdPartyStoragePartitioning'));
  await probe.close();
  if (!disabled) throw new Error('无法确认 Playwright 存储分区默认开关');
  const filtered = `--disable-features=${disabled.slice('--disable-features='.length).split(',').filter(value => value !== 'ThirdPartyStoragePartitioning').join(',')}`;
  browser = await chromium.launch({ channel, headless: true, ignoreDefaultArgs: [disabled], args: [filtered, '--enable-features=ThirdPartyStoragePartitioning'] });
  const versionPage = await browser.newPage(); await versionPage.goto('chrome://version');
  const actual = await versionPage.locator('#command_line').innerText(); await versionPage.close();
  assert.ok(actual.includes('--enable-features=ThirdPartyStoragePartitioning'));
  assert.ok(!(actual.match(/--disable-features=[^ ]+/g) || []).join(',').includes('ThirdPartyStoragePartitioning'));

  const setup = await browser.newContext();
  const adminResponse = await setup.request.post(`${fuxiOrigin}/api/auth/login`, { data: { username: 'fixtureadmin', password: 'fixture-admin-pass' } });
  assert.equal(adminResponse.status(), 200);
  const adminToken = (await adminResponse.json()).data.token;
  const legacyLogin = () => setup.request.post(`${fuxiOrigin}/api/auth/login`, { data: { username: 'fixturelegacy', password: 'fixture-legacy-pass' } });
  const initial = await legacyLogin(); assert.equal(initial.status(), 200);
  const legacy = (await initial.json()).data;
  const headers = { authorization: `Bearer ${legacy.token}` };
  const project = await setup.request.post(`${fuxiOrigin}/api/projects`, { headers, data: { name: '合成旧项目' } });
  const prototype = await setup.request.post(`${fuxiOrigin}/api/prototypes`, { headers, data: { name: '合成旧原型' } });
  assert.equal(project.status(), 200); assert.equal(prototype.status(), 200);
  const projectId = (await project.json()).data.id, prototypeId = (await prototype.json()).data.id;
  for (const version of [1, 2]) {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from(`<!doctype html><html><body>synthetic version ${version}</body></html>`));
    const upload = await setup.request.post(`${fuxiOrigin}/api/prototypes/${prototypeId}/upload`, {
      headers, multipart: { file: { name: 'fixture.zip', mimeType: 'application/zip', buffer: zip.toBuffer() }, versionNote: `fixture ${version}`, versionType: 'patch' },
    });
    assert.equal(upload.status(), 200);
  }
  const binding = await setup.request.post(`${fuxiOrigin}/api/auth/users/${legacy.user.id}/external-identity`, {
    headers: { authorization: `Bearer ${adminToken}` },
    data: { provider: 'tiangong', tenantId: null, subject: '9007199254740997', confirmed: true, reason: '合成旧账号核验' },
  });
  assert.equal(binding.status(), 200);
  assert.equal((await legacyLogin()).status(), 200);
  await setup.close();

  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await browserContext.grantPermissions(['storage-access'], { origin: portalOrigin });
  let reads = 0, exchanges = 0;
  const violations: string[] = [], pageErrors: string[] = [], requestFailures: string[] = [];
  await browserContext.exposeFunction('__fixtureRecordRead', () => { reads++; });
  await browserContext.addInitScript(origin => {
    if (location.origin !== origin) return;
    (window as any).__fixtureClicks = [];
    document.addEventListener('click', event => {
      if ((event.target as HTMLElement)?.id === 'open-fuxi')
        (window as any).__fixtureClicks.push({ trusted: event.isTrusted, active: navigator.userActivation?.isActive });
    }, true);
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'sky-token') (window as any).__fixtureRecordRead();
      return original.call(this, key);
    };
  }, portalOrigin);
  browserContext.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  browserContext.on('requestfailed', request => requestFailures.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  await browserContext.route('**/*', route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() || '';
    if (url.href.includes('fixture-valid-')) violations.push('credential in URL');
    if (body.includes('fixture-valid-') && !(url.origin === fuxiOrigin && url.pathname === '/api/auth/tiangong/exchange')) violations.push('credential in unexpected body');
    if (url.origin === fuxiOrigin && url.pathname === '/api/auth/tiangong/exchange') exchanges++;
    if (url.origin === 'https://ordinary.example.invalid') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>普通应用</title>' });
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) { violations.push('non-fixture request'); return route.abort(); }
    return route.continue();
  });
  const seed = await browserContext.newPage(); await seed.goto(`${portalOrigin}/seed`);
  const seedCredential = (value: string) => seed.evaluate(value => localStorage.setItem('sky-token', value), value);
  await seedCredential(config.testTokens.validA);
  const plaza = await browserContext.newPage(); await plaza.goto(harness.origin);
  const card = plaza.getByTestId('app-card').filter({ hasText: fuxi.source.name });
  const cardWidget = card.frameLocator('[data-testid="fuxi-portal-widget"]');
  const button = cardWidget.locator('#open-fuxi');
  const check = async (name: string, operation: () => Promise<void>) => { await operation(); checks.push(name); console.log(`PASS ${name}`); };
  const enter = async (scope = cardWidget) => {
    const popup = browserContext.waitForEvent('page', { timeout: 10000 });
    await scope.locator('#open-fuxi').click();
    try { return await popup; }
    catch {
      const observation = await scope.locator('body').evaluate(() => ({ status: document.getElementById('status')?.textContent, clicks: (window as any).__fixtureClicks }));
      throw new Error(`伏羲窗口未打开；按钮状态：${JSON.stringify(observation)}`);
    }
  };
  const user = (page: Page) => page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!response.ok) throw new Error('合成用户身份读取失败');
    return (await response.json()).data;
  });
  if (process.env.PLAZA_WIDGET_HTTPS_ONLY !== '1') {
  await check('目录及非可信点击不读取凭证或打开伏羲', async () => {
    await button.waitFor(); await card.hover();
    const pages = browserContext.pages().length;
    await button.evaluate(element => (element as HTMLButtonElement).click());
    await plaza.waitForTimeout(250);
    assert.equal(browserContext.pages().length, pages); assert.equal(reads, 0); assert.equal(exchanges, 0);
  });
  await check('浏览器禁止存储访问时不打开伏羲且不读取凭证', async () => {
    const denied = await browserContext.newPage();
    const sandbox = await card.getByTestId('fuxi-portal-widget').getAttribute('sandbox');
    const deniedServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'permissions-policy': 'storage-access=()' });
      response.end(`<!doctype html><iframe id="denied-widget" sandbox="${sandbox}" allow="storage-access" src="${portalOrigin}/fuxi-portal-widget.html"></iframe>`);
    });
    await new Promise<void>((accept, reject) => { deniedServer.once('error', reject); deniedServer.listen(0, '127.0.0.1', accept); });
    try {
    const deniedResponse = await denied.goto(`http://127.0.0.1:${(deniedServer.address() as AddressInfo).port}/denied-widget`);
    assert.equal(deniedResponse?.status(), 200);
    assert.equal(await denied.locator('#denied-widget').count(), 1, `denial fixture document missing iframe: ${(await denied.locator('body').innerText()).slice(0, 100)}`);
    const deniedWidget = denied.frameLocator('#denied-widget');
    const before = reads, pages = browserContext.pages().length;
    try { await deniedWidget.locator('#open-fuxi').click({ timeout: 6000 }); }
    catch { throw new Error(`拒绝场景 iframe 未加载，页面状态：${JSON.stringify(denied.frames().map(frame => ({ url: frame.url(), name: frame.name() })))}；请求：${JSON.stringify(requestFailures)}`); }
    await deniedWidget.locator('#status').filter({ hasText: '未允许读取' }).waitFor({ state: 'attached', timeout: 10000 });
    assert.equal(reads, before); assert.equal(browserContext.pages().length, pages);
    } finally {
      await denied.close();
      await new Promise<void>(accept => deniedServer.close(() => accept()));
    }
  });
  await check('门户按钮页单独打开不能绕过广场开关', async () => {
    const direct = await browserContext.newPage(); await direct.goto(`${portalOrigin}/fuxi-portal-widget.html`);
    await direct.locator('#status').filter({ hasText: '请从天宫中的广场入口进入' }).waitFor({ state: 'attached' });
    assert.equal(await direct.locator('#open-fuxi').isDisabled(), true); assert.equal(reads, 0);
    await direct.close();
  });
  let first: Page;
  await check('卡片一次点击进入旧账号，旧密码、项目、原型与历史版本保持', async () => {
    first = await enter();
    try { await first.waitForURL(`${fuxiOrigin}/`, { timeout: 15000 }); }
    catch {
      const status = await cardWidget.locator('#status').textContent().catch(() => 'unavailable');
      const alerts = await first.getByRole('alert').allTextContents().catch(() => []);
      throw new Error(`接收页等待跳转超时：${JSON.stringify({ status, alerts, reads, exchanges, portalPolicyRequests, portalPolicyResponses, requestFailures, pageErrors })}`);
    }
    assert.equal((await user(first)).id, legacy.user.id);
    const assets = await first.evaluate(async ({ projectId, prototypeId }) => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
      const responses = await Promise.all([fetch(`/api/projects/${projectId}`, { headers }), fetch(`/api/prototypes/${prototypeId}`, { headers }), fetch(`/api/prototypes/${prototypeId}/versions`, { headers })]);
      const bodies = await Promise.all(responses.map(response => response.json()));
      return { statuses: responses.map(response => response.status), project: bodies[0].data.name, prototype: bodies[1].data.name, versions: bodies[2].data.map((item: any) => item.version_number) };
    }, { projectId, prototypeId });
    assert.deepEqual(assets, { statuses: [200, 200, 200], project: '合成旧项目', prototype: '合成旧原型', versions: [2, 1] });
    assert.equal(reads, 1); assert.equal(exchanges, 1);
  });
  if (process.env.PLAZA_WIDGET_FIRST_ONLY !== '1') {
  await check('详情重复进入同一账号无需额外确认', async () => {
    await card.getByRole('button', { name: `查看 ${fuxi.source.name} 详情`, exact: true }).click();
    // Element Plus animates the dialog wrapper; an iframe can move while its
    // inner element itself appears stable. Wait for that transition to settle.
    await plaza.getByRole('dialog').evaluate(async element => {
      const ancestors = [element, element.parentElement, element.parentElement?.parentElement].filter((item): item is HTMLElement => Boolean(item));
      const animations = ancestors.flatMap(item => item.getAnimations()).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    });
    const detailWidget = plaza.getByRole('dialog').frameLocator('[data-testid="fuxi-portal-widget"]');
    const popup = await enter(detailWidget); await popup.waitForURL(`${fuxiOrigin}/`, { timeout: 10000 });
    assert.equal((await user(popup)).id, legacy.user.id); assert.equal(reads, 2);
    await popup.close();
    const dialog = plaza.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Close this dialog' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await plaza.locator('.el-overlay:visible').waitFor({ state: 'hidden' });
  });
  await check('另一身份需确认，取消后旧会话不变', async () => {
    const oldToken = await first!.evaluate(() => localStorage.getItem('token'));
    await seedCredential(config.testTokens.validB);
    const popup = await enter();
    await popup.getByRole('button', { name: '保持当前账号', exact: true }).click();
    await popup.getByRole('alert').filter({ hasText: '已取消切换' }).waitFor();
    assert.equal(await popup.evaluate(() => localStorage.getItem('token')), oldToken);
    await popup.close();
  });
  await check('无效门户身份不能登录且保留原有伏羲会话', async () => {
    const oldToken = await first!.evaluate(() => localStorage.getItem('token'));
    await seedCredential(config.testTokens.invalid);
    const popup = await enter();
    await popup.getByRole('alert').filter({ hasText: '身份验证失败' }).waitFor();
    assert.equal(await popup.evaluate(() => localStorage.getItem('token')), oldToken);
    await popup.close();
  });
  await check('门户停用开关阻止已打开页面读取凭证', async () => {
    const before = reads; portalEnabled = false;
    const popup = await enter();
    await cardWidget.locator('#status').filter({ hasText: '入口已停用' }).waitFor({ state: 'attached', timeout: 15000 });
    await plaza.getByText('伏羲入口已停用或配置不符，请联系维护者。', { exact: true }).last().waitFor({ timeout: 6000 });
    assert.equal(reads, before); if (!popup.isClosed()) await popup.close(); portalEnabled = true;
  });
  await check('广场停用开关在交接前重新核对', async () => {
    const before = reads; harness.config.fuxiEntry = { ...policy, enabled: false };
    const popup = await enter();
    try { await cardWidget.locator('#status').filter({ hasText: '广场伏羲入口已停用' }).waitFor({ state: 'attached', timeout: 15000 }); }
    catch { throw new Error(`广场停用未得到预期响应：${await cardWidget.locator('#status').textContent()}`); }
    assert.equal(reads, before); if (!popup.isClosed()) await popup.close(); harness.config.fuxiEntry = policy;
  });
  await check('普通外链不交接身份且保留 noopener', async () => {
    const before = reads, callCount = exchanges;
    const link = plaza.getByTestId('app-card').filter({ hasText: ordinary.source.name }).getByTestId('open-platform');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const opened = browserContext.waitForEvent('page'); await link.click();
    const popup = await opened; await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => window.opener), null); assert.equal(reads, before); assert.equal(exchanges, callCount);
    await popup.close();
  });
  await check('广场存储、网络与运行日志不包含天宫凭证', async () => {
    assert.deepEqual(violations, []); assert.deepEqual(pageErrors, []);
    assert.ok((await plaza.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)])).every(value => !String(value).includes('fixture-valid-')));
    const runtimeLog = fixtureLog.split(/\r?\n/).filter(line => !line.startsWith('{"fixture":true,')).join('\n');
    assert.ok(!runtimeLog.includes('fixture-valid-'));
  });
  }
  console.log(JSON.stringify({ fixture: true, browser: channel, partitioningEnabled: true,
    storagePermissionGrantedForTest: true, checks: checks.length, violations: violations.length }));
  }
  await browserContext.close();
  if (process.env.PLAZA_WIDGET_FIRST_ONLY !== '1') {

  // Different synthetic HTTPS sites, with the real plaza page and portal widget.
  // Only the Fuxi receiver is synthetic here; the previous checks use real Fuxi code.
  const sitePortal = 'https://portal-fixture.test', sitePlaza = 'https://plaza-fixture.test', siteFuxi = 'https://fuxi-fixture.test';
  harness.config.fuxiEntry = loadFuxiEntryPolicy({ PLAZA_FUXI_ENABLED: '1', PLAZA_FUXI_APP_ID: appId,
    PLAZA_FUXI_ENTRY_ID: entryId, PLAZA_FUXI_ORIGIN: siteFuxi, PLAZA_FUXI_MODE: 'portal-widget',
    PLAZA_FUXI_WIDGET_URL: `${sitePortal}/fuxi-portal-widget.html`,
  }, { local: false, publicOrigin: sitePlaza });
  const siteContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await siteContext.grantPermissions(['storage-access'], { origin: sitePortal });
  let siteReads = 0; const siteViolations: string[] = [], siteResponses: string[] = [];
  await siteContext.exposeFunction('__fixtureSiteRead', () => { siteReads++; });
  await siteContext.addInitScript(origin => {
    if (location.origin !== origin) return;
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'sky-token') (window as any).__fixtureSiteRead();
      return original.call(this, key);
    };
  }, sitePortal);
  await siteContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.href.includes('fixture-valid-a') || (request.postData() || '').includes('fixture-valid-a')) siteViolations.push('credential in network');
    const send = (contentType: string, body: string) => route.fulfill({ status: 200, contentType, body, headers: { 'cache-control': 'no-store' } });
    if (url.origin === sitePortal && url.pathname === '/seed') return send('text/html', '<!doctype html><title>portal seed</title>');
    if (url.origin === sitePortal && url.pathname === '/parent') return send('text/html', `<!doctype html><iframe id="plaza" src="${sitePlaza}/" allow="storage-access" style="width:1400px;height:900px"></iframe>`);
    if (url.origin === sitePortal && url.pathname === '/fuxi-portal-widget.html') return send('text/html', html);
    if (url.origin === sitePortal && url.pathname === '/fuxi-portal-widget.js') return send('text/javascript', js);
    if (url.origin === sitePortal && url.pathname === '/fuxi-portal-widget.css') return send('text/css', css);
    if (url.origin === sitePortal && url.pathname === '/fuxi-widget-test-policy.json') return send('application/json',
      JSON.stringify({ enabled: true, portalOrigin: sitePortal, plazaOrigin: sitePlaza, fuxiOrigin: siteFuxi, appId, entryId }));
    if (url.origin === sitePlaza) {
      // This in-memory HTTPS fixture forwards to the loopback backend; adapt
      // Host/Origin only inside the test proxy to satisfy its local checks.
      const headers: Record<string, string> = { ...request.headers(), host: new URL(harness.origin).host };
      if (headers.origin) headers.origin = harness.origin;
      const response = await route.fetch({ url: `${harness.origin}${url.pathname}${url.search}`, headers });
      siteResponses.push(`${url.pathname}: ${response.status()}`);
      return route.fulfill({ response });
    }
    if (url.origin === siteFuxi && url.pathname === '/auth/tiangong') return send('text/html', `<!doctype html><p id="result">waiting</p><script>
      const sourceWindow=window.opener;
      window.addEventListener('message',event=>{
        if(event.source!==sourceWindow||event.origin!==${JSON.stringify(sitePortal)}||event.data?.type!=='fuxi:tiangong:login'||event.data.requestId!=='synthetic-request')return;
        document.getElementById('result').textContent=event.data.token==='fixture-valid-a'?'accepted':'rejected';
      });
      sourceWindow.postMessage({type:'fuxi:tiangong:ready',requestId:'synthetic-request'},${JSON.stringify(sitePortal)});
    </script>`);
    siteViolations.push('unexpected network'); return route.abort();
  });
  const siteSeed = await siteContext.newPage(); await siteSeed.goto(`${sitePortal}/seed`);
  await siteSeed.evaluate(() => localStorage.setItem('sky-token', 'fixture-valid-a'));
  const hostPage = await siteContext.newPage(); await hostPage.goto(`${sitePortal}/parent`);
  const plazaFrame = hostPage.frameLocator('#plaza');
  const siteCard = plazaFrame.getByTestId('app-card').filter({ hasText: fuxi.source.name });
  const siteButton = siteCard.frameLocator('[data-testid="fuxi-portal-widget"]').locator('#open-fuxi');
  try { await siteButton.waitFor({ timeout: 8000 }); }
  catch {
    const frames = await Promise.all(hostPage.frames().map(async frame => ({ url: frame.url(),
      text: (await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(0, 100) })));
    throw new Error(`合成 HTTPS 页面未就绪：${JSON.stringify({ frames, responses: siteResponses, violations: siteViolations })}`);
  }
  const pagesBefore = siteContext.pages().length;
  await siteButton.evaluate(element => (element as HTMLButtonElement).click()); await hostPage.waitForTimeout(250);
  assert.equal(siteReads, 0); assert.equal(siteContext.pages().length, pagesBefore);
  const sitePopupPromise = siteContext.waitForEvent('page', { timeout: 10000 }); await siteButton.click();
  const sitePopup = await sitePopupPromise;
  await sitePopup.locator('#result').filter({ hasText: 'accepted' }).waitFor({ timeout: 6000 });
  assert.equal(siteReads, 1); assert.deepEqual(siteViolations, []);
  console.log(`PASS 合成跨站 HTTPS 门户→真实广场页面→门户按钮一次点击 (${channel})`);
  console.log(JSON.stringify({ syntheticHttps: true, realPlazaPage: true, syntheticFuxiReceiver: true,
    partitioningEnabled: true, storagePermissionGrantedForTest: true, violations: siteViolations.length }));
  await siteContext.close();
  }
} finally {
  await browser?.close();
  if (fixture && fixture.exitCode === null) {
    const stopped = new Promise<void>(accept => fixture!.once('exit', () => accept()));
    fixture.stdin.write('stop\n');
    await Promise.race([stopped, new Promise<void>(accept => setTimeout(() => { fixture?.kill(); accept(); }, 5000))]);
  }
  await new Promise<void>(accept => portalServer.close(() => accept()));
  await harness.close();
}
