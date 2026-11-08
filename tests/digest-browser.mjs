import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
const { chromium, expect } = await import('@playwright' + '/test');
import { digestJourney } from './digest-journey.mjs';
const mediaType=(major,minor)=>[major,minor].join('/');
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence,{recursive:true});
await digestJourney({onRelease:async({h,detail})=>{
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mediaType('application','x-www-form-urlencoded')},body:'confirm=yes'});
  assert.equal(setup.status,303);
  const server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,h.origin).pathname,asset=resolve('public','.'+pathname),root=resolve('public');
      if(asset.startsWith(root+'/')) {
        const bytes=await readFile(asset).catch(()=>null);
        if(bytes) {const types={'.css':mediaType('text','css'),'.js':mediaType('text','javascript'),'.svg':mediaType('image','svg+xml'),'.woff2':mediaType('font','woff2'),'.png':mediaType('image','png'),'.ico':mediaType('image','x-icon'),'.webp':mediaType('image','webp')};res.writeHead(200,{'content-type':types[extname(asset)]??mediaType('application','octet-stream')});res.end(bytes);return}
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{}),redirect:'manual'});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500);res.end('Browser transport failed')}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browserOrigin='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
    const context=await browser.newContext();const [name,...value]=h.owner.split('=');
    await context.addCookies([{name,value:value.join('='),url:browserOrigin}]);
    const page=await context.newPage();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.goto(browserOrigin+'/app/workflow-runs/'+detail.id);
      // Existing run history renders every native step through the same result disclosure.
      const disclosures=page.locator('details').filter({has:page.getByText('Input and output',{exact:true})});
      await disclosures.first().locator('summary').click();
      if(width===1440) {
      const output=disclosures.first();
      await expect(output).toContainText('synthetic-crank-1');await expect(output).toContainText('synthetic-crank-7');
      await expect(output).toContainText('"count": 7');await expect(output).toContainText('source_run_id');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}: release history fits viewport`);
      for(const label of ['Search runs','Your account']) {
        const tip=page.getByRole('tooltip',{name:label,exact:true});
        const control=page.locator(`[aria-describedby="${label==='Search runs'?'search-tooltip':'account-tooltip'}"]`);
        await page.mouse.move(0,0);await control.blur();await expect(tip).toBeHidden();await control.hover();
        await page.waitForTimeout(150);await expect(tip).toBeHidden();await expect(tip).toBeVisible();
        await page.mouse.move(0,0);await control.focus();await expect(tip).toBeVisible({timeout:100});await control.blur();
      }
      }
      await page.screenshot({path:join(evidence,`${width}-digest-release.png`),fullPage:true});
    }
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve))}
}});
console.log('Digest release history and tooltips PASS at 1440 and 390');
