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
    const search={id:'lookup',type:'table.lookup',table_id:table.id,input:{key:'{{trigger.input.key}}'}};
    const missingRoute={id:'route',type:'paths',mode:'exclusive',branches:[{id:'missing',when:[[{field:'steps.lookup.outcome',op:'text.equals',value:'not found'}]],steps:[]}],fallback:{steps:[]}};
    const missingHalt=await publish(h,'Absent operational record halts',{trigger:{type:'manual'},steps:[{...search,no_match:'halt'},missingRoute]});
    const missingContinue=await publish(h,'Absent operational record routes',{trigger:{type:'manual'},steps:[{...search,no_match:'continue'},missingRoute]});
    const halted=await startRun(h,missingHalt,{key:'absent_record'});assert.equal(halted.status,'stopped_by_search');assert.equal(stepOf(halted,'lookup').output.outcome,'not found');assert.equal(stepOf(halted,'route'),undefined);
    const continued=await startRun(h,missingContinue,{key:'absent_record'});assert.equal(continued.status,'succeeded');assert.deepEqual(stepOf(continued,'route').output.matched,['missing']);
    const createStep={...search,create_if_not_found:{value:'{{trigger.input.initial}}'}};
    const creating=await publish(h,'Find or create operational record',{settings:{max_concurrency:4},trigger:{type:'manual'},steps:[createStep]});
    const created=await startRun(h,creating,{key:'new_list',initial:[41,42]});assert.equal(created.status,'succeeded',JSON.stringify(created.error));
    const initial=stepOf(created,'lookup').output;assert.equal(initial.outcome,'created');assert.deepEqual(initial.record.value,[41,42]);assert.equal(initial.count,1);
    assert.equal(initial.operation_key,stepOf(created,'lookup').operation_key);
    await h.restart();
    const found=await startRun(h,creating,{key:'new_list',initial:[99]});assert.equal(found.status,'succeeded');assert.equal(stepOf(found,'lookup').output.outcome,'found');assert.deepEqual(stepOf(found,'lookup').output.record,initial.record,'Finding preserves the record, revision and timestamps');
    const raced=await Promise.all([startRun(h,creating,{key:'new_counter',initial:17}),startRun(h,creating,{key:'new_counter',initial:19})]);
    for(let pass=0;pass<5;pass++){const current=await Promise.all(raced.map(run=>h.get('workflow-runs/'+run.id)));if(current.every(run=>run.status==='succeeded'))break;await h.tick()}
    const raceOutputs=await Promise.all(raced.map(async run=>{const current=await h.get('workflow-runs/'+run.id);assert.equal(current.status,'succeeded');return stepOf(current,'lookup').output}));
    assert.deepEqual(raceOutputs.map(output=>output.outcome).sort(),['created','found']);assert.deepEqual(raceOutputs[0].record,raceOutputs[1].record);assert.equal(raceOutputs[0].record.revision,1);
    assert.ok([17,19].includes(raceOutputs[0].record.value));assert.equal((await h.get(`tables/${table.id}/records/new_counter`)).value,raceOutputs[0].record.value);
    assert.equal((await h.get('tables/'+table.id)).records.filter(record=>record.key==='new_counter').length,1);
    for(const input of [{key:'',initial:3},{key:'new_string',initial:'synthetic-crank-1101'},{key:'new_object',initial:{value:1}}]) {
      const refused=await startRun(h,creating,input);assert.equal(refused.status,'failed');assert.equal(refused.error.category,'validation');
    }
    await h.get(`tables/${table.id}/records/new_string`,h.owner,404);await h.get(`tables/${table.id}/records/new_object`,h.owner,404);
    const createId=uuid(),createRequest={key:'durable_counter',operation:'find_or_create',value:31};
    const receipt=await change(createRequest,createId);assert.equal(receipt.outcome,'created');await h.restart();assert.deepEqual(await change(createRequest,createId),receipt);
    await h.post(`tables/${table.id}/records`,{...createRequest,value:37,operation_id:createId},h.owner,409);
    assert.equal((await h.get(`tables/${table.id}/records/durable_counter`)).value,31);
    await h.post(`tables/${table.id}/records`,{...createRequest,operation_id:uuid()},'',403,{authorization:'Bearer '+preparation.token});
    const classifiedCreate=await publish(h,'Sensitive find-or-create refused',{trigger:{type:'manual'},steps:[createStep]});
    await h.post('data/classes',{workflow_id:classifiedCreate.id,data_class:'customer',identifier_fields:[]});
    const classified=await startRun(h,classifiedCreate,{key:'classified_record',initial:5});assert.equal(classified.status,'paused');await h.get(`tables/${table.id}/records/classified_record`,h.owner,404);
    const isolated=await h.send('/api/crank/workflows/'+creating.id+'/test',{bindings:{},input:{key:'test_record',initial:5}},h.owner);assert.equal(isolated.status,422);assert.match(isolated.text,/isolated test bindings/);await h.get(`tables/${table.id}/records/test_record`,h.owner,404);
    await h.post(`tables/${table.id}/pause`);
    const pausedCreate=await startRun(h,creating,{key:'paused_record',initial:5});assert.equal(pausedCreate.status,'paused');assert.equal(pausedCreate.error.category,'authority');await h.get(`tables/${table.id}/records/paused_record`,h.owner,404);
    const pausedState=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:pausedState.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
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
    await restored.post(`tables/${table.id}/records`,{...createRequest,operation_id:createId},restored.owner,409);
    await restored.post(`tables/${table.id}/records`,{key:'retired_count',operation:'upsert',value:0,operation_id:uuid()},restored.owner,409); // The populated erased-key fence survives receiving adoption.
    // Erasure spends keys/operation receipts and journals every deleted row.
    await h.post(`tables/${table.id}/pause`);
    await h.post(`tables/${table.id}/records/new_list/erase`,{confirm:'ERASE'});
    await h.post(`tables/${table.id}/records/durable_counter/erase`,{confirm:'ERASE'});
    const erased=await h.post(`tables/${table.id}/records/received_count/erase`,{confirm:'ERASE'});assert.equal(erased.phase,'complete');
    await h.get(`tables/${table.id}/records/received_count`,h.owner,404);
    const after=await h.get('tables/'+table.id);await h.post(`tables/${table.id}/adopt`,{digest:after.digest,confirm:'ADOPT_OPERATIONAL_STATE'});
    await h.post(`tables/${table.id}/records`,{key:'received_count',operation:'upsert',value:0,operation_id:uuid()},h.owner,409);
    const replayedCreate=await startRun(h,creating,{key:'new_list',initial:[1]});assert.equal(replayedCreate.status,'paused');assert.equal(replayedCreate.error.category,'authority');await h.get(`tables/${table.id}/records/new_list`,h.owner,404);
    await h.post(`tables/${table.id}/records`,{...createRequest,operation_id:createId},h.owner,409);
    const journal=await archive(h);erasedRestore=await harness('http://127.0.0.1:9');
    const rejected=await erasedRestore.send('/api/crank/data/restore',{archive:exported,journal,confirm:'RESTORE'},erasedRestore.owner);assert.equal(rejected.status,409,'later erasure journal refuses old state rows');
    return {concurrent_runs:10,counter:12,pop_values:[11,22,33],empty_outcomes:1,erased_record:seeded.record_id};
  } finally {await erasedRestore?.close();await restored?.close();await h.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await tableStateJourney()));
