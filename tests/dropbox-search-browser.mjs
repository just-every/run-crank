import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {dropboxSearchJourney,dropboxCustodyJourney,filename} from './dropbox-search-journey.mjs';
import {gmailBrowserJourney} from './gmail-search-browser.mjs';
import {calendarSearchBrowserJourney} from './google-calendar-search-browser.mjs';
async function dropboxBrowserJourney() {
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
async function onScreen({h,w,run,state,restrictedCookie}) {
 const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});assert.equal(setup.status,303);
 const server=createServer(async(req,res)=>{try {
  const pathname=new URL(req.url,h.origin).pathname;
  if(types[extname(pathname)])for(const root of ['./public','./dist/client']) {
   const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));if(!file.startsWith(directory+'/'))continue;
   const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers={...req.headers};delete headers['content-length'];
  const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end('Browser transport failed')}});
 await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
 const context=await browser.newContext(),[name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);const page=await context.newPage();
 try {
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
   const search=page.locator('.timeline-item').filter({hasText:'Dropbox file lookup'}).first();await search.getByText('Input and output',{exact:true}).click();
   if(width===1440) {
    if(state==='incomplete') {
     await expect(search).toContainText('incomplete');
     await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(0);
    } else {
     const rendered=JSON.parse(await search.locator('pre').nth(1).innerText());
     assert.equal(rendered.record.name,filename);assert.equal(rendered.record.folder_relative_path,filename);
     assert.equal(rendered.record.rev,'000000001');assert.equal(rendered.record.size,42);
     await expect(search).toContainText('id:synthetic-crank-a');await expect(search).toContainText('id:synthetic-crank-b');
     assert.equal(await search.locator('pre img').count(),0,'provider markup renders literally');
     assert.equal(await page.evaluate(()=>globalThis.dropboxInjected),undefined);
    }
    for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
     const control=page.locator(`[aria-describedby="${id}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
    }
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} retained results fit`);
   await page.screenshot({path:join(evidence,`${state}-results-${width}.png`),fullPage:true});
   if(state==='found') {
    await page.goto(h.origin+'/app/data');
    if(width===1440){await expect(page.locator('body')).toContainText('api.dropboxapi.com');await expect(page.locator('body')).toContainText('folder_path');await expect(page.locator('body')).toContainText('bearer');}
    await page.screenshot({path:join(evidence,`disclosure-${width}.png`),fullPage:true});
   }
   if(restrictedCookie) {
    const [restrictedName,...restrictedValue]=restrictedCookie.split('=');await context.addCookies([{name:restrictedName,value:restrictedValue.join('='),url:h.origin}]);
    await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
    if(width===1440){await expect(page.locator('body')).not.toContainText(filename);await expect(page.locator('body')).not.toContainText('id:synthetic-crank-a');}
    await page.screenshot({path:join(evidence,`restricted-${width}.png`),fullPage:true});
    await context.addCookies([{name,value:value.join('='),url:h.origin}]);
   }
  }
 }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try{await dropboxSearchJourney({onScreen});await dropboxCustodyJourney({onScreen})}finally{await browser.close()}
console.log('Dropbox exact names, revisions, metadata disclosure, incomplete scans, sealed history and payload restrictions PASS; screens at 1440 and 390');

}

// A single provider-search browser sanity command retains both existing adapters.
await gmailBrowserJourney();
await calendarSearchBrowserJourney();
await dropboxBrowserJourney();
