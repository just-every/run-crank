import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {expect} from '@playwright/test';
import {zendeskSearchJourney,hostileTicketSubject} from './zendesk-search-journey.mjs';

/** Invoked by the existing metadata-search Verify browser entry. */
export async function zendeskSearchBrowser(browser){
const evidence=join(process.env.CRANK_EVIDENCE,'zendesk');await mkdir(evidence,{recursive:true});
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png','.webp':'image'+'/'+'webp'};
async function onScreen({h,w,run,state}){
 const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application'+'/'+'x-www-form-urlencoded'},body:'confirm=yes'});assert.equal(setup.status,303);
 const server=createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,h.origin).pathname;
   if(types[extname(pathname)])for(const root of ['./public','./dist/client']){
    const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));if(!file.startsWith(directory+'/'))continue;
    const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
   }
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const headers={...req.headers};delete headers['content-length'];
   const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503);res.end('Browser transport failed')}
 });
 await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
 const context=await browser.newContext(),[name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);const page=await context.newPage();
 try{
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});
   await page.goto(h.origin+`/app/workflows/${w.id}?step=tickets&tab=setup`);
   if(width===1440){const inspector=page.getByRole('region',{name:'Selected step'});await expect(inspector).toContainText('subject, status, priority, requester_id, updated_at');await expect(inspector).toContainText('id desc');await expect(inspector).toContainText('Descriptions, comments and attachment bytes are excluded');assert.ok(await inspector.locator('.inspector-block').first().evaluate(el=>[...el.querySelectorAll('h3,span,p')].every(node=>parseFloat(getComputedStyle(node).fontSize)>=13)),'ticket settings remain readable');}
   await page.screenshot({path:join(evidence,`${state}-setup-${width}.png`),fullPage:true});
   await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
   const mail=page.locator('.timeline-item').filter({hasText:'Zendesk'}).first();await mail.getByText('Input and output',{exact:true}).click();
   if(width===1440){
    if(state==='found'){await expect(mail).toContainText('ticket_id');await expect(mail).toContainText('synthetic-crank.zendesk.com');await expect(mail).toContainText('found');const rendered=JSON.parse(await mail.locator('pre').nth(1).innerText());assert.equal(rendered.record.subject,hostileTicketSubject,'the displayed metadata retains the exact hostile header');assert.equal(await page.evaluate(()=>globalThis.zendeskInjected),undefined,'hostile headers are literal text');await expect(mail.locator('pre img')).toHaveCount(0);}
    else{await expect(mail).toContainText('incomplete');await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(0);}
    for(const label of ['Search runs','Your account']){
     const control=page.locator(`[aria-describedby="${label==='Search runs'?'search-tooltip':'account-tooltip'}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});
     await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
    }
   }
   await page.screenshot({path:join(evidence,`${state}-run-${width}.png`),fullPage:true});
   if(state==='found'){
    await page.goto(h.origin+'/app/data');const disclosure=page.locator('details.inline-disclosure').filter({hasText:'Zendesk ticket metadata review'}).first();await disclosure.locator('summary').click();
    if(width===1440){await expect(disclosure).toContainText('https://synthetic-crank.zendesk.com');await expect(disclosure).toContainText('query, metadata_fields');await expect(disclosure).toContainText('Provider-controlled; not verified');assert.ok(!(await disclosure.innerText()).includes('type:ticket tags:bug'),'disclosure lists categories without query values');}
    await page.screenshot({path:join(evidence,`disclosure-${width}.png`),fullPage:true});
   }
  }
 }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
await zendeskSearchJourney({onScreen});
console.log('Zendesk metadata, literal subjects, outcomes and tooltips PASS; screens at 1440 and 390');
}
