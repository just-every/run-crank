import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { harness } from './harness.mjs';
import { archive, rewritten } from './restore-journey.mjs';
import { publish, startRun, stepOf } from './kit.mjs';

export async function tableStateJourney() {
  const h=await harness('http://127.0.0.1:9');let restored,erasedRestore;
  const uuid=()=>crypto.randomUUID();
  try {
    await h.post('tables',{name:'Operational counters',confirm:'OPERATIONAL_NUMBERS_ONLY'},'',401);
    const table=await h.post('tables',{name:'Operational counters',confirm:'OPERATIONAL_NUMBERS_ONLY'},h.owner,201);
    const change=(input,operation_id=uuid())=>h.post(`tables/${table.id}/records`,{...input,operation_id});
    await h.get(`tables/${table.id}/records/received_count`,'',401);
    const preparation=await h.post('tokens',{label:'Table preparation refusal',scope:'agent'},h.owner,201);
    await h.get('tables/'+table.id,'',403,{authorization:'Bearer '+preparation.token});
    const seeded=await change({key:'received_count',operation:'upsert',value:0});
    await change({key:'received_count',operation:'upsert',value:0});
    assert.equal((await h.get('tables/'+table.id)).records.length,1,'keyed upsert never creates a second logical record');
    await h.post(`tables/${table.id}/records`,{key:'unsafe',operation:'upsert',value:'customer data',operation_id:uuid()},h.owner,422);
    const graph={settings:{max_concurrency:10},trigger:{type:'manual'},steps:[{id:'count',type:'table.atomic',table_id:table.id,input:{key:'received_count',operation:'increment',by:1}}]};
    const w=await publish(h,'Count admitted work',graph);
    const admitted=await Promise.all(Array.from({length:10},()=>startRun(h,w,{})));
    for(let pass=0;pass<10;pass++){
      const current=await Promise.all(admitted.map(run=>h.get('workflow-runs/'+run.id)));
      if(current.every(run=>run.status==='succeeded'))break;
      await h.tick(Date.now()+1000);
    }
    const completed=await Promise.all(admitted.map(run=>h.get('workflow-runs/'+run.id)));
    assert.ok(completed.every(run=>run.status==='succeeded'),JSON.stringify(completed.map(run=>({status:run.status,error:run.error}))));
    assert.equal((await h.get(`tables/${table.id}/records/received_count`)).value,10,'ten concurrently admitted runs add exactly ten');
    assert.deepEqual(completed.map(run=>stepOf(run,'count').output.value).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9,10]);
    const operation_id=uuid(),mutation={key:'received_count',operation:'increment',by:2};
    const first=await change(mutation,operation_id);await h.restart();assert.deepEqual(await change(mutation,operation_id),first);
    assert.equal((await h.get(`tables/${table.id}/records/received_count`)).value,12);
    await h.post(`tables/${table.id}/records`,{...mutation,by:3,operation_id},h.owner,409);
    await change({key:'queue',operation:'upsert',value:[11,22,33]});
    const pop=await publish(h,'Pop operational list',{settings:{max_concurrency:4},trigger:{type:'manual'},steps:[{id:'pop',type:'table.atomic',table_id:table.id,input:{key:'queue',operation:'pop_first'}}]});
    const popped=await Promise.all(Array.from({length:4},()=>startRun(h,pop,{})));
    for(let pass=0;pass<5;pass++){const current=await Promise.all(popped.map(run=>h.get('workflow-runs/'+run.id)));if(current.every(run=>run.status==='succeeded'))break;await h.tick(Date.now()+1000)}
    const outcomes=await Promise.all(popped.map(async run=>stepOf(await h.get('workflow-runs/'+run.id),'pop').output));
    assert.deepEqual(outcomes.filter(row=>row.outcome!=='list empty').map(row=>row.value).sort((a,b)=>a-b),[11,22,33]);assert.equal(outcomes.filter(row=>row.outcome==='list empty').length,1);
    const lookup=await publish(h,'Read operational count',{trigger:{type:'manual'},steps:[{id:'lookup',type:'table.lookup',table_id:table.id,no_match:'halt',input:{key:'received_count'}}]});
    assert.equal(stepOf(await startRun(h,lookup,{}),'lookup').output.record.value,12);
    const privateFlow=await publish(h,'Sensitive table access refused',graph);await h.post('data/classes',{workflow_id:privateFlow.id,data_class:'customer',identifier_fields:[]});
    assert.equal((await startRun(h,privateFlow,{})).status,'paused');assert.equal((await h.get(`tables/${table.id}/records/received_count`)).value,12);
    await h.post(`workflows/${w.id}/test`,{bindings:{}},h.owner,422);
    assert.equal((await h.get(`tables/${table.id}/records/received_count`)).value,12);
    await change({key:'retired_count',operation:'upsert',value:1});await h.post(`tables/${table.id}/pause`);
    await h.post(`tables/${table.id}/records/retired_count/erase`,{confirm:'ERASE'});
    const review=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:review.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
    const exported=await archive(h),sourceSnapshot=await h.get('tables/'+table.id);
    restored=await harness('http://127.0.0.1:9');
    const invalid=await rewritten(exported,(name,row)=>{if(name==='crank_state_records')row.value_json=JSON.stringify('unsupported customer record')});
    await restored.post('data/restore',{archive:invalid,confirm:'RESTORE'},restored.owner,400);
    assert.deepEqual(await restored.get('tables'),[],'invalid operational values leave no partial product state');
    await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
    const stateInventory=text=>text.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row'&&item.table.startsWith('crank_state_')).map(({table,row})=>JSON.stringify({table,row:{...row,...(['crank_state_tables','crank_state_operations'].includes(table)?{active:0}:{})}})).sort();
    assert.deepEqual(stateInventory(await archive(restored)),stateInventory(exported),'all state records, receipts and replay fences survive inactive restore');
    const received=await restored.get('tables/'+table.id);assert.equal(received.table.active,0);assert.deepEqual(received.records,sourceSnapshot.records);
    await restored.restart();await restored.tick(Date.now()+86400000);assert.deepEqual((await restored.get('tables/'+table.id)).records,received.records);
    await restored.post(`tables/${table.id}/adopt`,{digest:received.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
    await restored.post(`tables/${table.id}/records`,{...mutation,operation_id},restored.owner,409);
    await restored.post(`tables/${table.id}/records`,{key:'retired_count',operation:'upsert',value:0,operation_id:uuid()},restored.owner,409); // The populated erased-key fence survives receiving adoption.
    // Erasure spends keys/operation receipts and journals every deleted row.
    await h.post(`tables/${table.id}/pause`);
    const erased=await h.post(`tables/${table.id}/records/received_count/erase`,{confirm:'ERASE'});assert.equal(erased.phase,'complete');
    await h.get(`tables/${table.id}/records/received_count`,h.owner,404);
    const after=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:after.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
    await h.post(`tables/${table.id}/records`,{key:'received_count',operation:'upsert',value:0,operation_id:uuid()},h.owner,409);
    const journal=await archive(h);erasedRestore=await harness('http://127.0.0.1:9');
    const rejected=await erasedRestore.send('/api/crank/data/restore',{archive:exported,journal,confirm:'RESTORE'},erasedRestore.owner);assert.equal(rejected.status,409,'later erasure journal refuses old state rows');
    await tableTransformJourney();
    return {concurrent_runs:10,counter:12,pop_values:[11,22,33],empty_outcomes:1,erased_record:seeded.record_id};
  } finally {await erasedRestore?.close();await restored?.close();await h.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await tableStateJourney()));

/** Stored lookup values drive pure transforms and inline mappings at native doors. */
export async function tableTransformJourney({inspect=async()=>{}}={}) {
 const target='https://receiver.example',writes=[];
 const edge=async request=>{if(new URL(request.url).origin!==target)return undefined;const body=await request.json();writes.push(body);return Response.json({stored:body})};
 const h=await harness(target,{edge});let restored;
 try {
  const table=await h.post('tables',{name:'Non-sensitive sales routing codes',confirm:'OPERATIONAL_NUMBERS_ONLY'},h.owner,201);
  const put=(key,value)=>h.post(`tables/${table.id}/records`,{key,operation:'upsert',value,operation_id:crypto.randomUUID()});
  await put('tx',101);await put('ok',102);
  const graph={trigger:{type:'webhook'},steps:[
   {id:'rep',type:'transform',fn:'utility.lookup',input:{value:'{{trigger.body.state}}',table:{$table:table.id},default:999}},
   {id:'destination',type:'http',input:{method:'POST',url:target+'/routing',body:{rep:'{{steps.rep}}',inline:{$fn:'utility.lookup',args:{value:'{{trigger.body.state}}',table:{$table:table.id},default:999}}}}},
  ]};
  const w=await h.post('workflows',{name:'Stored sales routing',graph},h.owner,201),base='workflows/'+w.id;
  const listener=await h.post(base+'/samples/listen',{},h.owner,201);
  const {deliver,settled}=await import('./kit.mjs');
  assert.equal((await deliver(h,listener.url,{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded'},body:'state=TX'})).status,201);
  const preview=await h.post(base+'/preview',{});assert.equal(preview.source.source,'webhook');assert.equal(preview.steps[0].output,101);assert.equal(preview.steps[1].outcome,'not run in preview');assert.deepEqual(writes,[]);
  await inspect({h,w,state:'table-preview',expected:101});
  // A second current native owner still needs explicit ownership of the table.
  const otherOwner=await h.independentStarter();
  const refused=await h.post(base+'/preview',{},otherOwner);assert.equal(refused.steps.at(-1).outcome,'validation failure');assert.equal(refused.steps.some(step=>step.output!==undefined),false);assert.deepEqual(writes,[]);
  await h.post(base+'/test',{bindings:{}},h.owner,422);
  await h.post(base+'/publish',{},h.owner,201);const hook=await h.post(base+'/hooks',{},h.owner,201);
  let event=0;
  const dispatch=async state=>{const admitted=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded'},body:new URLSearchParams({state,event:'synthetic-crank-lookup-'+(++event)}).toString()});assert.equal(admitted.status,200,admitted.text);return settled(h,admitted.value.run_id)};
  assert.equal((await dispatch('TX')).status,'succeeded');assert.deepEqual(writes.at(-1),{rep:101,inline:101});
  await h.restart();assert.equal((await dispatch('ZZ')).status,'succeeded');assert.deepEqual(writes.at(-1),{rep:999,inline:999});
  await put('tx',201);assert.equal((await dispatch(' tx ')).status,'succeeded');assert.deepEqual(writes.at(-1),{rep:201,inline:201},'a new run reads the current stored lookup value');
  await inspect({h,w,state:'table-result',expected:201});
  const disclosed=(await h.get('data'+'/flows')).flows.find(row=>row.id==='table:'+table.id);assert.ok(disclosed);assert.deepEqual(disclosed.recipients,[]);assert.equal(JSON.stringify(disclosed).includes('201'),false);
  const exported=await archive(h);
  restored=await harness(target,{edge});await restored.post('data'+'/restore',{archive:exported,confirm:'RESTORE'});
  const {inventory}=await import('./restore-journey.mjs');
  const before=inventory(exported),after=inventory(await archive(restored));assert.deepEqual(before.filter(row=>!after.includes(row)),[],'all lookup, workflow, sample and history rows survive inactive');
  assert.deepEqual(after.filter(row=>!before.includes(row)).map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
  const count=writes.length;await restored.tick();assert.equal(writes.length,count);assert.equal((await restored.get('tables/'+table.id)).table.active,0);
  assert.equal((await restored.post(base+'/preview',{sample:{body:{state:'TX'}}})).steps.at(-1).outcome,'validation failure');
  assert.ok((await deliver(restored,hook.url,{method:'POST',body:'state=TX'})).status>=400);assert.equal(writes.length,count);
  await h.post('tables/'+table.id+'/pause');
  const paused=await h.post(base+'/preview',{});assert.equal(paused.steps.at(-1).outcome,'validation failure');assert.equal((await dispatch('TX')).status,'paused');assert.equal(writes.length,count);
  await inspect({h,w,state:'table-paused'});
  await h.post(`tables/${table.id}/records/tx/erase`,{confirm:'ERASE'});
  const review=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:review.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
  await h.get(`tables/${table.id}/records/tx`,h.owner,404);await h.post(`tables/${table.id}/records`,{key:'tx',operation:'upsert',value:201,operation_id:crypto.randomUUID()},h.owner,409);
  assert.equal((await dispatch('TX')).status,'succeeded');assert.deepEqual(writes.at(-1),{rep:999,inline:999},'reusing the captured key after erasure cannot revive its stored value');
  await inspect({h,w,state:'table-erased',expected:999});
  await h.post(base+'/pause');
  const sensitive=await h.post('workflows',{name:'Sensitive lookup refusal',graph},h.owner,201),sensitiveBase='workflows/'+sensitive.id;
  await h.post('data'+'/classes',{workflow_id:sensitive.id,data_class:'customer'});
  const privatePreview=await h.post(sensitiveBase+'/preview',{sample:{body:{state:'OK'}}});assert.equal(privatePreview.steps.at(-1).error.category,'authority');assert.equal(privatePreview.steps.some(step=>step.output!==undefined),false);
  assert.equal(writes.length,count+1);
 } finally {await restored?.close();await h.close()}
}
