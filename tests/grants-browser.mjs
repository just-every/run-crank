/** TEAM-002 PLATFORM-001 real rer dev + live public HTTP echo; run via heavy-slot. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {chromium} from '@playwright/test';
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const privateDir=await mkdtemp(join(tmpdir(),'crank-grants-')),log=join(privateDir,'dev.log'),children=[];
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
 const send=async(path,body,status=200,credential,idempotencyKey)=>{const r=await context.request.fetch(origin+'/api/crank/'+path,{method:body===undefined?'GET':'POST',headers:{origin,...(credential?{authorization:'Bearer '+credential}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},...(body===undefined?{}:{data:body})});const v=await r.json();assert.equal(r.status(),status,`${path}: ${JSON.stringify(v)}`);return v};
 const shot=async(width,state)=>{await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}/${state} overflow`)};
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const tool={id:'refund',type:'http',idempotency_header:'Idempotency-Key',input:{method:'POST',url:'https://httpbin.org/anything',body:{amount:'25.00',to:'finance@harbor.example',description:'Harbor Workshop — replacement valve shipment / order 4729'}}};
  const slow={...tool,id:'slow',input:{...tool.input,url:'https://httpbin.org/delay/10'}};
  const wait={id:'wait',type:'delay',mode:'for',input:{amount:5,unit:'minutes'}};
  const workflow=await send('workflows',{name:`Harbor Workshop — supplier refund decisions and weekend follow-up (${width})`,graph:{trigger:{type:'manual'},steps:[tool,wait,slow]}},201);
  await send(`workflows/${workflow.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-reviewed public HTTP echo using synthetic acceptance data; no authenticated provider or executor'}))}});
  await send(`workflows/${workflow.id}/publish`,{},201);
  const policy={rules:[{step_id:'slow',type:'http',connection_id:null,app:'none',fields:['method','url','body'],recipients:['finance@harbor.example'],recipient_field:'body.to',amount_field:'body.amount',max_usd:'100.00',max_per_minute:20},{step_id:'refund',type:'http',connection_id:null,app:'none',fields:['method','url','body'],recipients:['finance@harbor.example'],recipient_field:'body.to',amount_field:'body.amount',max_usd:'100.00',max_per_minute:20},{step_id:'wait',type:'delay',connection_id:null,app:'none',fields:['amount','unit'],recipients:[],max_per_minute:20}],approval:{timeout_seconds:1,delegate_ids:[],escalate_to:[]}};
  await page.goto(origin+'/app/access');const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'Standing grants for agent work',exact:true})});
  await panel.getByLabel('Label',{exact:true}).fill(`Supplier refund assistant — Harbor Workshop (${width}, ${workflow.id.slice(0,6)})`);await panel.getByLabel('Published workflow').selectOption(workflow.id);await panel.getByLabel('Expires at (UTC)').fill(new Date(Date.now()+86400000).toISOString());await panel.getByLabel('Grant policy (JSON)').fill(JSON.stringify(policy,null,2));await shot(width,'grant-policy');
  await panel.getByRole('button',{name:'Issue standing grant'}).click();await page.waitForLoadState('networkidle');const credential=await page.getByLabel('Credential',{exact:true}).inputValue();assert.match(credential,/^crg_/);await shot(width,'credential-created');
  const grant=(await send('grants')).find(g=>g.workflow_id===workflow.id);assert.ok(grant);assert.equal(grant.credential,undefined);
  const task=async(amount,extra=[])=>send('agent-tasks',{task_id:crypto.randomUUID(),actions:[...extra,{step_id:'refund',input:{body:{...tool.input.body,amount}}}]},201,credential);
  const keyedInput={task_id:'supplier-receipt-'+width,actions:[{step_id:'refund',input:{body:{...tool.input.body,amount:'75.00'}}}]},key='supplier-receipt-'+width;
  const within=await send('agent-tasks',keyedInput,201,credential,key);
  const recovered=await send('agent-tasks',keyedInput,201,credential,key);assert.equal(recovered.id,within.id);assert.equal(recovered.version_id,within.version_id);
  await send('agent-tasks',{...keyedInput,task_id:'changed-source'},409,credential,key);assert.equal(within.status,'succeeded',JSON.stringify(within.error));await page.goto(origin+'/app/workflow-runs/'+within.id);await shot(width,'within-grant');
  assert.equal(within.steps[0].output.body.json.amount,'75.00','live public HTTP receiver echoes the actual submitted amount');
  const approved=await task('125.00');await page.goto(origin+'/app/approvals');await shot(width,'approval-inbox');await page.goto(origin+'/app/workflow-runs/'+approved.id);await shot(width,'exact-review');await page.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal((await send('agent-tasks/'+approved.id,undefined,200,credential)).status,'succeeded');await shot(width,'approved');
  const rejected=await task('225.00');await page.goto(origin+'/app/workflow-runs/'+rejected.id);await page.getByRole('button',{name:'Reject',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal((await send('agent-tasks/'+rejected.id,undefined,200,credential)).status,'rejected');await shot(width,'rejected');
  const changed=await task('250.00'),old=changed.waits[0];await send(`workflow-runs/${changed.id}/approve`,{path:'refund',digest:old.proposal_digest,defer:true});const revised=await send(`agent-tasks/${changed.id}/proposal`,{path:'refund',digest:old.proposal_digest,input:{body:{...tool.input.body,amount:'275.00'}}},200,credential);await send(`workflow-runs/${changed.id}/approve`,{path:'refund',digest:old.proposal_digest},409);assert.equal(revised.status,'awaiting_approval');await page.goto(origin+'/app/workflow-runs/'+changed.id);await shot(width,'fresh-review-required');
  // Wait through the real per-minute Cron pass; the HTTP journey also proves restart.
  const due=Date.now()+75000;let escalation;while(Date.now()<due){escalation=await send('agent-tasks/'+changed.id,undefined,200,credential);if(escalation.escalations.length)break;await pause(1000)}assert.ok(escalation.escalations.length);await page.reload();await shot(width,'deadline-escalated');await page.getByRole('button',{name:'Reject',exact:true}).click();await page.waitForLoadState('networkidle');
  const parked=await task('80.00',[{step_id:'wait',input:{amount:5,unit:'minutes'}}]);assert.equal(parked.status,'waiting');
  await page.goto(origin+'/app/access');
  const inFlight=send('agent-tasks',{task_id:crypto.randomUUID(),actions:[{step_id:'slow',input:{body:tool.input.body}},{step_id:'refund',input:{body:tool.input.body}}]},201,credential);
  const startedDeadline=Date.now()+10000;let running;
  while(Date.now()<startedDeadline){const candidates=await send('workflow-runs?workflow='+workflow.id);for(const candidate of candidates.runs.filter(r=>r.status==='running')){const detail=await send('workflow-runs/'+candidate.id);if(detail.attempts.length){running=detail;break}}if(running)break;await pause(100)}
  assert.ok(running,'physical remote attempt must start before revocation');
  const row=page.locator('li.history-item').filter({has:page.getByRole('heading',{name:grant.label,exact:true})});await row.getByRole('button',{name:'Revoke grant'}).click();await page.waitForLoadState('networkidle');await shot(width,'grant-revoked');
  const interrupted=await inFlight;assert.equal(interrupted.status,'paused');assert.equal(interrupted.steps.find(s=>s.step_id==='slow').status,'uncertain');assert.equal(interrupted.steps.find(s=>s.step_id==='refund'),undefined);
  await page.goto(origin+'/app/workflow-runs/'+interrupted.id);await shot(width,'revoked-in-flight-uncertain');
  await send('agent-tasks',{task_id:'revoked',actions:[{step_id:'refund',input:{body:tool.input.body}}]},401,credential);await page.goto(origin+'/app/workflow-runs/'+parked.id);assert.match(await page.locator('body').innerText(),/grant revoked/i);await shot(width,'revoked-task-paused');
  console.log(`TEAM-002 PLATFORM-001 ${width}: keyed task recovery/conflict,  owner issuance, live HTTP response, exact approval/rejection, stale-review refusal, timeout escalation and revocation passed`);
 }
 await context.close();
}catch(error){if(page){await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,800))}console.error(String(error.message).replace(/https?:\/\/\S+/g,'[redacted URL]'));process.exitCode=1}
finally{await browser?.close();for(const child of children.reverse())await stop(child);await rm(privateDir,{recursive:true,force:true})}
