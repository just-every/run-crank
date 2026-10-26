import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {harness} from './harness.mjs';
import {door,doorPlan,doorImport,deliver,settled} from './kit.mjs';
import {doneLoopExport} from './n8n-graph-fixture.mjs';

export async function doneLoopJourney(declared) {
  // Official SplitInBatches V3 accumulates the returned body items, and empty
  // back-edge output stops the loop without invoking the done path.
  const completed=[],attempts=[];let completionMode='object',rejectCompletion=false;
  const completionReceiver=createServer(async(req,res)=>{
   let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text),path=req.url;attempts.push({path,input});
   if(completionMode==='failure'&&path==='/body'||rejectCompletion&&path==='/done-first'&&input.processed==='synthetic-crank-42'){res.writeHead(400);res.end();return}
   completed.push({path,input});res.writeHead(200,{'content-type':'application'+'/'+'json'});
   if(path==='/body')res.end(JSON.stringify(completionMode==='empty'||completionMode==='empty-later'&&input.message==='synthetic-crank-41'?[]:completionMode==='array'?[{processed:input.message,part:1},{processed:input.message,part:2}]:{processed:input.message,part:0}));
   else res.end(JSON.stringify({processed:input.processed,part:input.part}));
  });
  await new Promise(resolve=>completionReceiver.listen(0,'127.0.0.1',resolve));const completionTarget='http://127.0.0.1:'+completionReceiver.address().port;
  const completion=await harness(declared,{edge:async request=>{if(new URL(request.url).origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(completionTarget+new URL(request.url).pathname,{method:request.method,headers,body:await request.arrayBuffer()})}}).catch(async error=>{completionReceiver.closeAllConnections();await new Promise(resolve=>completionReceiver.close(resolve));throw error});
  try{
   const source=doneLoopExport(declared),plan=await doorPlan(completion,JSON.stringify(source));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0);
   assert.ok(plan.value.diagnostics.some(d=>String(d.message).includes('distinct linear done path')));
   assert.equal((await completion.get('workflows')).length,0);assert.equal(attempts.length,0);
   const reviewed={planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint};for(let i=0;i<2;i++)assert.equal((await door(completion,'apply',reviewed)).value.job.state,'completed');
   const [draft]=await completion.get('workflows');assert.equal(draft.status,'draft');
   await completion.restart();assert.equal((await door(completion,'reconcile',{planId:plan.value.planId})).value.ok,true);
   assert.equal((await door(completion,'undo',{planId:plan.value.planId})).value.job.state,'undone');
   await doorImport(completion,JSON.stringify(source));const [imported]=await completion.get('workflows');
   await completion.post('workflows/'+imported.id+'/publish',{},completion.owner,201);const hook=await completion.post('workflows/'+imported.id+'/hooks',{},completion.owner,201);
   const send=async messages=>{await deliver(completion,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages})});return settled(completion,(await completion.get('workflow-runs?workflow='+imported.id)).runs[0].id)};
   for(const scenario of [{mode:'object',messages:['synthetic-crank-40','synthetic-crank-41']},{mode:'array',messages:['synthetic-crank-40','synthetic-crank-40']},{mode:'object',messages:[]}]){
    completed.length=0;completionMode=scenario.mode;const run=await send(scenario.messages);assert.equal(run.status,'succeeded',JSON.stringify(run.error));
    const processed=scenario.messages.flatMap(message=>scenario.mode==='array'?[{processed:message,part:1},{processed:message,part:2}]:[{processed:message,part:0}]);
    assert.deepEqual(completed.map(row=>row.path),[...scenario.messages.map(()=>'/body'),...processed.map(()=>'/done-first'),...processed.map(()=>'/done-last')]);
    assert.deepEqual(completed.filter(row=>row.path==='/done-first').map(row=>row.input),processed.map(row=>({...row,phase:'synthetic-crank-32'})));
    assert.deepEqual(completed.filter(row=>row.path==='/done-last').map(row=>row.input),processed.map(row=>({...row,phase:'synthetic-crank-33'})));
   }
   completed.length=0;attempts.length=0;completionMode='empty';const empty=await send(['synthetic-crank-40','synthetic-crank-41']);assert.equal(empty.status,'succeeded');
   assert.deepEqual(attempts.map(row=>row.path),['/body'],'an empty returned item stream creates no next batch and no completion effect');
   assert.equal(empty.steps.find(step=>step.step_id==='n2').output.empty_result_at,0);
   completed.length=0;attempts.length=0;completionMode='empty-later';const laterEmpty=await send(['synthetic-crank-40','synthetic-crank-41','synthetic-crank-42']);assert.equal(laterEmpty.status,'succeeded');
   assert.deepEqual(attempts.map(row=>row.path),['/body','/body'],'retained earlier body successes cannot produce a done output after the back edge disappears');
   assert.equal(laterEmpty.steps.find(step=>step.step_id==='n2').output.empty_result_at,1);
   completed.length=0;completionMode='failure';const failed=await send(['synthetic-crank-40','synthetic-crank-41']);assert.equal(failed.status,'failed');assert.equal(completed.length,0,'a body failure cannot invoke the done continuation');
   completed.length=0;completionMode='object';rejectCompletion=true;let interrupted=await send(['synthetic-crank-41','synthetic-crank-42']);assert.equal(interrupted.status,'failed');
   assert.deepEqual(completed.map(row=>row.path),['/body','/body','/done-first']);
   const checkpoints=interrupted.steps.filter(step=>step.status==='succeeded'&&step.type==='http').map(step=>({path:step.path,operation_key:step.operation_key,output:step.output}));
   await completion.restart();rejectCompletion=false;const preview=await completion.get('workflow-runs/'+interrupted.id+'/replay');
   const pending=preview.eligible.find(step=>step.step_id==='n7');assert.ok(pending);
   interrupted=await completion.post('workflow-runs/'+interrupted.id+'/replay',{digest:preview.digest,paths:[pending.path]});assert.equal(interrupted.status,'succeeded',JSON.stringify(interrupted.error));
   assert.deepEqual(completed.map(row=>row.path),['/body','/body','/done-first','/done-first','/done-last','/done-last']);
   for(const checkpoint of checkpoints){const retained=interrupted.steps.find(step=>step.path===checkpoint.path);assert.equal(retained.operation_key,checkpoint.operation_key);assert.deepEqual(retained.output,checkpoint.output)}
   for(const [index,mutate] of [
    value=>value.connections.n3.main[0]=[{node:'n5',type:'main',index:0}],
    value=>value.connections.n9={main:[[{node:'n6',type:'main',index:0}]]},
    value=>value.connections.n6.main[0].push({node:'n8',type:'main',index:0}),
    value=>value.connections.n5.main[0]=[{node:'n5',type:'main',index:0}],
   ].entries()){
    const invalid=doneLoopExport(declared,'synthetic-crank-'+(50+index));mutate(invalid);const rejected=await doorPlan(completion,JSON.stringify(invalid));assert.equal(rejected.status,200,rejected.text);assert.equal(rejected.value.rejected.length,1);await door(completion,'undo',{planId:rejected.value.planId});
   }
  }finally{await completion.close();completionReceiver.closeAllConnections();await new Promise(resolve=>completionReceiver.close(resolve))}
}
