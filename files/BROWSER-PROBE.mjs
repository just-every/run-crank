import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium, expect} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
import {harness} from '/workspace/run-crank/tests/harness.mjs';
import {contentionJourney} from '/workspace/run-crank/tests/agent-door/journey.mjs';
import {serveMcpFixture} from '/workspace/run-crank/tests/mcp-browser-runtime.mjs';
const packet = process.env.HOME + '/rer-consolidation/work/sx-crank-c-f93/packet';
let h, browser, stop, context;
try {
 h = await harness('http://127.0.0.1:9', {clock:'2026-11-08T12:00:00.000Z'});
 stop = await serveMcpFixture(h);
 await contentionJourney({h, observe: row => writeFile(packet + '/candidate-contention.json', JSON.stringify(row,null,2)+'\n')});
 browser = await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
 context = await browser.newContext();
 const [name,...value] = h.owner.split('=');
 await context.addCookies([{name,value:value.join('='),url:h.origin}]);
 const page = await context.newPage(), screens = [];
 for (const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  await page.goto(h.origin+'/agents');
  await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Recent activity',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'This week',exact:true})).toBeVisible();
  if (width === 1440) {
   await expect(page.locator('#activity-title').locator('..')).toContainText('Refused');
   await expect(page.locator('[data-agents-count][data-class="standard"][data-decision="none"]')).not.toHaveText('0');
   assert.ok(await page.locator('[data-agents-count][data-class="standard"][data-decision="none"]').count());
   const tiny = await page.locator('main').evaluate(el => [...el.querySelectorAll('*')].filter(node=>node.getClientRects().length && node.textContent.trim() && parseFloat(getComputedStyle(node).fontSize)<13).map(node=>node.tagName));
   assert.deepEqual(tiny,[]);
   const icons = await page.locator('a,button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length);
   assert.equal(icons,0,'Existing Agents controls have visible text labels');
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const file='agents-'+width+'.png';
  await page.screenshot({path:packet+'/'+file,fullPage:true});
  screens.push({width,file,activity:await page.locator('#activity-title').locator('..').innerText(),summaries:await page.locator('#week-title').locator('..').innerText()});
 }
 await writeFile(packet+'/browser-receipt.json',JSON.stringify({status:'pass',door:'/agents',screens,controls:'Text-labelled; no icon-only controls',assertionWidth:1440},null,2)+'\n');
 console.log('PROBE BASE-AGENT-006 6: existing Agents activity and summaries at 1440 and 390 PASS');
} finally {
 await context?.close(); await browser?.close(); await stop?.(); await h?.close();
}
