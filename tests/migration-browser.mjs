/** MIG-001: installed move-in and native graph pages through owner HTTP doors. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {harness} from './harness.mjs';
import {chromium} from '@playwright/test';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
let browser,page,h,server;
try {
 // Build first. This runs the emitted deployment Worker, real D1 and native handlers.
 h=await harness('http://127.0.0.1:9051',{emitted:true});const origin=h.origin;
 const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.webp':'image/webp','.png':'image/png','.json':'application/json'};
 server=createServer(async(req,res)=>{try{
  const path=decodeURIComponent(new URL(req.url,origin).pathname);let asset;
  if(types[extname(path)])for(const root of ['dist/client','public']){const base=resolve(root),file=resolve(root,'.'+path);if(file.startsWith(base+'/')){try{asset=await readFile(file);break}catch{}}}
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
 const {graphExport}=await import('./n8n-graph-fixture.mjs');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/import');await shot(width,'move-in');
  const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();assert.equal(await page.locator('#search-tooltip').isVisible(),true);await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);assert.equal(await page.locator('#search-tooltip').isVisible(),true);await shot(width,'search-tooltip');
  const source=graphExport('http://127.0.0.1:9051','synthetic-crank-'+width),bad=structuredClone(source);
  bad.nodes.push({id:'subflow',name:'Subflow',type:'n8n-nodes-base.executeWorkflow',typeVersion:1,position:[300,300],parameters:{workflowId:'synthetic-crank-child'}});
  bad.nodes.push({id:'custom',name:'Custom',type:'synthetic-crank-custom',typeVersion:1,position:[300,500],parameters:{code:'={{ globalThis.crankInjected = 1 }}'}});
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(bad));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),0);assert.ok((await page.locator('body').innerText()).includes('Manual conversion required'));assert.equal(await page.evaluate(()=>globalThis.crankInjected),undefined);await shot(width,'manual-conversions');
  await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import');
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(source));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');await shot(width,'review-graph');
  await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.ok((await page.locator('body').innerText()).includes('present as drafts'));await shot(width,'applied-graph');
  const w=(await send('workflows')).find(w=>w.name===source.name);assert.ok(w);assert.equal(w.status,'draft');const detail=await send('workflows/'+w.id);assert.equal(detail.versions.length,0);assert.equal(detail.hooks.length,0);assert.equal(detail.draft.settings.n8n_layout.length,source.nodes.length);
  await page.goto(origin+'/app/workflows/'+w.id);await shot(width,'inactive-native-graph');
  await page.goto(origin+'/app/import');await page.getByRole('button',{name:'Undo unused import',exact:true}).click();await page.waitForURL('**/app/import');assert.equal((await send('workflows')).length,0);await shot(width,'undone-graph');
  console.log(`MIG-001 ${width}: mapping coverage, safe cancellation, inactive apply, native draft, undo and shell tooltip passed`);
 }

 await context.close();
}catch(error){if(page){await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,800))}console.error(String(error.message).replace(/https?:\/\/\S+/g,'[redacted URL]'));process.exitCode=1}
finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await h?.close()}
