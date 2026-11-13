import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

// The real page is mounted alone: routing and credentials belong to the paired integration.
// The harness is prebuilt and served statically because on-demand dev-server transforms
// can stall for minutes on this host, making page loads flaky.
const harnessRoot = resolve('artifacts/operations-harness');
await mkdir(harnessRoot, { recursive: true });
await writeFile(join(harnessRoot, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="app" class="plaza-public"></div><script type="module" src="./entry.ts"></script></html>`);
await writeFile(join(harnessRoot, 'entry.ts'), `import { createApp } from 'vue'\nimport Dashboard from '../../src/pages/OperationsDashboard.vue'\nimport '../../src/styles/design-tokens.css'\ncreateApp(Dashboard).mount('#app')\n`);
await build({ root: resolve('.'), configFile: false, logLevel: 'error', plugins: [vue()], base: './',
  build: { outDir: join(harnessRoot, 'dist'), emptyOutDir: true, rollupOptions: { input: join(harnessRoot, 'index.html') } } });
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url || '/').split('?')[0]);
  try {
    // The build mirrors the input path under outDir; assets stay at the dist root.
    const body = await readFile(join(harnessRoot, 'dist', (path === '/' ? '/artifacts/operations-harness/index.html' : path).replace(/^\/+/, '')));
    response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('static harness did not bind a port');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let deny=false;
let fail=false;
let releaseRefresh: (() => void) | undefined;
let refreshGate: Promise<void> | undefined;
const data={ status:'available',period:'30d',start:'2026-11-01T00:00:00.000Z',end:'2026-11-09T04:00:00.000Z',collectionStart:'2026-11-01T00:00:00.000Z',partial:true,appScopeAvailable:true,
  summary:{discoverySessions:10,usageSessions:4,discoveryVisitors:8,sessionOnly:2,searches:24,emptySearches:3,aiSearches:18,followUpSearches:4,questionSearches:5,webActions:3,agentActions:2},
  days:[{day:'2026-11-03',discoverySessions:6,usageSessions:2},{day:'2026-11-08',discoverySessions:4,usageSessions:2}],
  apps:[{id:'11111111-1111-4111-8111-111111111111',name:'测试公开应用',exposure:12,details:4,webSessions:3,agentSessions:0}],
  supply:{available:1,newApps:0,updates:1},retention:null };
await page.route('**/api/operations/dashboard?*', async route => {
  if (refreshGate) await refreshGate;
  if(deny) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{message:'管理员权限已失效',code:'PERMISSION_DENIED'}})});
  if(fail) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'看板服务暂不可用',code:'SERVICE_UNAVAILABLE'}})});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...data,period:new URL(route.request().url()).searchParams.get('period')})});
});
try {
  await page.goto(`http://127.0.0.1:${address.port}/artifacts/operations-harness/index.html`);
  await page.getByRole('heading',{name:'看见应用的发现与增长'}).waitFor();
  await page.getByText('测试公开应用').waitFor();
  await page.screenshot({path:'artifacts/operations-dashboard-desktop.png',fullPage:true});
  assert.equal(await page.getByText('搜索和筛选的结果范围无法区分，首次发现不完整，暂不计算留存。').count(),1);
  const changed=page.waitForResponse(response=>response.url().includes('/api/operations/dashboard?period=7d') && response.ok());
  await page.getByRole('button',{name:'近 7 天'}).click();
  await changed;
  await page.waitForFunction(()=>document.querySelector('[aria-label="统计时间范围"] button[aria-pressed="true"]')?.textContent?.includes('7'));
  assert.equal(await page.getByText('测试公开应用').count(),1);
  refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.getByText('更新中…', {exact:true}).waitFor();
  assert.equal(await page.getByText('测试公开应用').count(),1,'refresh keeps the loaded dashboard');
  fail=true; releaseRefresh!(); refreshGate=undefined;
  await page.getByText('看板服务暂不可用', {exact:true}).waitFor();
  assert.equal(await page.getByText('测试公开应用').count(),1,'transient failure keeps the last successful result');
  fail=false;
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.legend').isVisible(),true,'mobile retains the named trend series');
  assert.ok((await page.locator('.legend').boundingBox())!.height <= 36,'legend labels remain readable instead of wrapping one character per line');
  assert.ok(await page.locator('.chart polyline').nth(1).getAttribute('stroke-dasharray'),'the second series has a non-color distinction');
  assert.equal(new Set(await page.locator('.legend i').evaluateAll((marks: Element[]) => marks.map(mark => getComputedStyle(mark).borderTopStyle))).size,2,'legend markers map each series through a distinct line pattern');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile page must not overflow horizontally');
  await page.screenshot({path:'artifacts/operations-dashboard-mobile.png',fullPage:true});
  deny=true;
  await page.getByRole('button',{name:'近 90 天'}).click();
  await page.getByText('管理员权限已失效').waitFor();
  assert.equal(await page.getByText('测试公开应用').count(),0,'access loss clears prior data');
  process.stdout.write('运营看板浏览器检查通过：范围切换、指标不可计算、小屏和权限失效清除。\n');
} finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
