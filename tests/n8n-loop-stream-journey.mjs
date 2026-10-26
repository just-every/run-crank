import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {door,doorPlan,deliver,settled} from './kit.mjs';
import {streamLoopExport,streamLoopEnvelope} from './n8n-graph-fixture.mjs';

const parts=[1,2,1];
const bodyItems=message=>parts.map(part=>({processed:message,part}));
const returnedItems=(message,expanded)=>bodyItems(message).flatMap(item=>expanded&&item.part===1?[item,{...item}]:[item]);
const bodyPaths=messages=>messages.flatMap(()=>['/body',...parts.map(()=>'/body-next')]);
const checkpoint=step=>({path:step.path,operation_key:step.operation_key,output:step.output});
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');

/** Actual owned receiver, with only public-address routing bridged at the
 * network edge. No response, native step or retained checkpoint is faked. */
export async function streamLoopJourney(declared) {
 const attempts=[],completed=[],envelope=streamLoopEnvelope(declared),choice=envelope.conversions.n2;let mode='object',h,event=110;
 const receiver=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const input=JSON.parse(text),path=req.url;attempts.push({path,input});
  if(mode==='failure'&&path==='/body-next'&&input.part===2){res.writeHead(400);res.end();return}
  completed.push({path,input});
  if(mode==='binary'&&path==='/body-next'){res.writeHead(200,{'content-type':'application'+'/'+'octet-stream'});res.end(Buffer.from([0,1,255]));return}
  res.writeHead(200,{'content-type':'application'+'/'+'json'});
  if(path==='/body'){
   const result=mode==='stage-bound'?Array.from({length:choice.max_stage_items+1},(_,part)=>({processed:input.message,part})):bodyItems(input.message);if(mode==='initial-type')result[1].part='synthetic-crank-96';res.end(JSON.stringify(result));return;
  }
  const output={processed:input.processed,part:input.part};
  if(path==='/body-next'){
   if(mode==='empty'||mode==='empty-later'&&input.processed==='synthetic-crank-101'){res.end('[]');return}
   if(mode==='scalar'){res.end('17');return}
   if(mode==='mixed-primitive'){res.end(JSON.stringify([output,'synthetic-crank-97']));return}
   if(mode==='final-type'&&input.part===1)output.part='synthetic-crank-98';
   res.end(JSON.stringify(mode==='expanded'&&input.part===1?[output,{...output}]:output));return;
  }
  res.end(JSON.stringify(output));
 });
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const target='http://127.0.0.1:'+receiver.address().port;
 try{
  h=await harness(declared,{edge:async request=>{const url=new URL(request.url);if(url.origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(target+url.pathname,{method:request.method,headers,body:await request.arrayBuffer()})}});
  const unresolved=await doorPlan(h,JSON.stringify(streamLoopExport(declared)));assert.equal(unresolved.status,200,unresolved.text);assert.equal(unresolved.value.rejected.length,1,'intermediate item-stream conversion must require explicit reviewed bounds');assert.equal((await h.get('workflows')).length,0);assert.equal(attempts.length,0);await door(h,'undo',{planId:unresolved.value.planId});
  const plan=await doorPlan(h,JSON.stringify(envelope));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));assert.notEqual(plan.value.fingerprint,unresolved.value.fingerprint,'the reviewed bound choice must participate in import identity');assert.equal((await h.get('workflows')).length,0);assert.equal(attempts.length,0,'planning must perform no receiver operation');
  const approval={planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint};
  for(let i=0;i<2;i++){const applied=await door(h,'apply',approval);assert.equal(applied.value.job?.state,'completed',applied.text)}
  const [workflow]=await h.get('workflows'),draft=await h.get('workflows/'+workflow.id);assert.equal(draft.status,'draft');assert.equal(draft.versions.length,0);assert.equal(draft.hooks.length,0);assert.equal(attempts.length,0);
  assert.deepEqual(draft.draft.settings.n8n_conversions.n2,choice);assert.deepEqual(draft.draft.settings.n8n_conversion_dispositions.find(item=>item.node_id==='n2'),{node_id:'n2',kind:choice.kind,resolved:true,source_digest:digest(envelope.workflow.nodes[2]),choice_digest:digest(choice)},'native provenance must retain the exact source loop and reviewed bound choice');
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft.draft);assert.equal((await door(h,'reconcile',{planId:plan.value.planId})).value.ok,true);
  await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
  const send=async messages=>{const delivered=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json','x-event-id':'synthetic-crank-'+event++},body:JSON.stringify({messages})});assert.equal(delivered.status,200,delivered.text);assert.equal(delivered.value.accepted,true,delivered.text);return settled(h,delivered.value.run_id)};
  const reset=value=>{mode=value;attempts.length=0;completed.length=0};
  const verifyCompleted=(run,messages,expanded=false)=>{
   assert.equal(run.status,'succeeded',JSON.stringify(run.error));const expected=messages.flatMap(message=>returnedItems(message,expanded));
   assert.deepEqual(completed.map(row=>row.path),[...bodyPaths(messages),...expected.map(()=>'/done-first'),...expected.map(()=>'/done-last')],'each source batch must finish its body stream before the next batch; each done node must finish before the next');
   assert.deepEqual(completed.filter(row=>row.path==='/body-next').map(row=>row.input),messages.flatMap(message=>bodyItems(message)).map(item=>({...item,phase:'synthetic-crank-91'})),'all intermediate HTTP inputs retain source order and duplicate records');
   for(const [path,phase]of [['/done-first','synthetic-crank-32'],['/done-last','synthetic-crank-33']])assert.deepEqual(completed.filter(row=>row.path===path).map(row=>row.input),expected.map(item=>({...item,phase})),'completion must consume every returned record in order');
   const returned=run.steps.filter(step=>step.step_id==='n12'&&step.status==='succeeded');assert.equal(returned.length,expected.length,'the final body Set must process the complete expanded stream');for(const step of returned)assert.equal(step.output.phase,'synthetic-crank-92');
   const operations=run.steps.filter(step=>step.step_id==='n11'&&step.status==='succeeded');assert.equal(operations.length,messages.length*parts.length);assert.equal(new Set(operations.map(step=>step.operation_key)).size,operations.length,'duplicate source records must keep distinct native operations');
  };
  for(const scenario of [{mode:'object',messages:['synthetic-crank-100','synthetic-crank-101']},{mode:'expanded',messages:['synthetic-crank-100','synthetic-crank-100']}]){reset(scenario.mode);verifyCompleted(await send(scenario.messages),scenario.messages,scenario.mode==='expanded')}
  for(const scenario of [{mode:'object',messages:Array(choice.max_source_items+1).fill('synthetic-crank-100'),requests:[]},{mode:'stage-bound',messages:['synthetic-crank-100','synthetic-crank-101'],requests:['/body']}]){
   reset(scenario.mode);const run=await send(scenario.messages);assert.equal(run.status,'failed','reviewed stream bounds must stop oversized source or stage input');assert.equal(run.error.category,'validation');assert.deepEqual(attempts.map(row=>row.path),scenario.requests,'the declared bound must fail before the following HTTP write');assert.ok(run.steps.some(step=>step.step_id&&step.error?.category==='validation'&&/bound|limit/i.test(step.error.message)),'bound refusal must retain the failed native operation and its cause');
  }
  for(const scenario of [{mode:'empty',messages:['synthetic-crank-100','synthetic-crank-101'],processed:1},{mode:'empty-later',messages:['synthetic-crank-100','synthetic-crank-101','synthetic-crank-102'],processed:2}]){
   reset(scenario.mode);const run=await send(scenario.messages);assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(attempts.map(row=>row.path),bodyPaths(scenario.messages.slice(0,scenario.processed)),'an empty intermediate stream must stop later source batches and the entire done path');assert.equal(run.steps.filter(step=>step.step_id==='n12'&&step.status==='succeeded').length,(scenario.processed-1)*parts.length,'empty output must not invoke the following Set');
  }
  // These failures prove node barriers through actual receiver effects, without
  // relying on timestamp resolution or the compiler's generated wrapper IDs.
  reset('initial-type');const initialType=await send(['synthetic-crank-100','synthetic-crank-101']);assert.equal(initialType.status,'failed');assert.deepEqual(attempts.map(row=>row.path),['/body'],'a later invalid Set item must prevent every request in the following HTTP node');
  reset('final-type');const finalType=await send(['synthetic-crank-100','synthetic-crank-101']);assert.equal(finalType.status,'failed');assert.deepEqual(attempts.map(row=>row.path),bodyPaths(['synthetic-crank-100']),'every HTTP item must finish before the following Set validates its first returned item');
  for(const unsupported of ['binary','scalar','mixed-primitive']){
   reset(unsupported);const run=await send(['synthetic-crank-100','synthetic-crank-101']);assert.equal(run.status,'failed',unsupported+' response must require explicit conversion');assert.equal(attempts.filter(row=>row.path==='/body').length,1,'unsupported responses must stop before the next source batch');assert.ok(attempts.some(row=>row.path==='/body-next'));assert.equal(attempts.filter(row=>row.path.startsWith('/done-')).length,0,'unsupported response items must not reach downstream writes');assert.equal(run.steps.filter(step=>step.step_id==='n12').length,0,'unsupported response items must fail before downstream mappings');
  }
  reset('failure');let interrupted=await send(['synthetic-crank-100','synthetic-crank-101']);assert.equal(interrupted.status,'failed');assert.deepEqual(attempts.map(row=>row.path),['/body','/body-next','/body-next']);assert.deepEqual(completed.map(row=>row.path),['/body','/body-next']);
  const checkpoints=interrupted.steps.filter(step=>step.type==='http'&&step.status==='succeeded').map(checkpoint),failed=interrupted.steps.find(step=>step.step_id==='n11'&&step.status==='failed');assert.ok(failed,'failure must retain the exact failed intermediate operation');
  await h.restart();mode='object';const replay=await h.get('workflow-runs/'+interrupted.id+'/replay'),pending=replay.eligible.find(step=>step.path===failed.path);assert.ok(pending,'selective replay must identify the failed source HTTP item');assert.ok(!replay.eligible.some(step=>checkpoints.some(saved=>saved.path===step.path)),'successful source operations must not become replay candidates');
  interrupted=await h.post('workflow-runs/'+interrupted.id+'/replay',{digest:replay.digest,paths:[pending.path]});if(['queued','running'].includes(interrupted.status))interrupted=await settled(h,interrupted.id);
  verifyCompleted(interrupted,['synthetic-crank-100','synthetic-crank-101']);assert.equal(attempts.length,completed.length+1,'replay must add only the rejected request to otherwise exact once receiver effects');
  for(const saved of checkpoints)assert.deepEqual(checkpoint(interrupted.steps.find(step=>step.path===saved.path)),saved,'restart and selected replay must retain earlier HTTP checkpoints');
  assert.equal(interrupted.steps.find(step=>step.path===failed.path).operation_key,failed.operation_key,'retrying unchanged input must preserve the failed operation identity');
 }finally{await h?.close();receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve))}
}
