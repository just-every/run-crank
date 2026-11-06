import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {agentUsageJourney} from './agent-door/usage-journey.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const mime=(a,b)=>[a,b].join('/');
const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png')};
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
try {
 await agentUsageJourney({inspect:async({h,cookie,report,month})=>{
  const server=createServer(async(req,res)=>{try{
   const pathname=new URL(req.url,h.origin).pathname;
   if(types[extname(pathname)])for(const root of ['public','dist/client']) {
    const directory=resolve(root),file=resolve(directory,'.'+decodeURIComponent(pathname));if(!file.startsWith(directory+'/'))continue;
    const bytes=await readFile(file).catch(()=>null);if(bytes){res.writeHead(200,{'content-type':types[extname(pathname)]});res.end(bytes);return}
   }
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const headers={...req.headers};delete headers['content-length'];
   const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503);res.end('Browser transport failed')}});
  await new Promise(done=>server.listen(Number(new URL(h.origin).port),'127.0.0.1',done));
  const context=await browser.newContext(),[name,...value]=cookie.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);
  const page=await context.newPage();
  try {
   for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.goto(h.origin+'/app/operations?month='+month);
    const panel=page.locator('#agent-usage');
    for(const summary of await panel.locator('summary').all())await summary.click();
    if(width===1440) {
     await expect(panel.locator('[data-agent-totals]')).toHaveText('216 request attempts · 215 original operations · 1 replays');
     for(const agent of report.agents) {
      const row=panel.locator('[data-agent-id="'+agent.agent_id+'"]');
      await expect(row).toContainText(agent.name);
      await expect(row).toContainText(agent.request_attempts+' request attempts · '+agent.original_operations+' original operations · '+agent.replays+' replays');
      for(const d of agent.decisions)await expect(row).toContainText(d.decision+' · '+d.outcome+': '+d.request_attempts+' attempts ('+d.replays+' replays)');
      for(const c of agent.classes)await expect(row).toContainText(c.class+' · '+c.decision+' · '+c.outcome+': '+c.request_attempts+' attempts ('+c.replays+' replays)');
      await expect(row).toContainText('Money moved: Not reported · Provider spend: Not reported');
     }
     for(const [id,label] of [['search-tooltip','Search runs'],['account-tooltip','Your account']]) {
      const control=page.locator('[aria-describedby="'+id+'"]'),tooltip=page.getByRole('tooltip',{name:label,exact:true});
      await page.mouse.move(0,0);await control.blur();await expect(tooltip).toBeHidden();await control.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();
      await page.mouse.move(0,0);await control.focus();await expect(tooltip).toBeVisible({timeout:100});await control.blur();
     }
     assert.ok(await panel.locator('p,h2,h3,h4,li,summary').evaluateAll(nodes=>nodes.every(n=>parseFloat(getComputedStyle(n).fontSize)>=13)),'report text is readable');
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'report fits viewport');
    await panel.screenshot({path:join(evidence,'populated-'+width+'.png')});
    await page.getByLabel('Usage month (UTC)',{exact:true}).fill('2026-09');await page.getByRole('button',{name:'Update usage report',exact:true}).click();
    if(width===1440)await expect(page.locator('#agent-usage')).toContainText('No native agent calls in this UTC month.');
    await page.locator('#agent-usage').screenshot({path:join(evidence,'empty-'+width+'.png')});
    const response=await page.goto(h.origin+'/app/operations?month=invalid');
    if(width===1440) {assert.equal(response.status(),400);await expect(page.locator('main')).toContainText('month must be YYYY-MM in UTC');assert.equal(await page.locator('[data-agent-totals]').count(),0)}
    await page.screenshot({path:join(evidence,'error-'+width+'.png'),fullPage:true});
   }
  }finally{await context.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
 }});
}finally{await browser.close()}
console.log('Native agent usage browser PASS: populated, empty and error states; totals, classes, owner controls and tooltips at 1440 with matching 390 screens');
