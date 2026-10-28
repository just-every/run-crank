import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {inboundEmailJourney} from './inbound-email-journey.mjs';

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
      if(types[extname(pathname)])for(const root of ['public','dist/client']) {
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
      await page.setViewportSize({width,height:1000});await page.goto(h.origin+'/app/settings/email');
      if(width===1440) {
        await expect(page.getByRole('heading',{name:'Email settings',exact:true})).toBeVisible();
        const history=page.getByRole('region',{name:'Email admission history'});
        for(const decision of ['admitted','duplicate','Sender is not allowed','Alias revoked or inactive','Trusted routing authentication evidence unavailable'])await expect(history).toContainText(decision);
        await expect(page.getByRole('heading',{name:w.name,exact:true})).toBeVisible();
        const link=history.getByRole('link',{name:'Open run'}).first();await expect(link).toHaveAttribute('href',/^\/app\/workflow-runs\//);
        for(const label of ['Search runs','Your account']) {
          const control=page.locator(`[aria-describedby="${label==='Search runs'?'search-tooltip':'account-tooltip'}"]`),tooltip=page.getByRole('tooltip',{name:label,exact:true});
          await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
        }
        assert.ok(await page.locator('.panel').evaluateAll(panels=>panels.every(panel=>[...panel.querySelectorAll('p,label,button,a,h2,h3,strong')].every(el=>parseFloat(getComputedStyle(el).fontSize)>=13))),'settings text is at least 13 pixels');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} email settings fits`);
      await page.screenshot({path:join(evidence,`${width}-email-admission.png`),fullPage:true});
      await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
      const mapping=page.locator('.timeline-item').filter({hasText:'Formatter'}).first();await mapping.getByText('Input and output',{exact:true}).click();
      if(width===1440){await expect(mapping).toContainText('Forwarded purchase order');await expect(mapping).toContainText('order.pdf');await expect(mapping).toContainText('PO 4301');await expect(mapping).toContainText('Vendor PO')}
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} email run fits`);
      await page.screenshot({path:join(evidence,`${width}-email-run.png`),fullPage:true});
    }
  } finally {await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try {await inboundEmailJourney({onScreen,emitted:true})} finally {await browser.close()}
console.log('Inbound email admission history and mapped file custody PASS at 1440; matching 390 proof captured');
