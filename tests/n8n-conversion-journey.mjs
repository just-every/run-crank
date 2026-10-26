import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,door,doorPlan,startRun,stepOf} from './kit.mjs';
import {executorProtocolEdge} from './executor-fixture.mjs';
import {conversionExport,isolatedCodeChoice,loopExport} from './n8n-graph-fixture.mjs';

const definition=upper=>({inputs:{address:'string'},outputs:{normalized:'string'},steps:[{id:'trim',fn:'text.trim',input:{value:'{{trigger.input.address}}'}},...(upper?[{id:'upper',fn:'text.case',input:{value:'{{steps.trim}}',to:'upper'}}]:[])],result:{normalized:upper?'{{steps.upper}}':'{{steps.trim}}'}});
const envelope=(workflow,choice)=>({workflow,conversions:choice?{n1:choice}:{}});
async function reviewed(h,value,previousFingerprint) {
 const p=await doorPlan(h,JSON.stringify(value));assert.equal(p.status,200,p.text);assert.equal(p.value.rejected.length,0,JSON.stringify(p.value));
 const body={planId:p.value.planId,reviewedFingerprint:p.value.fingerprint};
 if(previousFingerprint)assert.ok((await door(h,'apply',{...body,reviewedFingerprint:previousFingerprint})).status>=400,'a changed choice cannot reuse an earlier review');
 for(let i=0;i<2;i++){const result=await door(h,'apply',body);assert.equal(result.value.job?.state,'completed',result.text)}
 return p.value;
}
async function cancelled(h,value) {
 const p=await doorPlan(h,JSON.stringify(value));assert.equal(p.status,200,p.text);assert.equal(p.value.rejected.length,1,JSON.stringify(p.value));
 assert.ok(p.value.diagnostics.some(d=>d.message?.includes('Manual conversion')));
 await door(h,'undo',{planId:p.value.planId});return p.value;
}

/** Engineering proof through the public import and execution doors. The remote
 * executor alone is faked; the Linux journey proves real source execution. */
