/** Native sibling action screens on the installed owner's existing public pages. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {nookJourney} from './nook-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM_EXECUTABLE?{executablePath:process.env.CRANK_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
let server,context,page;
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png'};
try {
 await nookJourney({inspect:async({h,run,state})=>{
  if(!server){
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
   context=await browser.newContext({viewport:{width:1440,height:1000}});
   const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
   await page.goto(h.origin+'/setup');
   if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
  }
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});
   await page.goto(h.origin+'/app/connections');
   if(width===1440){await expect(page.getByText('Synthetic Nook operations',{exact:true})).toBeVisible();await expect(page.getByText('Nook integration token',{exact:false})).toBeVisible()}
   await page.screenshot({path:join(evidence,`${width}-nook-${state}-connection.png`),fullPage:true});
   await page.goto(h.origin+'/app/workflow-runs/'+run.id);
   if(state==='acknowledged')await page.locator('.timeline-item details.inline-disclosure summary').first().click();
   if(width===1440){
    await expect(page.getByRole('heading',{name:'Workflow run',exact:true})).toBeVisible();
    const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
    assert.equal(await page.evaluate(()=>typeof globalThis.inert),'undefined');
    assert.ok((await page.locator('body').innerText()).includes(state==='acknowledged'?'synthetic-crank-200':'Reconnect'));
   }
   await page.screenshot({path:join(evidence,`${width}-nook-${state}-run.png`),fullPage:true});
  }
 }});
 console.log('Native Nook acknowledgement, revoked authority and connection screens proved at 1440 and captured at 390');
} finally {await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}}
