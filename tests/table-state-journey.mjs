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
    const first=await change(mutation,operation_id);assert.deepEqual(await change(mutation,operation_id),first);
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
    // Erasure spends keys/operation receipts and journals every deleted row.
    await h.post(`tables/${table.id}/pause`);
    const erased=await h.post(`tables/${table.id}/records/received_count/erase`,{confirm:'ERASE'});assert.equal(erased.phase,'complete');
    await h.get(`tables/${table.id}/records/received_count`,h.owner,404);
    const after=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:after.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
    await h.post(`tables/${table.id}/records`,{key:'received_count',operation:'upsert',value:0,operation_id:uuid()},h.owner,409);
    const journal=await archive(h);erasedRestore=await harness('http://127.0.0.1:9');
    const rejected=await erasedRestore.send('/api/crank/data/restore',{archive:exported,journal,confirm:'RESTORE'},erasedRestore.owner);assert.equal(rejected.status,409,'later erasure journal refuses old state rows');
    return {concurrent_runs:10,counter:12,pop_values:[11,22,33],empty_outcomes:1,erased_record:seeded.record_id};
  } finally {await erasedRestore?.close();await restored?.close();await h.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await tableStateJourney()));
