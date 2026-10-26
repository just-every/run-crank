import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {harness} from './harness.mjs';
import {door,doorPlan,deliver,settled} from './kit.mjs';
import {streamLoopEnvelope} from './n8n-graph-fixture.mjs';

/** Synthetic source exports use an actual owned receiver. Only routing from the
 * declared public destination to that receiver is bridged at the network edge. */
export async function batchLoopJourney() {
 const declared='https://receiver.example',attempts=[],effects=[];let h,mode='normal',event=200;
 const receiver=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const input=JSON.parse(text),path=req.url;attempts.push({path,input});
  if(mode==='failure'&&path==='/body-next'&&input.processed==='synthetic-crank-201'&&input.part===2){res.writeHead(400);res.end();return}
  effects.push({path,input});res.writeHead(200,{'content-type':'application'+'/'+'json'});
  if(path==='/body')res.end(JSON.stringify([1,2].map(part=>({processed:input.message,part:mode==='bad-type'&&input.message==='synthetic-crank-201'?'synthetic-crank-209':part}))));
  else if(mode==='empty'&&path==='/body-next')res.end('[]');
  else res.end(JSON.stringify({processed:input.processed,part:input.part}));
 });
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const target='http://127.0.0.1:'+receiver.address().port;
 try {
  h=await harness(declared,{edge:async request=>{
   const url=new URL(request.url);if(url.origin!==declared)return undefined;
   const headers=new Headers(request.headers);headers.delete('content-length');
   return fetch(target+url.pathname,{method:request.method,headers,body:await request.arrayBuffer()});
  }});
  const envelope=streamLoopEnvelope(declared,'synthetic-crank-200',{max_source_items:6,max_stage_items:12});envelope.workflow.nodes[3].parameters.batchSize=2;
  const unresolved=await doorPlan(h,JSON.stringify(envelope.workflow));assert.equal(unresolved.status,200);assert.equal(unresolved.value.rejected.length,1,'multi-item batches need retained reviewed stream bounds');await door(h,'undo',{planId:unresolved.value.planId});
  const plan=await doorPlan(h,JSON.stringify(envelope));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));
  const approval={planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint};
  for(let count=0;count<2;count++)assert.equal((await door(h,'apply',approval)).value.job.state,'completed');
  const [workflow]=await h.get('workflows'),draft=await h.get('workflows/'+workflow.id);assert.equal(draft.status,'draft');assert.equal(draft.versions.length,0);assert.equal(draft.hooks.length,0);assert.equal(effects.length,0);
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft.draft);assert.equal((await door(h,'reconcile',{planId:plan.value.planId})).value.ok,true);
  await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
  const send=async messages=>{const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages,event_id:'synthetic-crank-'+event++})});assert.equal(sent.status,200,sent.text);return settled(h,sent.value.run_id)};
  const records=messages=>messages.flatMap(processed=>[1,2].map(part=>({processed,part})));
  const expectedPaths=messages=>{
   const result=[];for(let offset=0;offset<messages.length;offset+=2){const count=messages.slice(offset,offset+2).length;result.push(...Array(count).fill('/body'),...Array(count*2).fill('/body-next'))}
   return [...result,...Array(messages.length*2).fill('/done-first'),...Array(messages.length*2).fill('/done-last')];
  };
  const reset=value=>{mode=value;attempts.length=0;effects.length=0};
  const verify=(run,messages)=>{
   assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(effects.map(row=>row.path),expectedPaths(messages),'batches must retain source node barriers and finish each batch before starting the next');
   assert.deepEqual(effects.filter(row=>row.path==='/body').map(row=>row.input),messages.map(message=>({message})));
   assert.deepEqual(effects.filter(row=>row.path==='/body-next').map(row=>row.input),records(messages).map(row=>({...row,phase:'synthetic-crank-91'})));
   for(const [path,phase]of [['/done-first','synthetic-crank-32'],['/done-last','synthetic-crank-33']])assert.deepEqual(effects.filter(row=>row.path===path).map(row=>row.input),records(messages).map(row=>({...row,phase})),'done output must retain every returned item in source order');
   const writes=run.steps.filter(row=>row.type==='http'&&row.status==='succeeded');assert.equal(new Set(writes.map(row=>row.operation_key)).size,writes.length,'equal source values retain distinct operation identities');
  };
  for(const messages of [['synthetic-crank-200','synthetic-crank-201','synthetic-crank-200','synthetic-crank-202','synthetic-crank-203'],[],['synthetic-crank-200']]){reset('normal');verify(await send(messages),messages)}
  reset('normal');const oversized=await send(Array(7).fill('synthetic-crank-200'));assert.equal(oversized.status,'failed');assert.equal(oversized.error.category,'validation');assert.equal(attempts.length,0,'source bound must be checked before any receiver write');
  reset('bad-type');const invalid=await send(['synthetic-crank-200','synthetic-crank-201','synthetic-crank-202']);assert.equal(invalid.status,'failed');assert.deepEqual(attempts.map(row=>row.path),['/body','/body'],'every item in the batch must finish Set validation before any following HTTP node starts');
  reset('empty');const empty=await send(['synthetic-crank-200','synthetic-crank-201','synthetic-crank-202']);assert.equal(empty.status,'succeeded');assert.deepEqual(attempts.map(row=>row.path),['/body','/body',...Array(4).fill('/body-next')],'empty return stream stops the remaining batch and completion work');
  reset('failure');const messages=['synthetic-crank-200','synthetic-crank-201','synthetic-crank-202'];let run=await send(messages);assert.equal(run.status,'failed');assert.deepEqual(attempts.map(row=>row.path),['/body','/body',...Array(4).fill('/body-next')]);
  const failed=run.steps.find(row=>row.step_id==='n11'&&row.status==='failed'),saved=run.steps.filter(row=>row.type==='http'&&row.status==='succeeded').map(({path,operation_key,output})=>({path,operation_key,output}));assert.ok(failed);
  await h.restart();mode='normal';const replay=await h.get('workflow-runs/'+run.id+'/replay');assert.ok(replay.eligible.some(row=>row.path===failed.path));
  run=await h.post('workflow-runs/'+run.id+'/replay',{digest:replay.digest,paths:[failed.path]});run=await settled(h,run.id);verify(run,messages);
  assert.equal(attempts.length,effects.length+1,'selected replay must repeat only the failed request');
  for(const checkpoint of saved){const current=run.steps.find(row=>row.path===checkpoint.path);assert.deepEqual({path:current.path,operation_key:current.operation_key,output:current.output},checkpoint)}
 } finally {await h?.close();receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve))}
}
