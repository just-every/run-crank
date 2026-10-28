/** Native sibling action screens on the installed owner's existing public pages. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {nookJourney} from './nook-journey.mjs';
import {orbitJourney} from './orbit-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM_EXECUTABLE?{executablePath:process.env.CRANK_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
let server,context,page;
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png'};
async function open(h) {
  if(!server){
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
   context=await browser.newContext({viewport:{width:1440,height:1000}});
   const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
   await page.goto(h.origin+'/setup');
   if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
  }
}
async function closePage() {
 await context?.close();context=null;page=null;if(server){server.closeAllConnections();await new Promise(done=>server.close(done));server=null}
}
try {
 await nookJourney({inspect:async({h,workflow,run,state})=>{
  await open(h);
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});
   await page.goto(h.origin+'/app/connections');
   if(width===1440){await expect(page.getByText('Synthetic Nook operations',{exact:true})).toBeVisible();await expect(page.getByText('Nook integration token',{exact:false})).toBeVisible()}
   await page.screenshot({path:join(evidence,`${width}-nook-${state}-connection.png`),fullPage:true});
   if(state==='acknowledged')for(const tab of ['setup','data','test']) {
    await page.goto(h.origin+'/app/workflows/'+workflow.id+'?step=post&tab='+tab);
    const arrow=page.locator('a.row-open').first(),tip=arrow.getByRole('tooltip');
    if(width===390)await arrow.focus();
    if(width===1440){
     await arrow.focus();await expect(tip).toBeVisible();
     await page.locator('h1').click();await arrow.hover();
     await expect(tip).toBeHidden();await page.waitForTimeout(350);await expect(tip).toBeVisible();
     const small=await page.locator('body').evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility==='visible'&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<13).map(el=>({tag:el.tagName,text:el.textContent.slice(0,80),size:getComputedStyle(el).fontSize})));
     assert.deepEqual(small,[],'visible editor text meets the minimum size');
    }
    await page.screenshot({path:join(evidence,`${width}-nook-editor-${tab}.png`),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'editor fits viewport');
   }
   await page.goto(h.origin+'/app/workflow-runs/'+run.id);
   if(state==='acknowledged')await page.locator('.timeline-item details.inline-disclosure summary').first().click();
   if(width===1440){
    await expect(page.getByRole('heading',{name:'Workflow run',exact:true})).toBeVisible();
    const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
    assert.equal(await page.evaluate(()=>typeof globalThis.inert),'undefined');
    assert.ok((await page.locator('body').innerText()).includes(state==='acknowledged'?'synthetic-crank-200':state==='revoked'?'Reconnect':state==='reconnected'?'Success':'earlier credential'));
   }
   await page.screenshot({path:join(evidence,`${width}-nook-${state}-run.png`),fullPage:true});
  }
 }});
 await closePage();
 await orbitJourney({inspect:async({h,workflow,run,state})=>{
  await open(h);
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   await page.goto(h.origin+'/app/connections');
   if(width===1440)await expect(page.getByText('Orbit scoped deal API',{exact:false})).toBeVisible();
   await page.screenshot({path:join(evidence,`${width}-${state}-connections.png`),fullPage:true});
   await page.goto(h.origin+'/app/workflows/'+workflow.id+'?step='+ (state==='orbit-read-back'?'update':'deal'));
   if(width===1440){
    const control=page.locator('a.row-open').first();await control.focus();await expect(control.getByRole('tooltip')).toBeVisible();
    const small=await page.locator('body').evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility==='visible'&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<13).map(el=>el.tagName));assert.deepEqual(small,[]);
   }
   await page.screenshot({path:join(evidence,`${width}-${state}-workflow.png`),fullPage:true});
   await page.goto(h.origin+'/app/workflow-runs/'+run.id);
   if(state==='orbit-read-back')await page.locator('.timeline-item details.inline-disclosure summary').last().click();
   if(width===1440){
    await expect(page.getByRole('heading',{name:'Workflow run',exact:true})).toBeVisible();
    assert.ok((await page.locator('body').innerText()).includes(state==='orbit-read-back'?'requested fields observed':'Reconnect Orbit'));
   }
   await page.screenshot({path:join(evidence,`${width}-${state}-run.png`),fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Orbit run fits viewport');
  }
 }});
 console.log('Native Nook and Orbit scoped operations, readback and authority screens proved at 1440 and captured at 390');
} finally {await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}}
