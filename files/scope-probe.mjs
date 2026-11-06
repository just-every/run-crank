import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {harness}=await import(pathToFileURL(resolve('tests/harness.mjs')));
const phase=process.argv[2];
assert.ok(['before','after'].includes(phase));
const h=await harness('http://127.0.0.1:9');
const rows=[];
try {
 const flow=await h.flow('synthetic-crank-removed-scope');
 const input={private_note:'synthetic-crank-private-run-input'};
 const run=await h.run(flow,'synthetic-crank-removed-scope',input);
 assert.equal(run.state,'pending');
 const token=await h.post('tokens',{label:'synthetic-crank-scope-probe',scope:'agent'},h.owner,201);
 const restricted=await h.post('tokens',{label:'synthetic-crank-original-read-ceiling',scope:'agent',tool_scopes:['workflows:read']},h.owner,201);
 const control=await h.post('tokens',{label:'synthetic-crank-authorized-read-control',scope:'agent',tool_scopes:['workflows:read','runs:read']},h.owner,201);
 const read=(path,credential)=>h.send('/api/crank/'+path,undefined,'',{authorization:'Bearer '+credential});
 const authorized=async stage=>{
  const direct=await read('runs/'+run.id,control.token),state=await read('state',control.token),owner=await h.send('/api/crank/state',undefined,h.owner);
  assert.equal(direct.status,200);assert.deepEqual(direct.value.input,input);
  for(const response of [state,owner]){assert.equal(response.status,200);assert.deepEqual(response.value.runs.find(row=>row.id===run.id)?.input,input)}
  rows.push({phase,stage,kind:'authorized-control',direct_status:direct.status,aggregate_status:state.status,owner_status:owner.status,payload_visible:true});
 };
 await authorized('before-removal');
 const removed=await h.post('agent-access/'+encodeURIComponent(token.agent_access.agent_id),{scopes:token.agent_access.scopes.filter(scope=>scope!=='runs:read'),revision:token.agent_access.revision});
 assert.ok(removed.scopes.includes('workflows:read'));assert.ok(!removed.scopes.includes('runs:read'));
 for(const stage of ['after-removal','after-worker-restart']){
  if(stage==='after-worker-restart')await h.restart();
  const direct=await read('runs/'+run.id,token.token),state=await read('state',token.token),original=await read('state',restricted.token),workflow=await read('flows/'+flow.id,token.token);
  assert.equal(direct.status,403);assert.equal(workflow.status,200);assert.equal(workflow.value.id,flow.id);
  const exposed=state.status===200&&state.value.runs.some(row=>row.id===run.id&&row.input?.private_note===input.private_note);
  const issuedExposed=original.status===200&&original.value.runs.some(row=>row.id===run.id&&row.input?.private_note===input.private_note);
  rows.push({phase,stage,kind:'removed-scope',direct_status:direct.status,aggregate_status:state.status,workflow_status:workflow.status,removed_payload_visible:exposed,original_ceiling_status:original.status,original_ceiling_payload_visible:issuedExposed,policy:exposed||issuedExposed?'FAIL':'PASS'});
  if(phase==='before'){assert.equal(exposed,true);assert.equal(issuedExposed,true)}
  else {assert.equal(state.status,403);assert.equal(exposed,false);assert.equal(original.status,403);assert.equal(issuedExposed,false)}
  await authorized(stage);
 }
 console.log(JSON.stringify({phase,observed_before_failure:phase==='before',policy:phase==='before'?'FAIL':'PASS',rows},null,2));
} finally {await h.close()}
