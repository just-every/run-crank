import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {door,doorPlan,doorImport,deliver,settled} from './kit.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {graphExport} from './n8n-graph-fixture.mjs';

/** Synthetic version-2 JSON source, shared with the installed-screen proof. */
export function arithmeticExport(target,id='synthetic-crank-date-arithmetic',parameters={}) {
 const source=graphExport(target,id);source.name='Synthetic date arithmetic '+id;
 source.settings.timezone='America'+'/'+'Chicago';
 source.nodes=source.nodes.slice(0,3).concat(source.nodes[4]);
 source.nodes[1].parameters={assignments:{assignments:[
  {id:'synthetic-crank-801',name:'date',type:'string',value:'={{ $json.body.date }}'},
  {id:'synthetic-crank-802',name:'label',type:'string',value:'synthetic-crank-803'},
  {id:'synthetic-crank-804',name:'due',type:'string',value:'synthetic-crank-overwritten'},
  {id:'synthetic-crank-805',name:'nested',type:'object',value:{values:[1,null,'synthetic-crank-806']}},
 ]},options:{}};
 Object.assign(source.nodes[2],{type:'n8n-nodes-base.dateTime',typeVersion:2,parameters:{operation:'addToDate',magnitude:'={{ $json.date }}',duration:1,timeUnit:'months',outputFieldName:'due',options:{includeInputFields:true},...parameters}});
 source.connections={n0:{main:[[{node:'n1',type:'main',index:0}]]},n1:{main:[[{node:'n2',type:'main',index:0}]]},n2:{main:[[{node:'n4',type:'main',index:0}]]}};
 source.nodes[3].parameters.url=target+'/date-arithmetic';
 return source;
}

