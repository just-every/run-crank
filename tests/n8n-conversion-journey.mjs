import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {archive,inventory} from './restore-journey.mjs';
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
 await embeddedWaitJourney();
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

/** Literal synchronous child; Wait must keep the incoming JSON as its output item. */
export function embeddedWaitExport(target,id='synthetic-crank-embedded-wait',wait={resume:'timeInterval',amount:1,unit:'hours'}) {
 const node=(id,type,typeVersion,parameters,name=id)=>({id,name,type:'n8n-nodes-base.'+type,typeVersion,parameters,position:[Number(id.slice(1))*220,0]});
 const edge=node=>({node,type:'main',index:0});
 const http=(id,path)=>node(id,'httpRequest',4.2,{method:'POST',url:target+path,sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}});
 const child={id:'synthetic-crank-wait-child',name:'Pinned interval child',nodes:[node('n0','executeWorkflowTrigger',1,{}),node('n1','wait',1.1,wait,'Child interval wait'),http('n2','/embedded-wait-after')],connections:{n0:{main:[[edge('Child interval wait')]]},'Child interval wait':{main:[[edge('n2')]]}}};
 return {id,name:'Synthetic embedded interval wait '+id,nodes:[node('n0','manualTrigger',1,{}),http('n1','/embedded-wait-before'),node('n2','executeWorkflow',1.2,{source:'parameter',workflowJson:JSON.stringify(child),mode:'once',options:{waitForSubWorkflow:true}}),http('n3','/embedded-wait-final')],connections:{n0:{main:[[edge('n1')]]},n1:{main:[[edge('n2')]]},n2:{main:[[edge('n3')]]}}};
}

