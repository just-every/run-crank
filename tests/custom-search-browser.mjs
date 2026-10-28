import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
import {customBrowserRuntime} from './custom-browser-runtime.mjs';
import {customSearchFixture} from './custom-search-fixture.mjs';
import {customSearchBrowser} from './private-write-browser.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const f=await customSearchFixture({browser:true});let browser,page,restored;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext();
  // This cookie is minted by the isolated synthetic fixture, never a real profile.
  const cookie=await f.h.independentStarter(),[name,...parts]=cookie.split('=');
  await context.addCookies([{name,value:parts.join('='),url:f.h.origin}]);page=await context.newPage();
  const shots=async(name,setup)=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});if(setup)await setup();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow');await page.screenshot({path:join(evidence,width+'-'+name+'.png'),fullPage:true})}await page.setViewportSize({width:1440,height:1000})};
  const runs=await customSearchBrowser({f,page,shots});
  const archive=await f.h.send('/api/crank/data/export',{},f.h.owner);assert.equal(archive.status,200);
  restored=await customBrowserRuntime();await restored.h.post('data/restore',{archive:archive.text,confirm:'RESTORE'});
  const [restoredName,...restoredValue]=restored.h.owner.split('=');
  await context.addCookies([{name:restoredName,value:restoredValue.join('='),url:restored.origin}]);
  assert.equal((await restored.h.get('workflow-runs/'+runs.waiting)).status,'paused');
  await restored.h.tick();assert.equal((await restored.h.get('workflow-runs/'+runs.waiting)).status,'paused');
  const table=await restored.h.get('tables/'+runs.table);assert.equal(table.table.active,0);assert.deepEqual(table.records.map(record=>({key:record.key,value:record.value})),[{key:'inspected_count',value:27}]);
  const tableHistory=await restored.h.get('workflow-runs/'+runs.tableCreated);assert.equal(tableHistory.steps.find(step=>step.step_id==='lookup').output.outcome,'created');
  await page.goto(restored.origin+'/app/connections');
  if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.goto(restored.origin+'/app/connections')}
  assert.match(await page.locator('body').innerText(),/revoked/i);
  await shots('custom-search-inactive-restore',()=>page.goto(restored.origin+'/app/connections'));
  const historical=await restored.h.get('workflow-runs/'+runs.created);assert.equal(historical.steps.find(s=>s.step_id==='search').output.outcome,'created');
  await shots('custom-search-restored-history',async()=>{await page.goto(restored.origin+'/app/workflow-runs/'+runs.created);await page.getByText('Input and output',{exact:true}).click()});
  console.log('custom-search-browser PASS: exact approval and created then found retained histories at 1440 and 390');
}catch(error){if(page)await page.screenshot({path:join(evidence,'search-error.png'),fullPage:true});throw error}
finally{await browser?.close();await restored?.close();await f.close()}
