import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {pipedriveSearchJourney,dealTitle} from './pipedrive-search-journey.mjs';

/** Shared retained-search screen proof; assertions run at desktop width and the
 * same native history receives one phone overflow smoke and screenshot. */
export async function pipedriveSearchBrowser(browser,evidence) {
 assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');await mkdir(evidence,{recursive:true});
 const mime=(major,minor)=>[major,minor].join('/');
 const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
 async function onScreen({h,run,state}) {
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});assert.equal(setup.status,303);
  const server=createServer(async(req,res)=>{try {
   const pathname=new URL(req.url,h.origin).pathname;
   if(types[extname(pathname)])for(const root of ['public','dist/client']) {
    const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));if(!file.startsWith(directory+'/'))continue;
    const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
   }
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers={...req.headers};delete headers['content-length'];
   const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503);res.end('Browser transport failed')}});
  await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
  const context=await browser.newContext(),[name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);const view=await context.newPage();
  try {
   for(const width of [1440,390]) {
    await view.setViewportSize({width,height:1000});await view.goto(h.origin+`/app/workflow-runs/${run.id}`);
    const search=view.locator('.timeline-item').filter({hasText:'Pipedrive exact deal lookup'}).first();await search.getByText('Input and output',{exact:true}).click();
    if(width===1440) {
     const visible=JSON.parse(await search.locator('pre').nth(1).innerText());
     if(state==='complete') {
      assert.equal(visible.outcome,'found');assert.equal(visible.complete,true);assert.equal(visible.pages,2);assert.deepEqual(visible.records,[{id:'3',title:dealTitle,status:'open',stage_id:'2'},{id:'10',title:dealTitle,status:'won',stage_id:'4'}]);
      assert.equal(await view.evaluate(()=>globalThis.pipedriveInjected),undefined);assert.equal(await search.locator('img').count(),0,'provider title markup renders literally');
     } else {assert.equal(visible.outcome,'truncated');assert.equal(visible.complete,false);assert.deepEqual(visible.records,[])}
     const small=await search.evaluate(node=>[...node.querySelectorAll('*')].filter(element=>element.textContent.trim()&&getComputedStyle(element).display!=='none'&&element.children.length===0).filter(element=>parseFloat(getComputedStyle(element).fontSize)<13).map(element=>element.className));assert.deepEqual(small,[],'retained search text is at least 13px');
     for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
      const control=view.locator(`[aria-describedby="${id}"]`),tooltip=view.getByRole('tooltip',{name:label,exact:true});await view.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await view.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await view.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
     }
    }
    assert.ok(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} retained search results fit the viewport`);
    await view.screenshot({path:join(evidence,`pipedrive-${state}-${width}.png`),fullPage:true});
   }
  } finally {await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
 }
 await pipedriveSearchJourney({onScreen});
 console.log('Pipedrive retained exact titles, stable stages, incomplete outcomes, literal rendering and tooltips PASS; screens at 1440 and 390');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
 try{await pipedriveSearchBrowser(browser,process.env.CRANK_EVIDENCE)}finally{await browser.close()}
}
