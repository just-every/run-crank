import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse,settled} from './kit.mjs';
import {CrankClient,CrankApiError} from '../sdk/index.js';
import {archive} from './restore-journey.mjs';

const graph={trigger:{type:'manual'},steps:[{id:'receipt',type:'http',input:{method:'POST',url:'https://platform-ledger.example/receipts',body:{to:'operations@harbor.example',amount:'25.00'}}}]};
const costs={cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-reviewed synthetic network edge; no paid operations'}))}};
const client=(h,authority={cookie:h.owner})=>new CrankClient({baseUrl:h.origin,...authority,fetch:(url,init)=>h.mf.dispatchFetch(url,init)});
const mcp=(h,authority={cookie:h.owner})=>async(method,params={},id=crypto.randomUUID())=>{
 const response=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:h.origin,accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-06-18',...(authority.cookie?{cookie:authority.cookie}:{}),...(authority.token?{authorization:'Bearer '+authority.token}:{})},body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params})});
 return {status:response.status,value:response.status===202?null:await response.json()};
};
const call=async(rpc,name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.status,200);assert.ok(!r.value.error,JSON.stringify(r.value));return r.value.result};
const issue=async(h,w)=>h.post('grants',{label:'Harbor supplier receipt agent',workflow_id:w.id,version_id:w.published_version_id,expires_at:new Date(Date.now()+3600000).toISOString(),policy:{rules:[{step_id:'receipt',type:'http',connection_id:null,app:'none',fields:['method','url','body'],recipients:['operations@harbor.example'],recipient_field:'body.to',amount_field:'body.amount',max_usd:'100.00',max_per_minute:50}],approval:{timeout_seconds:60,delegate_ids:[],escalate_to:[]}}},h.owner,201);

