import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, delimiter } from 'node:path';
import { chromium, type Page } from 'playwright';
import { startHarness } from './helpers/harness.js';
import { seedTagCatalog } from './helpers/tag-catalog.js';
import { loadFuxiEntryPolicy } from '../server/fuxi-entry.js';

const fixtureRoot=process.env.PLAZA_FUXI_FIXTURE_ROOT;
if(!fixtureRoot)throw new Error('Specify the isolated Fuxi fixture source');
const evidence=resolve(process.env.PLAZA_BRIDGE_REPORT_DIR||'artifacts/portal-parent');await mkdir(evidence,{recursive:true});
const moduleDir=resolve(fixtureRoot,'backend/node_modules');
const requireFuxi=createRequire(resolve(moduleDir,'_fixture.cjs'));const AdmZip=requireFuxi('adm-zip');
const rootScript=await readFile('ops/integration/tiangong-bridge/portal-auth-bridge.js','utf8');
const rootHtml=await readFile('ops/integration/tiangong-bridge/fuxi-plaza.html','utf8');
const rootCss=await readFile('ops/integration/tiangong-bridge/fuxi-plaza.css','utf8');
const bridgeHashes=()=>({script:createHash('sha256').update(rootScript).digest('hex'),html:createHash('sha256').update(rootHtml).digest('hex'),css:createHash('sha256').update(rootCss).digest('hex')});
const initialBridgeHashes=bridgeHashes();
const harness=await startHarness();
let portalOrigin='',fuxiOrigin='',appId='',portalEnabled=true;
let fixture:any,fixtureLog='',policy:any,legacy:any,projectId='',prototypeId='';
const outcomes:any[]=[];
const progress=async()=>writeFile(resolve(evidence,'e2e-progress.json'),JSON.stringify({status:'RUNNING',outcomes},null,2)+'\n');
const server=createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');const url=new URL(request.url||'/',portalOrigin);
  if(url.pathname==='/portal'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe id="wrapper" src="/fuxi-plaza.html"></iframe>');return;}
  if(url.pathname==='/seed'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>synthetic first-party session</title>');return;}
  if(url.pathname==='/fuxi-plaza.html'){
    response.setHeader('Content-Type','text/html');response.setHeader('Content-Security-Policy',`default-src 'none';script-src 'self';connect-src 'self';style-src 'self';frame-src ${harness.origin};base-uri 'none';form-action 'none';frame-ancestors 'self'`);
    response.end(rootHtml.replace('https://192.168.2.145:16490/',harness.origin+'/'));return;
  }
  if(url.pathname==='/portal-auth-bridge.js'){response.setHeader('Content-Type','text/javascript');response.end(rootScript);return;}
  if(url.pathname==='/fuxi-plaza.css'){response.setHeader('Content-Type','text/css');response.end(rootCss);return;}
  if(url.pathname==='/fuxi-widget-test-policy.json'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:portalEnabled,portalOrigin,plazaOrigin:harness.origin,fuxiOrigin,appId,entryId:'web'}));return;}
  response.writeHead(404).end();
});
async function launchBrowser(channel:string){
  const probe=await chromium.launch({channel,headless:true});const page=await probe.newPage();await page.goto(channel==='msedge'?'edge://version':'chrome://version');const command=await page.locator('#command_line').innerText();await probe.close();
  const disabled=(command.match(/--disable-features=[^ ]+/g)||[]).find(value=>value.includes('ThirdPartyStoragePartitioning'));
  const args=['--enable-features=ThirdPartyStoragePartitioning'];if(disabled)args.push('--disable-features='+disabled.slice('--disable-features='.length).split(',').filter(value=>value!=='ThirdPartyStoragePartitioning').join(','));
  const browser=await chromium.launch({channel,headless:true,ignoreDefaultArgs:['--disable-popup-blocking',...(disabled?[disabled]:[])],args});
  const version=await browser.newPage();await version.goto(channel==='msedge'?'edge://version':'chrome://version');const actual=await version.locator('#command_line').innerText();await version.close();
  assert(!actual.includes('--disable-popup-blocking'));assert(actual.includes('--enable-features=ThirdPartyStoragePartitioning'));return browser;
}
const me=(page:Page)=>page.evaluate(async()=>{const response=await fetch('/api/auth/me',{headers:{Authorization:`Bearer ${localStorage.getItem('token')}`}});if(!response.ok)throw new Error('fixture identity unavailable');return(await response.json()).data;});
async function run(channel:string,uiVersion:string,full:boolean,config:any){
  const browser=await launchBrowser(channel);const context=await browser.newContext({viewport:{width:1440,height:900}});
  let reads=0,exchanges=0;const violations:string[]=[];const pageErrors:string[]=[];const checks:string[]=[];
  try{
    await context.exposeFunction('__bridgeRead',()=>{reads++;});
    await context.exposeFunction('__bridgeLeak',()=>{violations.push('credential message reached plaza');});
    await context.addInitScript(({portal,plaza})=>{
      if(location.origin===portal){const original=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key==='sky-token')(window as any).__bridgeRead();return original.call(this,key);};}
      if(location.origin===plaza)addEventListener('message',event=>{if(JSON.stringify(event.data).includes('fixture-valid-'))(window as any).__bridgeLeak();});
    },{portal:portalOrigin,plaza:harness.origin});
    context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
    await context.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url()),body=request.postData()||'';
      if(url.href.includes('fixture-valid-'))violations.push('credential in URL');
      if(body.includes('fixture-valid-')&&!(url.origin===fuxiOrigin&&url.pathname==='/api/auth/tiangong/exchange'))violations.push('credential sent outside Fuxi exchange');
      if(url.origin===fuxiOrigin&&url.pathname==='/api/auth/tiangong/exchange')exchanges++;
      if(url.origin==='https://ordinary.example.invalid')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>ordinary fixture</title>'});
      if(![portalOrigin,harness.origin,fuxiOrigin].includes(url.origin)){violations.push('non-fixture network');return route.abort();}
      return route.continue();
    });
    const seed=await context.newPage();await seed.goto(portalOrigin+'/seed');await seed.evaluate(value=>localStorage.setItem('sky-token',value),config.testTokens.validA);await seed.close();
    assert(!(await context.storageState()).origins.some(item=>item.origin===fuxiOrigin));
    const shell=await context.newPage();await shell.goto(portalOrigin+'/portal');
    const plaza=shell.frameLocator('#wrapper').frameLocator('iframe');
    const card=plaza.getByTestId('app-card').filter({hasText:'伏羲解耦联合测试'});
    const button=card.getByTestId('open-platform');await button.waitFor({state:'visible'});
    for(let i=0;i<100&&!await button.isEnabled();i++)await shell.waitForTimeout(100);
    assert(await button.isEnabled(),'bridge discovery did not complete');
    assert.equal(await card.locator('iframe').count(),0);assert.equal(reads,0);assert.equal(exchanges,0);checks.push('native_plaza_button_no_iframe_no_preclick_credential_read');
    const normal=plaza.getByTestId('app-card').filter({hasText:'普通平台解耦对照'}).getByTestId('open-platform');
    const a=await button.boundingBox(),b=await normal.boundingBox();assert(Math.abs(a!.width-b!.width)<0.1&&Math.abs(a!.height-b!.height)<0.1);checks.push('same_shared_button_dimensions');
    const enter=async(target=button)=>{const opened=context.waitForEvent('page',{timeout:10000});await target.click();return opened;};
    const first=await enter();await first.waitForURL(fuxiOrigin+'/',{timeout:20000});assert.equal((await me(first)).id,legacy.user.id);assert.equal(reads,1);assert.equal(exchanges,1);checks.push('fresh_context_one_click_same_bound_legacy_account');
    const assets=await first.evaluate(async({projectId,prototypeId})=>{
      const headers={Authorization:`Bearer ${localStorage.getItem('token')}`};
      const responses=await Promise.all([fetch(`/api/projects/${projectId}`,{headers}),fetch(`/api/prototypes/${prototypeId}`,{headers}),fetch(`/api/prototypes/${prototypeId}/versions`,{headers})]);
      const bodies=await Promise.all(responses.map(response=>response.json()));return{statuses:responses.map(response=>response.status),project:bodies[0].data.name,prototype:bodies[1].data.name,versions:bodies[2].data.map((item:any)=>item.version_number)};
    },{projectId,prototypeId});
    assert.deepEqual(assets,{statuses:[200,200,200],project:'解耦合成旧项目',prototype:'解耦合成旧原型',versions:[2,1]});checks.push('legacy_project_prototype_and_two_version_records_preserved');
    const password=await context.request.post(fuxiOrigin+'/api/auth/login',{data:{username:'fixturelegacy',password:'fixture-legacy-pass'}});assert.equal(password.status(),200);assert.equal((await password.json()).data.user.id,legacy.user.id);checks.push('original_password_same_account_after_sso');
    await shell.screenshot({path:resolve(evidence,`${channel}-${uiVersion}-plaza.png`)});
    if(full){
      await card.getByRole('button',{name:'查看 伏羲解耦联合测试 详情',exact:true}).click();
      const dialog=plaza.getByRole('dialog');const detail=dialog.getByTestId('use-web');for(let i=0;i<50&&!await detail.isEnabled();i++)await shell.waitForTimeout(100);
      const again=await enter(detail);await again.waitForURL(fuxiOrigin+'/',{timeout:15000});assert.equal((await me(again)).id,legacy.user.id);await again.close();await dialog.getByRole('button',{name:'Close this dialog'}).click();await dialog.waitFor({state:'hidden'});checks.push('detail_entry_and_repeat_same_account');
      const oldToken=await first.evaluate(()=>localStorage.getItem('token'));
      const setCredential=async(value:string)=>{const seed=await context.newPage();await seed.goto(portalOrigin+'/seed');await seed.evaluate(value=>localStorage.setItem('sky-token',value),value);await seed.close();};
      await setCredential(config.testTokens.validB);const other=await enter();await other.getByRole('button',{name:'保持当前账号',exact:true}).click();await other.getByRole('alert').filter({hasText:'已取消切换'}).waitFor();assert.equal(await other.evaluate(()=>localStorage.getItem('token')),oldToken);await other.close();checks.push('other_identity_cancel_preserves_old_session');
      await setCredential(config.testTokens.invalid);const invalid=await enter();await invalid.getByRole('alert').filter({hasText:'身份验证失败'}).waitFor();assert.equal(await invalid.evaluate(()=>localStorage.getItem('token')),oldToken);await invalid.close();checks.push('invalid_identity_rejected_preserves_session');
      await setCredential(config.testTokens.validA);
      let before=reads;portalEnabled=false;const stopped=await enter();await plaza.getByText('入口已停用或配置发生变化，请重新进入。',{exact:true}).last().waitFor();assert.equal(reads,before);if(!stopped.isClosed())await stopped.close();portalEnabled=true;checks.push('portal_disable_prevents_credential_read');
      before=reads;harness.config.fuxiEntry={...policy,enabled:false};const disabled=await enter();await plaza.getByText('入口已停用或配置发生变化，请重新进入。',{exact:true}).last().waitFor();assert.equal(reads,before);if(!disabled.isClosed())await disabled.close();harness.config.fuxiEntry=policy;checks.push('plaza_disable_rechecked_before_credential_read');
      const oldReads=reads,oldExchanges=exchanges;const opened=context.waitForEvent('page');await normal.click();const ordinary=await opened;await ordinary.waitForLoadState();assert.equal(await ordinary.evaluate(()=>window.opener),null);assert.equal(reads,oldReads);assert.equal(exchanges,oldExchanges);await ordinary.close();checks.push('ordinary_platform_link_unchanged_no_identity_handoff');
    }
    const localStore=await card.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)]);assert(localStore.every(value=>!String(value).includes('fixture-valid-')));
    assert.deepEqual(violations,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(bridgeHashes(),initialBridgeHashes);checks.push('no_portal_token_in_plaza_network_messages_or_storage');
    outcomes.push({channel,uiVersion,checks,normalPopupBlocking:true,storagePartitioningEnabled:true,storageAccessPermissionGranted:false,realFuxiBackendAndFrontend:true,realCredentialsUsed:false,freshFuxiBrowserContext:true,bridgeHashes:initialBridgeHashes,ordinaryAndAuthenticatedButtonWidth:a!.width,credentialReads:reads,exchangeAttempts:exchanges});await progress();console.log(`PASS ${channel} ${uiVersion}: ${checks.length} checks`);
  }finally{harness.config.fuxiEntry=policy;portalEnabled=true;await context.close();await browser.close();}
}

