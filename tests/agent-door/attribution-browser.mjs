/** Installed editor preparation and approval attribution, including inactive history. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {customBrowserRuntime} from '../custom-browser-runtime.mjs';
import {fakeEdge} from '../kit.mjs';
import {nativeAttributionJourney} from './attribution-journey.mjs';

const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence,{recursive:true});
// Extend the existing installed native editor journey, retaining all construction assertions.
await import('../editor-browser.mjs');
const edge=fakeEdge(),runtime=await customBrowserRuntime(edge.edge);
let browser,receiving;
try {
 browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 async function owner(h) {
  await context.clearCookies();const [name,...value]=h.owner.split('=');
  await context.addCookies([{name,value:value.join('='),url:h.origin}]);
 }
 await nativeAttributionJourney(runtime.h,{
  restore:async archive=>{
   receiving=await customBrowserRuntime(edge.edge);await receiving.h.post('data/restore',{archive,confirm:'RESTORE'});
   const setup=await receiving.h.mf.dispatchFetch(receiving.h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:receiving.h.origin,cookie:receiving.h.owner,'content-type':'application'+'/'+'x-www-form-urlencoded'},body:'confirm=yes'});assert.equal(setup.status,303);
   return receiving.h;
  },
  inspect:async({stage,h,workflow,agent,sponsor,reviewer,native})=>{
   await owner(h);await page.setViewportSize({width:1440,height:1000});await page.goto(h.origin+'/app/workflows/'+workflow.id);
   const card=page.locator('.agent-card'),preparation=card.locator('[data-preparation]');
   await expect(preparation).toContainText(agent.name+' for '+sponsor.name);
   await expect(preparation).toContainText('Sponsor: '+sponsor.name);
   if(stage==='autonomous') {await expect(preparation).toContainText('No human approval recorded');await expect(preparation).not.toContainText('Approved by '+reviewer.name)}
   else await expect(preparation).toContainText('Approved by '+reviewer.name);
   assert.ok(await preparation.evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=13));
   await card.getByText('Preparation activity',{exact:true}).click();
   await expect(card.locator('.preparation-activity')).toContainText(agent.name+' for '+sponsor.name);
   if(stage==='retained'||stage==='restored') {
    assert.equal(native.prepared_by.approvers[0].name,reviewer.name);
    await expect(card.locator('.preparation-activity')).toContainText('Approved by '+reviewer.name);
   }
   // Imported names must remain text, never elements or attribute content.
   assert.equal(await card.locator('historical,preparer').count(),0);
   for(const control of await page.locator('a,button,summary').all()) {
    const onlyIcon=await control.evaluate(node=>!node.textContent.trim()&&!!node.querySelector('svg'));
    if(onlyIcon)assert.ok(await control.getAttribute('aria-describedby'),'icon-only controls name their tooltip');
   }
   if(['autonomous','retained','restored'].includes(stage))for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'editor fits '+width);
    await page.screenshot({path:join(evidence,width+'-'+stage+'.png'),fullPage:true});
   }
   if(stage==='retained') {
    await page.setViewportSize({width:1440,height:1000});await page.goto(h.origin+'/agents');
    await expect(page.locator('body')).toContainText(agent.name+' for '+sponsor.name);
    for(const width of [1440,390]) {await page.setViewportSize({width,height:1000});await page.screenshot({path:join(evidence,width+'-activity.png'),fullPage:true})}
   }
  },
 });
 assert.equal(edge.requests.length,0,'draft review and restoration make no provider request');
 console.log('PROBE BASE-AGENT-008 attribution: native MCP and person decisions -> separate preparer, sponsor and signed-in reviewer for create, update and duplicate');
 console.log('PROBE BASE-AGENT-008 refusals: spoofed confirmations, agent and device decisions, form accept, stale revision and revoked reviewer -> no native mutation');
 console.log('PROBE BASE-AGENT-008 custody: person APIs, audit export, restart and inactive archive -> complete retained attribution; no execution');
 console.log('PROBE BASE-AGENT-008 presentation: installed editor and activity -> escaped historical names at 1440 and 390');
} finally {await browser?.close();await receiving?.close();await runtime.close()}
