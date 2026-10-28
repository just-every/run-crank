import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {aiClassificationJourney,aiCustodyJourney,model,endpoint} from './ai-steps-journey.mjs';

const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence,{recursive:true});
const mime=(major,minor)=>[major,minor].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});

async function onScreen({h,w,run,state}) {
  // The native page handlers, session, data and shipped editor assets are served
  // unchanged; the model edge is the journey's only provider fake.
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});
  assert.equal(setup.status,303);
  const server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,h.origin).pathname;
      if(types[extname(pathname)])for(const root of ['public','dist/client']) {
        const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));
        if(!file.startsWith(directory+'/'))continue;
        const bytes=await readFile(file).catch(()=>null);
        if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const headers={...req.headers};delete headers['content-length'];
      const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(503);res.end('Browser transport failed')}
  });
  await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
  const context=await browser.newContext(),[name,...value]=h.owner.split('=');
  await context.addCookies([{name,value:value.join('='),url:h.origin}]);
  const page=await context.newPage();
  try {
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      if(state!=='uncertain') {
        await page.goto(h.origin+`/app/workflows/${w.id}?step=classify&tab=setup`);
        if(width===1440) {
          const inspector=page.getByRole('region',{name:'Selected step'});
          await expect(inspector).toContainText(model);await expect(inspector).toContainText(endpoint);
          await expect(inspector).toContainText('sales, support');await expect(inspector).toContainText('Text only');
        }
        await page.screenshot({path:join(evidence,`${width}-${state}-setup.png`),fullPage:true});
        await page.goto(h.origin+`/app/workflows/${w.id}?step=classify&tab=data`);
        if(width===1440) {
          const inspector=page.getByRole('region',{name:'Selected step'});
          if(state==='classified') {
            await expect(inspector).toContainText('synthetic-crank-response');
            await expect(inspector).toContainText('quoted_usd');await expect(inspector).toContainText('provider_reported_usd');
            await expect(inspector).toContainText('unknown');await expect(inspector).toContainText('support');
          }else await expect(inspector).toContainText('invalid structured output');
        }
        await page.screenshot({path:join(evidence,`${width}-${state}-editor.png`),fullPage:true});
      }
      await page.goto(h.origin+`/app/workflow-runs/${run.id}`);
      const ai=page.locator('.timeline-item').filter({hasText:'AI classification'}).first();
      await ai.getByText('Input and output',{exact:true}).click();
      if(width===1440) {
        if(state==='classified')await expect(ai).toContainText('synthetic-crank-response');
        else if(state==='refused') {
          await expect(ai).toContainText('invalid structured output');
          await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(0);
        }else {
          await expect(ai).toContainText('response is unknown');
          await expect(ai).toContainText(run.steps.find(step=>step.step_id==='classify').operation_key);
          await expect(page.locator('.timeline-item[data-state="succeeded"]')).toHaveCount(1);
        }
        for(const label of ['Search runs','Your account']) {
          const control=page.locator(`[aria-describedby="${label==='Search runs'?'search-tooltip':'account-tooltip'}"]`);
          const tooltip=page.getByRole('tooltip',{name:label,exact:true});
          await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();
          await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();
          await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
        }
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} fits the viewport`);
      await page.screenshot({path:join(evidence,`${width}-${state}-run.png`),fullPage:true});
    }
  }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
try{await aiClassificationJourney({onScreen});await aiCustodyJourney({onScreen})}
finally{await browser.close()}
console.log('AI classification editor provenance, failures, uncertainty and tooltips PASS; proof at 1440 and 390');
