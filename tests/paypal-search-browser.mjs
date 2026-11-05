import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {pathToFileURL} from 'node:url';
import {paypalSearchJourney,invoiceNumber} from './paypal-search-journey.mjs';

export async function paypalSearchBrowser() {
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
async function onScreen({h,w,run,state}) {
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
   const search=page.locator('.timeline-item').filter({hasText:'PayPal invoice lookup'}).first();await search.getByText('Input and output',{exact:true}).click();
   if(width===1440) {
    if(state==='found'){for(const text of ['synthetic-crank-801','found','synthetic-crank-invoice','9007199254740993.0100','USD','SENT'])await expect(search).toContainText(text);const output=JSON.parse(await search.locator('pre').nth(1).innerText());assert.equal(output.record.number,invoiceNumber);assert.equal(await page.evaluate(()=>globalThis.paypalInjected),undefined);await expect(search.locator('img')).toHaveCount(0)}
    else{await expect(search).toContainText('not found');await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(0)}
    for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
     const control=page.locator(`[aria-describedby="${id}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
    }
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} retained results fit`);
   await page.screenshot({path:join(evidence,`paypal-${state}-${width}.png`),fullPage:true});
  }
 }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try{await paypalSearchJourney({onScreen})}finally{await browser.close()}
console.log('PayPal retained identities, exact decimal totals, literal invoice numbers and tooltips PASS; screens at 1440 and 390');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await paypalSearchBrowser();
