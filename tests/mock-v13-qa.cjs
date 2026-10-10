const {chromium}=require('playwright');
const fs=require('fs'),http=require('http'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../dist'),html=fs.readFileSync(path.join(root,'portal.html'),'utf8');
const data=id=>JSON.parse(html.match(new RegExp('<script type="application/json" id="'+id+'">([\\s\\S]*?)</script>'))[1]);
const apps=data('pt-data'),metadata=new Map(data('pt-project-metadata').projects.map(m=>[m.id,m]));
const report={status:'RUNNING',views:[],errors:[],externalRequests:[]};
const assert=(v,m)=>{if(!v)throw Error(m)};
const server=http.createServer((req,res)=>{const file=path.resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();res.setHeader('content-type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res)});
async function detail(frame,id){for(let n=1;n<=3;n++){await frame.locator(`[data-page="${n}"]`).click();const b=frame.locator(`#pt-tools [data-open="${id}"]`).first();if(await b.count()){await b.click();return}}throw Error('Missing '+id)}
async function dimensions(frame){return frame.evaluate(()=>{const keys=['html','.pt-detail-main','.pt-start-panel'];return keys.map(key=>{const e=document.querySelector(key);return {key,width:e.clientWidth,height:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight}})})}
process.chdir(path.resolve(__dirname,'..'));
fs.mkdirSync('artifacts',{recursive:true});
let browser;
(async()=>{
 assert(apps.length===17,'Expected 17 applications');assert(crypto.createHash('sha256').update(html).digest('hex')===JSON.parse(fs.readFileSync(path.resolve(__dirname,'../generated/build-manifest.json'),'utf8')).packagedPortalSha256,'Build drift');
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 for(const viewport of [{width:1280,height:720},{width:1024,height:768}]){
  const ctx=await browser.newContext({viewport,colorScheme:'light'});ctx.on('page',p=>p.on('pageerror',e=>report.errors.push(e.message)));await ctx.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied=value}})});await ctx.route('**/*',route=>{const u=route.request().url();if(/^https?:/.test(u)&&new URL(u).origin!==origin){report.externalRequests.push(u);return route.abort()}return route.continue()});
  const page=await ctx.newPage();page.setDefaultTimeout(6000);await page.goto(origin+'/?prototype=1');await page.locator('iframe.portal-frame').waitFor();const frame=await(await page.locator('iframe.portal-frame').elementHandle()).contentFrame();await frame.locator('#pt-home [data-browse]').first().click();assert(await frame.locator('#pt-tools article').count()===8,'Page not eight cards');
  const row={viewport,apps:[]};report.views.push(row);
  for(const app of apps){
   await detail(frame,app.id);const m=metadata.get(app.id);assert((await frame.locator('#pt-detail h1').innerText())===app.name,'Name mismatch');assert(await frame.locator('#pt-entry-guide').getAttribute('open')!==null,'Guide closed');
   const text=await frame.locator('#pt-detail').innerText();assert(!/待接入|待登记|待确认|未登记|规划中|方案阶段/.test(text),'Incomplete '+app.id);
   const d=await dimensions(frame);row.apps.push({id:app.id,mode:m.accessMode,dimensions:d});assert(d.every(x=>x.scrollWidth<=x.width+1),'Horizontal overflow '+app.id);assert(d[0].scrollHeight<=d[0].height+1&&d[2].scrollHeight<=d[2].height+1,'Page/action overflow '+app.id);
   await frame.locator('#pt-project-info summary').click();assert((await frame.locator('#pt-project-info').innerText()).includes(m.repository),'Missing project info');await frame.locator('#pt-project-info summary').click();
   if(m.accessMode==='agent'){await frame.locator('[data-agent-access]').click();const prompt=await frame.locator('#pt-agent-text').inputValue();assert(prompt===m.entries[0].onboardingPrompt&&prompt.includes(app.name)&&prompt.includes('example.invalid')&&prompt.includes('最小验证'),'Incomplete prompt '+app.id);await frame.locator('[data-copy-agent]').click();assert(await frame.evaluate(()=>window.copied)===prompt,'Copy mismatch '+app.id);await frame.locator('[data-close-agent]').click()}
   else{
    const [popup]=await Promise.all([ctx.waitForEvent('page'),frame.locator('.pt-start-panel a.pt-button-primary').click()]);await popup.waitForLoadState();assert(new URL(popup.url()).searchParams.get('platform-demo')===app.id,'Wrong platform URL');assert((await popup.locator('#pt-demo-title').innerText()).includes(app.name),'Wrong workbench');await popup.locator('#pt-demo-task').selectOption({index:1});await popup.locator('[data-demo-next]').click();assert((await popup.locator('#pt-platform-demo').innerText()).includes(m.platformDemo.tasks[1]),'Selected task lost');await popup.locator('[data-demo-next]').click();assert((await popup.locator('#pt-platform-demo').innerText()).includes(m.platformDemo.resultItems[0]),'Missing platform result');
    if(viewport.width===1280){const download=await Promise.all([popup.waitForEvent('download'),popup.locator('[data-demo-report]').click()]);const file=await download[0].path();const body=fs.readFileSync(file,'utf8');assert(body.includes(app.name)&&body.includes(m.platformDemo.tasks[1])&&body.includes(m.platformDemo.resultItems[0]),'Wrong report '+app.id)}
    const size=await popup.evaluate(()=>({h:innerHeight,sh:document.documentElement.scrollHeight,w:innerWidth,sw:document.documentElement.scrollWidth}));assert(size.h===size.sh&&size.w===size.sw,'Platform overflow');if(app.id==='auroraflow'&&viewport.width===1280)await popup.screenshot({path:'artifacts/mock-v13-auroraflow-platform.png'});await popup.close();
   }
   if(app.id==='auroraflow'||app.id==='heap-hunter')await page.screenshot({path:`artifacts/mock-v13-${app.id}-${viewport.width}.png`});await frame.locator('#pt-detail [data-back]').click();
  }
  await ctx.close();
 }
 assert(!report.errors.length,'Runtime error');assert(!report.externalRequests.length,'Unexpected external call');report.status='PASS';
})().catch(e=>{report.status='FAIL';report.error=e.stack;process.exitCode=1}).finally(async()=>{fs.writeFileSync('artifacts/mock-v13-qa.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,apps:report.views.map(v=>v.apps.length),detailOverflow:report.views.flatMap(v=>v.apps.filter(a=>a.dimensions[1].scrollHeight>a.dimensions[1].height+1).map(a=>({width:v.viewport.width,id:a.id,extra:a.dimensions[1].scrollHeight-a.dimensions[1].height}))),errors:report.errors,error:report.error}));await browser?.close();server.close()});