/** Review and apply are inert; exact calendar results are read at the destination. */
export async function n8nDateTimeJourney() {
 const target='https://receiver.example',writes=[];
 const edge=async request=>{if(new URL(request.url).origin!==target)return undefined;const body=await request.json();writes.push(body);return Response.json({stored:body})};
 const h=await harness(target,{edge});
 try {
  const cases=[
   ['addToDate',1,'months','2024-01-31T18:05:06.123Z','2024-02-29T12:05:06.123-06:00',true],
   ['subtractFromDate',1,'months','2024-03-31T17:05:06Z','2024-02-29T12:05:06.000-06:00',false],
   ['addToDate',1,'years','2024-02-29T18:00:00Z','2025-02-28T12:00:00.000-06:00',true],
   ['subtractFromDate',1,'years','2024-02-29T12:00:00-06:00','2023-02-28T12:00:00.000-06:00',false],
   ['addToDate',1,'days','2026-03-07T12:00:00-06:00','2026-03-08T12:00:00.000-05:00',true],
   ['subtractFromDate',1,'days','2026-03-08T12:00:00-05:00','2026-03-07T12:00:00.000-06:00',false],
   ['addToDate',24,'hours','2026-03-07T12:00:00-06:00','2026-03-08T13:00:00.000-05:00',true],
   ['subtractFromDate',24,'hours','2026-11-01T12:00:00-06:00','2026-10-31T13:00:00.000-05:00',false],
   ['addToDate',1,'weeks','2026-10-25T12:00:00-05:00','2026-11-01T12:00:00.000-06:00',true],
   ['subtractFromDate',1,'weeks','2026-11-01T12:00:00-06:00','2026-10-25T12:00:00.000-05:00',false],
   ['addToDate',1,'days','2026-03-07T02:30:00-06:00','2026-03-08T03:30:00.000-05:00',false],
   ['addToDate',90,'minutes','2026-03-08T01:30:00-06:00','2026-03-08T04:00:00.000-05:00',false],
   ['subtractFromDate',90,'minutes','2026-03-08T04:00:00-05:00','2026-03-08T01:30:00.000-06:00',true],
   ['addToDate',1,'seconds','2026-01-01T23:59:59.999-06:00','2026-01-02T00:00:00.999-06:00',false],
   ['subtractFromDate',1,'seconds','2026-01-02T00:00:00.001-06:00','2026-01-01T23:59:59.001-06:00',true],
   ['addToDate',-1,'months','2024-03-31T12:00:00-05:00','2024-02-29T12:00:00.000-06:00',false],
   ['subtractFromDate',1,'days','2026-11-02T01:30:00-06:00','2026-11-01T01:30:00.000-06:00',false],
   ['addToDate',1,'days','2026-10-31T01:30:00-05:00','2026-11-01T01:30:00.000-05:00',false],
   ['addToDate',0,'days','2026-11-01T01:30:00-06:00','2026-11-01T01:30:00.000-06:00',true],
   ['addToDate',1,'months','2024-01-31T18:05:06.123Z','2024-02-29T18:05:06.123Z',false,'UTC'],
   ['subtractFromDate',1,'months','2024-03-31T18:05:06Z','2024-02-29T18:05:06.000+00:00',false,'Etc'+'/'+'UTC'],
  ];
  const bySettings=new Map(),sources=[],caseSources=cases.map(([operation,duration,timeUnit,,,includeInputFields,timezone],index)=>{
   const key=JSON.stringify([operation,duration,timeUnit,includeInputFields,timezone]);if(bySettings.has(key))return bySettings.get(key);
   const source=arithmeticExport(target,'synthetic-crank-'+(810+index),{operation,duration,timeUnit,options:{includeInputFields}});if(timezone)source.settings.timezone=timezone;bySettings.set(key,source);sources.push(source);return source;
  });
  const defaults=arithmeticExport(target,'synthetic-crank-850',{options:{}});delete defaults.nodes[2].parameters.outputFieldName;delete defaults.nodes[2].parameters.duration;delete defaults.nodes[2].parameters.timeUnit;
  sources.push(defaults);caseSources.push(defaults);
  for(const change of [
   s=>s.nodes[2].typeVersion=1,s=>s.nodes[2].typeVersion=2.1,
   s=>s.nodes[2].parameters.duration='={{ $json.duration }}',s=>s.nodes[2].parameters.duration='1',
   s=>s.nodes[2].parameters.duration=0.5,s=>s.nodes[2].parameters.duration=10001,
   s=>s.nodes[2].parameters.duration=null,s=>s.nodes[2].parameters.timeUnit=null,s=>s.nodes[2].parameters.options=null,
   s=>s.nodes[2].parameters.timeUnit='quarters',s=>s.nodes[2].parameters.timeUnit='business_days',s=>s.nodes[2].parameters.timeUnit='milliseconds',
   s=>s.nodes[2].parameters.options.timezone=true,s=>s.nodes[2].parameters.options.fromFormat='MM-dd-yyyy',
   s=>s.nodes[2].parameters.options.includeInputFields='false',s=>s.nodes[2].parameters.options.unknown=true,
   s=>s.nodes[2].parameters.outputFieldName='nested.due',s=>s.nodes[2].parameters.outputFieldName='__proto__',
   s=>delete s.settings.timezone,s=>s.settings.timezone='synthetic-crank-invalid',
   s=>s.nodes[2].parameters.operation='roundDate',s=>s.nodes[2].parameters.magnitude='={{ globalThis.crankInjected = 1 }}',
  ]) {
   const source=structuredClone(sources[0]);change(source);const plan=await doorPlan(h,JSON.stringify(source));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,1,'inexact settings must stay manual');assert.ok(plan.value.diagnostics.some(row=>row.message?.includes('Manual conversion')));await door(h,'undo',{planId:plan.value.planId});
  }
  assert.deepEqual(await h.get('workflows'),[]);assert.deepEqual(writes,[],'review must not dispatch');
  const plan=await doorImport(h,JSON.stringify(sources));assert.equal(plan.rejected.length,0);
  assert.equal((await door(h,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint})).value.job.state,'completed');
  const workflows=await h.get('workflows');assert.equal(workflows.length,sources.length,'repeated apply must retain exactly one draft per source');
  for(const workflow of workflows){const detail=await h.get('workflows/'+workflow.id);assert.equal(detail.status,'draft');assert.deepEqual(detail.versions,[]);assert.deepEqual(detail.hooks,[])}
  await h.restart();
  let firstHook;
  const hooks=new Map();for(const source of sources){const workflow=workflows.find(row=>row.name===source.name);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);hooks.set(source.id,await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201))}
  for(const [index,source]of caseSources.entries()) {
   const hook=hooks.get(source.id);firstHook??=hook;
   const item=cases[index],date=item?.[3]??'2026-03-08T18:00:00Z',expected=item?.[4]??'2026-03-08T13:00:00.000-05:00';
   const expectedBody=item?.[5]?{date,label:'synthetic-crank-803',due:expected,nested:{values:[1,null,'synthetic-crank-806']}}:{[index===cases.length?'newDate':'due']:expected};
   const before=writes.length,admitted=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({date})});assert.equal(admitted.status,200,admitted.text);const run=await settled(h,admitted.value.run_id);
   assert.equal(run.status,'succeeded',JSON.stringify({index,error:run.error}));assert.equal(writes.length,before+1);assert.deepEqual(writes.at(-1),expectedBody,'complete destination payload must preserve source output and retention semantics');assert.deepEqual(run.steps.find(step=>step.step_id==='n3').output.body,{stored:expectedBody},'destination readback must match');assert.deepEqual(run.steps.find(step=>step.step_id==='n2').output,expectedBody);
  }
  await h.restart();
  for(const date of ['2026-02-30T12:00:00Z','2026-01-01T25:00:00Z','2026-01-01T12:00:00+25:00','2026-03-08T12:00:00','03-08-2026','synthetic-crank-invalid','',null]) {
   const before=writes.length,sent=await deliver(h,firstHook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({date})});const run=await settled(h,sent.value.run_id);assert.equal(run.status,'failed');assert.ok(['validation','type_mismatch'].includes(run.error.category));assert.equal(writes.length,before,'invalid date must produce no destination write');assert.ok(!run.steps.some(step=>step.step_id==='n3'&&step.status==='succeeded'));
  }
  const saved=await archive(h),original=inventory(saved),count=writes.length,restored=await harness(target,{edge});
  try {
   await restored.post('data'+'/restore',{archive:saved,confirm:'RESTORE'});const receiving=inventory(await archive(restored));assert.deepEqual(original.filter(row=>!receiving.includes(row)),[],'all portable records survive intact');assert.deepEqual(receiving.filter(row=>!original.includes(row)).map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
   for(const workflow of workflows){const detail=await restored.get('workflows/'+workflow.id);assert.equal(detail.status,'paused');assert.deepEqual(detail.draft,(await h.get('workflows/'+workflow.id)).draft);assert.ok(detail.hooks.every(row=>row.status!=='active'))}
   await restored.tick();const refused=await deliver(restored,firstHook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({date:'2024-01-31T18:05:06.123Z'})});assert.ok(refused.status>=400);assert.equal(writes.length,count,'restoration must remain inactive');
  } finally {await restored.close()}
 } finally {await h.close()}
}
