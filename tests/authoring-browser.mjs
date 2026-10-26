import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse} from './kit.mjs';
import {setupAuthoring,authoringModelReply} from './authoring-fixture.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const fake=fakeEdge(),invoices=[];let crmReads=0,modelCalls=0;
fake.routes.set('authoring-model.example',({body})=>{modelCalls++;return jsonResponse(authoringModelReply(JSON.parse(body)))});
const crm=createServer((req,res)=>{crmReads++;res.setHeader('content-type','application'+'/'+'json');res.end(JSON.stringify({id:req.url.split('/').at(-1),country:'US',company:'Harbour Workshop — wholesale equipment and maintenance'}))});
await new Promise(r=>crm.listen(0,'127.0.0.1',r));
fake.routes.set('crm-authoring.example',({url,method})=>{assert.equal(method,'GET');return fetch('http://127.0.0.1:'+crm.address().port+url.pathname)});
fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,body})=>{
 if(method==='GET')return jsonResponse({QueryResponse:{Invoice:invoices}});
 const row={...JSON.parse(body),Id:'synthetic-crank-'+(100+invoices.length),TotalAmt:19.99};invoices.push(row);return jsonResponse({Invoice:row});
});
const h=await harness('http://127.0.0.1:9',{edge:fake.edge,bindings:{AI_ENABLED:'true',AI_MODEL:'configured-authoring-model',AI_API_KEY:'synthetic-crank-90',AI_BASE_URL:'https://authoring-model.example/v1'}});
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png','.webp':'image'+'/'+'webp'};
const bridge=createServer(async(req,res)=>{try{
 const path=new URL(req.url,h.origin).pathname;
 if(types[extname(path)]){const dir=resolve('public'),file=resolve(dir,'.'+decodeURIComponent(path));if(file.startsWith(dir+'/')){const data=await readFile(file).catch(()=>null);if(data){res.writeHead(200,{'content-type':types[extname(path)]});res.end(data);return}}}
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
  const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
  const account=page.locator('.person.control-tooltip');await account.focus();await expect(page.locator('#account-tooltip')).toBeVisible();await page.locator('h1').click();await account.hover();await page.waitForTimeout(350);await expect(page.locator('#account-tooltip')).toBeVisible();await page.locator('h1').click();
  await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});console.log(`authoring browser width=${width} state=${state}`);
 };
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});const before=invoices.length,beforeReads=crmReads;
  const setup=await setupAuthoring(h,{samples:[{id:'synthetic-crank-'+width}],prompt:'For US leads from our owned CRM, prepare a USD 19.99 QuickBooks draft invoice for Harbour Workshop. Keep uncertain business decisions explicit.'});
  await page.goto(h.origin+'/app/skills');await page.getByRole('link',{name:'Describe a workflow',exact:true}).click();
  await page.getByLabel('What should happen?').fill(setup.request.prompt);await page.getByLabel('CRM connection',{exact:true}).selectOption(setup.crm.id);await page.getByLabel('QuickBooks connection',{exact:true}).selectOption(setup.qbo.id);
  if(!await page.getByLabel('Authorized lead source URL',{exact:true}).isVisible())await page.getByText('Lead source, invoice details and samples',{exact:true}).click();
  for(const [key,label] of [['lead_url','Authorized lead source URL'],['realm_id','QuickBooks company ID'],['customer_id','QuickBooks customer ID'],['item_id','QuickBooks item ID'],['amount_usd','Invoice amount (USD)']])await page.getByLabel(label,{exact:true}).fill(setup.request[key]);
  await page.getByLabel('Sample inputs (JSON array)',{exact:true}).fill(JSON.stringify(setup.request.samples));await shot(width,'request');
  await page.getByRole('button',{name:'Generate draft',exact:true}).click();await page.waitForURL('**/app/authoring/*');
  const workflowId=new URL(page.url()).pathname.split('/').at(-1),path='authoring/'+workflowId;
  let proposal=await h.get(path);assert.equal(invoices.length,before);assert.equal(crmReads,beforeReads);assert.ok(proposal.questions.some(q=>!q.answer));await shot(width,'generated');
  const widened=structuredClone(proposal.graph);widened.steps.push({id:'email',type:'http',input:{method:'POST',url:'https://outbound-authoring.example/send'}});
  await page.getByLabel('Workflow graph (JSON)',{exact:true}).fill(JSON.stringify(widened));await page.getByRole('button',{name:'Save draft changes',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  assert.deepEqual(JSON.parse(await page.getByLabel('Workflow graph (JSON)',{exact:true}).inputValue()),widened);assert.equal(invoices.length,before);await shot(width,'scope-refused');
  const graph=structuredClone(proposal.graph);graph.steps[2].name='Prepare Harbour Workshop reviewed draft invoice';
  await page.getByLabel('Workflow graph (JSON)',{exact:true}).fill(JSON.stringify(graph,null,2));
  await page.getByLabel('Sample inputs (JSON array)',{exact:true}).fill(JSON.stringify([{id:'synthetic-crank-'+width,review_note:'Reviewed against authorized CRM sample'}]));
  for(const q of proposal.questions)await page.locator(`[name="answer_${q.id}"]`).fill('Confirmed the fetched country and stable business key; this remains a sandbox invoice for owner review.');
  await page.getByRole('button',{name:'Save draft changes',exact:true}).click();await page.waitForLoadState('networkidle');proposal=await h.get(path);assert.ok(proposal.questions.every(q=>q.answer));assert.equal(proposal.tested.passed,false);await shot(width,'edited');
  for(const id of [setup.crm.id,setup.qbo.id])await page.locator(`[name="binding_${id}"]`).selectOption(id);
  await page.getByRole('button',{name:'Test saved draft',exact:true}).click();await page.waitForLoadState('networkidle');proposal=await h.get(path);assert.equal(proposal.tested.passed,true);assert.equal(invoices.length,before+1);await shot(width,'tested');
  await page.getByText('Review owner estimates before promotion',{exact:true}).click();
  for(const kind of ['orchestration','connectors','models','executors']){await page.locator(`[name="estimate_${kind}_usd_per_run"]`).fill('0');await page.locator(`[name="estimate_${kind}_assumption"]`).fill('Owner reviewed the native sandbox flow with nonbilling provider edges; generation cost remains unverified.')}
  await page.getByRole('button',{name:'Record owner estimate',exact:true}).click();await page.waitForLoadState('networkidle');
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Promote tested version',exact:true}).click();await page.waitForLoadState('networkidle');
  proposal=await h.get(path);assert.equal(proposal.promoted,true);assert.equal(invoices.length,before+1);assert.equal((await h.get('grants')).length,0);await shot(width,'promoted');
 }
 assert.equal(modelCalls,2);console.log('authoring-browser: PASS widths=1440,390 production_sends=0 scope_refusal=true exact_human_promotion=true');await context.close();
}catch(error){if(page){console.error('screen path:',new URL(page.url()).pathname,(await page.locator('body').innerText()).slice(0,1500));await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true})}throw error}
finally {await browser.close();await h.close();bridge.closeAllConnections();crm.closeAllConnections();await Promise.all([new Promise(r=>bridge.close(r)),new Promise(r=>crm.close(r))])}
