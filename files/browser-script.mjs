import assert from 'node:assert/strict';
import {writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium, expect} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
import {harness} from '/workspace/run-crank/tests/harness.mjs';
import {serveMcpFixture} from '/workspace/run-crank/tests/mcp-browser-runtime.mjs';
import {contentionJourney} from '/workspace/run-crank/tests/agent-door/journey.mjs';
const evidence = process.argv[2];
await mkdir(evidence, {recursive:true});
const head = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
let h, browser, context, stop, observed;
try {
 h=await harness('http://127.0.0.1:9',{clock:'2026-11-08T12:00:00.000Z'});
 await contentionJourney({h,observe: result => {observed=result}});
 stop=await serveMcpFixture(h);
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
 context=await browser.newContext({viewport:{width:1440,height:1000}});
 const [name,...values]=h.owner.split('=');
 await context.addCookies([{name,value:values.join('='),url:h.origin}]);
 const page=await context.newPage(),screens=[];
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  await page.goto(h.origin+'/agents');
  if(width===1440){
   await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();
   await expect(page.getByRole('heading',{name:'Recent activity'})).toBeVisible();
   await expect(page.locator('[data-agents-count][data-class="standard"][data-decision="none"]')).toHaveText(String(observed.refused));
   await expect(page.getByText('Refused: another decision was running',{exact:false}).first()).toBeVisible();
   await expect(page.getByRole('columnheader',{name:'Handled',exact:true})).toBeVisible();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const tiny=await page.locator('main').evaluate(element=>[...element.querySelectorAll('*')].filter(node=>node.getClientRects().length&&node.textContent.trim()&&parseFloat(getComputedStyle(node).fontSize)<13).length);
   assert.equal(tiny,0);
   const iconOnly=await page.locator('button,a').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length);
   assert.equal(iconOnly,0,'Existing Agents controls have visible text labels');
  }
  const file='agents-'+width+'.png';
  await page.screenshot({path:join(evidence,file),fullPage:true});
  screens.push({width,file,summary:await page.locator('[data-agents-count][data-class="standard"][data-decision="none"]').textContent(),
   overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
 }
 await writeFile(join(evidence,'browser.json'),JSON.stringify({status:'pass',head,door:'/agents',observed,screens,functionalAssertionsWidth:1440},null,2)+'\n');
 console.log('PROBE BASE-AGENT-006 browser: /agents at 1440 and 390 -> contention refusals counted as standard and Not decided; refusal activity retained; no icon-only controls');
}finally{await context?.close();await browser?.close();await stop?.();await h?.close()}
