import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {fakeEdge,publish,startRun,stepOf,jsonResponse,runs,settled} from './kit.mjs';
import {orbitFixture,orbitIds,orbitOrigin,orbitStage,orbitNextStage} from './orbit-fixture.mjs';
const minute=60000;

/** Native connections and immutable public workflows; only the documented Orbit edge is faked. */
export async function orbitJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),f=orbitFixture(edge),h=await harness('http://127.0.0.1:9',{edge:edge.edge});let restored;
 try {
  await h.post('connections',{...f.input,binding:{...f.input.binding,origin:'http://127.0.0.1'}},h.owner,422);
  const agent=await h.post('tokens',{label:'Synthetic Orbit preparation',scope:'agent'},h.owner,201);
  await h.post('connections',f.input,'',403,{authorization:'Bearer '+agent.token});
  const c=await f.connect(h);assert.deepEqual(c.binding,{...f.input.binding,record_ids:[...orbitIds].sort(),fields:[...f.input.binding.fields].sort()});
  await h.post(`connections/${c.id}/rotate`,{secret:{token:f.token},binding:{...c.binding,origin:'https://foreign.synthetic-crank.example'}},h.owner,400);
  const step=(type,input,extra={})=>({id:'deal',type:'orbit.'+type,connection_id:c.id,input,...extra});
  const manual=async(type,input,extra={})=>publish(h,'Orbit '+type,{trigger:{type:'manual'},steps:[step(type,input,extra)]});
  const read=await manual('read_deal',{deal_id:orbitIds[0]},{retry_policy:{base_delay_ms:1}}),initial=await startRun(h,read,{});
  assert.equal(initial.status,'succeeded',JSON.stringify(initial.error));
  assert.deepEqual(stepOf(initial,'deal').output,{record:{...f.records.get(orbitIds[0])},etag:f.etag(f.records.get(orbitIds[0])),origin:orbitOrigin});
  const find=await manual('find_deal',{title:'synthetic-crank-401'},{multi_match:'all'}),found=await startRun(h,find,{});
  assert.equal(found.status,'succeeded');assert.deepEqual(stepOf(found,'deal').output.records,orbitIds.slice(0,2).map(id=>f.records.get(id)));
  const ambiguous=await manual('find_deal',{title:'synthetic-crank-401'},{multi_match:'stop'});
  assert.equal(stepOf(await startRun(h,ambiguous,{}),'deal').output.outcome,'multiple matches');
  const missing=await manual('find_deal',{title:'synthetic-crank-absent'},{no_match:'halt'});
  assert.equal(stepOf(await startRun(h,missing,{}),'deal').output.outcome,'not found');
  for(const mode of ['scope-refused','page-failed','bad-cursor','foreign-record','redirect']) {
   f.mode=mode;const failed=await startRun(h,find,{});assert.notEqual(failed.status,'succeeded',mode);
   assert.notEqual(stepOf(failed,'deal').output?.outcome,'not found',mode+' cannot become no-match');
  }
  f.mode='ok';let before=f.calls.length;
  for(const input of [{deal_id:'01K00000000000000000000009'},{deal_id:orbitIds[0],url:orbitOrigin+'/other'}]) {
   const invalid=await manual('read_deal',input);assert.equal((await startRun(h,invalid,{})).error.category,'validation');
  }
  for(const [method,url,body] of [
   ['GET','https://foreign.'+new URL(orbitOrigin).host+`/api/rest/v1/deals/${orbitIds[0]}?fields=title`],
   ['GET',orbitOrigin+`/api/rest/v1/deals/01K00000000000000000000009?fields=title`],
   ['GET',orbitOrigin+`/api/rest/v1/deals/${orbitIds[0]}?fields=title,private_note`],
   ['GET',orbitOrigin+`/api/rest/v1/deals/${orbitIds[0]}?fields=title&tenant=foreign`],
   ['DELETE',orbitOrigin+`/api/rest/v1/deals/${orbitIds[0]}`],
   ['POST',orbitOrigin+'/api/rest/v1/deals',{title:'synthetic-crank-403'}],
   ['PATCH',orbitOrigin+`/api/rest/v1/deals/${orbitIds[0]}`,{private_note:'synthetic-crank-403'}],
  ]) {
   const unsafe=await publish(h,'Orbit exact credential destination',{trigger:{type:'manual'},steps:[{id:'request',type:'http',connection_id:c.id,input:{method,url,...(body?{body}:{}),headers:{'if-match':f.etag(f.records.get(orbitIds[0]))}}}]});
   assert.notEqual((await startRun(h,unsafe,{})).status,'succeeded');
  }
  assert.equal(f.calls.length,before,'no foreign destination, record, field or unsupported verb reaches the provider');
  const changes={value_cents:9500,stage_id:orbitNextStage,company_id:null};
  const graph={trigger:{type:'manual'},steps:[step('read_deal',{deal_id:orbitIds[0]},{id:'read'}),step('update_deal',{deal_id:orbitIds[0],etag:'{{steps.read.etag}}',fields:changes},{id:'update'})]};
  const w=await publish(h,'Orbit conditional update',graph),done=await startRun(h,w,{});
  assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(f.updates.length,1);
  assert.deepEqual(stepOf(done,'update').output,{record:{id:orbitIds[0],title:'synthetic-crank-401',...changes},origin:orbitOrigin,independently_read_back:true,reconciled:false,outcome:'requested fields observed'});
  await inspect({h,workflow:w,run:done,state:'orbit-read-back'});
  const stale=await manual('update_deal',{deal_id:orbitIds[0],etag:stepOf(initial,'deal').output.etag,fields:{value_cents:5000}});
  assert.equal((await startRun(h,stale,{})).error.status,409);assert.equal(f.updates.length,1);
  for(const fields of [{value_cents:-1},{value_cents:'95.00'},{stage_id:'synthetic-crank-invalid'},{private_note:'synthetic-crank-404'}]) {
   const invalid=await manual('update_deal',{deal_id:orbitIds[0],etag:f.etag(f.records.get(orbitIds[0])),fields});
   assert.equal((await startRun(h,invalid,{})).error.category,'validation');
  }
  before=f.updates.length;f.mode='lost';
  const lost=await publish(h,'Orbit lost update acknowledgement',{trigger:{type:'manual'},steps:[step('update_deal',{deal_id:orbitIds[0],etag:f.etag(f.records.get(orbitIds[0])),fields:{value_cents:9000}},{timeout_ms:100})]});
  const recovered=await startRun(h,lost,{});assert.equal(recovered.status,'succeeded',JSON.stringify(recovered.error));assert.equal(f.updates.length,before+1);
  assert.equal(stepOf(recovered,'deal').output.record.value_cents,9000);assert.equal(stepOf(recovered,'deal').output.reconciled,true);
  await h.restart();assert.equal(stepOf(await h.get('workflow-runs/'+recovered.id),'deal').operation_key,stepOf(recovered,'deal').operation_key);assert.equal(f.updates.length,before+1);
  f.mode='bad-readback';const uncertain=await startRun(h,w,{});assert.equal(uncertain.status,'uncertain');
  assert.deepEqual((await h.get(`workflow-runs/${uncertain.id}/replay`)).eligible,[]);await h.post(`workflow-runs/${uncertain.id}/resume`,{},h.owner,409);
  f.mode='ok';
  // Revocation after an accepted write pauses readback; reconnection must never repeat that PATCH.
  const resumeWorkflow=await manual('update_deal',{deal_id:orbitIds[0],etag:f.etag(f.records.get(orbitIds[0])),fields:{value_cents:8000}});
  f.mode='post-revoke';f.afterWrite=()=>h.post(`connections/${c.id}/revoke`);before=f.updates.length;
  const paused=await startRun(h,resumeWorkflow,{});assert.equal(paused.status,'paused');assert.equal(f.updates.length,before+1);
  await h.restart();f.token='synthetic-crank-405';await h.post(`connections/${c.id}/rotate`,{secret:{token:f.token}});
  const resumed=await h.post(`workflow-runs/${paused.id}/resume`);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.equal(f.updates.length,before+1);
  assert.equal(stepOf(resumed,'deal').operation_key,stepOf(paused,'deal').operation_key);assert.equal(stepOf(resumed,'deal').output.record.value_cents,8000);
  // A retry rechecks current authority instead of using the earlier read grant.
  f.mode='retry';f.afterRequest=()=>h.post(`connections/${c.id}/rotate`,{secret:{token:f.token},scopes:[]});before=f.calls.length;
  const revoked=await startRun(h,read,{});assert.equal(revoked.status,'paused');assert.equal(f.calls.length,before+1);
  await inspect({h,workflow:read,run:revoked,state:'orbit-scope-revoked'});
  await h.post(`connections/${c.id}/rotate`,{secret:{token:f.token},scopes:['deal.read','deal.update']});
  const inventory=await h.get('data'+'/flows'),disclosure=inventory.flows.find(flow=>flow.kind==='orbit.update_deal');
  assert.deepEqual(disclosure.recipients,[orbitOrigin]);for(const key of ['purpose','fields','credentials','region','retention'])assert.ok(disclosure[key]);
  assert.ok(!JSON.stringify(inventory).includes(f.token));assert.match(disclosure.region,/not verified/);
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);assert.ok(!archive.text.includes(f.token));assert.ok(!archive.text.includes(f.input.secret.token));
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data'+'/restore',{archive:archive.text,confirm:'RESTORE'});
  const restoredConnection=(await restored.get('connections')).find(row=>row.id===c.id);assert.deepEqual(restoredConnection.binding,c.binding);assert.equal(restoredConnection.status,'needs_reconnect');
  assert.equal((await restored.get('workflows/'+w.id)).status,'paused');before=f.calls.length;await restored.tick();assert.equal(f.calls.length,before);
  for(const workflow of await h.get('workflows')) {
   await h.post(`workflows/${workflow.id}/pause`);
   for(const run of await runs(h,workflow))if(['queued','running','waiting','awaiting_approval','paused'].includes(run.status))await h.post(`workflow-runs/${run.id}/cancel`);
  }
  const subject='synthetic-crank-401',preview=await h.post('data'+'/subject',{subject});assert.ok(preview.workflow_runs.some(run=>run.id===done.id));
  await h.post('data'+'/erase',{subject,confirm:'ERASE',digest:preview.digest});await h.get('workflow-runs/'+done.id,h.owner,404);
  assert.equal(f.calls.length,before,'erasure does not perform remote actions');
 }finally{await restored?.close();await h.close()}
}

