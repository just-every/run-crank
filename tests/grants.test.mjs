import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,publish,startRun,stepOf,until} from './kit.mjs';
import {archive} from './restore-journey.mjs';

const headers = grant => ({authorization:'Bearer '+grant.credential});
const policy = (steps, account=null, overrides={}) => ({
 rules:steps.map(step=>({step_id:step.id,type:step.type,connection_id:account,app:account?'http':'none',fields:Object.keys(step.input),recipients:['supplier@example.test'],recipient_field:'body.to',amount_field:'body.amount',max_usd:'100.00',max_per_minute:50})),
 approval:{timeout_seconds:60,delegate_ids:[],escalate_to:[]},...overrides,
});
const tool = (id,account=null) => ({id,type:'http',...(account?{connection_id:account}:{}),input:{method:'POST',url:'https://grants-ledger.example/'+id,body:{amount:'25.00',to:'supplier@example.test',description:'Harbor Workshop refund'}}});
const issue = (h,w,p) => h.post('grants',{label:'Harbor operations bounded refund agent',workflow_id:w.id,version_id:w.published.published_version_id??w.published.version.id,expires_at:new Date(Date.now()+3600000).toISOString(),policy:p},h.owner,201);
const task = (h,g,actions,status=201) => h.post('agent-tasks',{task_id:crypto.randomUUID(),actions},'',status,headers(g));
const action = (step,body) => ({step_id:step.id,input:{body:{...step.input.body,...body}}});
const decide = (h,r,decision='approve',extra={},cookie=h.owner,status=200) => h.post(`workflow-runs/${r.id}/${decision}`,{path:r.waits[0].path,digest:r.waits[0].proposal_digest,...extra},cookie,status);
async function join(h,name) {
 const email=name.toLowerCase().replaceAll(' ','-')+'@example.test';assert.equal((await h.send('/auth/invite',{email,displayName:name,role:'member'},h.owner)).status,202);
 const mail=h.mail.findLast(m=>m.to.includes(email)), token=new URL(mail.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
 const result=await h.send('/auth/confirm',{token});assert.equal(result.status,303);return {cookie:result.cookie,id:(await h.get('state',result.cookie)).actor.id};
}

test('TEAM-002 PLATFORM-001: grant-free publication and credential-bound dynamic tasks; exact USD/recipient/field review, rejection, edited approval and reapproval after external changes',async()=>{
 const edge=fakeEdge();edge.routes.set('grants-ledger.example',({body})=>jsonResponse({id:crypto.randomUUID(),effect:JSON.parse(body)}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try{
  const c=await connection(h,{app:'http',label:'Harbor ledger account',auth_kind:'bearer',domains:['grants-ledger.example'],secret:{token:fakeSecret('ledger')}}), steps=[tool('refund',c.id),tool('notify',c.id)];
  const w=await publish(h,'Harbor refunds with optional human review',{trigger:{type:'manual'},steps});
  assert.equal((await startRun(h,w,{})).status,'succeeded','publishing needs no standing grant or approval');
  const reviewed=await publish(h,'Optional exact editable decision',{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'120.00'},editable:['amount'],caps:{amount:{max_usd:'500.00'}}},{...tool('reviewed'),input:{...tool('reviewed').input,body:{amount:'{{steps.review.proposal.amount}}',to:'supplier@example.test'}}}]});
  const reviewRun=await startRun(h,reviewed,{});await decide(h,reviewRun,'approve',{edits:{amount:'600.00'}},h.owner,422);
  const edited=await decide(h,reviewRun,'approve',{edits:{amount:'95.00'}});assert.equal(edited.status,'succeeded');assert.equal(JSON.parse(edge.requests.at(-1).body).amount,'95.00');assert.equal(stepOf(edited,'review').output.original.amount,'120.00');
  await h.post('data/attestations',{data_class:'financial',agreements:['Local acceptance test receiver and synthetic financial data only'],data_location:'Local test D1',confirm:'ATTEST'},h.owner,201);
  await h.post('data/classes',{workflow_id:w.id,data_class:'financial',identifier_fields:['to']});
  const g=await issue(h,w,policy(steps,c.id));
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes',redirect:'manual'});assert.equal(setup.status,303);
  const access=await h.send('/app/access',undefined,h.owner);assert.equal(access.status,200);assert.ok(access.text.includes((await h.get('state')).actor.id),'owner can see native reviewer identifiers in the grant controls');
  const grants=await h.get('grants');assert.equal(grants[0].credential,undefined);assert.equal(grants[0].token_hash,undefined);
  assert.ok(!(JSON.stringify(await h.get('state'))).includes(g.credential));
  await h.post('grants',{...g},'',403,headers(g));await h.post('tokens',{label:'self escalation',scope:'agent'},'',403,headers(g));
  await h.get('state','',403,headers(g));await h.get('connections','',403,headers(g));
  await h.post('workflows',{name:'Unauthorized draft',graph:{trigger:{type:'manual'},steps:[]}},'',403,headers(g));
  const preparer=await h.post('tokens',{label:'Preparation only',scope:'agent'},h.owner,201);
  await h.post('agent-tasks',{task_id:'not authorized',actions:[action(steps[0],{})]},'',403,{authorization:'Bearer '+preparer.token});
  const within=await task(h,g,[action(steps[1],{amount:'100.00'}),action(steps[0],{amount:'0.01'})]);assert.equal(within.status,'succeeded');
  assert.deepEqual(within.steps.map(s=>s.step_id),['notify','refund'],'agent selects and orders tools rather than merely starting the published graph');
  const version=await h.get(`workflows/${w.id}/versions/${within.version.number}`);assert.ok(!JSON.stringify(version.graph).includes('0.01'),'submitted financial values stay out of immutable graphs');
  assert.equal((await h.get('agent-tasks/'+within.id,'',200,headers(g))).grant_id,g.id);
  const other=await startRun(h,w,{});await h.get('agent-tasks/'+other.id,'',404,headers(g));
  await task(h,g,[{step_id:'foreign',input:{}}],422);
  await task(h,g,[{step_id:'refund',input:{url:'https://foreign.example/'}}],422);
  const rejected=await task(h,g,[action(steps[0],{amount:'100.01'})]), count=edge.requests.length;
  assert.equal(rejected.status,'awaiting_approval');assert.equal(rejected.waits[0].proposal.input.body.amount,'100.01');
  assert.equal((await decide(h,rejected,'reject')).status,'rejected');assert.equal(edge.requests.length,count);
  const pending=await task(h,g,[action(steps[0],{amount:'125.00'})]);
  await decide(h,pending,'approve',{digest:'stale' },h.owner,409);
  const approved=await decide(h,pending,'approve',{defer:true});assert.equal(approved.status,'queued');
  const revised=await h.post(`agent-tasks/${pending.id}/proposal`,{path:'refund',digest:pending.waits[0].proposal_digest,input:{body:{...steps[0].input.body,amount:'140.00'}}},'',200,headers(g));
  assert.equal(revised.status,'awaiting_approval');assert.equal(revised.waits[0].resolution,null);
  await decide(h,pending,'approve',{},h.owner,409);assert.equal(edge.requests.length,count);
  assert.equal(revised.revisions[0].prior_input.body.amount,'125.00');
  assert.equal((await decide(h,revised)).status,'succeeded');assert.equal(JSON.parse(edge.requests.at(-1).body).amount,'140.00');
  const recipient=await task(h,g,[action(steps[0],{to:'unapproved@example.test'})]);assert.equal(recipient.status,'awaiting_approval');await decide(h,recipient,'reject');
  const fields=await task(h,g,[{step_id:'refund',input:{extra:'outside allowed fields'}}]);assert.equal(fields.status,'awaiting_approval');await decide(h,fields,'reject');
  const audit=await h.get('audit');for(const name of ['grant.create','grant.task','grant.proposal.revise','run.approve','run.reject'])assert.ok(audit.some(a=>a.action===name),name);
 }finally{await h.close()}
});

