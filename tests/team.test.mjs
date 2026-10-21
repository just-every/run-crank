import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {publish,connection,fakeSecret,fakeEdge,jsonResponse} from './kit.mjs';

async function invite(h,name,baseRole='member') {
 const invited=await h.send('/auth/invite',{email:name.toLowerCase().replaceAll(' ','-')+'@example.test',displayName:name,role:baseRole},h.owner);
 assert.equal(invited.status,202,invited.text);
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const token=new URL(link,h.origin).searchParams.get('token');
 const signed=await h.send('/auth/confirm',{token});
 assert.equal(signed.status,303,signed.text);
 const people=await h.send('/auth/operators',undefined,h.owner);
 return {id:people.value.find(p=>p.displayName===name).id,cookie:signed.cookie};
}

test('TEAM-001: product scopes fence direct reads, lists, publication, review and next-request changes; transfer survives departure',async()=>{
 const edge=fakeEdge();edge.routes.set('other.example',()=>jsonResponse({id:'settlement-receipt'}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try{
  const graph={trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'25.00'}},{id:'record',type:'map',input:{approved:true}}]};
  const restricted=await publish(h,'Harbour supplier settlement — restricted',graph),other=await publish(h,'Other department payroll facts',graph);
  const c=await connection(h,{app:'http',label:'Harbour finance account',auth_kind:'bearer',domains:['finance.example'],secret:{token:fakeSecret('private-finance')}});
  const hidden=await connection(h,{app:'http',label:'Other department account',auth_kind:'bearer',domains:['other.example'],secret:{token:fakeSecret('hidden-account')}});
  const builder=await invite(h,'Dana Reyes'),viewer=await invite(h,'Morgan Lee'),approver=await invite(h,'Alex Rivera'),operator=await invite(h,'Casey Nguyen');
  const scope=(person,role,workflow_ids=[restricted.id],connection_ids=[c.id])=>h.post('team/'+person.id,{role,workflow_ids,connection_ids});
  for(const [person,role] of [[builder,'builder'],[viewer,'viewer'],[approver,'approver'],[operator,'operator']]) await scope(person,role);
  for(const person of [builder,viewer,approver,operator]){
   assert.deepEqual((await h.get('workflows',person.cookie)).map(w=>w.id),[restricted.id]);
   assert.deepEqual((await h.get('connections',person.cookie)).map(c=>c.id),[c.id]);
   await h.get('workflows/'+other.id,person.cookie,403);
   assert.equal((await h.send('/api/crank/workflows/'+other.id+'/draft',{name:'Forbidden'},person.cookie)).status,403);
   await h.get('audit',person.cookie,403);await h.get('team',person.cookie,403);
   assert.deepEqual((await h.get('state',person.cookie)).runs,[]);
  }
  await h.post(`workflows/${restricted.id}/draft`,{name:'Harbour supplier settlement — reviewed draft'},builder.cookie);
  const published=await h.post(`workflows/${restricted.id}/publish`,{},builder.cookie,201,{'Idempotency-Key':'builder-publication'});
  assert.equal(published.version.authority.publisher,builder.id);
  const publishRetry=await h.post(`workflows/${restricted.id}/publish`,{},builder.cookie,201,{'Idempotency-Key':'builder-publication'});
  assert.equal(publishRetry.version.id,published.version.id);
  const bound={trigger:{type:'manual'},steps:[{id:'send',type:'http',connection_id:hidden.id,input:{url:'https://other.example/events',method:'POST',body:{}}}]};
  await h.post(`workflows/${restricted.id}/draft`,{graph:bound},builder.cookie);
  assert.equal((await h.send(`/api/crank/workflows/${restricted.id}/publish`,{},builder.cookie)).status,403,'binding an unshared connection refuses publication');
  await h.post(`workflows/${restricted.id}/draft`,{graph},builder.cookie);
  await h.post(`workflows/${restricted.id}/publish`,{},builder.cookie,201);
  const run=await h.post(`workflows/${restricted.id}/run`,{input:{tax_fact:'pending'}},operator.cookie,201);
  const detail=await h.get('workflow-runs/'+run.id,viewer.cookie);assert.equal(detail.trigger,undefined);assert.equal(detail.payload,'restricted');
  const decision={path:'review',digest:run.waits[0].proposal_digest};
  for(const person of [viewer,builder,operator]) assert.equal((await h.send(`/api/crank/workflow-runs/${run.id}/approve`,decision,person.cookie)).status,403);
  assert.equal((await h.post(`workflow-runs/${run.id}/approve`,decision,approver.cookie)).status,'succeeded');
  const own=await h.post(`workflows/${restricted.id}/run`,{input:{}},operator.cookie,201);
  await scope(operator,'approver');
  assert.equal((await h.send(`/api/crank/workflow-runs/${own.id}/approve`,{path:'review',digest:own.waits[0].proposal_digest},operator.cookie)).status,403,'run starter cannot gain self-approval by changing roles');
  await scope(approver,'approver',[]);assert.equal((await h.send(`/api/crank/workflow-runs/${own.id}/approve`,{path:'review',digest:own.waits[0].proposal_digest},approver.cookie)).status,403);
  assert.deepEqual((await h.get('workflow-runs',approver.cookie)).runs,[]);
  const spending=await publish(h,'Shared settlement still requires account-use authority',{...graph,steps:[...graph.steps,...bound.steps]});
  await scope(operator,'operator',[spending.id],[]);
  assert.equal((await h.send(`/api/crank/workflows/${spending.id}/run`,{input:{}},operator.cookie)).status,403,'workflow sharing cannot bypass connection-use scope');
  assert.equal(edge.requests.length,0);
  await scope(operator,'operator',[spending.id],[hidden.id]);
  const spend=await h.post(`workflows/${spending.id}/run`,{input:{}},operator.cookie,201),spendDecision={path:'review',digest:spend.waits[0].proposal_digest};
  await scope(approver,'approver',[spending.id],[]);
  assert.equal((await h.send(`/api/crank/workflow-runs/${spend.id}/approve`,spendDecision,approver.cookie)).status,403,'approvers also need the declared connection-use scope');
  await scope(approver,'approver',[spending.id],[hidden.id]);
  assert.equal((await h.post(`workflow-runs/${spend.id}/approve`,spendDecision,approver.cookie)).status,'succeeded');assert.equal(edge.requests.length,1);
  let release;const arriving=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"name":'));await arriving;controller.enqueue(encoder.encode('"A revoked builder must not save this"}'));controller.close()}});
  const pending=h.mf.dispatchFetch(h.origin+`/api/crank/workflows/${restricted.id}/draft`,{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{host:new URL(h.origin).host,origin:h.origin,cookie:builder.cookie,'content-type':'application/json'}});
  await new Promise(resolve=>setTimeout(resolve,500));await scope(builder,'viewer',[]);release();
  const refused=await pending;assert.equal(refused.status,403,await refused.text());assert.notEqual((await h.get('workflows/'+restricted.id)).name,'A revoked builder must not save this');
  assert.equal((await h.send(`/api/crank/workflows/${restricted.id}/publish`,{},builder.cookie,{'Idempotency-Key':'builder-publication'})).status,403,'a publication receipt cannot restore revoked workflow scope');
  await scope(builder,'builder');
  await h.post('team/transfer',{workflow_id:restricted.id,new_owner_id:viewer.id});
  assert.equal((await h.get('workflows/'+restricted.id)).owner.id,viewer.id);
  const deactivated=await h.send('/auth/operator/status',{operatorId:builder.id,status:'inactive'},h.owner);assert.equal(deactivated.status,200,deactivated.text);
  assert.equal((await h.send('/api/crank/workflows/'+restricted.id,undefined,builder.cookie)).status,401);
  assert.equal((await h.send(`/api/crank/workflows/${restricted.id}/publish`,{},builder.cookie,{'Idempotency-Key':'builder-publication'})).status,401);
  assert.equal((await h.get('workflows/'+restricted.id)).status,'published');
  await h.restart();assert.equal((await h.get('workflows/'+restricted.id)).owner.id,viewer.id);
  assert.equal((await h.post(`workflow-runs/${own.id}/reject`,{path:'review',digest:own.waits[0].proposal_digest})).status,'rejected');
  const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='team.scope'));assert.ok(audit.some(a=>a.action==='workflow.transfer'));
  const archive=await h.post('data/export');assert.ok(!JSON.stringify(archive).includes('private-finance'));assert.ok(!JSON.stringify(archive).includes('hidden-account'));
  assert.ok(!archive.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>item.kind==='row'&&item.table==='crank_team_access'));
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});assert.equal(setup.status,303);
  const page=await h.send('/app/access',undefined,h.owner);assert.equal(page.status,200);assert.ok(page.text.includes('/api/crank/team/'+viewer.id));
 }finally{await h.close()}
});

