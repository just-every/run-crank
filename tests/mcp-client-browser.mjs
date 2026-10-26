import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {mcpClientFixture,eventTime} from './mcp-client-journey.mjs';
import {serveMcpFixture} from './mcp-browser-runtime.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
let browser,page,f,stop;
try{
 f=await mcpClientFixture({emitted:true});const {h}=f;stop=await serveMcpFixture(h);
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 const context=await browser.newContext(),[name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
 await page.goto(h.origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
 const shot=async(width,state)=>{await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`)};
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(h.origin+'/app/access');await shot(width,'access');
  await page.getByRole('link',{name:'Manage client tool servers',exact:true}).click();await page.waitForLoadState('networkidle');await shot(width,'client-servers');
  for(const [selector,tooltip] of [['.search.control-tooltip','#search-tooltip'],['.person.control-tooltip','#account-tooltip']]){
   const control=page.locator(selector);await control.focus();await expect(page.locator(tooltip)).toBeVisible();await page.locator('h1').click();await control.hover();await page.waitForTimeout(350);await expect(page.locator(tooltip)).toBeVisible();
  }
  await page.locator('h1').click();await page.getByLabel('Client name').fill('Harbor appointments and operations · '+width);await page.getByLabel('Published tool workflow').selectOption(f.workflow.id);await page.getByLabel('Expires at (UTC)',{exact:true}).fill(f.input.expires_at);
  await page.getByText('Tool and grant setup',{exact:true}).click();await page.getByLabel('Enabled tools (JSON)').fill(JSON.stringify(f.input.tools,null,2));await page.getByLabel('Standing grant (JSON)').fill(JSON.stringify(f.input.policy,null,2));await shot(width,'review-client-tools');
  await page.getByRole('button',{name:'Create client server',exact:true}).click();await page.waitForLoadState('networkidle');await expect(page.getByLabel('Client secret',{exact:true})).toBeVisible();
  const clientUrl=await page.getByLabel('Server URL',{exact:true}).inputValue(),secret=await page.getByLabel('Client secret',{exact:true}).inputValue();assert.ok(secret);
  // Hide only the password glyphs in evidence; the real issued secret stays private.
  await shot(width,'client-created');await page.getByRole('link',{name:'Return to client servers',exact:true}).click();
  const call=async(tool,args)=>{const r=await context.request.post(clientUrl,{headers:{accept:'application'+'/'+'json, text'+'/'+'event-stream',authorization:'Bearer '+secret,'mcp-protocol-version':'2025-06-18'},data:{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools'+'/'+'call',params:{name:tool,arguments:args}}});return {status:r.status(),value:await r.json()}};
  const event=await call('create_calendar_event',{summary:'Harbor appointment · '+width,...eventTime});assert.equal(event.status,200);const run=event.value.result.structuredContent.run;assert.equal(run.status,'succeeded');
  const disabled=await call('find_hubspot_contact',{});assert.equal(disabled.status,403);
  const refused=(await h.get('mcp-clients/'+new URL(clientUrl).pathname.split('/').at(-1)+'/calls')).find(c=>c.status==='refused');await page.goto(h.origin+'/app/workflow-runs/'+refused.run_id);await shot(width,'refused-call-run');
  const held=await call('review_channel_message',{text:'Harbor appointment confirmed · '+width});assert.equal(held.status,200);const waiting=held.value.result.structuredContent.run;assert.equal(waiting.status,'awaiting_approval');
  await page.goto(h.origin+'/app/workflow-runs/'+waiting.id);await shot(width,'client-approval');
  await h.post('workflow-runs/'+waiting.id+'/approve',{path:waiting.waits[0].path,digest:waiting.waits[0].proposal_digest});
  await page.goto(h.origin+'/app/workflow-runs/'+run.id);await shot(width,'calendar-readback');
  const clientId=new URL(clientUrl).pathname.split('/').at(-1);await page.goto(h.origin+'/app/settings/mcp?client='+clientId);await shot(width,'client-history');
  const row=page.locator('li.history-item').filter({has:page.getByRole('heading',{name:'Harbor appointments and operations · '+width,exact:true})});
  await row.getByRole('button',{name:'Revoke client',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal((await call('send_channel_message',{channel:f.slackChannel,text:'synthetic-crank-70'})).status,401);await shot(width,'client-revoked');
  console.log(`PLATFORM-002 ${width}: owner issuance, selected typed tools, approval, verified Calendar edge, refusal, call history, revocation and shell tooltips passed`);
 }
 await context.close();
}catch(error){if(page)await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error(String(error.message).replace(/crm_[A-Za-z0-9_-]+/g,'[redacted secret]'));process.exitCode=1}
finally{await browser?.close();await stop?.();await f?.h.close()}
