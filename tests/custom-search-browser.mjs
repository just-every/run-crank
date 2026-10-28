import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
import {customSearchFixture} from './custom-search-fixture.mjs';
import {customSearchBrowser} from './private-write-browser.mjs';
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const f=await customSearchFixture({browser:true});let browser,page;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext();
  // This cookie is minted by the isolated synthetic fixture, never a real profile.
  const cookie=await f.h.independentStarter(),[name,...parts]=cookie.split('=');
  await context.addCookies([{name,value:parts.join('='),url:f.h.origin}]);page=await context.newPage();
  const shots=async(name,setup)=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});if(setup)await setup();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow');await page.screenshot({path:join(evidence,width+'-'+name+'.png'),fullPage:true})}await page.setViewportSize({width:1440,height:1000})};
  await customSearchBrowser({f,page,shots});
  console.log('custom-search-browser PASS: exact approval and created then found retained histories at 1440 and 390');
}catch(error){if(page)await page.screenshot({path:join(evidence,'search-error.png'),fullPage:true});throw error}
finally{await browser?.close();await f.close()}