test('TEAM-001 / WORK-008: scoped builders freeze draft tests; both account bindings, late commits and continued dispatch obey live authority',async()=>{
 const edge=fakeEdge();edge.routes.set('ledger.example',()=>jsonResponse({id:'sandbox-invoice'},201));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try{
  const builder=await invite(h,'Riley Chen'),viewer=await invite(h,'Sam Patel');
  const account=await connection(h,{app:'http',label:'Harbour production ledger',auth_kind:'bearer',domains:['ledger.example'],secret:{token:fakeSecret('production')}});
  const sandbox=await connection(h,{app:'http',label:'Harbour test ledger',auth_kind:'bearer',domains:['ledger.example'],secret:{token:fakeSecret('sandbox')}});
  await h.post(`connections/${sandbox.id}/purpose`,{purpose:'test'});
  const graph={trigger:{type:'manual'},steps:[{id:'invoice',type:'http',connection_id:account.id,input:{url:'https://ledger.example/invoices',method:'POST',body:{customer:'{{trigger.input.customer}}'}}}]};
  const workflow=await publish(h,'Harbour Workshop — builder invoice rehearsal',graph),other=await publish(h,'Unshared department workflow',graph);
  const scope=(role='builder',connections=[account.id,sandbox.id])=>h.post('team/'+builder.id,{role,workflow_ids:[workflow.id],connection_ids:connections});
  await scope();await h.post('team/'+viewer.id,{role:'viewer',workflow_ids:[workflow.id],connection_ids:[]});
  const request={input:{customer:'Northshore Mechanical — sandbox sample'},bindings:{[account.id]:sandbox.id}};
  await h.post(`workflows/${other.id}/test`,request,builder.cookie,403);
  await h.post(`workflows/${workflow.id}/test`,request,viewer.cookie,403);
  for(const ids of [[account.id],[sandbox.id]]){
   await scope('builder',ids);await h.post(`workflows/${workflow.id}/test`,request,builder.cookie,403);
  }
  assert.equal(edge.requests.length,0,'neither a hidden original nor a hidden replacement account can be used');
  await scope();const tested=await h.post(`workflows/${workflow.id}/test`,request,builder.cookie,201);
  assert.equal(tested.status,'succeeded');assert.equal(tested.mode,'test');assert.equal(tested.version.published_by,builder.id);
  assert.equal(tested.version.authority,'member-authorized draft test');assert.equal(tested.steps[0].output.body.id,'sandbox-invoice');
  assert.equal(edge.requests.length,1);assert.equal(JSON.parse(edge.requests[0].body).customer,request.input.customer);
  assert.equal((await h.get('workflows/'+workflow.id)).published_version_id,workflow.published.version.id,'a builder test never publishes its snapshot');
  assert.equal((await h.get(`workflows/${workflow.id}/today`)).runs,0,'test work remains outside production usage');
  await h.post(`workflows/${workflow.id}/run`,{input:{}},builder.cookie,403);
  const live={...request,bindings:{[account.id]:account.id}};
  const waiting=await h.post(`workflows/${workflow.id}/test`,live,builder.cookie,201);
  assert.equal(waiting.status,'awaiting_approval');assert.equal(edge.requests.length,1,'production-account rehearsal still requires exact-effect approval');
  await h.post(`workflow-runs/${waiting.id}/approve`,{path:'invoice',digest:waiting.waits[0].proposal_digest},builder.cookie,403);
  const testReviewer=await invite(h,'Taylor Brooks');await h.post('team/'+testReviewer.id,{role:'approver',workflow_ids:[workflow.id],connection_ids:[account.id,sandbox.id]});
  await h.post(`workflow-runs/${waiting.id}/approve`,{path:'invoice',digest:waiting.waits[0].proposal_digest},testReviewer.cookie,403);
  assert.equal((await h.get('workflow-runs/'+waiting.id,testReviewer.cookie)).waits[0].can_review,false);assert.equal(edge.requests.length,1,'a scoped approver cannot confirm a production-account test effect');

  await h.restart();const completed=await h.post(`workflow-runs/${waiting.id}/approve`,{path:'invoice',digest:waiting.waits[0].proposal_digest});
  assert.equal(completed.status,'succeeded');assert.equal(edge.requests.length,2,'unchanged builder authority survives restart');
  const repairWorkflow=await publish(h,'Builder rehearsal — repair one invalid amount',{trigger:{type:'manual'},steps:[{id:'rows',type:'loop',max_items:2,concurrency:1,order:'input',empty:'error',item_errors:'continue',input:{items:[{amount:'bad'}]},result:'{{steps.amount}}',steps:[{id:'amount',type:'transform',fn:'number.parse',input:{value:'{{item.amount}}'}}]}]});
  await h.post('team/'+builder.id,{role:'builder',workflow_ids:[workflow.id,repairWorkflow.id],connection_ids:[account.id,sandbox.id]});
  const failedTest=await h.post(`workflows/${repairWorkflow.id}/test`,{bindings:{}},builder.cookie,201);
  const preview=await h.get(`workflow-runs/${failedTest.id}/replay`);
  const repaired=await h.post(`workflow-runs/${failedTest.id}/replay`,{paths:['rows/items/0/amount'],digest:preview.digest,corrections:{'rows/items/0/amount':{value:'782.25'}}});
  assert.equal(repaired.status,'succeeded','an owner can repair a builder test under its unchanged original test authority');assert.equal(repaired.repair_of,failedTest.id);assert.equal(repaired.steps.find(step=>step.path==='rows/items/0/amount').output,782.25);
  const revokedTest=await h.post(`workflows/${repairWorkflow.id}/test`,{bindings:{}},builder.cookie,201),revokedPreview=await h.get(`workflow-runs/${revokedTest.id}/replay`);
  await scope();const revokedRepair=await h.post(`workflow-runs/${revokedTest.id}/replay`,{paths:['rows/items/0/amount'],digest:revokedPreview.digest,corrections:{'rows/items/0/amount':{value:'500.00'}}});
  assert.equal(revokedRepair.status,'paused','owner repair cannot replace a revoked test initiator’s authority');assert.equal(revokedRepair.error.category,'authority');
  for(const change of ['role','connection','deactivation']){
   await scope();const pending=await h.post(`workflows/${workflow.id}/test`,live,builder.cookie,201);
   if(change==='deactivation')assert.equal((await h.send('/auth/operator/status',{operatorId:builder.id,status:'inactive'},h.owner)).status,200);
   else await scope(change==='role'?'viewer':'builder',change==='connection'?[]:[account.id,sandbox.id]);
   if(change!=='deactivation')await scope(); // Regranting never resurrects an old test revision.
   await h.restart();const stopped=await h.post(`workflow-runs/${pending.id}/approve`,{path:'invoice',digest:pending.waits[0].proposal_digest});
   assert.equal(stopped.status,'paused',change);assert.equal(stopped.error.category,'authority');assert.equal(edge.requests.length,2,change+' stops the next dispatch');
  }
  // A separately active builder loses scope after HTTP admission but before its test commits.
  await h.post('team/'+viewer.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[account.id,sandbox.id]});
  let release;const ready=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"bindings":'));await ready;controller.enqueue(encoder.encode(JSON.stringify(request.bindings)+'}'));controller.close()}});
  const inFlight=h.mf.dispatchFetch(h.origin+`/api/crank/workflows/${workflow.id}/test`,{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{origin:h.origin,cookie:viewer.cookie,'content-type':'application/json'}});
  await new Promise(resolve=>setTimeout(resolve,500));await h.post('team/'+viewer.id,{role:'viewer',workflow_ids:[],connection_ids:[]});release();
  assert.equal((await inFlight).status,403);assert.equal(edge.requests.length,2,'late-commit revocation creates no test effect');
  assert.ok((await h.get('audit')).some(a=>a.action==='workflow.test'&&a.actor_id===builder.id&&a.version_id===tested.version_id));
  const exported=await h.post('data/export'),receiving=await harness('http://127.0.0.1:9',{edge:edge.edge});
  try{
   assert.ok(!exported.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).some(item=>item.table==='crank_team_access'),'builder access authority never travels');
   await receiving.post('data/restore',{archive:exported,confirm:'RESTORE'});
   const restored=await receiving.get('workflow-runs/'+tested.id);assert.equal(restored.mode,'test');assert.deepEqual(restored.steps,tested.steps);assert.equal(restored.version.declared.test_team_revision,tested.version.declared.test_team_revision);
   assert.equal((await receiving.get('workflows/'+workflow.id)).status,'paused');
   await receiving.tick();assert.equal(edge.requests.length,2,'portable test provenance never grants receiving execution authority');
  }finally{await receiving.close()}

 }finally{await h.close()}
});
