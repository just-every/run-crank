/** Financial owner journeys at the installed UI's public doors. Use heavy-slot. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {quickbooksReconciliationJourney} from './effect-readback-journey.mjs';
import {gustoHandoffJourney} from './gusto-handoff-journey.mjs';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
let server,context,page,active;
const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
async function attach(h,width) {
 if(active===h)return;
 await context?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}
 active=h;
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
 context=await browser.newContext({viewport:{width,height:1000}});
 const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
 await page.goto(h.origin+'/setup');
 if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click()}
}
async function shot(width,state) {
 await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`);
 const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);await expect(page.locator('#search-tooltip')).toBeVisible();
}
try {
 for(const width of [1440,390]) {
  await quickbooksReconciliationJourney({inspect:async({h,run,decision,state})=>{
   await attach(h,width);
   await page.goto(h.origin+`/app/workflow-runs/${run.id}`+(state==='multiple'||state==='choose'?'?reconcile=invoice':''));
   if(state==='choose'){
    await page.getByLabel('Reason for this choice').fill(decision.reason);
    await page.getByRole('button',{name:'Use record and continue',exact:true}).click();await page.waitForLoadState('networkidle');
    await expect(page.getByText('Read back, not repeated',{exact:true})).toBeVisible();await shot(width,'owner-continued');return h.get('workflow-runs/'+run.id);
   }
   if(state==='multiple')await expect(page.getByLabel('Provider record').locator('option')).toHaveCount(2);
   await shot(width,state);
  }});
  await gustoHandoffJourney({inspect:async({h,bound,company,run,state,preview})=>{
   await attach(h,width);
   if(state==='gusto-uncertain'){
    await page.goto(h.origin+`/app/workflow-runs/${run.id}?reconcile=handoff`);
    await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Uncertain');
    await expect(page.locator('.timeline-item[data-state="uncertain"]')).toHaveCount(1);
    await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(run.steps.filter(step=>step.status==='succeeded').length);
    const record=page.getByLabel('Provider record');await expect(record.locator('option')).toHaveCount(preview.matches.length);
    await record.selectOption(preview.matches[0].Id);
    await page.getByLabel('Reason for this choice').fill('Confirmed the original Gusto worker after the lost acknowledgement; retain completed checkpoints and continue once');
    await shot(width,'gusto-uncertain');
    await page.getByRole('button',{name:'Use record and continue',exact:true}).click();await page.waitForLoadState('networkidle');
    await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Success');
    await expect(page.getByText('Read back, not repeated',{exact:true})).toBeVisible();return true;
   }
   if(state==='gusto-reconciled'){
    await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
    await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Success');
    await expect(page.getByText('Read back, not repeated',{exact:true})).toBeVisible();
    await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(run.steps.length);
    await expect(page.locator('.timeline-item[data-state="uncertain"]')).toHaveCount(0);
    await shot(width,'gusto-reconciled');return;
   }
   if(state==='consent'){
    await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
    await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Paused');
    const requirements=page.locator('.detail-primary > .notice');
    await expect(requirements).toContainText(/agreement reference/i);
    await expect(requirements).toContainText(/owner consent/i);
    await expect(requirements).toContainText('contractor_1099_handoff');
    const obligation=page.locator('.timeline-item[data-state="waiting"]');
    await expect(obligation).toHaveCount(1);
    await expect(obligation.locator('.timeline-head .status')).toHaveText('Waiting');
    await obligation.getByText('Input and output',{exact:true}).click();
    const retained=JSON.parse(await obligation.locator('pre').first().innerText());
    const held=run.steps.find(step=>step.status==='waiting').input;
    assert.equal(retained.currency,held.currency);assert.deepEqual(retained.tax_lines,held.tax_lines);assert.equal(retained.ach_reference,held.ach_reference);
    await expect(page.getByRole('button',{name:'Resume run',exact:true})).toBeVisible();
    await shot(width,'paused-gusto');
    await page.goto(h.origin+'/app/account');await shot(width,'account-provider-settings');
    await page.getByRole('link',{name:'Review Gusto responsibilities and operation consent',exact:true}).click();
    await page.getByLabel('Gusto company identifier').fill(company);await page.getByRole('button',{name:'Inspect requirements',exact:true}).click();
    const disclosure=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Send contractor data for 1099 preparation'})});await disclosure.locator('summary').click();
    await shot(width,'provider-consent-required');
    await disclosure.getByLabel('Owner-attested completed agreement reference').fill('synthetic-crank-6');await disclosure.getByRole('checkbox').check();await disclosure.getByRole('button',{name:'Authorize operation',exact:true}).click();await page.waitForLoadState('networkidle');
    await expect(page.locator('summary').filter({hasText:'Send contractor data for 1099 preparation · Authorized'})).toBeVisible();await shot(width,'provider-authorized');return true;
   }
   await page.goto(h.origin+`/app/workflow-runs/${run.id}`);await expect(page.getByText('Success',{exact:true}).first()).toBeVisible();await shot(width,state);
  }});
  console.log(`Financial owner journeys ${width}: retained Gusto obligation, provider consent, owner readback choice, continuation, compensation and shared tooltips passed`);
 }
}finally{await context?.close();await browser.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}}
