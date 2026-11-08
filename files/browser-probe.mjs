import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),packet=process.env.F94_PACKET;
const {chromium,expect}=await import(pathToFileURL(root+'/node_modules/@playwright/test/index.mjs'));
const {harness}=await import(pathToFileURL(root+'/tests/harness.mjs'));
const {serveMcpFixture}=await import(pathToFileURL(root+'/tests/mcp-browser-runtime.mjs'));
const {contentionJourney}=await import(pathToFileURL(root+'/tests/agent-door/journey.mjs'));
let h,browser,context,stop;
try {
 h=await harness('http://127.0.0.1:9',{emitted:true});
 const probe=await contentionJourney({h,observe:async receipt=>writeFile(packet+'/browser-contention.json',JSON.stringify({head:process.env.F94_HEAD,...receipt},null,2)+'\n')});
 stop=await serveMcpFixture(h);
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
 context=await browser.newContext();
 const [name,...value]=h.owner.split('=');
 await context.addCookies([{name,value:value.join('='),url:h.origin}]);
 const page=await context.newPage(),screens=[];
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  await page.goto(h.origin+'/agents');
  if(width===1440) {
   await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();
   await expect(page.getByRole('heading',{name:'Recent activity',exact:true})).toBeVisible();
   const count=page.locator('[data-agents-count][data-class="standard"][data-decision="none"]');
   await expect(count).toHaveText(String(probe.refused));
   await expect(count.locator('..')).toContainText('Not decided');
   await expect(page.locator('section[aria-labelledby="activity-title"]')).toContainText('another decision was running');
   const tiny=await page.locator('main').evaluate(element=>[...element.querySelectorAll('*')].filter(node=>node.getClientRects().length&&node.textContent.trim()&&parseFloat(getComputedStyle(node).fontSize)<13).map(node=>node.tagName));
   assert.deepEqual(tiny,[]);
   const icons=await page.locator('button,a').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length&&!node.textContent.trim()).length);
   assert.equal(icons,0,'Existing agent controls have text labels');
  }
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
  const file=width+'-agents.png';
  await page.screenshot({path:packet+'/'+file,fullPage:true});
  screens.push({width,file,overflow});
  console.log('BROWSER '+width+': summary and activity captured; overflow='+overflow);
 }
 await writeFile(packet+'/browser.json',JSON.stringify({head:process.env.F94_HEAD,status:'pass',assertedWidth:1440,...probe,screens,tooltips:'No icon-only controls on inspected agent screen',uiChanges:false},null,2)+'\n');
} finally {
 await context?.close();await browser?.close();await stop?.();await h?.close();
}
