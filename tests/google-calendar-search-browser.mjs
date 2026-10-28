import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {googleCalendarSearchJourney} from './google-calendar-search-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
async function onScreen({h,w,run}) {
 const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});assert.equal(setup.status,303);
 const server=createServer(async(req,res)=>{try {
  const pathname=new URL(req.url,h.origin).pathname;
  if(types[extname(pathname)])for(const root of ['public','dist/client']) {
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
   const search=page.locator('.timeline-item').filter({hasText:'Calendar event search'}).first();await search.getByText('Input and output',{exact:true}).click();
   if(width===1440) {
    for(const text of ['synthetic-crank-a','synthetic-crank-b','synthetic-crank-c','2026-11-01T01:30:00-05:00','2026-11-01T01:30:00-06:00','cancelled','2026-11-01','synthetic-crank-series','synthetic-crank-person'])await expect(search).toContainText(text);
    assert.equal(await search.locator('img').count(),0,'provider markup renders literally');
    for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
     const control=page.locator(`[aria-describedby="${id}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
    }
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} retained results fit`);
   await page.screenshot({path:join(evidence,`calendar-results-${width}.png`),fullPage:true});
  }
 }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try{await googleCalendarSearchJourney({onScreen})}finally{await browser.close()}
console.log('Retained Calendar identities, zoned times and literal results PASS; screens at 1440 and 390');
