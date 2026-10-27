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

test('TEAM-001: complete explicit grants authorize native work, delegation, scoped recovery and value-free duties without cross-grant widening',async()=>{
 const edge=fakeEdge();edge.routes.set('grants.example',()=>jsonResponse({id:'synthetic-crank-receipt'},201));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const person=await invite(h,'Synthetic grant builder'),admin=await invite(h,'Synthetic delegated admin'),recipient=await invite(h,'Synthetic delegated builder'),auditor=await invite(h,'Synthetic audit reader'),billing=await invite(h,'Synthetic billing administrator');
  const c=await connection(h,{app:'http',label:'Synthetic account',auth_kind:'bearer',domains:['grants.example'],secret:{token:fakeSecret('grant-custody')}});
  const graph={trigger:{type:'manual'},steps:[{id:'send',type:'http',connection_id:c.id,input:{url:'https://grants.example/events',method:'POST',body:{customer:'synthetic-crank-customer-private'}}}]};
  const w=await publish(h,'Synthetic granted workflow',graph),other=await publish(h,'Synthetic ungranted workflow',graph);
  const grant=(role,workflow_ids=[],connection_ids=[])=>({role,workflow_ids,connection_ids});
  const assign=(p,grants,cookie=h.owner,status=200)=>h.post('team/'+p.id,{grants},cookie,status);
  await h.get('workflows/'+w.id,person.cookie,403);
  await assign(person,[grant('builder',[w.id]),grant('viewer',[w.id],[c.id])]);
  await h.post(`workflows/${w.id}/publish`,{},person.cookie,403);
  assert.equal(edge.requests.length,0);
  await assign(person,[grant('viewer',[other.id]),grant('builder',[w.id],[c.id])]);
  const published=await h.post(`workflows/${w.id}/publish`,{},person.cookie,201);
  assert.equal(published.version.authority.publisher,person.id);
  await h.post(`workflows/${other.id}/draft`,{name:'Refused cross-grant write'},person.cookie,403);
  const visible=await h.post(`workflows/${w.id}/run`,{input:{customer:'synthetic-crank-allowed-payload'}},h.owner,201);
  const restricted=await h.post(`workflows/${other.id}/run`,{input:{customer:'synthetic-crank-restricted-payload'},business_key:'synthetic-crank-restricted-key'},h.owner,201);
  const legacyVisible=await h.flow('Synthetic complete legacy read'),legacyRestricted=await h.flow('Synthetic status-only legacy read');
  const legacyRuns=[await h.run(legacyVisible,'synthetic-crank-mixed-one',{customer:'synthetic-crank-legacy-allowed'}),await h.run(legacyRestricted,'synthetic-crank-mixed-two',{customer:'synthetic-crank-legacy-restricted'})];
  for(const grants of [
   [grant('builder',[w.id,legacyVisible.id],[c.id]),grant('viewer',[other.id,legacyRestricted.id])],
   [grant('viewer',[other.id,legacyRestricted.id]),grant('builder',[w.id,legacyVisible.id],[c.id])],
  ]) {
   await assign(person,grants);
   const listed=(await h.get('workflow-runs',person.cookie)).runs;
   assert.deepEqual(listed.map(row=>row.id).sort(),[visible.id,restricted.id].sort());
   assert.equal(listed.find(row=>row.id===visible.id).trigger.input.customer,'synthetic-crank-allowed-payload');
   const hidden=listed.find(row=>row.id===restricted.id);assert.equal(hidden.payload,'restricted');assert.equal(hidden.trigger,undefined);assert.equal(hidden.business_key,null);
   assert.equal((await h.get('workflow-runs/'+restricted.id,person.cookie)).payload,'restricted');
   assert.deepEqual((await h.get('workflow-runs?q=synthetic-crank-restricted-payload',person.cookie)).runs,[]);
   assert.deepEqual((await h.get('workflow-runs?business_key=synthetic-crank-restricted-key',person.cookie)).runs,[]);
   assert.deepEqual((await h.get('workflow-runs?q=synthetic-crank-allowed-payload',person.cookie)).runs.map(row=>row.id),[visible.id]);
   const state=await h.get('state',person.cookie);
   assert.equal(state.runs.find(row=>row.id===legacyRuns[0].id).input.customer,'synthetic-crank-legacy-allowed');
   assert.equal(state.runs.find(row=>row.id===legacyRuns[1].id).payload,'restricted');
   assert.ok(!JSON.stringify(state).includes('synthetic-crank-legacy-restricted'));
   assert.equal((await h.get('runs/'+legacyRuns[1].id,person.cookie)).payload,'restricted');
  }
  await assign(admin,[grant('admin',[w.id],[c.id])]);
  await assign(recipient,[grant('builder',[w.id],[c.id])],admin.cookie);
  await h.post(`workflows/${w.id}/draft`,{name:'Delegated builder draft'},recipient.cookie);
  await assign(recipient,[grant('builder',[other.id],[c.id])],admin.cookie,403);
  await assign(recipient,[grant('auditor')],admin.cookie,403);
  await assign(recipient,[grant('approver',[w.id],[c.id])],admin.cookie,403);
  await assign(admin,[grant('admin',[w.id],[c.id]),grant('approver',[w.id],[c.id])]);
  await assign(recipient,[grant('approver',[w.id],[c.id])],admin.cookie,403);
  await assign(admin,[grant('admin',['workspace:production'])]);
  await assign(recipient,[]);
  await assign(recipient,[grant('builder',['workspace:production'])],admin.cookie);
  const created=await h.post('workflows',{name:'Synthetic delegated creation',graph:{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]}},recipient.cookie,201);
  assert.equal((await h.get('workflows/'+created.id,recipient.cookie)).name,'Synthetic delegated creation');
  await h.get('workflows/'+created.id,admin.cookie,403);
  await h.get('workflows/'+w.id,recipient.cookie,403);
  await h.post('workflows',{name:'Synthetic denied environment',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]}},recipient.cookie,403);
  const createdLegacy=await h.post('flows',{name:'Synthetic delegated legacy draft',source_app:'Synthetic source',destination_app:'Synthetic destination',target_url:'http://127.0.0.1:9/events'},recipient.cookie,201);
  assert.equal((await h.get('flows/'+createdLegacy.id,recipient.cookie)).status,'draft');
  await h.get('flows/'+createdLegacy.id,admin.cookie,403);
  await assign(recipient,[],admin.cookie);
  await h.get('workflows/'+created.id,recipient.cookie,403);
  await assign(recipient,[grant('builder',[w.id],[c.id])]);
  await assign(admin,[grant('admin',[w.id],[c.id])]);
  await h.post('data/export',{},admin.cookie,403);
  let release;const gate=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"grants":'));await gate;controller.enqueue(encoder.encode(JSON.stringify([grant('viewer',[w.id])])+'}'));controller.close()}});
  const pendingDelegation=h.mf.dispatchFetch(h.origin+'/api/crank/team/'+recipient.id,{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{origin:h.origin,cookie:admin.cookie,'content-type':'application/json'}});
  await new Promise(resolve=>setTimeout(resolve,500));await assign(admin,[]);release();assert.equal((await pendingDelegation).status,403);
  assert.equal((await h.get('team')).find(row=>row.operator_id===recipient.id).grants[0].role,'builder');
  const recover=await publish(h,'Synthetic scoped recovery',{trigger:{type:'manual'},steps:[{id:'amount',type:'transform',fn:'number.parse',input:{value:'bad'}}]});
  const run=await h.post(`workflows/${recover.id}/run`,{},h.owner,201);
  await assign(person,[grant('operator',[recover.id])]);
  const preview=await h.get(`workflow-runs/${run.id}/replay`,person.cookie);
  assert.deepEqual(preview.eligible.map(step=>step.path),['amount']);
  const repaired=await h.post(`workflow-runs/${run.id}/replay`,{digest:preview.digest,paths:['amount'],corrections:{amount:{value:'42.25'}}},person.cookie);
  assert.equal(repaired.status,'succeeded');assert.equal(repaired.steps[0].output,42.25);
  await h.get(`workflow-runs/${run.id}/replay`,recipient.cookie,403);
  await assign(auditor,[grant('auditor')]);await assign(billing,[grant('billing')]);
  const history=await h.get('audit',auditor.cookie);assert.ok(history.some(row=>row.action==='team.scope'));
  assert.ok(history.every(row=>row.detail===undefined && row.detail_json===undefined));
  const auditExport=(await h.get('audit/export',auditor.cookie)).trim().split('\n').map(JSON.parse);
  assert.ok(auditExport.some(row=>row.action==='audit.export'&&row.actor_id===auditor.id));
  assert.ok(auditExport.every(row=>row.detail===undefined&&row.detail_json===undefined));
  const totals=await h.get('reports/usage',billing.cookie);assert.deepEqual(totals.map(row=>({runs:row.runs,accounted_units:row.accounted_units})),[{runs:5,accounted_units:'0'}]);
  for(const p of [auditor,billing]) {
   for(const path of ['connections','workflows','workflow-runs']) assert.deepEqual((await h.get(path,p.cookie)).runs??await h.get(path,p.cookie),[]);
   await h.get('workflow-runs/'+run.id,p.cookie,403);await h.post('data/export',{},p.cookie,403);
   assert.ok(!JSON.stringify(await h.get('state',p.cookie)).includes('synthetic-crank-customer-private'));
  }
  assert.ok(!JSON.stringify([history,totals]).includes('synthetic-crank-customer-private'));
  assert.ok(!JSON.stringify([history,totals]).includes('grant-custody'));
  const reviewWorkflow=await publish(h,'Synthetic owner separation',{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'25.00'}}]});
  const ownerRun=await h.send('/api/crank/workflows/'+reviewWorkflow.id+'/run',{input:{}},h.owner);assert.equal(ownerRun.status,201);
  await h.post(`workflow-runs/${ownerRun.value.id}/approve`,{path:'review',digest:ownerRun.value.waits[0].proposal_digest},h.owner,403);
  const ownTest=await h.post(`workflows/${w.id}/test`,{bindings:{[c.id]:c.id}} ,h.owner,201);
  assert.equal(ownTest.status,'awaiting_approval');
  await h.post(`workflow-runs/${ownTest.id}/approve`,{path:'send',digest:ownTest.waits[0].proposal_digest},h.owner,403);
  const legacy=await h.flow('Synthetic legacy self approval');
  const pending=await h.send('/api/crank/flows/'+legacy.id+'/runs',{event_id:'synthetic-crank-self',input:{customer:'synthetic-crank-private'}},h.owner);assert.equal(pending.status,201);
  await h.post('runs/'+pending.value.id+'/approve',{},h.owner,403);
  const legacyAdmin=await invite(h,'Synthetic legacy administrator','admin');
  await assign(legacyAdmin,[grant('admin',[reviewWorkflow.id,legacy.id]),grant('approver',[reviewWorkflow.id,legacy.id])]);
  const nativeOwn=await h.post(`workflows/${reviewWorkflow.id}/run`,{},legacyAdmin.cookie,201);
  await h.post(`workflow-runs/${nativeOwn.id}/approve`,{path:'review',digest:nativeOwn.waits[0].proposal_digest},legacyAdmin.cookie,403);
  const own=await h.post('flows/'+legacy.id+'/runs',{event_id:'synthetic-crank-admin-self',input:{}},legacyAdmin.cookie,201);
  await h.post('runs/'+own.id+'/approve',{},legacyAdmin.cookie,403);
 } finally {await h.close()}
});

