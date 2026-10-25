import assert from 'node:assert/strict';
import {jsonResponse,startRun,stepOf} from './kit.mjs';

export async function gustoReconciliationJourney({h,fake,bound,company,consent,sandboxPublish,inspect}) {
 const subject='synthetic-crank-reconcile@example.test';
 const upstream=fake.routes.get('api.gusto-demo.com');let lost=false,mode='one',before=0,after=0;
 fake.routes.set('synthetic-crank-checkpoint.example',()=>{before++;return jsonResponse({id:'synthetic-crank-retained'})});
 fake.routes.set('synthetic-crank-continuation.example',()=>{after++;return jsonResponse({id:'synthetic-crank-continued'})});
 fake.routes.set('api.gusto-demo.com',async request=>{
  const response=await upstream(request);
  if(request.method==='POST' && request.url.pathname.endsWith('/contractors') && !lost){lost=true;return jsonResponse({},503)}
  if(request.method==='GET' && request.url.pathname.endsWith('/contractors')){
   const all=await response.json(),matching=all.filter(r=>r.last_name==='Reconciled contractor');
   const rows=mode==='zero'?[]:mode==='multiple'?[...all,{...matching[0],uuid:'synthetic-crank-duplicate'}]:all;
   return jsonResponse(rows,200,{'x-page':'1','x-total-pages':'1','x-total-count':String(rows.length),'x-per-page':'100'});
  }
  return response;
 });
 try {
  await consent('contractor_1099_handoff');
  const workflow=await sandboxPublish(h,'Synthetic regulated lost write and exact continuation',{trigger:{type:'manual'},steps:[
   {id:'earlier',type:'http',input:{url:'https://synthetic-crank-checkpoint.example/retained'}},
   {id:'handoff',type:'gusto.contractor_1099_handoff',connection_id:bound.id,input:{company_id:company,currency:'USD',ach_reference:'synthetic-crank-reconcile',data:{type:'Individual',wage_type:'Fixed',first_name:'Synthetic',last_name:'Reconciled contractor',email:'{{trigger.input.email}}',file_new_hire_report:false}}},
   {id:'later',type:'http',input:{url:'https://synthetic-crank-continuation.example/finish',query:{worker:'{{steps.handoff.provider_id}}'}}},
  ]});
  await h.post(`workflows/${workflow.id}/pause`);
  await h.post('data/classes',{workflow_id:workflow.id,data_class:'financial',identifier_fields:['email']});
  await h.post('data/attestations',{data_class:'financial',agreements:['Synthetic financial acceptance data handling'],data_location:'Owned test D1',confirm:'ATTEST'},h.owner,201);
  await h.post(`workflows/${workflow.id}/resume`);
  const inventory=JSON.stringify(await h.get('data/flows'));assert.ok(inventory.includes('https://api.gusto-demo.com'));assert.ok(inventory.includes('data.email'));assert.ok(!inventory.includes(subject));
  const writeCount=()=>fake.requests.filter(r=>r.method==='POST' && r.url.pathname.endsWith('/contractors')).length,prior=writeCount();
  const run=await startRun(h,workflow,{email:subject});assert.equal(run.status,'uncertain');assert.equal(before,1);assert.equal(after,0);
  const identity=stepOf(run,'handoff').operation_key;assert.ok(identity);
  await h.restart();mode='zero';
  const door=`workflow-runs/${run.id}/reconcile`,preview=()=>h.get(door+'?path=handoff');
  assert.equal((await preview()).matches.length,0);assert.equal(writeCount(),prior+1);
  mode='multiple';const multiple=await preview();assert.equal(multiple.matches.length,2);
  await h.post(door,{path:'handoff',digest:multiple.digest,remote_id:'synthetic-crank-unconfirmed',reason:'Synthetic unmatched record refused'},h.owner,422);
  mode='one';const one=await preview();assert.equal(one.matches.length,1);
  await h.post(door,{path:'handoff',digest:multiple.digest,remote_id:one.matches[0].Id,reason:'Synthetic stale readback refused'},h.owner,409);
  await consent('contractor_1099_handoff',{consent:false});
  const revoked=await h.send('/api/crank/'+door,{path:'handoff',digest:one.digest,remote_id:one.matches[0].Id,reason:'Synthetic withdrawn authority refused'},h.owner);
  assert.equal(revoked.status,422);assert.match(revoked.text,/consent|agreement/i);
  assert.equal((await h.get('workflow-runs/'+run.id)).status,'uncertain');
  await consent('contractor_1099_handoff');
  await h.post(door,{path:'handoff',digest:one.digest,remote_id:one.matches[0].Id,reason:'Synthetic old authority review refused'},h.owner,409);
  const current=await preview();
  const viaUi=inspect && await inspect({h,bound,company,run,state:'gusto-uncertain',preview:current});
  const done=viaUi?await h.get('workflow-runs/'+run.id):await h.post(door,{path:'handoff',digest:current.digest,remote_id:current.matches[0].Id,reason:'Confirmed original provider worker after acknowledgement loss'});
  assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(before,1);assert.equal(after,1);assert.equal(writeCount(),prior+1);
  assert.deepEqual(stepOf(done,'earlier').output,stepOf(run,'earlier').output);assert.equal(stepOf(done,'handoff').operation_key,identity);
  assert.equal(stepOf(done,'handoff').output.provider_id,current.matches[0].Id);assert.equal(stepOf(done,'handoff').trace.reconciliation.provider_id,current.matches[0].Id);
  await h.post(door,{path:'handoff',digest:current.digest,remote_id:current.matches[0].Id,reason:'Synthetic repeated decision refused'},h.owner,409);
  assert.equal(after,1);assert.equal(writeCount(),prior+1);
  if(inspect)await inspect({h,bound,company,run:done,state:'gusto-reconciled'});
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);assert.ok(!archive.text.includes(subject),'regulated financial input, output and decision remain sealed in portability');
  await h.post(`workflows/${workflow.id}/pause`);
  const erased=await h.post('data/subject',{subject});assert.deepEqual(erased.workflow_runs.map(r=>r.id),[run.id]);assert.equal(erased.blocked,false);
  await h.post('data/erase',{subject,confirm:'ERASE',digest:erased.digest});await h.get('workflow-runs/'+run.id,h.owner,404);
  assert.equal(writeCount(),prior+1,'local erasure never repeats or deletes the provider effect');
 } finally {fake.routes.set('api.gusto-demo.com',upstream)}
}