export async function conversionJourney() {
 const remote=executorProtocolEdge(),h=await harness('https://receiver.example',{edge:remote.edge});
 try {
  const component=await h.post('subflows',{name:'Synthetic reviewed normalizer',definition:definition(false)},h.owner,201);
  const registry=conversionExport('registry'),code=conversionExport('code','synthetic-crank-43');
  const embedded=conversionExport('registry','synthetic-crank-54');embedded.nodes[1].parameters=structuredClone(loopExport('https://receiver.example').nodes[4].parameters);
  const inline=await doorPlan(h,JSON.stringify(embedded));assert.equal(inline.status,200,inline.text);assert.equal(inline.value.rejected.length,0,'a two-node embedded snapshot uses the graph importer');await door(h,'undo',{planId:inline.value.planId});
  embedded.nodes[1].parameters.options.waitForSubWorkflow='unsupported';await cancelled(h,embedded);
  const unresolved=await cancelled(h,envelope(registry));await cancelled(h,envelope(code));
  await cancelled(h,envelope(code,{kind:'manual',reason:'synthetic-crank-55 owner review pending'}));
  const choice={kind:'registry-subflow',reviewed:true,subflow_id:component.subflow_id,subflow_version:component.version,definition_digest:component.definition_digest,input:{address:'={{ $json.address }}'}};
  for(const mutate of [v=>v.workflow.nodes[1].parameters.options.waitForSubWorkflow=false,v=>v.workflow.nodes[1].parameters.mode='each',v=>v.conversions.n1.reviewed=false,v=>v.conversions.n1.input.address='={{ globalThis.crankInjected = 1 }}',v=>v.workflow.nodes[1].credentials={httpHeaderAuth:{id:'synthetic-crank-44',name:'Reference only'}}]){const v=envelope(structuredClone(registry),structuredClone(choice));mutate(v);await cancelled(h,v)}
  const bundle=envelope(registry,choice),p=await reviewed(h,bundle);assert.notEqual(p.fingerprint,unresolved.fingerprint);assert.notEqual(p.bundleSha256,unresolved.bundleSha256);
  let [w]=await h.get('workflows');const draft=(await h.get('workflows/'+w.id)).draft;
  assert.deepEqual(draft.settings.n8n_conversions,{n1:choice});assert.equal(draft.settings.n8n_conversion_dispositions[0].resolved,true);
  await h.restart();assert.deepEqual((await h.get('workflows/'+w.id)).draft,draft);
  assert.equal((await door(h,'reconcile',{planId:p.planId})).value.ok,true);
  const wrong=structuredClone(bundle);wrong.conversions.n1.definition_digest='0'.repeat(64);
  // A distinct choice cannot be approved with the earlier review fingerprint.
  assert.equal((await door(h,'undo',{planId:p.planId})).value.job.state,'undone');
  const stale=await reviewed(h,wrong,p.fingerprint);[w]=await h.get('workflows');await h.post('workflows/'+w.id+'/publish',{},h.owner,409);
  assert.equal((await door(h,'undo',{planId:stale.planId})).value.job.state,'undone');
  const applied=await reviewed(h,bundle);[w]=await h.get('workflows');
  await h.post('workflows/'+w.id+'/publish',{},h.owner,201);
  const first=await startRun(h,w,{address:'  synthetic-crank-45  '});assert.equal(first.status,'succeeded');assert.deepEqual(stepOf(first,'n1').output,{normalized:'synthetic-crank-45'});
  await h.post(`subflows/${component.subflow_id}/versions`,{definition:definition(true)},h.owner,201);
  assert.deepEqual(stepOf(await startRun(h,w,{address:' synthetic-crank-46 '}),'n1').output,{normalized:'synthetic-crank-46'},'a new registry release never upgrades the imported pin');
  await h.post(`subflows/${component.subflow_id}/versions/1/revoke`);
  assert.equal((await startRun(h,w,{address:'synthetic-crank-47'})).status,'paused');
  const refused=await door(h,'undo',{planId:applied.planId});assert.ok(refused.status>=400||refused.value.job?.state!=='undone');
 }finally{await h.close()}
 const executing=await harness('https://receiver.example',{edge:remote.edge});
 try{
  const account=await connection(executing,{app:'http',label:'Synthetic fresh native executor',auth_kind:'bearer',domains:['executor.example'],secret:{token:remote.token}});
  const source=conversionExport('code','synthetic-crank-48'),choice=isolatedCodeChoice(account.id);
  for(const mutate of [v=>delete v.conversions.n1.output_schema,v=>v.conversions.n1.allowed_egress=['https://unapproved.example'],v=>delete v.conversions.n1.connection_id,v=>delete v.conversions.n1.timeout_ms,v=>v.workflow.nodes[1].parameters.mode='asynchronous']){const v=envelope(structuredClone(source),structuredClone(choice));mutate(v);await cancelled(executing,v)}
  const bundle=envelope(source,choice),p=await reviewed(executing,bundle);let [w]=await executing.get('workflows');
  const draft=(await executing.get('workflows/'+w.id)).draft;assert.equal(draft.steps[0].source,choice.source);assert.notEqual(draft.steps[0].source,source.nodes[1].parameters.jsCode);assert.equal(remote.submitted.length,0);
  await executing.restart();assert.deepEqual((await executing.get('workflows/'+w.id)).draft,draft);
  assert.equal((await door(executing,'undo',{planId:p.planId})).value.job.state,'undone');
  const again=await reviewed(executing,bundle);[w]=await executing.get('workflows');await executing.post('workflows/'+w.id+'/publish',{},executing.owner,201);
  const run=await startRun(executing,w,{address:' synthetic-crank-49 '});assert.equal(run.status,'waiting',JSON.stringify(run));
  const [{task_id,job}]=remote.submitted;assert.equal(job.language,'javascript');assert.equal(job.source,choice.source);assert.deepEqual(job.input,{address:' synthetic-crank-49 '});assert.deepEqual(job.allowed_egress,[]);assert.equal(job.timeout_ms,choice.timeout_ms);assert.equal(job.memory_mb,choice.memory_mb);
  remote.complete(task_id,{normalized:'synthetic-crank-49'});await executing.restart();await executing.tick(Date.now()+61000);
  const done=await executing.get('workflow-runs/'+run.id);assert.equal(done.status,'succeeded',JSON.stringify(done));assert.deepEqual(stepOf(done,'n1').output.output,{normalized:'synthetic-crank-49'});assert.equal(remote.submitted.length,1);
  const mismatch=await startRun(executing,w,{address:'synthetic-crank-50'});remote.complete(mismatch.executor_tasks[0].id,{normalized:42});await executing.tick(Date.now()+120000);assert.equal((await executing.get('workflow-runs/'+mismatch.id)).status,'failed','native output schema remains enforced after conversion');
  await executing.post('connections/'+account.id+'/revoke');const before=remote.submitted.length;assert.equal((await startRun(executing,w,{address:'synthetic-crank-51'})).status,'paused');assert.equal(remote.submitted.length,before);
  const undo=await door(executing,'undo',{planId:again.planId});assert.ok(undo.status>=400||undo.value.job?.state!=='undone');
 }finally{await executing.close()}
}
