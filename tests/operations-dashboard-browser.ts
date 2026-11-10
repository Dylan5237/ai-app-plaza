import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The real page is mounted alone: routing and credentials belong to the paired integration.
await mkdir('artifacts', {recursive:true});
await writeFile('artifacts/operations-dashboard-harness.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="app" class="plaza-public"></div><script type="module">import {createApp} from '/node_modules/vue/dist/vue.esm-bundler.js'; import Dashboard from '/src/pages/OperationsDashboard.vue'; import '/src/styles/design-tokens.css'; createApp(Dashboard).mount('#app')</script></html>`);
const server = await createServer({root:resolve('.'),server:{host:'127.0.0.1',port:0,strictPort:false}});
await server.listen();
const address=server.httpServer?.address();
if(!address || typeof address==='string') throw new Error('Vite did not bind a test port');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL as any } : {}) });
const page=await browser.newPage({viewport:{width:1440,height:1000}});
let deny=false;
const data={ status:'available',period:'30d',start:'2026-11-01T00:00:00.000Z',end:'2026-11-09T04:00:00.000Z',collectionStart:'2026-11-01T00:00:00.000Z',partial:true,appScopeAvailable:true,
  summary:{discoverySessions:10,usageSessions:4,discoveryVisitors:8,sessionOnly:2,searches:null,emptySearches:null,webActions:3,agentActions:2},
  days:[{day:'2026-11-03',discoverySessions:6,usageSessions:2},{day:'2026-11-08',discoverySessions:4,usageSessions:2}],
  apps:[{id:'11111111-1111-4111-8111-111111111111',name:'测试公开应用',exposure:12,details:4,webSessions:3,agentSessions:0}],
  supply:{available:1,newApps:0,updates:1},retention:null };
await page.route('**/api/operations/dashboard?*', async route => {
  if(deny) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{message:'管理员权限已失效',code:'PERMISSION_DENIED'}})});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...data,period:new URL(route.request().url()).searchParams.get('period')})});
});
try {
  await page.goto(`http://127.0.0.1:${address.port}/artifacts/operations-dashboard-harness.html`);
  await page.getByRole('heading',{name:'看见应用的发现与增长'}).waitFor();
  await page.getByText('测试公开应用').waitFor();
  await page.screenshot({path:'artifacts/operations-dashboard-desktop.png',fullPage:true});
  assert.equal(await page.getByText('搜索和筛选的结果范围无法区分，首次发现不完整，暂不计算留存。').count(),1);
  const changed=page.waitForResponse(response=>response.url().includes('/api/operations/dashboard?period=7d') && response.ok());
  await page.getByRole('button',{name:'近 7 天'}).click();
  await changed;
  await page.waitForFunction(()=>document.querySelector('[aria-label="统计时间范围"] button[aria-pressed="true"]')?.textContent?.includes('7'));
  assert.equal(await page.getByText('测试公开应用').count(),1);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile page must not overflow horizontally');
  await page.screenshot({path:'artifacts/operations-dashboard-mobile.png',fullPage:true});
  deny=true;
  await page.getByRole('button',{name:'近 90 天'}).click();
  await page.getByText('管理员权限已失效').waitFor();
  assert.equal(await page.getByText('测试公开应用').count(),0,'access loss clears prior data');
  process.stdout.write('运营看板浏览器检查通过：范围切换、指标不可计算、小屏和权限失效清除。\n');
} finally { await browser.close(); await server.close(); }
