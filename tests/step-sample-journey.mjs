import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse} from './kit.mjs';
import {archive,inventory} from './restore-journey.mjs';
const rows=(text,table)=>inventory(text).map(JSON.parse).filter(record=>record.table===table).map(record=>record.row);

/** One builder journey: isolate a write, review a live effect, read it and map its response. */
export async function stepSampleJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(), effects=[], records=new Map();
 edge.routes.set('samples.example',({method,headers,body,url})=>{
  const account=headers.authorization;
  if(method==='GET')return jsonResponse({items:(records.get(account)??[]).filter(record=>record.id===new URL(url).searchParams.get('id'))});
  const record={id:'synthetic-crank-contact-'+(effects.length+1),...JSON.parse(body)};
  effects.push({account,record});records.set(account,[...(records.get(account)??[]),record]);return jsonResponse(record,201);
 });
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const productionToken=fakeSecret('synthetic-crank-production'),sandboxToken=fakeSecret('synthetic-crank-sandbox');
  const production=await connection(h,{app:'http',auth_kind:'bearer',label:'Contact account',account_name:'Synthetic Crank production',domains:['samples.example'],secret:{token:productionToken}});
  const sandbox=await connection(h,{app:'http',auth_kind:'bearer',label:'Contact test account',account_name:'Synthetic Crank sandbox',domains:['samples.example'],secret:{token:sandboxToken}});
  await h.post(`connections/${sandbox.id}/purpose`,{purpose:'test'});
  const graph={trigger:{type:'webhook'},steps:[
   {id:'format',type:'map',input:{name:'{{trigger.body.name}}'}},
   {id:'create',type:'http',connection_id:production.id,input:{method:'POST',url:'https://samples.example/contacts',body:{name:'{{steps.format.name}}'}}},
   {id:'lookup',type:'http',connection_id:production.id,input:{method:'GET',url:'https://samples.example/contacts',query:{id:'{{steps.create.body.id}}'}}},
   {id:'mapped',type:'map',input:{contact_id:'{{steps.lookup.body.items[0].id}}',name:'{{steps.lookup.body.items[0].name}}'}},
   {id:'notify',type:'http',input:{method:'POST',url:'https://samples.example/notify',body:{contact:'{{steps.mapped.contact_id}}'}}},
  ]};
  const w=await h.post('workflows',{name:'Isolated contact step tests',graph},h.owner,201),base=`workflows/${w.id}`;
  const published=await h.post(base+'/publish',{},h.owner,201);
  await h.post(base+'/pause');
  await h.post('data'+'/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['name']});
  await h.post(base+'/resume');
  const saved=await h.post(base+'/samples',{sample:{body:{name:'synthetic-crank-private-lead'}}},h.owner,201),trigger=saved.samples.find(sample=>sample.selected);
  const test=(step,binding,expected=201)=>h.post(base+'/test',{step_path:step,bindings:{[production.id]:binding}},h.owner,expected);
  await test('lookup',production.id,422); // No earlier create output and no hidden write.
  await h.post(base+'/test',{step_path:'create',bindings:{}},h.owner,422);
  assert.equal(edge.requests.length,0);
  const manualOutput=await h.post(base+'/samples',{step_path:'create',sample:{body:{id:'synthetic-crank-absent'}}},h.owner,201);
  const untouched=await test('lookup',production.id);
  assert.equal(untouched.status,'succeeded');assert.deepEqual(untouched.steps.find(step=>step.path==='lookup').output.body.items,[]);assert.equal(effects.length,0);
  assert.ok((await h.post(base+'/validate',{})).warnings.includes('Step create relies on a schema sample; not tested'),'substituting a saved response does not claim the app step was tested');
  await h.post(base+'/samples/delete',{sample_id:manualOutput.samples.find(sample=>sample.selected&&sample.step_path==='create').id});
  const isolated=await test('create',sandbox.id);
  assert.equal(isolated.status,'succeeded');assert.equal(isolated.mode,'test');assert.equal(isolated.version.declared.sample_source,'manual sample');
  assert.deepEqual(isolated.steps.map(step=>step.path).sort(),['create','format']);assert.equal(effects.length,1);
  assert.equal(records.get('Bearer '+productionToken),undefined);
  assert.equal(records.get('Bearer '+sandboxToken)[0].name,'synthetic-crank-private-lead');
  let samples=(await h.get(base+'/samples')).samples;
  let output=samples.find(sample=>sample.selected&&sample.step_path==='create');
  assert.equal(output.source_id,isolated.id);assert.equal(output.payload.body.id,effects[0].record.id);assert.match(output.label,/action response from test/);
  assert.ok((await h.post(base+'/preview',{})).sample_source.includes(isolated.id));
  const live=await test('create',production.id);
  assert.equal(live.status,'awaiting_approval');assert.equal(effects.length,1);
  const confirmation=live.waits.find(wait=>wait.path==='create');
  assert.equal(confirmation.proposal.account.id,production.id);assert.equal(confirmation.proposal.account.name,'Synthetic Crank production');
  assert.equal(confirmation.proposal.input.method,'POST');assert.deepEqual(confirmation.proposal.input.body,{name:'synthetic-crank-private-lead'});
  await inspect({h,w,state:'step-confirmation',run:live,step:'create'});
  await h.post(`workflow-runs/${live.id}/approve`,{path:'create',digest:'stale'},h.owner,409);
  await h.restart();
  const completed=await h.post(`workflow-runs/${live.id}/approve`,{path:'create',digest:confirmation.proposal_digest});
  assert.equal(completed.status,'succeeded');assert.equal(effects.length,2);
  output=(await h.get(base+'/samples')).samples.find(sample=>sample.selected&&sample.step_path==='create');
  assert.equal(output.source_id,completed.id);assert.deepEqual(output.payload,completed.steps.find(step=>step.path==='create').output);
  assert.equal((await h.get(base+'/samples')).samples.filter(sample=>sample.source_id===completed.id).length,1,'the resumed target publishes one response, not the frozen prefix maps');
  const searched=await test('lookup',production.id);
  assert.equal(searched.status,'succeeded');assert.equal(searched.waits.length,0);assert.equal(effects.length,2,'a read test never repeats the create');
  assert.deepEqual(searched.steps.find(step=>step.path==='lookup').output.body.items,[effects[1].record]);
  const preview=await h.post(base+'/preview',{});
  assert.deepEqual(preview.steps.find(step=>step.path==='mapped').output,{contact_id:effects[1].record.id,name:'synthetic-crank-private-lead'});
  assert.equal(preview.steps.at(-1).outcome,'not run in preview');assert.equal(effects.length,2);
  assert.ok(preview.sample_source.includes(completed.id)&&preview.sample_source.includes(searched.id));
  await inspect({h,w,state:'step-response',run:searched,step:'lookup',sample:output});
  const audit=await h.get(`audit?kind=run&id=${searched.id}`);
  assert.ok(audit.some(entry=>entry.action==='workflow.test'&&entry.detail.mode==='test'&&entry.detail.sample_source.includes(completed.id)));
  assert.equal((await h.get(base+'/today')).runs,0);
  assert.equal((await h.get(base)).published_version_id,published.version.id);
  const exported=await archive(h);
  const retainedOutputs=rows(exported,'crank_workflow_samples').filter(sample=>sample.source==='history');
  assert.ok(retainedOutputs.length>0&&retainedOutputs.every(sample=>JSON.parse(sample.payload_json).sealed==='crank-payload-v1'));
  const subject=await h.post('data'+'/subject',{subject:'synthetic-crank-private-lead'});
  assert.ok(subject.workflow_runs.some(run=>run.id===completed.id)&&subject.workflow_runs.some(run=>run.id===searched.id));
  assert.deepEqual(subject.sealed_unmatched,[]);
  assert.equal(rows(exported,'crank_usage_spend').length,0);assert.equal(rows(exported,'crank_notices').length,0);
  for(const version of rows(exported,'crank_workflow_versions'))assert.equal(version.graph_json.includes('synthetic-crank-private-lead'),false,'sample values stay out of unsealed graph metadata');
  const receiving=await harness('http://127.0.0.1:9',{edge:edge.edge});
  try {
   await receiving.post('data'+'/restore',{archive:exported,confirm:'RESTORE'});
   assert.deepEqual(rows(await archive(receiving),'crank_workflow_samples'),rows(exported,'crank_workflow_samples'));
   assert.ok((await receiving.get(base+'/samples')).samples.every(sample=>!sample.selected));
   await receiving.post(base+'/test',{step_path:'create',bindings:{[production.id]:production.id}},receiving.owner,409);
  } finally {await receiving.close()}
  // A later revoked account cannot complete a waiting test or replace its saved response.
  const waiting=await test('create',production.id),before=effects.length;
  await h.post(`connections/${production.id}/revoke`);
  const refused=await h.post(`workflow-runs/${waiting.id}/approve`,{path:'create',digest:waiting.waits[0].proposal_digest});
  assert.equal(refused.status,'paused');assert.equal(effects.length,before);
  assert.equal((await h.get(base+'/samples')).samples.some(sample=>sample.source_id===waiting.id),false);
  // Schema changes retain the old output and name missing downstream fields until reloaded.
  const custom=version=>({trigger:{type:'manual'},steps:[{id:'source',type:'custom.request',connector_id:'synthetic-crank-schema',connector_version:version,operation:'read'},{id:'map',type:'map',input:{name:'{{steps.source.new_field}}'}}]});
  const schemaWorkflow=await h.post('workflows',{name:'Versioned source sample',graph:custom(1)},h.owner,201),schemaBase=`workflows/${schemaWorkflow.id}`;
  await h.post(schemaBase+'/samples',{sample:{input:{}}},h.owner,201);
  await h.post(schemaBase+'/samples',{step_path:'source',sample:{name:'synthetic-crank-schema-value'}},h.owner,201);
  await h.post(schemaBase+'/draft',{graph:custom(2)});
  const warnings=(await h.post(schemaBase+'/validate',{})).warnings;
  assert.ok(warnings.includes('Stale sample for step source: connector schema changed; reload the sample'));
  assert.ok(warnings.includes('Stale sample for step source: missing fields steps.source.new_field'));
  await h.post(schemaBase+'/samples',{step_path:'source',sample:{new_field:'synthetic-crank-fresh-value'}},h.owner,201);
  const fresh=await h.get(schemaBase+'/samples');assert.equal(fresh.warnings.some(warning=>warning.includes('Stale sample for step source')),false);
  assert.deepEqual((await h.post(schemaBase+'/preview',{})).steps.at(-1).output,{name:'synthetic-crank-fresh-value'});
  const gated={...graph,steps:[{id:'gate',type:'approval',input:{name:'{{trigger.body.name}}'}},...graph.steps]};
  await h.post(base+'/draft',{graph:gated});
  await h.post(base+'/samples',{step_path:'gate',sample:{approved:true}},h.owner,201);
  await test('create',sandbox.id,422);assert.equal(effects.length,before,'a saved output cannot stand in for a preceding approval');
  await h.post(base+'/pause');await h.post('data'+'/erase',{workflow_run_id:completed.id,confirm:'ERASE'});
  assert.equal((await h.get(base+'/samples')).samples.some(sample=>sample.source_id===completed.id),false);
  await h.post(base+'/samples',{source:'history',run_id:completed.id,step_path:'create'},h.owner,404);
  assert.equal(trigger.source,'manual');
 } finally {await h.close()}
}