test('TEAM-001: the native upgrade snapshots exact existing Base access once and never grants newly invited people fallback access',async()=>{
 const h=await harness('http://127.0.0.1:9',{beforeTeamMigration:true});
 try {
  const w=await publish(h,'Synthetic migration workflow',{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]});
  const admin=await invite(h,'Synthetic migrating administrator','admin'),viewer=await invite(h,'Synthetic migrating reader');
  await h.migrateTeam();
  const reports=await h.get('team/migration');
  assert.deepEqual(reports.map(row=>row.operator_id).sort(),[admin.id,viewer.id].sort());
  for(const row of reports){assert.equal(row.gained_access,0);assert.deepEqual(row.grants[0].workflow_ids.slice().sort(),(row.operator_id===admin.id?[w.id,'workspace:production']:[w.id]).sort());assert.deepEqual(row.grants[0].connection_ids,[])}
  assert.deepEqual(reports.find(row=>row.operator_id===admin.id).grants[0].actions,['read','prepare','start']);
  assert.deepEqual(reports.find(row=>row.operator_id===viewer.id).grants[0].actions,['read']);
  await h.post(`workflows/${w.id}/draft`,{name:'Migrated edit remains authorized'},admin.cookie);
  await h.post(`workflows/${w.id}/publish`,{},admin.cookie,403);
  assert.equal((await h.get('workflows/'+w.id,viewer.cookie)).name,'Migrated edit remains authorized');
  await h.post(`workflows/${w.id}/draft`,{name:'Refused migration widening'},viewer.cookie,403);
  const authored=await h.post('workflows',{name:'Synthetic migrated creation',graph:{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]}},admin.cookie,201);
  assert.equal((await h.get('workflows/'+authored.id,admin.cookie)).name,'Synthetic migrated creation');
  await h.post('workflows',{name:'Refused cross-environment creation',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]}},admin.cookie,403);
  const later=await publish(h,'Synthetic post-migration record',{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]});
  await h.get('workflows/'+later.id,admin.cookie,403);
  const newcomer=await invite(h,'Synthetic new ungranted administrator','admin');
  await h.get('workflows/'+w.id,newcomer.cookie,403);
  await h.restart();assert.deepEqual(await h.get('team/migration'),reports,'restart never widens or repeats the migration snapshot');
  const archive=await h.post('data/export');
  assert.ok(!archive.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>['crank_team_access','crank_team_migration_reports'].includes(item.table)));
 }finally{await h.close()}
});