test('PLATFORM-001: SDK and MCP draft lifecycle, granted execution/progress, paginated reads and out-of-grant denial share native approval and audit',async()=>{
 const edge=fakeEdge();edge.routes.set('platform-ledger.example',({body})=>jsonResponse({id:crypto.randomUUID(),receipt:JSON.parse(body)}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try{
  const sdk=client(h),rpc=mcp(h);
  const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Crank public-door acceptance',version:'1'}});
  assert.equal(initialized.value.result.capabilities.tools.listChanged,false);
  const notification=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:h.origin,cookie:h.owner,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});assert.equal(notification.status,202);assert.equal(await notification.text(),'');
  const hostile=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:'https://foreign.example',cookie:h.owner,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(hostile.status,403);
  const malformed=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:h.origin,cookie:h.owner,accept:'application/json, text/event-stream','content-type':'application/json'},body:'{'});assert.equal(malformed.status,400);assert.equal((await malformed.json()).error.code,-32700);
  const listed=await rpc('tools/list');assert.ok(listed.value.result.tools.some(t=>t.name==='start_task'));
  assert.equal((await rpc('invented')).value.error.code,-32601);
  assert.equal((await rpc('tools/call',{name:'get_run',arguments:{run_id:'x',url:'https://untrusted.example'}})).value.error.code,-32602);
  const draft=await sdk.createDraft({name:'Harbor Workshop — supplier receipt integration',graph},{idempotencyKey:'sdk-create'});
  assert.equal(draft.status,'draft');assert.equal(edge.requests.length,0);
  assert.equal((await sdk.validateDraft(draft.id)).ok,true);
  const mcpDraft=await call(rpc,'create_draft',{input:{name:'Harbor Workshop — MCP draft only',graph},idempotency_key:'mcp-create'});
  const duplicate=await call(rpc,'create_draft',{input:{name:'Harbor Workshop — MCP draft only',graph},idempotency_key:'mcp-create'});
  assert.equal(mcpDraft.structuredContent.value.id,duplicate.structuredContent.value.id);
  assert.equal(edge.requests.length,0,'remote draft creation/validation never dispatches actions');
  assert.equal((await call(rpc,'validate_draft',{workflow_id:mcpDraft.structuredContent.value.id})).structuredContent.value.ok,true);
  const preparer=await h.post('tokens',{label:'Harbor integrations preparation',scope:'agent'},h.owner,201), prep=client(h,{token:preparer.token});
  assert.equal((await prep.createDraft({name:'Agent-prepared inert draft',graph})).status,'draft');
  await assert.rejects(()=>prep.publishDraft(draft.id),e=>e instanceof CrankApiError&&e.status===403&&e.code==='forbidden');
  await h.post(`workflows/${draft.id}/estimate`,costs);
  const published=await sdk.publishDraft(draft.id);assert.ok(published.version.id);
  const current=await sdk.readWorkflow(draft.id), grant=await issue(h,current), exec=client(h,{token:grant.credential}), agentRpc=mcp(h,{token:grant.credential});
  const input={task_id:'sdk-receipt',actions:[{step_id:'receipt',input:{body:{to:'operations@harbor.example',amount:'25.00'}}}]};
  let loseResponse=true;
  const lossy=new CrankClient({baseUrl:h.origin,token:grant.credential,fetch:async(url,init)=>{
   const response=await h.mf.dispatchFetch(url,init);
   if(loseResponse){loseResponse=false;await response.text();throw Error('Simulated response loss after committed task')}
   return response;
  }});
  const starts=await Promise.allSettled([lossy.startTask(input,{idempotencyKey:'receipt-one'}),...Array.from({length:3},()=>exec.startTask(input,{idempotencyKey:'receipt-one'}))]);
  assert.equal(starts[0].status,'rejected');assert.equal(starts[0].reason.code,'network_error');
  const ids=starts.slice(1).map(result=>{assert.equal(result.status,'fulfilled');return result.value.id});assert.equal(new Set(ids).size,1);
  const run=await settled(h,ids[0]);assert.equal(run.status,'succeeded');assert.equal(edge.requests.length,1);
  await h.restart();
  const retry=await exec.startTask({actions:input.actions,task_id:input.task_id},{idempotencyKey:'receipt-one'});
  assert.equal(retry.id,run.id);assert.equal(retry.version_id,run.version_id);assert.equal(retry.status,'succeeded');assert.equal(edge.requests.length,1);
  await assert.rejects(()=>exec.startTask({...input,task_id:'changed'},{idempotencyKey:'receipt-one'}),e=>e.status===409&&e.code==='conflict');
  assert.equal((await h.get('audit')).filter(a=>a.action==='grant.task'&&a.subject_id===run.id).length,1);
  const exported=await archive(h);assert.ok(!exported.includes('receipt-one'));assert.ok(!exported.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>item.table==='crank_task_idempotency'));
  assert.equal((await exec.readTask(run.id)).id,run.id);
  const restored=await harness('http://127.0.0.1:9',{edge:edge.edge});
  try{
   await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
   assert.equal((await restored.get(`workflows/${draft.id}`)).status,'paused');
   assert.equal((await restored.get(`workflow-runs/${run.id}`)).status,'succeeded');
   await assert.rejects(()=>client(restored,{token:grant.credential}).startTask(input,{idempotencyKey:'receipt-one'}),e=>e.status===401);
   await restored.restart();await restored.tick();assert.equal(edge.requests.length,1);
  }finally{await restored.close()}

  const second=await call(agentRpc,'start_task',{input:{...input,task_id:'mcp-receipt'},idempotency_key:'mcp-task'});assert.equal(second.structuredContent.value.status,'succeeded');
  const secondRetry=await call(agentRpc,'start_task',{input:{...input,task_id:'mcp-receipt'},idempotency_key:'mcp-task'});assert.equal(secondRetry.structuredContent.value.id,second.structuredContent.value.id);assert.equal(edge.requests.length,2);
  assert.equal((await call(agentRpc,'get_task',{run_id:second.structuredContent.value.id})).structuredContent.value.grant_id,grant.id);
  const count=edge.requests.length;
  await assert.rejects(()=>exec.startTask({task_id:'foreign',actions:[{step_id:'foreign',input:{}}]}),e=>e.status===422&&e.code==='invalid_operation');
  assert.equal((await call(agentRpc,'create_draft',{input:{name:'Escalate',graph}})).isError,true);
  assert.equal((await call(agentRpc,'list_connections')).isError,true);
  const heldInput={task_id:'outside-limit',actions:[{step_id:'receipt',input:{body:{to:'outsider@example.test',amount:'100.01'}}}]};
  const held=await call(agentRpc,'start_task',{input:heldInput,idempotency_key:'needs-review'});
  assert.equal(held.structuredContent.value.status,'awaiting_approval');assert.equal(edge.requests.length,count,'grant limit cannot bypass exact human approval');
  const waiting=held.structuredContent.value;
  const pendingRetry=await exec.startTask(heldInput,{idempotencyKey:'needs-review'});assert.equal(pendingRetry.id,waiting.id);assert.equal(pendingRetry.status,'awaiting_approval');assert.equal(pendingRetry.waits[0].proposal_digest,waiting.waits[0].proposal_digest);assert.equal(edge.requests.length,count);
  assert.equal((await h.post(`workflow-runs/${waiting.id}/reject`,{path:waiting.waits[0].path,digest:waiting.waits[0].proposal_digest})).status,'rejected');
  assert.equal(edge.requests.length,count);
  const rejectedRetry=await exec.startTask(heldInput,{idempotencyKey:'needs-review'});assert.equal(rejectedRetry.id,waiting.id);assert.equal(rejectedRetry.status,'rejected');assert.equal(edge.requests.length,count);
  const seen=[];for await(const r of sdk.iterateRuns({workflow:draft.id,limit:1}))seen.push(r.id);
  assert.deepEqual(new Set(seen),new Set([run.id,second.structuredContent.value.id,waiting.id]));assert.equal(seen.length,3);
  const page=await call(rpc,'list_runs',{workflow:draft.id,limit:1});assert.ok(page.structuredContent.value.next);
  const next=await call(rpc,'list_runs',{workflow:draft.id,limit:1,before:page.structuredContent.value.next});assert.notEqual(next.structuredContent.value.runs[0].id,page.structuredContent.value.runs[0].id);
  const audit=await h.get('audit');for(const action of ['workflow.create','workflow.publish','grant.task','run.reject'])assert.ok(audit.some(a=>a.action===action),action);
  assert.equal((await h.send('/api/crank/v1/workflows')).value.code,'unauthenticated');
  const independent=await issue(h,current), other=client(h,{token:independent.credential});
  const separate=await other.startTask(input,{idempotencyKey:'receipt-one'});assert.notEqual(separate.id,run.id);assert.equal(edge.requests.length,count+1);
  await h.post(`workflows/${draft.id}/pause`);
  const erased=await h.post('data/erase',{workflow_run_id:run.id,confirm:'ERASE'});assert.ok(erased.retained.some(item=>item.table==='crank_task_idempotency'));
  await h.post(`workflows/${draft.id}/resume`);
  await assert.rejects(()=>exec.startTask(input,{idempotencyKey:'receipt-one'}),e=>e.status===409);assert.equal(edge.requests.length,count+1);
  await h.post(`grants/${grant.id}/revoke`);await assert.rejects(()=>exec.readTask(waiting.id),e=>e.status===401);
  await assert.rejects(()=>exec.startTask(heldInput,{idempotencyKey:'needs-review'}),e=>e.status===401);
 }finally{await h.close()}
});

