import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse} from './kit.mjs';
import {recurringSetup} from './recurring-fixture.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const fake=fakeEdge();let reads=0;
fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,url})=>{reads++;assert.equal(method,'GET');return jsonResponse({Invoice:{Id:url.pathname.split('/').at(-1),Balance:521,SyncToken:String(reads),DueDate:'2020-01-01',BillEmail:{Address:'billing@harbour.example.test'}}})});
const h=await harness('http://127.0.0.1:9',{emitted:true,edge:fake.edge});
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png','.webp':'image'+'/'+'webp'};
const bridge=createServer(async(req,res)=>{try{
 const pathname=new URL(req.url,h.origin).pathname;
 if(types[extname(pathname)])for(const root of ['public','dist/client']){
  const dir=resolve(root),file=resolve(dir,'.'+decodeURIComponent(pathname));if(!file.startsWith(dir+'/'))continue;
  const data=await readFile(file).catch(()=>null);if(data){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(data);return}
 }
 const chunks=[];for await(const c of req)chunks.push(c);const headers={...req.headers};delete headers['content-length'];
 const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch{res.writeHead(503);res.end('Browser transport failed')}});
await new Promise(r=>bridge.listen(Number(new URL(h.origin).port),'127.0.0.1',r));
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});let page;
try {
 const context=await browser.newContext();const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
 await page.goto(h.origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
 const shot=async(width,state)=>{
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`);
  for(const [control,tooltip] of [[page.getByRole('link',{name:'Search runs',exact:true}),page.locator('#search-tooltip')],[page.locator('.person.control-tooltip'),page.locator('#account-tooltip')]]){
   await control.focus();await expect(tooltip).toBeVisible();await page.locator('h1').click();await control.hover();await page.waitForTimeout(350);await expect(tooltip).toBeVisible();await page.locator('h1').click();
  }
  await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});console.log(`recurring browser width=${width} state=${state}`);
 };
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});const s=await recurringSetup(h,{invoiceId:'synthetic-crank-'+width,create:false});
  await page.goto(h.origin+'/app/skills');await shot(width,'skills');await page.getByRole('link',{name:'Open recurring skills',exact:true}).click();
  const publish=page.locator('form').filter({has:page.getByRole('button',{name:'Publish skill version',exact:true})});
  await publish.getByLabel('Skill identity',{exact:true}).selectOption(s.skill.skill_id);await publish.getByLabel('Skill name',{exact:true}).fill(s.skill.name);
  await publish.getByLabel('Published workflow',{exact:true}).selectOption(s.workflow.id);await publish.getByLabel('Exact published workflow version',{exact:true}).selectOption(s.published.version.id);
  await publish.getByLabel('Instructions',{exact:true}).fill('Check Harbour Workshop wholesale invoice against the connected accounting record.\nKeep any customer message blocked until its authorized transport is available.');
  await publish.getByRole('button',{name:'Publish skill version',exact:true}).click();await page.waitForLoadState('networkidle');
  const state=await h.get('recurring-skills'),version=state.skills.find(v=>v.skill_id===s.skill.skill_id&&v.number===2);assert.ok(version);
  const create=page.locator('form').filter({has:page.getByRole('button',{name:'Create recurring objective',exact:true})});
  await create.getByLabel('Objective name',{exact:true}).fill('Harbour Workshop — wholesale equipment invoice and outstanding maintenance');
  await create.getByLabel('Exact skill version',{exact:true}).selectOption(version.id);await create.getByLabel('Owner-issued execution grant',{exact:true}).selectOption(s.grant.id);
  await create.getByLabel('Exact QuickBooks realm',{exact:true}).fill(s.objective.realm_id);await create.getByLabel('Stable invoice identifier',{exact:true}).fill(s.objective.invoice_id);
  await create.getByRole('button',{name:'Create recurring objective',exact:true}).click();await page.waitForLoadState('networkidle');
  const taskId=new URL(page.url()).pathname.split('/').at(-1);await shot(width,'pinned-objective');
  await page.getByRole('button',{name:'Check invoice now',exact:true}).click();await page.waitForLoadState('networkidle');
  let task=await h.get('recurring-tasks/'+taskId);assert.equal(task.runs.length,1);assert.equal(task.runs[0].outcome.contact_state,'not_sent');assert.equal(task.runs[0].skill_version_id,version.id);
  await shot(width,'blocked-contact');
  await page.getByRole('link',{name:'Open workflow run',exact:true}).click();await page.waitForLoadState('networkidle');await shot(width,'native-run');await page.goto(h.origin+'/app/recurring/'+taskId);
  const newer=await h.post('recurring-skills',{...s.publication,skill_id:s.skill.skill_id,instructions:'Third reviewed version; no broader tool or recipient authority.'},h.owner,201);
  await page.reload();await page.getByLabel('Exact skill version',{exact:true}).selectOption(newer.id);await page.getByLabel('Elapsed minutes between live checks',{exact:true}).fill('60');
  await page.getByRole('button',{name:'Adopt for the next run',exact:true}).click();await page.waitForLoadState('networkidle');
  task=await h.get('recurring-tasks/'+taskId);assert.equal(task.skill_version_id,newer.id);assert.equal(task.runs[0].skill_version_id,version.id);assert.notEqual(task.objective_version_id,task.runs[0].objective_version_id);await shot(width,'adopted-next-run');
  const before=reads;await page.getByRole('button',{name:'Pause objective',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal((await h.get('recurring-tasks/'+taskId)).status,'paused');assert.equal(reads,before);await shot(width,'paused');
  await page.getByRole('button',{name:'Permanently revoke tool',exact:true}).click();await page.waitForLoadState('networkidle');assert.ok((await h.get('recurring-tasks/'+taskId)).tool_revoked_at);assert.equal(reads,before);await shot(width,'tool-revoked');
  await page.getByRole('link',{name:'All recurring objectives',exact:false}).click();await shot(width,'recurring-list');
 }
 assert.equal(reads,4);assert.equal(fake.requests.filter(r=>r.method!=='GET').length,0);console.log('recurring-browser: PASS widths=1440,390 customer_sends=0 frozen_open_versions=true');await context.close();
}catch(error){if(page){console.error('screen path:',new URL(page.url()).pathname,(await page.locator('body').innerText()).slice(0,1800));await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true})}throw error}
finally {await browser.close();await h.close();bridge.closeAllConnections();await new Promise(r=>bridge.close(r))}
