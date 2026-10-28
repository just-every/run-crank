/** Retained sample journeys at the installed UI's public doors. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {sampleJourney} from './sample-journey.mjs';
import {stepSampleJourney} from './step-sample-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--use-mock-keychain','--password-store=basic',...(process.env.CRANK_CHROMIUM?['--no-sandbox']:[])]});
let server,context,page,active;
const types={'.css':'text'+'/css','.js':'text'+'/javascript','.svg':'image'+'/svg+xml','.woff2':'font'+'/woff2','.png':'image'+'/png'};
async function attach(h,width) {
 if(active===h)return;
 await context?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}
 active=h;
 server=createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,h.origin).pathname;
  if(types[extname(pathname)])for(const root of ['public','./dist/client']){
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
try {
 await sampleJourney({inspect:async({h,w,state,listener,sample,step='trigger'})=>{
  await attach(h,1440);
  if(state.startsWith('condition-')) {
   await page.goto(h.origin+`/app/workflows/${w.id}?step=route&tab=test`);
   await page.getByRole('button',{name:'Preview selected sample',exact:true}).click();
   const result=page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Preview result',exact:true})});
   await expect(result).toContainText(sample.source==='webhook'?sample.id:'manual sample');
   const routing=result.locator(`.preview-list > li[data-outcome="${state==='condition-mismatch'?'type mismatch':'routed'}"]`);
   await expect(routing).toHaveCount(1);
   await routing.getByText('Condition details',{exact:true}).click();
   await expect(routing.locator('details pre')).toContainText('"branch": "premium"');
   await expect(routing.locator('details pre')).toContainText('"right": 5000');
   await expect(routing.locator('details pre')).toContainText(state==='condition-mismatch'||state==='condition-routed'?'type_mismatch':state==='condition-fallback'?'"left": "100"':'"left": "6000"');
   if(state==='condition-mismatch') {
    await expect(result).not.toContainText('Not run in preview');
    await expect(routing).toContainText('Type mismatch');
   } else {
    await expect(result).toContainText('Not run in preview');
    await expect(routing).toContainText(state==='condition-fallback'||state==='condition-routed'?'Fallback':'Qualified lead');
    if(state==='condition-captured') await expect(routing).toContainText('Regional lead');
   }
   const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
   for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});
   }
   await page.setViewportSize({width:1440,height:1000});
   return;
  }
  await page.goto(h.origin+`/app/workflows/${w.id}?step=${step}&tab=test`);
  await expect(page.getByText('Step notify relies on a schema sample; not tested',{exact:true})).toBeVisible();
  if(state==='waiting') {
   await page.getByRole('button',{name:'Wait for webhook',exact:true}).click();
   await expect(page.getByRole('heading',{name:'Waiting for one sample'})).toBeVisible();
   listener.url=await page.getByLabel('Draft sample URL').inputValue();
  } else {
   if(state==='stale') await expect(page.getByText('Stale sample: missing fields body.new_question',{exact:true})).toBeVisible();
   else {
    await page.getByRole('button',{name:'Preview selected sample',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Preview result',exact:true})).toBeVisible();
    const result=page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Preview result',exact:true})});
    await expect(result).toContainText(state==='manual'?'manual sample':state==='history'||state==='step-history'?sample.source_id:state==='step-schema'?'schema sample · not tested':sample.id);
    await expect(result).toContainText(state==='manual'?'MANUAL-SOURCE':state==='step-history'?'SYNTHETIC-CRANK-CONTACT':state==='step-schema'?'synthetic-crank-schema':'HIDDEN-VALUE');
    if(state==='step-history') {await expect(result).toContainText('step notify');await expect(result).toContainText('Saved sample; step not run')}
   }
  }
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   if(state==='waiting'&&width===1440) {
    const contrast=await page.getByRole('link',{name:'Refresh captured samples',exact:true}).evaluate(link=>{
     const luminance=color=>{
      const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{const v=value/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4});
      return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
     };
     const style=getComputedStyle(link),foreground=luminance(style.color),background=luminance(style.backgroundColor);
     return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05);
    });
    assert.ok(contrast>=4.5,`${width} sample refresh contrast ${contrast}`);
    console.log(`${width} sample refresh contrast ${contrast.toFixed(2)}:1`);
   }
   await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true,...(state==='waiting'?{mask:[page.getByLabel('Draft sample URL')]}:{})});
   if(width===1440) assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`);
  }
  await page.setViewportSize({width:1440,height:1000});
  const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
  if(state==='step-history') {
   await page.getByText('Load from run history',{exact:true}).click();
   await page.getByRole('button',{name:'Load history sample',exact:true}).click();
   await expect(page.getByRole('heading',{name:'Retained step outputs',exact:true})).toBeVisible();
   const selected=(await h.get(`workflows/${w.id}/samples`)).samples.filter(sample=>sample.selected);
   assert.equal(selected.find(sample=>sample.step_path==='notify').source_id,sample.source_id);
   assert.equal(selected.find(sample=>sample.step_path==='notify').source,'history');
   assert.equal(selected.find(sample=>sample.step_path==='trigger').source,'history');
  }
  if(state==='step-schema') {
   const saveForm=page.locator('form').filter({has:page.getByRole('button',{name:'Save sample',exact:true})});
   await saveForm.getByRole('combobox').selectOption('manual');
   await saveForm.getByRole('textbox').fill(JSON.stringify({body:{id:'synthetic-crank-ui'}}));
   await page.getByRole('button',{name:'Save sample',exact:true}).click();
   const selected=(await h.get(`workflows/${w.id}/samples`)).samples.filter(sample=>sample.selected);
   assert.equal(selected.find(sample=>sample.step_path==='notify').source,'manual');
   assert.deepEqual(selected.find(sample=>sample.step_path==='notify').payload,{body:{id:'synthetic-crank-ui'}});
   assert.equal(selected.find(sample=>sample.step_path==='trigger').source,'history');
   await page.getByRole('button',{name:'Preview selected sample',exact:true}).click();
   const result=page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Preview result',exact:true})});
   await expect(result).toContainText('manual sample');await expect(result).toContainText('SYNTHETIC-CRANK-UI');
   for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await page.screenshot({path:join(evidence,`${width}-step-manual.png`),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} step-manual overflow`);
   }
   await page.setViewportSize({width:1440,height:1000});
  }
 }});
 await stepSampleJourney({inspect:async({h,w,state,run,step})=>{
  await attach(h,1440);
  if(state==='step-confirmation') {
   await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
   await expect(page.getByText('Synthetic Crank production',{exact:false}).first()).toBeVisible();
   await expect(page.getByText('Confirm live test:',{exact:false}).first()).toBeVisible();
  } else {
   await page.goto(h.origin+`/app/workflows/${w.id}?step=${step}&tab=test`);
   await expect(page.getByRole('heading',{name:'Retained step outputs',exact:true})).toBeVisible();
   await page.getByRole('button',{name:'Test this step',exact:true}).click();
   await expect(page).toHaveURL(new RegExp('/app/workflow-runs/'));
   await expect(page.getByText('Draft test · this snapshot',{exact:false}).first()).toBeVisible();
  }
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});
   if(width===1440)assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`);
  }
  await page.setViewportSize({width:1440,height:1000});
 }});
 console.log('Retained sample screens and isolated step tests passed at 1440 and 390');
} finally {await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}}
