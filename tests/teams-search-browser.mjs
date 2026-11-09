import {expectHoverTooltip} from './tooltip-browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {pathToFileURL} from 'node:url';
import {teamsSearchJourney,teamsCustodyJourney,hostileName} from './teams-search-journey.mjs';

export async function teamsSearchBrowser() {
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
async function onScreen({h,w,run,state,cookie=h.owner}) {
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
 const context=await browser.newContext(),[name,...value]=cookie.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);const page=await context.newPage();
 try {
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
   const search=page.locator('.timeline-item').filter({hasText:'Teams directory lookup'}).first();
   if(state!=='restricted')await search.getByText('Input and output',{exact:true}).click();
   if(width===1440) {
    if(state==='found'||state==='sealed'){for(const text of ['synthetic-crank-a',state==='sealed'?'synthetic-crank-c':'synthetic-crank-b','found','synthetic-crank-name','userPrincipalName'])await expect(search).toContainText(text);const output=JSON.parse(await search.locator('pre').nth(1).innerText());assert.equal(output.records[0].displayName,hostileName);assert.equal(await page.evaluate(()=>globalThis.teamsInjected),undefined);await expect(search.locator('img')).toHaveCount(0)}
    else if(state==='incomplete'){await expect(search).toContainText('incomplete');await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(0)}
    else if(state==='restored'){await expect(search).toContainText('sealed');assert.ok(!(await page.locator('body').innerText()).includes(hostileName));}
    else if(state==='expired'){assert.equal(JSON.parse(await search.locator('pre').innerText()),null);assert.ok(!(await page.locator('body').innerText()).includes(hostileName));}
    else {await expect(page.getByText('Input and output',{exact:true})).toHaveCount(0);assert.ok(!(await page.locator('body').innerText()).includes(hostileName));await expect(page.getByText('Restricted for your role.',{exact:true})).toBeVisible();}
    const small=await page.locator('body').evaluate(root=>[...root.querySelectorAll('*')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility==='visible'&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(el).fontSize)<13).map(el=>el.tagName));assert.deepEqual(small,[]);
    for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
     const control=page.locator(`[aria-describedby="${id}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});await expectHoverTooltip(page,control,tooltip);await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
    }
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} retained results fit`);
   await page.screenshot({path:join(evidence,`teams-${state}-${width}.png`),fullPage:true});
   if(state==='found'){
    await page.goto(h.origin+'/app/data');
    const disclosure=page.locator('details.inline-disclosure').filter({hasText:'Teams exact email review'}).first();await disclosure.locator('summary').click();
    if(width===1440){for(const text of ['graph.microsoft.com','email','projection','bearer','not verified'])await expect(disclosure).toContainText(text);assert.ok(!(await disclosure.innerText()).includes(hostileName));}
    await page.screenshot({path:join(evidence,`teams-disclosure-${width}.png`),fullPage:true});
   }
  }
 }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try{await teamsSearchJourney({onScreen});await teamsCustodyJourney({onScreen})}finally{await browser.close()}
console.log('Teams directory retained identities, exact outcomes, literal names and tooltips PASS; screens at 1440 and 390');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await teamsSearchBrowser();
