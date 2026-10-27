import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {invoiceOutcomeJourney} from './invoice-outcome-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM_EXECUTABLE?{executablePath:process.env.CRANK_CHROMIUM_EXECUTABLE}:{}),args:['--use-mock-keychain','--password-store=basic',...(process.platform==='linux'?['--no-sandbox']:[])]});let context,server,active,page;
const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.webp':'image'+'/'+'webp'};
async function attach(h,width){
 if(active===h)return;await context?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}active=h;
 server=createServer(async(req,res)=>{try{const path=new URL(req.url,h.origin).pathname;if(types[extname(path)])for(const root of ['public','dist/client']){const dir=resolve(root),file=resolve(dir,'.'+decodeURIComponent(path));if(!file.startsWith(dir+'/'))continue;const data=await readFile(file).catch(()=>null);if(data){res.writeHead(200,{'content-type':types[extname(path)]});res.end(data);return}}
 const chunks=[];for await(const c of req)chunks.push(c);const headers={...req.headers};delete headers['content-length'];const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch{res.writeHead(503);res.end('Browser transport failed')}});
 await new Promise(r=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',r));context=await browser.newContext({viewport:{width,height:1000}});const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();await page.goto(h.origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
}
try{for(const width of [1440,390]){
 await invoiceOutcomeJourney({inspect:async({h,run,state})=>{await attach(h,width);
 // The grant owner starts this dynamic task. Review it through an independent
 // native owner session, just as the HTTP journey does through its public doors.
 const reviewer = state.startsWith('approve-') || state==='uncertain-readback' ? await h.independentStarter() : h.owner;
 const [cookieName,...cookieValue]=reviewer.split('=');
 await context.addCookies([{name:cookieName,value:cookieValue.join('='),url:h.origin}]);
 await page.goto(h.origin+'/app/workflow-runs/'+run.id+(state==='uncertain-readback'?'?reconcile=verify_invoice':''));
 if(state.startsWith('approve-')){await page.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForLoadState('networkidle');if(state==='approve-uncertain')await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Uncertain');else await expect(page.getByRole('heading',{name:/Invoice criteria verified/})).toBeVisible();return h.get('workflow-runs/'+run.id)}
 if(state==='invalid-amount')await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Failed');else await expect(page.getByRole('heading',{name:state.endsWith('satisfied')?/Invoice criteria verified/:/Invoice obligation open/})).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),state+' overflow');
 const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
 const account=page.locator('.person.control-tooltip');await account.focus();await expect(page.locator('#account-tooltip')).toBeVisible();await page.locator('h1').click();await account.hover();await page.waitForTimeout(350);await expect(page.locator('#account-tooltip')).toBeVisible();
 await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});console.log(`invoice-outcome browser width=${width} state=${state} run=${run.id}`);
 if(state==='uncertain-readback'){await expect(page.getByLabel('Provider record').locator('option')).toHaveCount(1);await page.getByLabel('Reason for this choice').fill('Independent provider readback confirms the lost repair response; continue without repeating it');await page.getByRole('button',{name:'Use record and continue',exact:true}).click();await page.waitForLoadState('networkidle');await expect(page.getByRole('heading',{name:/Invoice criteria verified/})).toBeVisible();return h.get('workflow-runs/'+run.id)}
 }});
}}finally{await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}}
