import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse} from './kit.mjs';
import {nativeConnectionPerson} from './connection-transfer-journey.mjs';

export async function connectionTransferBrowser() {
 const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
 const mime=(major,minor)=>[major,minor].join('/');
 const types={'.css':mime('text','css'),'.js':mime('text','javascript'),'.svg':mime('image','svg+xml'),'.woff2':mime('font','woff2'),'.png':mime('image','png'),'.webp':mime('image','webp')};
 const edge=fakeEdge();edge.routes.set('ownership.example',()=>jsonResponse({ok:true}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});let server,browser;
 try {
  const first=await nativeConnectionPerson(h,'Browser connection steward'),next=await nativeConnectionPerson(h,'Browser next steward');
  const c=await connection(h,{app:'http',label:'Synthetic east account',auth_kind:'bearer',domains:['ownership.example'],scopes:['records.read'],secret:{token:'synthetic-crank-401'}});
  for(const p of [first,next])await h.post('team/'+p.id,{grants:[{role:'admin',workflow_ids:[],connection_ids:[c.id]}]});
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':mime('application','x-www-form-urlencoded')},body:'confirm=yes'});assert.equal(setup.status,303);
  server=createServer(async(req,res)=>{try {
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
  browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
  async function signed(cookie) {const context=await browser.newContext(),[name,...value]=cookie.split('=');await context.addCookies([{name,value:value.join('='),url:h.origin}]);return {context,page:await context.newPage()}}
  const owner=await signed(h.owner),steward=await signed(first.cookie),successor=await signed(next.cookie);
  const row=page=>page.locator('li.settings-row').filter({hasText:'Synthetic east account'});
  const details=(page,label)=>row(page).locator('details').filter({has:page.getByText(label,{exact:true})});
  async function proof(page,state,open) {
   for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.goto(h.origin+'/app/connections');
    if(open)await details(page,open).locator('summary').click();
    if(width===1440) {
     const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible({timeout:100});await search.blur();await search.hover();await page.waitForTimeout(150);await expect(page.locator('#search-tooltip')).toBeHidden();await expect(page.locator('#search-tooltip')).toBeVisible();await page.mouse.move(0,0);
     assert.ok(await row(page).evaluate(element=>[...element.querySelectorAll('label,button,summary,p,.muted,strong')].filter(el=>el.getClientRects().length).every(el=>parseFloat(getComputedStyle(el).fontSize)>=13)),'connection controls use readable text');
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),state+' fits '+width);
    await page.screenshot({path:join(evidence,`ownership-${state}-${width}.png`),fullPage:true});
   }
   await page.setViewportSize({width:1440,height:1000});
  }
  await proof(owner.page,'transfer-review','Transfer ownership');
  await owner.page.getByLabel('New responsible person').selectOption({label:first.name});await owner.page.getByRole('button',{name:'Transfer and pause',exact:true}).click();await owner.page.waitForURL('**/app/connections');
  assert.equal((await h.get('connections')).find(row=>row.id===c.id).owner_id,first.id);
  await proof(steward.page,'fresh-consent','Reconnect connection');
  await expect(row(steward.page)).toContainText(first.name);await expect(row(steward.page)).toContainText('Needs reconnect');
  await steward.page.getByLabel('token',{exact:true}).fill('synthetic-crank-402');await steward.page.getByRole('button',{name:'Save fresh credential',exact:true}).click();await steward.page.waitForURL('**/app/connections');
  assert.equal((await h.get('connections')).find(row=>row.id===c.id).status,'active');
  await proof(steward.page,'authorized-management','Rotate credential');
  await owner.page.goto(h.origin+'/app/connections');await details(owner.page,'Transfer ownership').locator('summary').click();await owner.page.getByLabel('New responsible person').selectOption({label:next.name});await owner.page.getByRole('button',{name:'Transfer and pause',exact:true}).click();await owner.page.waitForURL('**/app/connections');
  await proof(steward.page,'predecessor-refused');
  await expect(row(steward.page).getByRole('button',{name:'Revoke',exact:true})).toHaveCount(0);await expect(row(steward.page).locator('form')).toHaveCount(0);
  const refused=await steward.context.request.post(h.origin+`/api/crank/connections/${c.id}/rotate`,{headers:{origin:h.origin},data:{secret:{token:'synthetic-crank-403'}}});assert.equal(refused.status(),403);
  await proof(successor.page,'new-responsibility','Reconnect connection');
  await owner.context.close();await steward.context.close();await successor.context.close();
 } finally {await browser?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done))}await h.close()}
 console.log('Connection transfer review, fresh consent, authorized management and predecessor refusal PASS; screens 1440 and 390');
}

if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1]))await connectionTransferBrowser();