async function embeddedWaitJourney() {
 const target='https://receiver.example',writes=[],h=await harness(target,{edge:async request=>{if(new URL(request.url).origin!==target)return undefined;const body=await request.json();writes.push({path:new URL(request.url).pathname,body});return Response.json(body)}});
 let restored;
 try {
  const source=embeddedWaitExport(target),snapshot=JSON.parse(source.nodes[2].parameters.workflowJson);
  const changeChild=(source,change)=>{const child=JSON.parse(source.nodes[2].parameters.workflowJson);change(child);source.nodes[2].parameters.workflowJson=JSON.stringify(child)};
  for(const change of [
   s=>changeChild(s,c=>c.nodes[1].typeVersion=1),s=>changeChild(s,c=>c.nodes[1].typeVersion=2),
   ...[{resume:'specificTime'}, {resume:'webhook'}, {resume:'form'}, {amount:'={{ $json.amount }}'}, {amount:'1'}, {amount:0.5}, {amount:-1}, {unit:'weeks'}, {unit:'={{ $json.unit }}'}, {options:{}}, {unknown:true}].map(settings=>s=>changeChild(s,c=>Object.assign(c.nodes[1].parameters,settings))),
   s=>s.nodes[2].parameters.mode='each',s=>s.nodes[2].parameters.options.waitForSubWorkflow=false,
   s=>changeChild(s,c=>c.connections['Child interval wait'].main[0].push({node:'n2',type:'main',index:0})),
   s=>changeChild(s,c=>c.nodes.push({...c.nodes[0],id:'n4',name:'n4'})),
  ]) {
   const invalid=structuredClone(source);change(invalid);const response=await doorPlan(h,JSON.stringify(invalid)),plan=response.value;assert.equal(response.status,200,response.text);assert.equal(plan.rejected.length,1);assert.ok(plan.diagnostics.some(row=>row.message?.includes('Manual conversion')));
   const applied=await door(h,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint});assert.ok(applied.status<500,applied.text);
   assert.deepEqual(await h.get('workflows'),[],'unsupported embedded settings cannot create a native draft');assert.deepEqual(writes,[],'manual conversions cannot dispatch');await door(h,'undo',{planId:plan.planId});
  }
  const preview=await doorPlan(h,JSON.stringify(source));assert.equal(preview.status,200,preview.text);assert.equal(preview.value.rejected.length,0,JSON.stringify(preview.value));await door(h,'undo',{planId:preview.value.planId});
  const changed=structuredClone(source);changeChild(changed,c=>c.nodes[1].parameters.amount=2);
  const changedPlan=await doorPlan(h,JSON.stringify(changed));assert.equal(changedPlan.status,200,changedPlan.text);assert.equal(changedPlan.value.rejected.length,0);assert.notEqual(changedPlan.value.fingerprint,preview.value.fingerprint,'child wait settings participate in the review fingerprint');
  assert.equal((await door(h,'apply',{planId:changedPlan.value.planId,reviewedFingerprint:preview.value.fingerprint})).status,403);
  await door(h,'undo',{planId:changedPlan.value.planId});
  assert.deepEqual(await h.get('workflows'),[],'preview never creates workflows');assert.deepEqual(writes,[],'preview never executes the child');
  const account=await connection(h,{app:'http',label:'Synthetic child continuation account',auth_kind:'bearer',domains:['receiver.example'],secret:{token:'synthetic-crank-901'}});
  const bound={workflow:source,conversions:{n3:{kind:'http-connection',reviewed:true,connection_id:account.id}}};
  changed.id='synthetic-crank-wait-changed';changed.name='Synthetic changed interval child';
  const variants=[bound,...['seconds','minutes','days'].map((unit,index)=>embeddedWaitExport(target,'synthetic-crank-wait-'+index,{amount:1,unit})),embeddedWaitExport(target,'synthetic-crank-wait-zero',{amount:0,unit:'seconds'}),changed];
  const plan=await reviewed(h,variants),workflows=await h.get('workflows');assert.equal(workflows.length,variants.length,'repeated apply produces one draft per source');
  const workflow=workflows.find(row=>row.name===source.name),draft=(await h.get('workflows/'+workflow.id)).draft;
  const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  assert.equal(draft.settings.n8n_subflow_pins[0].digest,createHash('sha256').update(canonical(snapshot)).digest('hex'));
  const changedWorkflow=workflows.find(row=>row.name===changed.name);assert.ok(changedWorkflow);assert.notEqual((await h.get('workflows/'+changedWorkflow.id)).draft.settings.n8n_subflow_pins[0].digest,draft.settings.n8n_subflow_pins[0].digest,'changing only child Wait settings changes the immutable child digest');
  assert.equal(draft.steps.find(step=>step.id==='n2_n1').type,'delay');assert.deepEqual(draft.steps.find(step=>step.id==='n2_n1').input,{amount:1,unit:'hours'});
  for(const row of workflows){const detail=await h.get('workflows/'+row.id);assert.equal(detail.status,'draft');assert.deepEqual(detail.versions,[]);assert.deepEqual(detail.hooks,[])}
  assert.deepEqual(writes,[],'reviewed apply remains inactive');
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft);assert.equal((await door(h,'reconcile',{planId:plan.planId})).value.ok,true);
  for(const [index,seconds]of [[0,1],[1,60],[2,86400],['zero',0]]){const row=workflows.find(row=>row.name.endsWith('synthetic-crank-wait-'+index));await h.post('workflows/'+row.id+'/publish',{},h.owner,201);const input={message:'synthetic-crank-unit-'+index},started=Date.now(),run=await startRun(h,row,input),returned=Date.now();assert.equal(run.status,'waiting');assert.ok(Date.parse(run.waits[0].due_at)>=started+seconds*1000&&Date.parse(run.waits[0].due_at)<=returned+seconds*1000,'literal units set the expected relative deadline');await h.tick(Date.parse(run.waits[0].due_at)+1);assert.equal((await h.get('workflow-runs/'+run.id)).status,'succeeded');assert.deepEqual(writes.slice(-3),['before','after','final'].map(phase=>({path:'/embedded-wait-'+phase,body:input})))}
  writes.length=0;await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);
  const payload={message:'synthetic-crank-902',amount:7,nested:{items:[null,false,'',7,{value:'synthetic-crank-903'}]}};
  const started=Date.now(),waiting=await startRun(h,workflow,payload),returned=Date.now();assert.equal(waiting.status,'waiting');assert.equal(waiting.waits.length,1);assert.equal(waiting.waits[0].path,'n2_n1');
  assert.deepEqual(writes,[{path:'/embedded-wait-before',body:payload}]);
  const checkpoint=stepOf(waiting,'n1'),due=Date.parse(waiting.waits[0].due_at);assert.ok(due>=started+3600000&&due<=returned+3600000,'one hour stays a relative duration across clock boundaries');
  await h.restart();assert.equal((await h.get('workflow-runs/'+waiting.id)).status,'waiting');
  await h.tick(due-1);assert.equal((await h.get('workflow-runs/'+waiting.id)).status,'waiting');assert.equal(writes.length,1,'early Cron cannot release the child');
  await h.tick(due+1);await h.tick(due+60001);
  const complete=await h.get('workflow-runs/'+waiting.id);assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));assert.deepEqual(stepOf(complete,'n1'),checkpoint,'the earlier receiver checkpoint is never rewritten');
  assert.deepEqual(writes,[{path:'/embedded-wait-before',body:payload},{path:'/embedded-wait-after',body:payload},{path:'/embedded-wait-final',body:payload}]);
  assert.deepEqual(stepOf(complete,'n2_n2').input.body,payload);assert.deepEqual(stepOf(complete,'n3').output.body,payload,'the child delay must not replace the JSON payload with timing metadata');
  const cancelledRun=await startRun(h,workflow,payload);await h.post('workflow-runs/'+cancelledRun.id+'/cancel');const beforeCancel=writes.length;await h.restart();await h.tick(Date.parse(cancelledRun.waits[0].due_at)+1);assert.equal((await h.get('workflow-runs/'+cancelledRun.id)).status,'cancelled');assert.equal(writes.length,beforeCancel,'cancellation refuses child continuation');
  const portable=await startRun(h,workflow,payload),saved=await archive(h),original=inventory(saved),beforeRestore=writes.length;
  restored=await harness(target,{edge:async request=>{if(new URL(request.url).origin!==target)return undefined;writes.push({path:new URL(request.url).pathname,body:await request.json()});return Response.json({})}});
  await restored.post('data'+'/restore',{archive:saved,confirm:'RESTORE'});const received=inventory(await archive(restored));assert.deepEqual(original.filter(row=>!received.includes(row)),[],'all portable records, child pins, mappings and checkpoints survive');assert.deepEqual(received.filter(row=>!original.includes(row)).map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
  const inactive=await restored.get('workflows/'+workflow.id);assert.equal(inactive.status,'paused');assert.deepEqual(inactive.draft,draft);assert.ok(inactive.hooks.every(hook=>hook.status!=='active'));
  await restored.restart();await restored.tick(Date.parse(portable.waits[0].due_at)+1);assert.equal((await restored.get('workflow-runs/'+portable.id)).status,'paused');await restored.post('workflow-runs/'+portable.id+'/resume',{},restored.owner,409);assert.equal(writes.length,beforeRestore,'inactive restore cannot replay the earlier write or resume the child');
  await h.post('connections/'+account.id+'/revoke');await h.restart();await h.tick(Date.parse(portable.waits[0].due_at)+1);assert.equal((await h.get('workflow-runs/'+portable.id)).status,'paused');assert.equal(writes.length,beforeRestore,'revoked native credentials refuse the next child step');
  assert.equal((await h.post('workflow-runs/'+portable.id+'/resume')).status,'paused');assert.equal(writes.length,beforeRestore,'manual resume cannot revive revoked authority');
  const undo=await door(h,'undo',{planId:plan.planId});assert.ok(undo.status>=400||undo.value.job?.state!=='undone','used child wait imports remain protected');
 }finally{await restored?.close();await h.close()}
}