test('PLATFORM-001: concurrent and restarted draft/publication/rollback retries retain identities and audit without changing later state or restoring authority',async()=>{
 const h=await harness('http://127.0.0.1:9');let restored;
 try{
  const sdk=client(h), input={name:'Harbor Workshop — durable draft write',graph};
  const copies=await Promise.all(Array.from({length:4},()=>sdk.createDraft(input,{idempotencyKey:'create-one'})));
  assert.equal(new Set(copies.map(w=>w.id)).size,1);assert.equal(new Set(copies.map(w=>w.idempotency.draft_id)).size,1);
  const id=copies[0].id;assert.equal((await sdk.listWorkflows()).length,1);assert.equal((await sdk.readWorkflow(id)).draft_versions.length,1);
  await assert.rejects(()=>sdk.createDraft({...input,name:'Conflicting reuse'},{idempotencyKey:'create-one'}),e=>e.status===409&&e.code==='conflict');
  const edit={description:'Supplier onboarding — owner reviews before publication'};
  const saves=await Promise.all(Array.from({length:4},()=>sdk.updateDraft(id,edit,{idempotencyKey:'draft-one'})));
  assert.equal(new Set(saves.map(w=>w.idempotency.draft_id)).size,1);assert.equal((await sdk.readWorkflow(id)).draft_versions.length,2);
  await sdk.updateDraft(id,{description:'Later owner revision'});
  await h.restart();const retry=await sdk.updateDraft(id,edit,{idempotencyKey:'draft-one'});
  assert.equal(retry.description,'Later owner revision');assert.equal(retry.idempotency.replayed,true);assert.equal(retry.idempotency.draft_id,saves[0].idempotency.draft_id);
  await assert.rejects(()=>sdk.updateDraft(id,{description:'Changed key payload'},{idempotencyKey:'draft-one'}),e=>e.status===409);
  const audit=(await h.get('audit')).filter(a=>a.subject_id===id);assert.equal(audit.filter(a=>a.action==='workflow.create').length,1);assert.equal(audit.filter(a=>a.action==='workflow.draft').length,2);
  await h.post(`workflows/${id}/estimate`,costs);
  let losePublication=true;
  const lossy=new CrankClient({baseUrl:h.origin,cookie:h.owner,fetch:async(url,init)=>{
   const response=await h.mf.dispatchFetch(url,init);
   if(losePublication){losePublication=false;await response.text();throw Error('Simulated loss after committed publication')}
   return response;
  }});
  const publications=await Promise.allSettled([lossy.publishDraft(id,{}, {idempotencyKey:'publication-one'}),
   ...Array.from({length:3},()=>sdk.publishDraft(id,{}, {idempotencyKey:'publication-one'}))]);
  assert.equal(publications[0].status,'rejected');assert.equal(publications[0].reason.code,'network_error');
  const published=publications.slice(1).map(r=>{assert.equal(r.status,'fulfilled',r.reason?.message);return r.value});
  assert.equal(new Set(published.map(r=>r.version.id)).size,1);
  const first=published[0];assert.equal(first.workflow.versions.length,1);
  const rpc=mcp(h),mcpRetry=await call(rpc,'publish_workflow',{workflow_id:id,idempotency_key:'publication-one'});
  assert.equal(mcpRetry.structuredContent.value.version.id,first.version.id);
  await sdk.updateDraft(id,{graph:{trigger:{type:'schedule',at:'09:00',timezone:'America/New_York'},steps:[{id:'receipt',type:'map',input:{supplier:'Northshore Fabrication',amount:'782.25'}}]}});
  await h.post(`workflows/${id}/estimate`,costs);
  const second=await sdk.publishDraft(id,{}, {idempotencyKey:'publication-two'});assert.notEqual(second.version.id,first.version.id);
  await h.post(`workflows/${id}/pause`);
  await h.restart();
  const oldRetry=await sdk.publishDraft(id,{}, {idempotencyKey:'publication-one'});
  assert.equal(oldRetry.version.id,first.version.id);assert.equal(oldRetry.workflow.published_version_id,second.version.id);
  assert.equal(oldRetry.workflow.status,'paused');assert.equal(oldRetry.workflow.versions.length,2);
  assert.equal((await h.get(`workflows/${id}/trigger`)).schedule.version_id,second.version.id);
  await assert.rejects(()=>sdk.publishDraft(id,{changed:true},{idempotencyKey:'publication-one'}),e=>e.status===409&&e.code==='conflict');
  const rollbacks=await Promise.all(Array.from({length:4},()=>sdk.rollbackWorkflow(id,first.version.number,{idempotencyKey:'rollback-one'})));
  assert.equal(new Set(rollbacks.map(r=>r.version.id)).size,1);
  const rollback=rollbacks[0];assert.equal(rollback.workflow.versions.length,3);assert.equal(rollback.version.authority.rollback_of,first.version.number);
  assert.deepEqual((await h.get(`workflows/${id}/versions/${rollback.version.number}`)).graph,graph);
  assert.equal((await h.get(`workflows/${id}/trigger`)).schedule,null);
  await h.post(`workflows/${id}/pause`);await h.restart();
  const rolledRetry=await sdk.rollbackWorkflow(id,first.version.number,{idempotencyKey:'rollback-one'});
  assert.equal(rolledRetry.version.id,rollback.version.id);assert.equal(rolledRetry.workflow.status,'paused');
  await assert.rejects(()=>sdk.rollbackWorkflow(id,second.version.number,{idempotencyKey:'rollback-one'}),e=>e.status===409);
  const publicationAudit=(await h.get('audit')).filter(a=>a.subject_id===id&&a.action==='workflow.publish');
  assert.equal(publicationAudit.length,3);assert.deepEqual(new Set(publicationAudit.map(a=>a.version_id)),new Set([first.version.id,second.version.id,rollback.version.id]));
  const actor=await h.post('tokens',{label:'Different preparer credential',scope:'agent'},h.owner,201);
  const agent=client(h,{token:actor.token}), own=await agent.createDraft(input,{idempotencyKey:'create-one'});assert.notEqual(own.id,id);
  await assert.rejects(()=>agent.publishDraft(id,{}, {idempotencyKey:'publication-one'}),e=>e.status===403);
  await h.post(`tokens/${actor.id}/revoke`);await assert.rejects(()=>agent.createDraft(input,{idempotencyKey:'create-one'}),e=>e.status===401);
  await assert.rejects(()=>agent.publishDraft(id,{}, {idempotencyKey:'publication-one'}),e=>e.status===401);
  const exported=await archive(h),items=exported.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]);
  assert.ok(!items.some(item=>item.kind==='row'&&item.table==='crank_workflow_idempotency'));assert.ok(!exported.includes('create-one'));assert.ok(!exported.includes('draft-one'));assert.ok(!exported.includes('publication-one'));assert.ok(!exported.includes('rollback-one'));
  restored=await harness('http://127.0.0.1:9');await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
  assert.equal((await restored.get(`workflows/${id}`)).status,'paused');assert.equal((await restored.get(`workflows/${id}`)).draft_versions.length,4);
  await assert.rejects(()=>client(restored).publishDraft(id,{}, {idempotencyKey:'publication-one'}),e=>e.status===409);
  const rows=text=>text.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).filter(item=>item.kind==='row').map(({table,row})=>JSON.stringify({table,row})).sort();
  const before=rows(exported),after=rows(await archive(restored));assert.deepEqual(after.filter(item=>before.includes(item)),before);
  assert.deepEqual(after.filter(item=>!before.includes(item)).map(item=>JSON.parse(item).row.action),['data.restore']);
  await restored.restart();await restored.tick();assert.equal((await restored.get(`workflows/${id}`)).status,'paused');
  await restored.post(`workflows/${id}/estimate`,costs);
  const restoreReview=(await restored.get(`workflows/${id}`)).restore;
  const adopted=await client(restored).publishDraft(id,{restore_snapshot:restoreReview.snapshot,restore_decisions:{}},{idempotencyKey:'publication-one'});
  assert.notEqual(adopted.version.id,first.version.id);assert.equal(adopted.workflow.versions.length,4);

 }finally{await restored?.close();await h.close()}
});

