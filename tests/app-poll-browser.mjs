/** App polling journeys through the installed UI's public doors. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {crmPollJourney,subscriptionPollJourney,comparisonPollJourney} from './app-poll-journey.mjs';
import {sheetPollJourney} from './sheet-poll-journey.mjs';
import {appHistoryJourney} from './app-history-journey.mjs';
import {appSubjectJourney} from './app-subject-journey.mjs';
import {appRetentionJourney} from './app-retention-journey.mjs';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse} from './kit.mjs';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--use-mock-keychain','--password-store=basic',...(process.env.CRANK_CHROMIUM?['--no-sandbox']:[])]});
let server,context,page,active;
const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
async function attach(h,width) {
 if(active===h)return;
 await context?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}
 active=h;
 server=createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,h.origin).pathname;
  if(types[extname(pathname)])for(const root of ['public','dist/client']){
   const dir=resolve(root),file=resolve(dir,'.'+decodeURIComponent(pathname));if(!file.startsWith(dir+'/'))continue;
   const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers={...req.headers};delete headers['content-length'];
  const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end('Browser transport failed')}});
 await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
 context=await browser.newContext({viewport:{width,height:1000}});
 const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
 await page.goto(h.origin+'/setup');
 if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
}
async function shot(width,state) {
 await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`);
 const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
}
async function rateScreens(width) {
 const edge=fakeEdge();let limited=false;
 edge.routes.set('api.github.com',({url})=>url.pathname.startsWith('/repos/')?new Response(null,{status:301,headers:{location:'/repositories/123/issues'}}):limited?jsonResponse({error:'slow down'},429):jsonResponse([]));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const trigger={type:'url_poll',url:'https://api.github.com/repos/just-every/run-crank/issues',items_path:'',interval_minutes:1};
  const w=await h.post('workflows',{name:'Public repository changes',graph:{trigger,steps:[{id:'record',type:'map',input:{id:'{{trigger.id}}'}}]}},h.owner,201);
  await attach(h,width);await page.goto(h.origin+`/app/workflows/${w.id}?step=trigger`);
  if(width===1440) {
   await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeVisible();
   await expect(page.getByRole('alert')).toContainText('60 requests per 3600 seconds');
   await expect(page.getByRole('alert')).toContainText('3 redirects per page');
   await expect(page.getByText('Poll request budget',{exact:true}).locator('..')).toContainText('4 requests');
   await expect(page.getByRole('alert')).toContainText('Slowest safe interval: 5 min');
   await expect(page.getByText('Polling interval',{exact:true}).locator('..')).toContainText('1 min');
   assert.equal((await h.get('workflows/'+w.id)).published_version_id,null);
   // Advice must remain visible when another step is selected before publishing.
   await page.goto(h.origin+`/app/workflows/${w.id}?step=record`);
   await expect(page.getByRole('alert')).toBeVisible();
   await page.goto(h.origin+`/app/workflows/${w.id}?step=trigger`);
  }
  await shot(width,'rate-warning-before-publish');
  await h.post(`workflows/${w.id}/draft`,{graph:{trigger:{...trigger,interval_minutes:5},steps:[]}});
  await page.reload();
  if(width===1440) {
   await expect(page.getByRole('alert')).toHaveCount(0);
   await expect(page.getByText('Polling interval',{exact:true}).locator('..')).toContainText('5 min');
   assert.equal((await h.get('workflows/'+w.id)).published_version_id,null);
  }
  await shot(width,'supported-interval-before-publish');
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  const time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);await h.tick(time);limited=true;await h.tick(time+300000);
  await page.reload();
  if(width===1440) {
   await expect(page.getByText('Poll status',{exact:true}).locator('..')).toContainText('429');
   const report=(await h.get('reports/latency?workflow='+w.id)).workflows[0];
   assert.ok(report.poll.late.some(p=>p.cause==='provider rate limit'&&p.http_status===429));
  }
  await shot(width,'provider-rate-limit');
 } finally {await h.close()}
}
try {
 for(const width of [1440,390]) await rateScreens(width);
 for(const width of [1440,390]) for(const journey of [crmPollJourney,subscriptionPollJourney,comparisonPollJourney,sheetPollJourney,appHistoryJourney,appSubjectJourney,appRetentionJourney]) {
  await journey({inspect:async({h,w,state,run})=>{
   await attach(h,width);await page.goto(h.origin+`/app/workflows/${w.id}?step=trigger`);
   if(state==='snapshot-retention-preview') {
    await page.goto(h.origin+'/app/data');await page.getByLabel('Payload days',{exact:true}).fill('1');await page.getByRole('button',{name:'Preview what this removes',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Retention dry run',exact:true,level:1})).toBeVisible();
    if(width===1440){await expect(page.locator('.retention-app-records .settings-row')).toHaveCount(1);await expect(page.locator('main')).toContainText('legal hold');await expect(page.locator('main')).toContainText('current published-version baseline')}
    await shot(width,state);return;
   }
   if(state==='unadmitted-subject-preview') {
    await page.goto(h.origin+'/app/data');await page.getByLabel('Identifier',{exact:true}).fill('Synthetic-Crank-21');await page.getByRole('button',{name:'Preview erasure',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Erasure preview',exact:true,level:1})).toBeVisible();await expect(page.getByText('Retained comparison data',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Erase matching data',exact:true})).toBeVisible();await shot(width,state);return;
   }
   if(state==='watch-picker') {
    await page.getByText('Watched field settings',{exact:true}).click();await page.getByRole('link',{name:'Load field names',exact:true}).click();
    await expect(page.getByRole('checkbox',{name:'Status',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'Customer',exact:true})).toBeChecked();
    await shot(width,state);
    await page.getByLabel('Update choice').selectOption('any');await page.getByRole('button',{name:'Save watched fields',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('every edit can start a run');
    const saved=await h.get('workflows/'+w.id);assert.equal(saved.draft.trigger.any_field,true);assert.equal(saved.status,'draft');assert.equal(saved.published_version_id,null);
    await shot(width,'watch-any-field');return;
   }
   if(state==='comparison-payload'||state==='row-released'||state==='history-payload') {
    await page.goto(h.origin+'/app/workflow-runs/'+run.id);
    if(width===1440)for(const value of state==='row-released'?['synthetic-crank-51','Filled buyer','450','change_time_source','poll']:[state==='history-payload'?'synthetic-crank-history':'synthetic-crank-record','changed_fields','previous','current','Pending','Approved','change_time_source','provider'])await expect(page.locator('main')).toContainText(value);
    await shot(width,state);return;
   }
   await expect(page.getByText('Last successful poll',{exact:true})).toBeVisible();
   await expect(page.getByText('Next poll',{exact:true})).toBeVisible();
   if(state==='expired') await expect(page.getByText('expired',{exact:true})).toBeVisible();
   if(state==='renewed') await expect(page.getByText('Subscription expiry',{exact:true})).toBeVisible();
   if(state==='changed') {
    const open=page.locator('.row-open').first();await open.focus();await expect(open.getByRole('tooltip')).toBeVisible();
    await page.locator('h1').click();await open.hover();await page.waitForTimeout(350);await expect(open.getByRole('tooltip')).toBeVisible();
   }
   await shot(width,state);
  }});
 }
 console.log('App poll screens passed at 1440 and 390');
} finally {await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}}
