import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {driftRepairJourney} from './drift-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});let context,server,active,page;
const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
async function attach(h,width){
 if(active===h)return;await context?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}active=h;
 server=createServer(async(req,res)=>{try{const path=new URL(req.url,h.origin).pathname;if(types[extname(path)])for(const root of ['public','dist/client']){const dir=resolve(root),file=resolve(dir,'.'+decodeURIComponent(path));if(!file.startsWith(dir+'/'))continue;const data=await readFile(file).catch(()=>null);if(data){res.writeHead(200,{'content-type':types[extname(path)]});res.end(data);return}}
 const chunks=[];for await(const c of req)chunks.push(c);const headers={...req.headers};delete headers['content-length'];const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()))}catch{res.writeHead(503);res.end('Browser transport failed')}});
 await new Promise(r=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',r));context=await browser.newContext({viewport:{width,height:1000}});const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();await page.goto(h.origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
}
try{for(const width of [1440,390]){
 await driftRepairJourney({inspect:async({h,workflow,proposal,bindings,state})=>{await attach(h,width);
 await page.goto(h.origin+'/app/workflows/'+workflow.id+'/drift');await expect(page.getByRole('heading',{name:'Detected provider changes',exact:true})).toBeVisible();await page.screenshot({path:join(evidence,`${width}-${state}-incidents.png`),fullPage:true});
 await page.goto(h.origin+'/app/drift/'+proposal.proposal.id);
 await expect(page.getByRole('heading',{name:state==='scope'?'Review requested scopes':'Review mapping repair',exact:true,level:2})).toBeVisible();
 if(state==='tested')await expect(page.getByRole('link',{name:'Sandbox succeeded',exact:true})).toHaveCount(20);
 if(state==='approved')await expect(page.getByRole('heading',{name:'Repair deployed',exact:true})).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),state+' overflow');
 const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
 await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});console.log(`drift browser width=${width} state=${state} proposal=${proposal.proposal.id}`);
 if(state==='scope'){await page.getByRole('button',{name:'Reject new scope',exact:true}).click();await page.waitForLoadState('networkidle');return h.get('drift/'+proposal.proposal.id)}
 if(state==='proposal'){for(const [source,target] of Object.entries(bindings))await page.locator('[name="binding_'+source+'"]').selectOption(target);await page.getByRole('button',{name:'Replay retained cases',exact:true}).click();await page.waitForLoadState('networkidle');return h.get('drift/'+proposal.proposal.id)}
 if(state==='tested'){await page.getByRole('checkbox').check();for(const kind of ['orchestration','connectors','models','executors']){await page.locator('[name="estimate_'+kind+'_usd_per_run"]').fill('0');await page.locator('[name="estimate_'+kind+'_assumption"]').fill('Owned acceptance receiver and sandbox accounts; zero observed charge')}await page.getByRole('button',{name:'Approve mapping and resume',exact:true}).click();await page.waitForLoadState('networkidle');return h.get('drift/'+proposal.proposal.id)}
 if(state==='rollback'){await page.getByRole('button',{name:'Roll back mapping and hold writes',exact:true}).click();await page.waitForLoadState('networkidle');return h.get('drift/'+proposal.proposal.id)}
 if(state==='approved')for(const continuation of proposal.continuations){await page.goto(h.origin+'/app/workflow-runs/'+continuation.run_id);await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Success');await page.screenshot({path:join(evidence,`${width}-continued-${continuation.run_id.slice(0,8)}.png`),fullPage:true})}
 }});
}}finally{await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}}
