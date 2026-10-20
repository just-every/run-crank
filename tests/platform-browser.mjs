/** PLATFORM-001: real SDK/MCP doors and native UI; run via heavy-slot. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {chromium} from '@playwright/test';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const privateDir=await mkdtemp(join(tmpdir(),'crank-platform-')),log=join(privateDir,'dev.log'),children=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let browser,page;
function start(command,args,env=process.env,cwd=process.cwd()) {
 const child=spawn(command,args,{env,cwd,stdio:['ignore','pipe','pipe']});children.push(child);
 const stream=createWriteStream(log,{flags:'a',mode:0o600});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});child.once('close',()=>stream.end());return child;
}
async function stop(child) {
 const tree=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number)),owned=new Set([child.pid]);
 for(let n=0;n<20;n++)for(const [pid,parent]of tree)if(owned.has(parent))owned.add(pid);
 child.kill('SIGTERM');await pause(1000);
 for(const pid of [...owned].reverse())try{process.kill(pid,'SIGTERM')}catch{}
}
try {
 const dev=start('rer',['dev','--foreground'],{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH});
 let open;const deadline=Date.now()+10*60000;
 while(Date.now()<deadline){const text=await readFile(log,'utf8').catch(()=>'');open=/RER_OPEN\s+(https?:\/\/\S+)/.exec(text)?.[1];if(open)break;if(dev.exitCode!==null)throw Error('rer dev exited: '+text.replace(/https?:\/\/\S+/g,'[private URL]').slice(-1800));await pause(1000)}
 assert.ok(open,'rer dev readiness deadline');
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});const context=await browser.newContext();page=await context.newPage();
 await page.goto(open);await page.waitForURL(u=>['/app','/setup'].includes(u.pathname),{timeout:60000});
 if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
 const origin=new URL(open).origin;
 const cookie=(await context.cookies()).map(c=>c.name+'='+c.value).join('; ');
 const {CrankClient}=await import('../sdk/index.js');
 const sdk=new CrankClient({baseUrl:origin,cookie});
 const send=async(path,body,status=200)=>{const r=await context.request.fetch(origin+'/api/crank/'+path,{method:body===undefined?'GET':'POST',headers:{origin},...(body===undefined?{}:{data:body})});const v=await r.json();assert.equal(r.status(),status,`${path}: ${JSON.stringify(v)}`);return v};
 const rpc=async(name,args={},token)=>{const r=await fetch(origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin,cookie,accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-06-18',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));assert.ok(!v.error,JSON.stringify(v));return v.result};
 const shot=async(width,state)=>{await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}/${state} overflow`)};
 const costs={cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-reviewed native mapping only; no provider or executor'}))}};
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const graph={trigger:{type:'manual'},steps:[{id:'receipt',type:'map',input:{supplier:'Harbor Workshop — replacement valve supplier',amount:'25.00',to:'operations@harbor.example',reference:'Order 4729 · October purchasing review'}}]};
  const input={name:`Harbor Workshop — supplier receipt integration and exact review (${width})`,description:'SDK preparation with MCP execution under an owner-issued grant',graph};
  const draft=await sdk.createDraft(input,{idempotencyKey:'browser-'+width});
  assert.equal((await sdk.createDraft(input,{idempotencyKey:'browser-'+width})).id,draft.id);
  assert.equal((await rpc('validate_draft',{workflow_id:draft.id})).structuredContent.value.ok,true);
  await page.goto(origin+'/app/workflows/'+draft.id);await shot(width,'sdk-draft');
  const mcpDraft=await rpc('create_draft',{input:{...input,name:input.name+' — MCP prepared'},idempotency_key:'mcp-browser-'+width});assert.equal(mcpDraft.isError,false);
  await send(`workflows/${draft.id}/estimate`,costs);await sdk.publishDraft(draft.id);const workflow=await sdk.readWorkflow(draft.id);
  const grant=await send('grants',{label:`Supplier receipt agent (${width})`,workflow_id:draft.id,version_id:workflow.published_version_id,expires_at:new Date(Date.now()+3600000).toISOString(),policy:{rules:[{step_id:'receipt',type:'map',connection_id:null,app:'none',fields:['supplier','amount','to','reference'],recipients:['operations@harbor.example'],recipient_field:'to',amount_field:'amount',max_usd:'100.00',max_per_minute:20}],approval:{timeout_seconds:60,delegate_ids:[],escalate_to:[]}}},201);
  // Local development credentials also require the gate cookie. The bearer
  // still selects the grant actor; this supplies the dev gate through real HTTP.
  const exec=new CrankClient({baseUrl:origin,token:grant.credential,fetch:(url,init)=>{const headers=new Headers(init.headers);headers.set('cookie',cookie);return fetch(url,{...init,headers})}});
  const run=await exec.startTask({task_id:'sdk-browser-'+width,actions:[{step_id:'receipt',input:{amount:'25.00'}}]});assert.equal(run.status,'succeeded');assert.equal((await exec.readTask(run.id)).id,run.id);
  await page.goto(origin+'/app/workflow-runs/'+run.id);assert.ok((await page.locator('body').innerText()).includes(run.id));await shot(width,'sdk-task-succeeded');
  const mcpRun=await rpc('start_task',{input:{task_id:'mcp-browser-'+width,actions:[{step_id:'receipt',input:{amount:'100.00'}}]}},grant.credential);assert.equal(mcpRun.structuredContent.value.status,'succeeded');
  const progress=await rpc('get_task',{run_id:mcpRun.structuredContent.value.id},grant.credential);assert.equal(progress.structuredContent.value.id,mcpRun.structuredContent.value.id);
  await page.goto(origin+'/app/workflow-runs/'+mcpRun.structuredContent.value.id);await shot(width,'mcp-task-succeeded');
  const held=await rpc('start_task',{input:{task_id:'mcp-held-'+width,actions:[{step_id:'receipt',input:{amount:'100.01'}}]}},grant.credential);assert.equal(held.structuredContent.value.status,'awaiting_approval');
  await page.goto(origin+'/app/workflow-runs/'+held.structuredContent.value.id);assert.match(await page.locator('body').innerText(),/100.01/);await shot(width,'mcp-outside-grant-awaits-review');
  await page.getByRole('button',{name:'Reject',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal((await exec.readTask(held.structuredContent.value.id)).status,'rejected');assert.ok((await page.locator('body').innerText()).includes(held.structuredContent.value.id));await shot(width,'mcp-proposal-rejected');
  assert.equal((await rpc('create_draft',{input},grant.credential)).isError,true);
  const ids=[];for await(const row of sdk.iterateRuns({workflow:draft.id,limit:1}))ids.push(row.id);assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
  console.log(`PLATFORM-001 ${width}: SDK/MCP drafts, duplicate identity, granted progress, exact rejection, denial and paginated history passed`);
 }
 await context.close();
}catch(error){if(page){await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,800))}console.error(String(error.message).replace(/https?:\/\/\S+/g,'[redacted URL]'));process.exitCode=1}
finally{await browser?.close();for(const child of children.reverse())await stop(child);await rm(privateDir,{recursive:true,force:true})}