const uiContent='src/components/platform-open-button.content.html',uiStyle='src/styles/platform-open-button.css';
const originalContent=await readFile(uiContent),originalStyle=await readFile(uiStyle);
let mutated=false;
const build=async(label:string)=>{const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:120000});await writeFile(resolve(evidence,`build-${label}.log`),result.stdout+result.stderr);assert.equal(result.status,0,`local ${label} build failed`);};
try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));portalOrigin=`http://localhost:${(server.address()as AddressInfo).port}`;
  fixture=spawn(process.execPath,['backend/tests/fixtures/tiangong-browser-server.js'],{cwd:fixtureRoot,env:{...process.env,NODE_PATH:[moduleDir,process.env.NODE_PATH].filter(Boolean).join(delimiter),FUXI_TIANGONG_FIXTURE_PLAZA_ORIGINS:portalOrigin},stdio:['pipe','pipe','pipe'],windowsHide:true});
  fixture.stderr.on('data',(chunk:any)=>{fixtureLog+=String(chunk);});fixture.stdout.on('data',(chunk:any)=>{fixtureLog+=String(chunk);});
  const config=await new Promise<any>((accept,reject)=>{let output='';const timeout=setTimeout(()=>reject(new Error('isolated Fuxi fixture startup timeout')),25000);fixture.stdout.on('data',(chunk:any)=>{output+=String(chunk);const line=output.split(/\r?\n/).find(value=>value.startsWith('{"fixture":true,'));if(line){clearTimeout(timeout);accept(JSON.parse(line));}});fixture.once('error',reject);fixture.once('exit',(code:any)=>{clearTimeout(timeout);reject(new Error('isolated fixture exited '+code));});});
  assert(config.fixture);fuxiOrigin=config.fuxiOrigin;assert.equal(new URL(fuxiOrigin).hostname,'127.0.0.1');
  const fuxi=await seedTagCatalog(harness.db,harness.config.audience,['原型制作'],930),ordinary=await seedTagCatalog(harness.db,harness.config.audience,['平台'],931);appId=fuxi.appId;fuxi.source.name='伏羲解耦联合测试';ordinary.source.name='普通平台解耦对照';
  for(const item of [fuxi,ordinary]){item.source.entries=[{id:'web',kind:'web',label:'打开平台',url:'https://ordinary.example.invalid/'}];item.source.primaryEntry='web';await harness.db.query('UPDATE published_snapshots SET manifest=$2::jsonb WHERE id=$1',[item.snapshotId,JSON.stringify(item.source)]);}
  policy=loadFuxiEntryPolicy({PLAZA_FUXI_ENABLED:'1',PLAZA_FUXI_APP_ID:appId,PLAZA_FUXI_ENTRY_ID:'web',PLAZA_FUXI_ORIGIN:fuxiOrigin,PLAZA_FUXI_MODE:'portal-parent',PLAZA_FUXI_PORTAL_ORIGIN:portalOrigin},{local:true,publicOrigin:harness.origin});harness.config.fuxiEntry=policy;
  const setup=await chromium.launch({channel:'chrome',headless:true});const api=await setup.newContext();
  const login=await api.request.post(fuxiOrigin+'/api/auth/login',{data:{username:'fixtureadmin',password:'fixture-admin-pass'}});assert.equal(login.status(),200);const admin=(await login.json()).data.token;
  const original=await api.request.post(fuxiOrigin+'/api/auth/login',{data:{username:'fixturelegacy',password:'fixture-legacy-pass'}});assert.equal(original.status(),200);legacy=(await original.json()).data;const headers={Authorization:`Bearer ${legacy.token}`};
  const project=await api.request.post(fuxiOrigin+'/api/projects',{headers,data:{name:'解耦合成旧项目'}}),prototype=await api.request.post(fuxiOrigin+'/api/prototypes',{headers,data:{name:'解耦合成旧原型'}});assert.equal(project.status(),200);assert.equal(prototype.status(),200);projectId=(await project.json()).data.id;prototypeId=(await prototype.json()).data.id;
  for(const version of [1,2]){const zip=new AdmZip();zip.addFile('index.html',Buffer.from(`<!doctype html><body>synthetic original version ${version}</body>`));const response=await api.request.post(`${fuxiOrigin}/api/prototypes/${prototypeId}/upload`,{headers,multipart:{file:{name:'fixture.zip',mimeType:'application/zip',buffer:zip.toBuffer()},versionNote:`fixture ${version}`,versionType:'patch'}});assert.equal(response.status(),200);}
  const binding=await api.request.post(`${fuxiOrigin}/api/auth/users/${legacy.user.id}/external-identity`,{headers:{Authorization:`Bearer ${admin}`},data:{provider:'tiangong',subject:'9007199254740997',tenantId:null,confirmed:true,reason:'本地解耦夹具的合成旧账号'}});assert.equal(binding.status(),200);await api.close();await setup.close();
  const beforeIndex=createHash('sha256').update(await readFile('dist/index.html')).digest('hex');
  for(const channel of ['chrome','msedge'])await run(channel,'v1',true,config);
  await writeFile(uiContent,originalContent.toString().replace('打开平台','打开工作台'));await writeFile(uiStyle,originalStyle.toString().replace('padding: 5px 9px','padding: 5px 13px'));mutated=true;await build('ui-v2');
  assert.notEqual(createHash('sha256').update(await readFile('dist/index.html')).digest('hex'),beforeIndex);
  for(const [name,key] of Object.entries({ 'portal-auth-bridge.js':'script','fuxi-plaza.html':'html','fuxi-plaza.css':'css'} as const))assert.equal(createHash('sha256').update(await readFile('ops/integration/tiangong-bridge/'+name)).digest('hex'),initialBridgeHashes[key]);
  for(const channel of ['chrome','msedge'])await run(channel,'v2',false,config);
  await writeFile(uiContent,originalContent);await writeFile(uiStyle,originalStyle);mutated=false;await build('restored-v1');assert.equal(createHash('sha256').update(await readFile('dist/index.html')).digest('hex'),beforeIndex);
  const runtime=fixtureLog.split(/\r?\n/).filter(line=>!line.startsWith('{"fixture":true,')).join('\n');assert(!runtime.includes('fixture-valid-'));
  const receipt={status:'PASS',localOnly:true,productionWrites:0,realCredentialsUsed:false,realFuxiFixtureCodeCommit:'2fe1a344159971b49003e6b8aded4dcf4a95c7c3',uiOnlyChangeRetestedAgainstIdenticalPortalBridge:true,portalBridgeFilesUnchanged:true,finalUiSourceRestored:true,normalPopupBlocking:true,storagePartitioningEnabled:true,storageAccessPermissionGranted:false,productionHttpsAndCompanyPolicyNotTested:true,outcomes};await writeFile(resolve(evidence,'portal-parent-browser.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:'PASS',runs:outcomes.length,checks:outcomes.reduce((sum,item)=>sum+item.checks.length,0),bridgeHashes:initialBridgeHashes,productionWrites:0}));
}finally{
  if(mutated){await writeFile(uiContent,originalContent);await writeFile(uiStyle,originalStyle);}
  if(fixture&&fixture.exitCode===null){fixture.stdin.write('stop\n');await new Promise<void>(resolve=>{fixture.once('exit',()=>resolve());setTimeout(resolve,10000);});}
  await new Promise<void>(resolve=>server.close(()=>resolve()));await harness.close();
}
