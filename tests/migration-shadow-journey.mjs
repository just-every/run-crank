import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {doorImport,doorPlan,door} from './kit.mjs';
import {graphExport} from './n8n-graph-fixture.mjs';
import {archive,inventory} from './restore-journey.mjs';

const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
export const fingerprint=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function shadowExport(target,id='synthetic-crank-shadow') {
 const source=graphExport(target,id);source.name='Synthetic no-write migration comparison';source.nodes=[source.nodes[0],source.nodes[1],source.nodes[4]];
 source.connections={n0:{main:[[{node:'n1',type:'main',index:0}]]},n1:{main:[[{node:'n4',type:'main',index:0}]]}};
 return source;
}
export async function shadowFixture(h,target,catchup=false) {
 if(catchup){const plan=await doorPlan(h,JSON.stringify(shadowExport(target)),true);assert.equal(plan.status,200,plan.text);const applied=await door(h,'apply',{planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint});assert.equal(applied.value.job?.state,'completed',applied.text)}
 else await doorImport(h,JSON.stringify(shadowExport(target)));
 const workflow=(await h.get('workflows')).find(row=>row.name==='Synthetic no-write migration comparison'),detail=await h.get('workflows/'+workflow.id);
 // The imported draft is deliberately reviewed in native form. No converter is extended.
 const graph=structuredClone(detail.draft);
 graph.steps=[
  {id:'mapped',type:'map',input:{customer:{$fn:'utility.lookup',args:{value:'{{trigger.body.customer}}',table:{$literal:{'synthetic-crank-6':'synthetic-crank-wrong'}},default:'{{trigger.body.customer}}'}},amount:'{{trigger.body.amount}}',nullable:'{{trigger.body.nullable}}',absent:'{{trigger.body.absent}}',items:'{{trigger.body.items}}'}},
  {id:'eligible',type:'filter',when:[[{field:'trigger.body.amount',op:'number.gt',value:0,value_type:'number'}]]},
  {id:'route',type:'paths',mode:'exclusive',
   branches:[{id:'large',name:'Large',when:[[{field:'steps.mapped.amount',op:'number.gt',value:5,value_type:'number'}]],
    steps:[{id:'large_write',type:'http',input:{method:'POST',url:target+'/large',query:{source:'synthetic-crank-1'},body:'{{steps.mapped}}'}}]
   }],
   fallback:{steps:[{id:'small_write',type:'http',input:{method:'PATCH',url:target+'/small',body:'{{steps.mapped}}'}}]}
  },
 ];
 await h.post('workflows/'+workflow.id+'/draft',{graph});
 const create=async revision=>h.post('imports/comparisons',{workflow_id:workflow.id,draft_digest:fingerprint((await h.get('workflows/'+workflow.id)).draft),source_system:'n8n',source_workflow:'synthetic-crank-shadow',source_revision:revision,non_sensitive:true});
 return {workflow,graph,create};
}
export const shadowInput=n=>({body:{customer:'synthetic-crank-'+n,amount:n,nullable:null,items:[1,null,'synthetic-crank-900']}});
export function shadowExpected(target,n,{wrong=false}={}) {
 const mapped={customer:wrong?'synthetic-crank-wrong':'synthetic-crank-'+n,amount:n,nullable:null,items:[1,null,'synthetic-crank-900']};
 const large=n>5,bodyText=JSON.stringify(mapped);
 return {outcome:'completed',outputs:{mapped,eligible:{passed:true},route:{matched:[large?'large':'fallback']}},intents:[{path:'route/'+(large?'large/large_write':'fallback/small_write'),destination:target+(large?'/large?source=synthetic-crank-1':'/small'),method:large?'POST':'PATCH',headers:{accept:'application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5','content-type':'application/json'},body:mapped,body_text:bodyText}]};
}
export const observation=(target,n,options={})=>({event_id:'synthetic-crank-event-'+n,sequence:n,input:shadowInput(n),result:shadowExpected(target,n,options),provenance:{kind:'synthetic',label:'Owner-supplied documented-format fixture; no live source execution'}});
export async function migrationShadowJourney() {
 const target='https://receiver.example',requests=[];
 const edge=async request=>{if(new URL(request.url).origin===target){requests.push({url:request.url,method:request.method,body:await request.text()});return Response.json({unexpected:true})}};
 const h=await harness(target,{edge});
 try {
  const {workflow,graph,create}=await shadowFixture(h,target);
  const base='imports/comparisons/',comparison=await create('synthetic-crank-revision-1'),key=comparison.id;
  assert.equal(comparison.draft_digest,fingerprint(graph),'the comparison pins the reviewed native draft')
  assert.equal((await h.get('workflows/'+workflow.id)).versions.length,0,'comparison creates no ordinary test or published version');
  assert.deepEqual((await h.get('workflow-runs?workflow='+workflow.id)).runs,[]);
  // Source and native observations arrive in different orders, including duplicates.
  for(const n of [2,1,3,4,5]) {
   const body=observation(target,n),before=await h.get(base+key);
   await h.post(base+key+'/observe',body);
   let report=await h.post(base+key+'/evaluate',{event_id:body.event_id,sequence:n,input:body.input,allow_effects:true,mode:'production'});
   assert.equal(report.events.find(e=>e.sequence===n).status,'matched',JSON.stringify(report.events.find(e=>e.sequence===n).differences));
   assert.deepEqual(report.events.find(e=>e.sequence===n).native.result,shadowExpected(target,n));
   assert.equal(report.events.find(e=>e.sequence===n).input_digest,fingerprint(body.input),'the exact input is fingerprinted')
   await h.post(base+key+'/evaluate',{event_id:body.event_id,sequence:n,input:body.input});
   await h.post(base+key+'/observe',body);
   report=await h.get(base+key);assert.equal(report.events.length,before.events.length+1,'duplicates never add an event or match');
  }
  assert.equal((await h.get(base+key)).counts.consecutive,5);
  const differentInput={...observation(target,1),input:shadowInput(88)};await h.post(base+key+'/evaluate',differentInput,h.owner,409);
  await h.post(base+key+'/evaluate',{event_id:'synthetic-crank-secret',sequence:80,input:{password:'synthetic-crank-not-a-secret'}},h.owner,422);
  await h.post('data/classes',{workflow_id:workflow.id,data_class:'customer'},h.owner,409);
  const stoppedComparison=await create('synthetic-crank-filtered'),stoppedInput=shadowInput(0),stopped=await h.post(base+stoppedComparison.id+'/evaluate',{event_id:'synthetic-crank-filtered',sequence:80,input:stoppedInput});
  assert.equal(stopped.events.find(event=>event.sequence===80).native.result.outcome,'stopped');assert.deepEqual(stopped.events.find(event=>event.sequence===80).native.result.intents,[]);

  const bad=observation(target,6);
  const nativeOnly=await h.post(base+key+'/evaluate',{event_id:bad.event_id,sequence:6,input:bad.input});assert.equal(nativeOnly.events.find(e=>e.sequence===6).status,'unpaired');
  let report=await h.post(base+key+'/observe',bad);assert.equal(report.counts.mismatched,1);assert.equal(report.counts.consecutive,0);
  const difference=report.events.find(e=>e.sequence===6).differences.find(d=>d.field.endsWith('["customer"]'));
  assert.deepEqual(difference.source,{present:true,value:'synthetic-crank-6'});assert.deepEqual(difference.crank,{present:true,value:'synthetic-crank-wrong'});
  await h.post(base+key+'/cutover',{},h.owner,409);
  report=await h.post(base+key+'/decisions',{event_id:bad.event_id,reason:'Synthetic mapping discrepancy accepted for inspection only synthetic-crank-reviewer-subject'});
  assert.equal(report.events.find(e=>e.sequence===6).decisions[0].reason,'Synthetic mapping discrepancy accepted for inspection only synthetic-crank-reviewer-subject');assert.ok(report.events.find(e=>e.sequence===6).decisions[0].decided_by);
  assert.equal(report.counts.consecutive,0,'a reason cannot turn a mismatch into a match');
  for(const subject of ['synthetic-crank-reviewer-subject','synthetic-crank-shadow'])assert.ok((await h.post('data/subject',{subject})).import_comparisons.some(row=>row.id===key),'subject erasure includes decision reasons and source identity labels');
  const unpaired=observation(target,7);await h.post(base+key+'/observe',unpaired);
  assert.equal((await h.get(base+key)).events.find(e=>e.sequence===7).status,'unpaired');
  await h.restart();
  await h.post(base+key+'/evaluate',{event_id:unpaired.event_id,sequence:7,input:unpaired.input});
  for(let n=8;n<=25;n++){const body=observation(target,n);await h.post(base+key+'/evaluate',{event_id:body.event_id,sequence:n,input:body.input});await h.post(base+key+'/observe',body)}
  report=await h.get(base+key);assert.deepEqual(report.counts,{matched:24,mismatched:1,unpaired:0,consecutive:19});
  assert.equal(report.events.length,25);assert.deepEqual(requests,[],'no receiver or transport request is permitted');
  await h.post(base+key+'/observe',{...unpaired,result:shadowExpected(target,7,{wrong:true})},h.owner,409);
  await h.post(base+key+'/observe',{...unpaired,event_id:'synthetic-crank-other'},h.owner,409);
  await h.post(base+key+'/observe',{...unpaired,event_id:'synthetic-crank-unlabelled',sequence:27,provenance:null},h.owner,422);
  assert.equal((await h.send('/api/crank/'+base+key,undefined,'')).status,401);
  assert.equal((await h.send('/api/crank/'+base+key+'/evaluate',{event_id:'synthetic-crank-denied',sequence:28,input:{}},h.owner,{origin:'https://foreign.example'})).status,403);
  // The correction starts a fresh immutable snapshot. It cannot erase the prior mismatch.
  const edited=structuredClone(graph);edited.steps[0].input.customer='{{trigger.body.customer}}';
  await h.post('workflows/'+workflow.id+'/draft',{graph:edited});
  await h.post(base+key+'/evaluate',{event_id:'synthetic-crank-stale',sequence:29,input:shadowInput(29)},h.owner,409);
  const oldReport=await h.get(base+key);assert.equal(oldReport.stale,true);assert.equal(oldReport.events.find(e=>e.sequence===6).native.result.outputs.mapped.customer,'synthetic-crank-wrong','correcting the draft preserves the old immutable evaluation');
  const corrected=await create('synthetic-crank-revision-1');
  for(let n=1;n<=20;n++) {
   const body=observation(target,n);
   await h.post(base+corrected.id+'/evaluate',{event_id:body.event_id,sequence:n,input:body.input});await h.post(base+corrected.id+'/observe',body);
  }
  report=await h.get(base+corrected.id);assert.equal(report.counts.consecutive,20);assert.equal(report.cutover_eligible,false);await h.post(base+corrected.id+'/cutover',{},h.owner,409);
  // Missing, null and array order stay visible as distinct differences.
  const distinct=observation(target,21);distinct.result.outputs.mapped={...distinct.result.outputs.mapped,absent:null,items:[null,1,'synthetic-crank-900']};
  await h.post(base+corrected.id+'/observe',distinct);report=await h.post(base+corrected.id+'/evaluate',{event_id:distinct.event_id,sequence:21,input:distinct.input});
  const diffs=report.events.find(e=>e.sequence===21).differences;
  assert.ok(diffs.some(d=>d.field.endsWith('["absent"]')&&d.source.present&&!d.crank.present));assert.ok(diffs.some(d=>d.field.endsWith('["items"][0]')&&d.source.value===null&&d.crank.value===1));assert.equal(report.counts.consecutive,0);
  const saved=await archive(h),original=inventory(saved),restored=await harness(target,{edge});
  try {
   await restored.post('data/restore',{archive:saved,confirm:'RESTORE'});const receiving=inventory(await archive(restored));assert.deepEqual(original.filter(row=>!receiving.includes(row)),[],'complete portable custody remains intact');
   assert.deepEqual(receiving.filter(row=>!original.includes(row)).map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
   const restoredReport=await restored.get(base+corrected.id);assert.equal(restoredReport.active,0);assert.deepEqual(restoredReport.events,report.events);await restored.post(base+corrected.id+'/evaluate',{event_id:'synthetic-crank-restored',sequence:30,input:{}},restored.owner,409);await restored.tick();assert.deepEqual(requests,[]);
  } finally {await restored.close()}
  // Erased samples cannot be resurrected by a duplicate source capture or old archive.
  const hold=await h.post('data/holds',{kind:'subject',subject:'synthetic-crank-1',reason:'Retain comparison evidence'},h.owner,201);
  const heldPreview=await h.post('data/subject',{subject:'synthetic-crank-1'});assert.equal(heldPreview.blocked,true);await h.post('data/erase',{subject:'synthetic-crank-1',digest:heldPreview.digest,confirm:'ERASE'},h.owner,409);
  await h.post('data/holds/'+hold.id+'/release');
  const preview=await h.post('data/subject',{subject:'synthetic-crank-1'});assert.ok(preview.import_comparisons.length>=1);
  const erased=await h.post('data/erase',{subject:'synthetic-crank-1',digest:preview.digest,confirm:'ERASE'});assert.ok(erased.operations.length);
  const again=await create('synthetic-crank-revision-1');await h.post(base+again.id+'/observe',observation(target,1),h.owner,409);
  const revised=await create('synthetic-crank-revision-2');await h.post(base+revised.id+'/observe',observation(target,1),h.owner,409);
  const later=await archive(h),empty=await harness(target,{edge});try{await empty.post('data/restore',{archive:saved,journal:later,confirm:'RESTORE'},empty.owner,409)}finally{await empty.close()}
  // Unsupported whole graphs are refused before evaluating a chosen branch.
  for(const extra of [{id:'delay',type:'delay',mode:'for',input:{amount:1,unit:'seconds'}},{id:'read',type:'http',input:{method:'GET',url:target+'/read'}}]) {
   const unsupported=structuredClone(graph);unsupported.steps.push(extra);await h.post('workflows/'+workflow.id+'/draft',{graph:unsupported});await create('synthetic-crank-unsupported').then(()=>assert.fail('unsupported comparison admitted'),error=>assert.match(error.message,/Comparison/));
  }
  await h.post('workflows/'+workflow.id+'/draft',{graph});const revoked=await create('synthetic-crank-revoked');
  await h.send('/auth/signout',{},h.owner);assert.equal((await h.send('/api/crank/'+base+revoked.id+'/evaluate',{event_id:'synthetic-crank-denied',sequence:1,input:{}},h.owner)).status,401);
  assert.deepEqual(requests,[]);assert.deepEqual((await h.get('workflow-runs?workflow='+workflow.id,await h.independentStarter())).runs,[]);
  const probe=await harness(target,{edge,comparisonDispatchProbe:true});try {
   const fixture=await shadowFixture(probe,target),comparison=await fixture.create('synthetic-crank-probe');
   const refusal=await probe.send('/api/crank/'+base+comparison.id+'/evaluate',{event_id:'synthetic-crank-dispatch-probe',sequence:1,input:shadowInput(1)},probe.owner);
   assert.equal(refusal.status,400);assert.match(refusal.value.error,/Comparison cannot dispatch|comparison cannot dispatch/);
   assert.equal((await probe.get(base+comparison.id)).events.length,0,'transport refusal retains no fabricated result');assert.deepEqual(requests,[]);
  }finally{await probe.close()}

 } finally {await h.close()}
}
