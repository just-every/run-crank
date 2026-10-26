/** MIG-001: installed move-in and native graph pages through owner HTTP doors. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {harness} from './harness.mjs';
import {chromium} from '@playwright/test';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
let browser,page,h,server,receiver;
try {
 // Build first. This runs the emitted deployment Worker, real D1 and native handlers.
 const declared='https://receiver.example',effects=[];
 receiver=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);effects.push({path:req.url,input});res.writeHead(200,{'content-type':'application'+'/'+'json'});res.end(JSON.stringify(req.url==='/body'?{processed:input.message,part:0}:{processed:input.processed,part:input.part}))});
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const receiverOrigin='http://127.0.0.1:'+receiver.address().port;
 h=await harness(declared,{emitted:true,edge:async request=>{const url=new URL(request.url);if(url.origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(receiverOrigin+url.pathname,{method:request.method,headers,body:await request.arrayBuffer()})}});const origin=h.origin;
 const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.webp':'image'+'/'+'webp','.png':'image'+'/'+'png','.json':'application'+'/'+'json'};
 server=createServer(async(req,res)=>{try{
  const path=decodeURIComponent(new URL(req.url,origin).pathname);let asset;
  if(types[extname(path)])for(const root of ['./dist/client','public']){const base=resolve(root),file=resolve(root,'.'+path);if(file.startsWith(base+'/')){try{asset=await readFile(file);break}catch{}}}
  if(asset){res.writeHead(200,{'content-type':types[extname(path)]});res.end(asset);return}
  const chunks=[];for await(const c of req)chunks.push(c);
  const response=await h.mf.dispatchFetch(origin+req.url,{method:req.method,headers:req.headers,redirect:'manual',...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Browser fixture transport failed')}});
 await new Promise(r=>server.listen(Number(new URL(origin).port),'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});const context=await browser.newContext();
 const cookie=h.owner.indexOf('=');await context.addCookies([{name:h.owner.slice(0,cookie),value:h.owner.slice(cookie+1),url:origin}]);page=await context.newPage();
 await page.goto(origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
 const send=async(path,body,status=200)=>{const r=await context.request.fetch(origin+'/api/crank/'+path,{method:body===undefined?'GET':'POST',headers:{origin},...(body===undefined?{}:{data:body})});const v=await r.json();assert.equal(r.status(),status,path+': '+(v.error??'unexpected status'));return v};
 const shot=async(width,state)=>{await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`)};
 const {loopExport,doneLoopExport,switchExport,dateExport}=await import('./n8n-graph-fixture.mjs');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/import');await shot(width,'move-in');
  const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();assert.equal(await page.locator('#search-tooltip').isVisible(),true);await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);assert.equal(await page.locator('#search-tooltip').isVisible(),true);await shot(width,'search-tooltip');
  const source=loopExport(declared,'synthetic-crank-'+width),bad=structuredClone(source);
  bad.nodes.push({id:'subflow',name:'Subflow',type:'n8n-nodes-base.executeWorkflow',typeVersion:1,position:[300,300],parameters:{workflowId:'synthetic-crank-child'}});
  bad.nodes[5].credentials={httpHeaderAuth:{id:'synthetic-crank-16',name:'Reference only'}};
  bad.nodes.push({id:'custom',name:'Custom',type:'synthetic-crank-custom',typeVersion:1,position:[300,500],parameters:{code:'={{ globalThis.crankInjected = 1 }}'}});
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(bad));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),0);assert.ok((await page.locator('body').innerText()).includes('Manual conversion required'));assert.ok((await page.locator('body').innerText()).includes('fresh native account binding required'));assert.equal(await page.evaluate(()=>globalThis.crankInjected),undefined);await shot(width,'manual-conversions');
  await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import');
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(source));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.ok(await page.getByText(/Supported fields/).count());await shot(width,'review-graph');await page.getByText(/Supported fields/).click();await shot(width,'supported-fields');
  await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.ok((await page.locator('body').innerText()).includes('present as drafts'));await shot(width,'applied-graph');
  const w=(await send('workflows')).find(w=>w.name===source.name);assert.ok(w);assert.equal(w.status,'draft');const detail=await send('workflows/'+w.id);assert.equal(detail.versions.length,0);assert.equal(detail.hooks.length,0);assert.equal(detail.draft.settings.n8n_layout.length,source.nodes.length);
  await page.goto(origin+'/app/workflows/'+w.id);await shot(width,'inactive-native-graph');
  await page.goto(origin+'/app/import');await page.getByRole('button',{name:'Undo unused import',exact:true}).click();await page.waitForURL('**/app/import');assert.equal((await send('workflows')).length,0);await shot(width,'undone-graph');
  for(const extra of [switchExport(declared,'synthetic-crank-switch-'+width),dateExport(declared,'synthetic-crank-date-'+width)]){await page.getByLabel('Workflow export JSON').fill(JSON.stringify(extra));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1);await page.getByText(/Supported fields/).click();await shot(width,extra.name.includes('Switch')?'switch-review':'date-review');await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import')}
  console.log(`MIG-001 ${width}: mapping coverage, safe cancellation, inactive apply, native draft, undo and shell tooltip passed`);
 }

 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/import');
  const source=doneLoopExport(declared,'synthetic-crank-'+(width+1));source.name+=' '+width;
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(source));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1);await page.getByText(/Supported fields/).click();assert.ok((await page.locator('body').innerText()).includes('distinct linear done path'));await shot(width,'done-review');
  await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');
  const workflow=(await send('workflows')).find(row=>row.name===source.name),inactive=await send('workflows/'+workflow.id);
  assert.equal(inactive.status,'draft');assert.equal(inactive.versions.length,0);assert.equal(inactive.hooks.length,0);assert.ok(inactive.draft.steps.some(step=>step.id==='n7_each'));
  await page.goto(origin+'/app/workflows/'+workflow.id);await shot(width,'done-inactive-native');
  await send(`workflows/${workflow.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner browser acceptance against the actual owned receiver'}))}});
  await send(`workflows/${workflow.id}/publish`,{},201);const hook=await send(`workflows/${workflow.id}/hooks`,{},201),before=effects.length;
  const delivered=await context.request.post(hook.url,{data:{messages:['synthetic-crank-70','synthetic-crank-71']}});assert.equal(delivered.status(),200);
  const runs=await send('workflow-runs?workflow='+workflow.id);let run;
  for(let attempt=0;attempt<100;attempt++){run=await send('workflow-runs/'+runs.runs[0].id);if(!['queued','running'].includes(run.status))break;await page.waitForTimeout(50)}
  assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(effects.slice(before).map(row=>row.path),['/body','/body','/done-first','/done-first','/done-last','/done-last']);
  assert.deepEqual(effects.slice(before+2,before+4).map(row=>row.input.processed),['synthetic-crank-70','synthetic-crank-71']);
  for(const id of ['n5','n7','n9'])assert.ok(run.steps.some(step=>step.step_id===id&&step.status==='succeeded'));
  await page.goto(origin+'/app/workflow-runs/'+run.id);await shot(width,'done-completed-run');
  console.log(`MIG-001 ${width}: reviewed done-output conversion, inactive native draft, actual ordered body and completion receiver effects and retained checkpoints passed`);
 }

 await context.close();
}catch(error){if(page){await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,800))}console.error(String(error.message).replace(/https?:\/\/\S+/g,'[redacted URL]'));process.exitCode=1}
finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await h?.close();if(receiver){receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve))}}
