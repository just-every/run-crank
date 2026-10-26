import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,door,doorPlan,doorImport,startRun} from './kit.mjs';
import {executorProtocolEdge} from './executor-fixture.mjs';
import {originalCodeExport,originalCodeChoice} from './n8n-graph-fixture.mjs';

/** Native public-door orchestration with the executor faked only at its protocol.
 * The existing Linux journey executes these wrappers inside the real sandbox. */
export async function originalCodeJourney() {
 const executor=executorProtocolEdge(),writes=[],target='https://receiver.example';
 const h=await harness(target,{edge:async request=>{if(new URL(request.url).hostname==='executor.example')return executor.edge(request);if(new URL(request.url).origin===target){writes.push(await request.json());return Response.json({received:true})}return undefined}});
 try {
  const account=await connection(h,{app:'http',label:'Synthetic reviewed original-code sandbox',auth_kind:'bearer',domains:['executor.example'],secret:{token:executor.token}}),choice=originalCodeChoice(account.id);
  for(const source of ['return process.env;','return $node.other.json;','return $input["all"]();','return $input.all(1);']){
   const workflow=originalCodeExport();workflow.nodes[1].parameters.jsCode=source;const plan=await doorPlan(h,JSON.stringify({workflow,conversions:{n1:choice}}));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,1);await door(h,'undo',{planId:plan.value.planId});
  }
  const sources=['runOnceForAllItems','runOnceForEachItem'].map((mode,index)=>originalCodeExport(mode,'synthetic-crank-'+(700+index),target));
  const plan=await doorImport(h,JSON.stringify(sources.map(workflow=>({workflow,conversions:{n1:choice}}))));assert.equal(executor.submitted.length,0,'review and inactive apply must not compile or run source in an executor');
  const workflows=await h.get('workflows');await h.restart();
  for(const [index,source]of sources.entries()){
   const workflow=workflows.find(row=>row.name===source.name),draft=await h.get('workflows/'+workflow.id);assert.equal(draft.status,'draft');assert.equal(draft.versions.length,0);assert.equal(draft.hooks.length,0);assert.deepEqual(draft.draft.settings.n8n_conversions.n1,choice);
   await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const run=await startRun(h,workflow,{address:' synthetic-crank-'+(710+index)+' '});assert.equal(run.status,'waiting',JSON.stringify(run.error));
   const submitted=executor.submitted.at(-1);assert.deepEqual(submitted.job.input,{items:[{json:{address:' synthetic-crank-'+(710+index)+' '}}]});assert.ok(submitted.job.source.includes(JSON.stringify(source.nodes[1].parameters.jsCode+'\n')),'the original reviewed source must be retained as data in the sandbox wrapper');assert.deepEqual(submitted.job.allowed_egress,[]);assert.equal(writes.length,index);
   executor.complete(submitted.task_id,{items:[{json:{normalized:'synthetic-crank-'+(710+index)}}]});await h.restart();await h.tick(Date.now()+61000);
   const done=await h.get('workflow-runs/'+run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(writes.at(-1),{normalized:'synthetic-crank-'+(710+index)});assert.equal(executor.submitted.length,index+1,'restart must read the retained task without submitting the original code again');
  }
  const workflow=workflows[0],bad=await startRun(h,workflow,{address:'synthetic-crank-720'}),submitted=executor.submitted.at(-1),before=writes.length;executor.complete(submitted.task_id,{items:[{json:{normalized:42}}]});await h.tick(Date.now()+61000);assert.equal((await h.get('workflow-runs/'+bad.id)).status,'failed');assert.equal(writes.length,before,'declared output schema must stop downstream writes');
  await h.post('connections/'+account.id+'/revoke');const count=executor.submitted.length,revoked=await startRun(h,workflow,{address:'synthetic-crank-721'});assert.equal(revoked.status,'paused');assert.equal(executor.submitted.length,count);
  const undo=await door(h,'undo',{planId:plan.planId});assert.ok(undo.status>=400||undo.value.job?.state!=='undone');
 } finally {await h.close()}
}