test('PLATFORM-001: lost, concurrent and restarted duplicate requests keep one inert preparation without overwriting later work',async()=>{
 const edge=fakeEdge();edge.routes.set('platform-ledger.example',({body})=>jsonResponse({id:crypto.randomUUID(),receipt:JSON.parse(body)}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});let restored;
 try{
  const sdk=client(h),source=await sdk.createDraft({name:'Northshore supplier onboarding',description:'Approved purchasing workflow',graph});
  await h.post(`workflows/${source.id}/estimate`,costs);await sdk.publishDraft(source.id);
  let loseResponse=true;
  const lossy=new CrankClient({baseUrl:h.origin,cookie:h.owner,fetch:async(url,init)=>{
   const response=await h.mf.dispatchFetch(url,init);
   if(loseResponse){loseResponse=false;await response.text();throw Error('Simulated loss after committed duplication')}
   return response;
  }});
  const attempts=await Promise.allSettled([lossy.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'}),
   ...Array.from({length:3},()=>sdk.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'}))]);
  assert.equal(attempts[0].status,'rejected');assert.equal(attempts[0].reason.code,'network_error');
  const copies=attempts.slice(1).map(result=>{assert.equal(result.status,'fulfilled',result.reason?.message);return result.value});
  const copy=copies[0];
  assert.equal((await sdk.listWorkflows()).length,2,'a lost response and concurrent retries create only one preparation');
  assert.deepEqual(copy.draft,source.draft);assert.equal(copy.draft_versions.length,1);
  assert.equal(copy.published_version_id,null);assert.deepEqual(copy.versions,[]);assert.deepEqual(copy.hooks,[]);
  assert.equal(edge.requests.length,0,'duplicating a published workflow grants no dispatch authority');
  assert.equal((await h.send(`/api/crank/workflows/${copy.id}/run`,{},h.owner)).status,409);
  await sdk.updateDraft(source.id,{graph:{...graph,steps:[{...graph.steps[0],input:{...graph.steps[0].input,body:{to:'operations@harbor.example',amount:'89.00'}}}]}});
  await h.restart();
  const retried=(await call(mcp(h),'duplicate_workflow',{workflow_id:source.id,idempotency_key:'supplier-copy'})).structuredContent.value;
  assert.deepEqual(retried.draft,copy.draft,'retry preserves the reviewed copy even after its source changes');
  const edited={...graph,steps:[{...graph.steps[0],input:{...graph.steps[0].input,body:{to:'operations@harbor.example',amount:'42.00'}}}]};
  await sdk.updateDraft(copy.id,{description:'Owner customized this preparation',graph:edited});
  const current=await sdk.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'});
  assert.equal(current.description,'Owner customized this preparation');assert.deepEqual(current.draft,edited);
  assert.equal((await sdk.listWorkflows()).length,2);
  const conflict=await h.send(`/api/crank/v1/workflows/${source.id}/duplicate`,{changed:true},h.owner,{'Idempotency-Key':'supplier-copy'});
  assert.equal(conflict.status,409);assert.equal((await sdk.listWorkflows()).length,2);
  const otherSource=await sdk.createDraft({name:'A separate supplier workflow',graph});
  await sdk.duplicateWorkflow(otherSource.id,{idempotencyKey:'supplier-copy'});
  assert.equal((await sdk.listWorkflows()).length,4,'a key is scoped to its source workflow');
  const token=await h.post('tokens',{label:'Supplier preparation integration',scope:'agent'},h.owner,201),agent=client(h,{token:token.token});
  await agent.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'});
  assert.equal((await sdk.listWorkflows()).length,5,'independent credentials have independent preparations');
  await h.post(`tokens/${token.id}/revoke`);
  await assert.rejects(()=>agent.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'}),e=>e.status===401);
  const audit=(await h.get('audit')).filter(row=>row.subject_id===copy.id);
  assert.equal(audit.filter(row=>row.action==='workflow.create').length,1);assert.equal(audit.filter(row=>row.action==='workflow.draft').length,1);
  assert.equal(edge.requests.length,0);
  await h.post(`workflows/${copy.id}/estimate`,costs);await sdk.publishDraft(copy.id);
  const run=await h.post(`workflows/${copy.id}/run`,{},h.owner,201);await settled(h,run.id);
  assert.equal(edge.requests.length,1);assert.equal(JSON.parse(edge.requests[0].body).amount,'42.00','only explicit publication/start sends the owner-customized work');
  await sdk.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'});await h.tick();
  assert.equal(edge.requests.length,1,'late retries cannot start or replay the copied workflow');
  const exported=await archive(h),items=exported.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]);
  assert.ok(!items.some(item=>item.kind==='row'&&item.table==='crank_workflow_idempotency'));
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
  const local=client(restored),fresh=await local.duplicateWorkflow(source.id,{idempotencyKey:'supplier-copy'});
  assert.deepEqual(fresh.draft,(await local.readWorkflow(source.id)).draft);assert.equal(fresh.published_version_id,null);assert.deepEqual(fresh.versions,[]);
  assert.equal((await restored.send(`/api/crank/workflows/${fresh.id}/run`,{},restored.owner)).status,409);
  await restored.restart();await restored.tick();assert.equal(edge.requests.length,1,'receipt-free restoration and fresh duplication stay inactive');
 }finally{await restored?.close();await h.close()}
});


test('Per-client MCP connector tools enforce exact grants, approvals, history, restart and revocation',async()=>{
 const {mcpClientJourney}=await import('./mcp-client-journey.mjs');await mcpClientJourney();
});