test('TEAM-002 PLATFORM-001: atomic rate bounds, immutable account/version grants, expiry and mid-dispatch revocation retain in-flight uncertainty and stop the next action',async()=>{
 const edge=fakeEdge();let release,hold=false;
 edge.routes.set('grants-ledger.example',({url})=>hold&&url.pathname==='/first'?new Promise(resolve=>{release=()=>resolve(jsonResponse({id:'remote-recorded'}))}):jsonResponse({id:'recorded'}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try{
  const steps=[tool('first'),tool('second')],w=await publish(h,'Grant lifecycle',{trigger:{type:'manual'},steps});
  const p=policy(steps);p.rules.forEach(r=>r.max_per_minute=1);const g=await issue(h,w,p);
  const concurrent=await Promise.all([task(h,g,[action(steps[0],{})]),task(h,g,[action(steps[0],{})])]);await h.tick();
  const final=await Promise.all(concurrent.map(r=>h.get('workflow-runs/'+r.id)));assert.equal(final.filter(r=>r.status==='succeeded').length,1);assert.equal(final.filter(r=>r.status==='awaiting_approval').length,1);assert.equal(edge.requests.length,1);
  await decide(h,final.find(r=>r.status==='awaiting_approval'),'reject');
  const short=await h.post('grants',{label:'Short lifetime',workflow_id:w.id,version_id:w.published.version.id,expires_at:new Date(Date.now()+1200).toISOString(),policy:policy(steps)},h.owner,201);
  await new Promise(r=>setTimeout(r,1300));await task(h,short,[action(steps[0],{})],401);
  const inFlightGrant=await issue(h,w,policy(steps));hold=true;const before=edge.requests.length,running=task(h,inFlightGrant,steps.map(s=>action(s,{})));
  await until(()=>release,'remote write started');const r=(await h.get('workflow-runs?workflow='+w.id)).runs.find(r=>r.status==='running');assert.ok(r);
  await h.post('grants/'+inFlightGrant.id+'/revoke');release();release=null;hold=false;
  const stopped=await running;assert.equal(stopped.status,'paused');assert.equal(stepOf(stopped,'first').status,'uncertain');assert.equal(stepOf(stopped,'second'),undefined);assert.equal(edge.requests.length,before+1);
  assert.equal(stopped.attempts[0].error_category,'uncertain');await task(h,inFlightGrant,[action(steps[0],{})],401);
  await h.post(`workflow-runs/${stopped.id}/resume`);assert.equal((await h.get('workflow-runs/'+stopped.id)).status,'paused');
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);await task(h,g,[action(steps[0],{})],403);
 }finally{release?.();await h.close()}
});

test('TEAM-002 PLATFORM-001 BASE-001 DATA-001 BASE-003: owner-selected native delegation and durable timeout escalation, complete inactive history restore and no inherited execution credential',async()=>{
 const edge=fakeEdge();edge.routes.set('grants-ledger.example',()=>jsonResponse({id:'retained'}));const h=await harness('http://127.0.0.1:9',{edge:edge.edge});let restored;
 try{
  const delegate=await join(h,'Finance reviewer'),outsider=await join(h,'Unassigned reviewer'),step=tool('refund'),w=await publish(h,'Weekend refund decision',{trigger:{type:'manual'},steps:[step]});
  const p=policy([step]);p.approval={timeout_seconds:60,delegate_ids:[delegate.id],escalate_to:[outsider.id]};const g=await issue(h,w,p);
  const ordinary=await startRun(h,w,{});
  await h.get('workflow-runs/'+ordinary.id,delegate.cookie,403);
  const ordinaryReview=await publish(h,'Synthetic unrelated standing reviewer',{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'30.00'}}]});
  const unrelated=await startRun(h,ordinaryReview,{});
  await decide(h,unrelated,'approve',{},delegate.cookie,403);
  const separate=await issue(h,w,policy([step]));
  const separateWait=await task(h,separate,[action(step,{amount:'301.00'})]);
  await h.get('workflow-runs/'+separateWait.id,delegate.cookie,403);
  await decide(h,separateWait,'approve',{},delegate.cookie,403);
  await decide(h,separateWait,'reject');
  const waiting=await task(h,g,[action(step,{amount:'300.00'})]);
  const view=await h.get('workflow-runs/'+waiting.id,delegate.cookie);assert.equal(view.waits[0].can_review,true);assert.equal(view.waits[0].proposal.input.body.amount,'300.00');assert.equal(view.trigger,undefined,'delegation reveals the proposed effect, not every payload');
  await decide(h,waiting,'approve',{},outsider.cookie,403);
  assert.equal((await decide(h,waiting,'approve',{},delegate.cookie)).status,'succeeded');
  await h.post('grants',{},delegate.cookie,403);
  const timeout=await task(h,g,[action(step,{amount:'350.00'})]);const deadline=Date.parse(timeout.waits[0].expires_at);
  await h.restart();await h.tick(deadline+1);await h.tick(deadline+2);
  const escalated=await h.get('workflow-runs/'+timeout.id);assert.equal(escalated.status,'awaiting_approval');assert.equal(escalated.escalations.length,1);assert.deepEqual(JSON.parse(escalated.escalations[0].recipient_ids_json),[outsider.id]);
  const count=edge.requests.length,exported=await archive(h);assert.ok(!exported.includes(g.credential));
  const items=text=>text.trim().split('\n').map(JSON.parse).flatMap(p=>p.items??[]).filter(i=>i.kind==='row').map(({table,row})=>JSON.stringify({table,row})).sort();
  assert.ok(!items(exported).some(r=>['crank_grants','crank_grant_admissions'].includes(JSON.parse(r).table)));
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data/restore',{confirm:'RESTORE',archive:exported});
  const original=items(exported),received=items(await archive(restored));assert.deepEqual(received.filter(r=>!original.includes(r)).map(r=>JSON.parse(r).row.action),['data.restore']);assert.deepEqual(received.filter(r=>original.includes(r)),original);
  assert.deepEqual(await restored.get('grants'),[]);await task(restored,g,[action(step,{})],401);
  await restored.restart();await restored.tick(deadline+86400000);assert.equal(edge.requests.length,count);assert.equal((await restored.get('workflow-runs/'+timeout.id)).status,'paused');
  const adoption=await restored.get('workflows/'+w.id);
  await restored.post(`workflows/${w.id}/publish`,{restore_snapshot:adoption.restore.snapshot,restore_decisions:{[timeout.id]:'resume'}},restored.owner,201);
  const receiving=await restored.get('workflow-runs/'+timeout.id);assert.equal(receiving.grant_id,null,'explicit native adoption replaces the source execution authority');
  const resumed=await decide(restored,receiving);assert.equal(resumed.status,'succeeded');assert.equal(resumed.version_id,timeout.version_id);assert.equal(edge.requests.length,count+1,'only explicit receiving-owner review dispatches the frozen task');await task(restored,g,[action(step,{})],401);
  const disclosures=await h.get('data/flows');assert.ok(disclosures.flows.some(f=>f.recipients.includes('https://grants-ledger.example')&&f.fields.includes('body.amount')));
  assert.equal((await decide(h,escalated,'reject',{},outsider.cookie)).status,'rejected');
  assert.equal((await h.get('audit')).filter(a=>a.action==='grant.approval.escalate').length,1);
  const recoverySteps=[tool('before_wait'),{id:'checkpoint',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},tool('after_wait')];
  const recovery=await publish(h,'Granted task durable continuation',{trigger:{type:'manual'},steps:recoverySteps}),rp=policy(recoverySteps);
  rp.rules[1]={step_id:'checkpoint',type:'delay',connection_id:null,app:'none',fields:['amount','unit'],recipients:[],max_per_minute:10};
  const rg=await issue(h,recovery,rp),parked=await task(h,rg,[action(recoverySteps[0],{}),{step_id:'checkpoint',input:{amount:1,unit:'minutes'}},action(recoverySteps[2],{})]);
  assert.equal(parked.status,'waiting');const beforeWait=edge.to('grants-ledger.example').filter(r=>r.url.pathname==='/before_wait').length;
  await h.restart();await h.tick(Date.parse(parked.waits[0].due_at)+1);const continued=await h.get('workflow-runs/'+parked.id);
  assert.equal(continued.status,'succeeded');assert.equal(continued.version_id,parked.version_id);assert.equal(edge.to('grants-ledger.example').filter(r=>r.url.pathname==='/before_wait').length,beforeWait,'restart never repeats a granted effect');assert.equal(edge.to('grants-ledger.example').filter(r=>r.url.pathname==='/after_wait').length,1);

  const replacementGraph={trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'450.00'}},{id:'record',type:'map',input:{approved:true}}]};
  await h.post(`workflows/${w.id}/draft`,{graph:replacementGraph});
  const replacement=await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  assert.notEqual(replacement.version.id,w.published.version.id);
  const native=await startRun(h,w,{});
  assert.equal(native.status,'awaiting_approval');
  for(const person of [delegate,outsider]) {
   await decide(h,native,'approve',{},person.cookie,403);
   await decide(h,native,'reject',{},person.cookie,403);
   await h.get('workflow-runs/'+native.id,person.cookie,403);
  }
  const unchanged=await h.get('workflow-runs/'+native.id);
  assert.equal(unchanged.status,'awaiting_approval');assert.equal(unchanged.waits[0].resolution,null);
  assert.equal((await decide(h,native)).status,'succeeded','a current independent owner can decide the replacement publication');

 }finally{await restored?.close();await h.close()}
});
