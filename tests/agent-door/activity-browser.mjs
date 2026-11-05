import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {harness} from '../harness.mjs';
import {seedActivity,period} from './activity-journey.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const h=await harness('http://127.0.0.1:9',{clock:'2026-11-02T12:00:00.000Z'});
const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.png':'image'+'/'+'png'};
const bridge=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,h.origin).pathname,root=resolve('public'),file=resolve(root,'.'+decodeURIComponent(path));
  if(types[extname(path)]&&file.startsWith(root+'/')){
   const data=await readFile(file).catch(()=>null);if(data){res.writeHead(200,{'content-type':types[extname(path)]});res.end(data);return}
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers={...req.headers};delete headers['content-length'];
  const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,redirect:'manual',...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503);res.end('Browser transport failed')}
});
await new Promise(resolve=>bridge.listen(Number(new URL(h.origin).port),'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
let page;
try{
 const seeded=await seedActivity(h,{volume:3});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const [name,...value]=h.owner.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);page=await context.newPage();
 await page.goto(h.origin+'/agents?'+period);
 await expect(page.getByRole('heading',{name:'Activity',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Waiting for approval',exact:true})).toBeVisible();
 await page.getByLabel('Agent ID',{exact:true}).fill('crank-token:'+seeded.a.id);
 await page.getByLabel('Class',{exact:true}).selectOption('standard');
 await page.getByRole('button',{name:'Apply filters',exact:true}).focus();await page.keyboard.press('Enter');
 await page.waitForURL(url=>url.searchParams.get('agent')==='crank-token:'+seeded.a.id);
 const response=await h.send('/agents/api/activity?'+new URL(page.url()).searchParams,undefined,h.owner);
 assert.equal(response.status,200);const expected=response.value;
 await expect(page.locator('[data-activity-total]')).toHaveText(expected.total+' calls in this period');
 assert.deepEqual(await page.locator('[data-activity-id]').evaluateAll(rows=>rows.map(row=>row.dataset.activityId)),expected.rows.map(row=>row.id));
 for(const count of expected.counts)await expect(page.locator('[data-agents-count][data-class="'+count.class+'"][data-decision="'+count.decision+'"]')).toHaveText(String(count.count));
 for(const item of await page.locator('[data-activity-id]').all())await expect(item).toContainText('Harbour preparation assistant for Harbour owner');
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Export this period',exact:true}).click();
 const download=await downloadPromise,path=await download.path();const exported=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(exported,expected.rows,'a person opens the complete period export');
 const native=expected.rows.find(row=>row.native.length);assert.ok(native);
 const target=await context.request.get(h.origin+native.native[0].href,{maxRedirects:0});assert.equal(target.status(),303);
 const require=createRequire(import.meta.url),axe=await readFile(require.resolve('axe-core/axe.min.js'),'utf8');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(source=>{
   const script=document.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;script.textContent=source;document.head.append(script);
  },axe);
  const result=await page.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.deepEqual(result.violations.filter(item=>['serious','critical'].includes(item.impact)).map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})),[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'activity fits the viewport');
  assert.ok(await page.locator('main').evaluate(root=>[...root.querySelectorAll('button,input,select,a,p,td,th,label')].every(element=>parseFloat(getComputedStyle(element).fontSize)>=13)));
  assert.equal(await page.locator('button').evaluateAll(items=>items.filter(item=>!item.textContent.trim()).length),0,'every action has a visible text label');
  await page.screenshot({path:join(evidence,width+'-activity.png'),fullPage:true});
  console.log('PROBE BASE-AGENT-009 browser '+width+': populated Agents page -> correct attribution, no overflow, serious and critical axe findings=0');
 }
 await page.getByLabel('Class',{exact:true}).selectOption('money');await page.getByRole('button',{name:'Apply filters',exact:true}).click();
 await expect(page.getByText('No activity matches these filters.',{exact:true})).toBeVisible();
 await context.close();
 console.log('agent activity browser: PASS filters, keyboard, export, counts, native link, widths=1440,390');
}catch(error){if(page)await page.screenshot({path:join(evidence,'error.png'),fullPage:true});throw error}
finally{
 await browser.close();await h.close();bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));
}
