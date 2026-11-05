import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {twilioInboundJourney,smsAccount,smsNumber} from './twilio-inbound-journey.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
async function onScreen({h,w,run}) {
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});assert.equal(setup.status,303);
  const server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,h.origin).pathname;
      if(types[extname(pathname)])for(const root of ['public','./dist/client']) {
        const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));if(!file.startsWith(directory+'/'))continue;
        const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const headers={...req.headers};delete headers['content-length'];
      const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(503);res.end('Browser transport failed')}
  });
  await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
  const context=await browser.newContext(),[name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);const page=await context.newPage();
  try {
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});await page.goto(h.origin+`/app/workflows/${w.id}?step=trigger&tab=setup`);
      if(width===1440) {
        const inspector=page.locator('.inspector');await expect(inspector).toContainText('Twilio SMS');await expect(inspector).toContainText(smsAccount);await expect(inspector).toContainText(smsNumber);
        await expect(inspector).toContainText(w.callback);await expect(inspector).toContainText('ownership and provisioning unverified');
        for(const label of ['Search runs','Your account']) {
          const control=page.locator(`[aria-describedby="${label==='Search runs'?'search-tooltip':'account-tooltip'}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});
          await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
        }
        assert.ok(await inspector.locator('.field').evaluateAll(fields=>fields.every(field=>[...field.children].every(el=>parseFloat(getComputedStyle(el).fontSize)>=13))),'receiving fields use readable text');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} SMS editor fits`);
      await page.screenshot({path:join(evidence,`${width}-sms-editor.png`),fullPage:true});
      await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
      const mapping=page.locator('.timeline-item').filter({hasText:'Formatter'}).first();await mapping.getByText('Input and output',{exact:true}).click();
      if(width===1440){await expect(mapping).toContainText('synthetic-crank-1702');await expect(mapping).toContainText(smsNumber);await expect(mapping).toContainText(smsAccount);await expect(page.locator('body')).toContainText('Inbound SMS')}
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} SMS run fits`);
      await page.screenshot({path:join(evidence,`${width}-sms-run.png`),fullPage:true});
    }
  } finally {await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try {await twilioInboundJourney({onScreen,emitted:true})} finally {await browser.close()}
console.log('Twilio SMS published binding and retained typed input PASS at 1440; matching 390 proof captured');
