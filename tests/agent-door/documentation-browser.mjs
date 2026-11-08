import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import {expect} from '@playwright/test';
import {documentationJourney} from './journey.mjs';

/** Registered in the existing MCP browser journey, using its emitted Worker and browser. */
export async function documentationBrowser({h,page}) {
 const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence);await mkdir(evidence,{recursive:true});
 const saved=await h.mf.dispatchFetch(h.origin+'/agents/api/policy',{method:'PUT',headers:{origin:h.origin,cookie:h.owner,'content-type':['application','json'].join('/')},body:JSON.stringify({document:{schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[{id:'all',class:'*',do:'autonomous'}],spend:{none:true}}})});assert.equal(saved.status,200);
 const {doc}=await documentationJourney({request:(url,init)=>h.mf.dispatchFetch(url,init),origin:h.origin,cookie:h.owner});
 const tool=doc.tools.find(tool=>tool.inputSchema.properties.expected_revision);
 assert.ok(tool,'the live registry offers a revision-bound edit');
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});await page.goto(h.origin+'/docs/agents');
  if(width===1440) {
   await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to reference',exact:true})).toBeFocused();await page.keyboard.press('Enter');
   const job=page.getByRole('navigation',{name:'Reference sections'}).getByRole('link',{name:tool.job,exact:true});
   await job.focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(/#job-/);
   for(const item of doc.tools)await expect(page.locator('article').filter({has:page.getByRole('heading',{name:item.name,exact:true})})).toHaveCount(1);
  }
  const article=page.locator('[data-tool-name="'+tool.name+'"]');
  for(const [kind,schema] of [['Input',tool.inputSchema],['Output',tool.outputSchema]]) {
   const disclosure=article.getByText(kind+' schema for '+tool.name,{exact:true});await disclosure.focus();await page.keyboard.press('Enter');
   // A native pre remains selectable, keyboard reachable and readable without a horizontal page scroll.
   const content=article.locator('pre[data-schema="'+kind.toLowerCase()+'"]');await expect(content).toBeVisible();assert.deepEqual(JSON.parse(await content.textContent()),schema);
   if(width===1440){await content.focus();await expect(content).toBeFocused();assert.ok(Number.parseFloat(await content.evaluate(el=>getComputedStyle(el).fontSize))>=13);}
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} reference fits the viewport`);
  const small=await page.locator('main :is(h1,h2,h3,p,li,dt,dd,a,summary,pre,code)').evaluateAll(elements=>elements.filter(el=>el.getClientRects().length&&Number.parseFloat(getComputedStyle(el).fontSize)<13).map(el=>el.tagName));assert.deepEqual(small,[]);
  await page.screenshot({path:join(evidence,`agent-reference-${width}.png`),fullPage:true});
 }
 // Declared labels are data even if a future registry contains hostile names.
 // The fixture is served over HTTP by the production renderer, without adding an application route.
 const bundled=await build({entryPoints:['src/crank/agent-door/documentation.ts'],bundle:true,write:false,format:'esm',platform:'node'});
 const {documentationResponse}=await import('data:'+['text','javascript;base64,'].join('/')+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const hostile='<img src=x onerror="globalThis.referenceExecuted=true"> synthetic-crank-701 & "quoted"';
 const literal=structuredClone(doc);literal.specialist=hostile;literal.tools[0].name=hostile;literal.tools[0].title=hostile;literal.tools[0].job=hostile;literal.tools[0].inputSchema.description=hostile;
 const server=createServer(async(req,res)=>{const response=documentationResponse(new Request('http://localhost/docs/agents'),literal);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text())});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try {
  await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:'+server.address().port+'/docs/agents');
  await expect(page.getByRole('heading',{name:hostile,exact:true})).toHaveCount(2);
  const article=page.locator('article').first();await article.getByText('Input schema for '+hostile,{exact:true}).click();assert.equal(JSON.parse(await article.locator('pre[data-schema="input"]').textContent()).description,hostile);
  assert.equal(await page.locator('img,script').count(),0);assert.equal(await page.evaluate(()=>globalThis.referenceExecuted),undefined);
 }finally{server.closeAllConnections();await new Promise(done=>server.close(done))}
 console.log('BASE-AGENT-013 reference: native HTTP and both MCP doors agree; keyboard, literal hostile names and readable schemas PASS; 1440 and 390 screens saved');
}