/** Scoped current snapshots use the existing durable watched-field admission and erasure doors. */
export async function orbitPollJourney() {
 const edge=fakeEdge(),f=orbitFixture(edge),effects=[],h=await harness('http://127.0.0.1:9',{edge:edge.edge});let restored;
 edge.routes.set('receiver.synthetic-crank.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  const c=await f.connect(h),trigger={type:'app_poll',provider:'orbit',resource:'deals',connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['stage_id','value_cents']};
  for(const patch of [{resource:'contacts'},{url:'https://foreign.synthetic-crank.example'},{watched_fields:['private_note']}])await h.post('workflows',{name:'Invalid Orbit poll',graph:{trigger:{...trigger,...patch},steps:[]}},h.owner,422);
  const graph={trigger,steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.synthetic-crank.example',body:{id:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',source:'{{trigger.source_kind}}',history:'{{trigger.history_available}}',clock:'{{trigger.change_time_source}}'}}}]};
  const w=await publish(h,'Orbit watched deal snapshot',graph),fresh=await publish(h,'Orbit new deal snapshot',{...graph,trigger:{...trigger,event:'new'}});
  let time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);const poll=async()=>{time+=minute;await h.tick(time)};
  await h.tick(time);assert.equal(effects.length,0);
  f.records.get(orbitIds[0]).title='synthetic-crank-unwatched';await poll();assert.equal(effects.length,0);
  f.records.get(orbitIds[0]).stage_id=orbitNextStage;f.records.get(orbitIds[0]).value_cents=9500;f.mode='page-failed';await poll();assert.equal(effects.length,0);assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
  f.mode='ok';await h.restart();time+=minute;await Promise.all([h.tick(time),h.tick(time)]);
  const changed=await runs(h,w);assert.equal(changed.length,1);assert.equal((await settled(h,changed[0].id)).status,'succeeded');
  assert.deepEqual(effects,[{id:orbitIds[0],previous:{stage_id:orbitStage,value_cents:12000},current:{stage_id:orbitNextStage,value_cents:9500},changed:['stage_id','value_cents'],source:'current_snapshot',history:false,clock:'poll'}]);
  await poll();assert.equal(effects.length,1,'unchanged repeated pages do not duplicate a domain change');
  f.records.set(orbitIds[2],{id:orbitIds[2],title:'synthetic-crank-406',stage_id:orbitStage,value_cents:100,company_id:null});await poll();
  assert.equal((await runs(h,fresh)).length,1);assert.equal((await settled(h,(await runs(h,fresh))[0].id)).status,'succeeded');
  await poll();assert.equal((await runs(h,fresh)).length,1);
  await h.post(`connections/${c.id}/revoke`);f.records.get(orbitIds[0]).value_cents=5000;const before=f.calls.length;await poll();assert.equal(f.calls.length,before);assert.equal((await runs(h,w)).length,2);
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
  const portable=text=>text.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).filter(item=>item.kind==='row'&&item.table.startsWith('crank_app_')).map(item=>JSON.stringify({table:item.table,row:item.row})).sort();
  assert.ok(portable(archive.text).length>2);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data'+'/restore',{archive:archive.text,confirm:'RESTORE'});
  const copy=await restored.send('/api/crank/data/export',{},restored.owner);assert.deepEqual(portable(copy.text),portable(archive.text));await restored.tick(time+minute);assert.equal(f.calls.length,before);
  for(const workflow of [w,fresh])await h.post(`workflows/${workflow.id}/pause`);
  const subject='synthetic-crank-406',preview=await h.post('data'+'/subject',{subject});await h.post('data'+'/erase',{subject,confirm:'ERASE',digest:preview.digest});
  await h.post(`connections/${c.id}/rotate`,{secret:{token:f.token}});await h.post(`workflows/${fresh.id}/publish`,{},h.owner,201);await poll();await poll();
  assert.equal((await runs(h,fresh)).length,0,'an erased record cannot re-enter through retained provider snapshots');
 }finally{await restored?.close();await h.close()}
}
