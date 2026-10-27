import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {deliver,hookUrl,publish,fakeEdge,jsonResponse,settled} from './kit.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';

const graph=()=>({trigger:{type:'webhook',dedup:{key:'body.event',window_minutes:1440}},steps:[
 {id:'mapped',type:'map',input:{utm:'{{trigger.body.utm}}',email:'{{trigger.body.email}}'}},
 {id:'upper',type:'transform',fn:'text.case',input:{value:'{{steps.mapped.utm}}',to:'upper'}},
 {id:'qualify',type:'filter',when:[[{field:'trigger.body.email',op:'text.ends_with',value:'.test'}]]},
 {id:'notify',type:'http',input:{method:'POST',url:'https://crm.example/contacts',body:{utm:'{{steps.upper}}'}}}
]});
const portable=(text,table)=>inventory(text).map(JSON.parse).filter(row=>row.table===table).map(({row})=>row);
const checkpoints=text=>inventory(text).map(JSON.parse).filter(row=>['crank_wf_runs','crank_seen_items','crank_polls','crank_trigger_events','crank_usage_spend','crank_notices'].includes(row.table));
export async function sampleJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge();edge.routes.set('crm.example',()=>jsonResponse({id:'synthetic-crank-contact'}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const w=await h.post('workflows',{name:'Retained lead samples',graph:graph()},h.owner,201),base=`workflows/${w.id}`;
  const productionUrl=await hookUrl(h,w);
  assert.equal((await deliver(h,productionUrl,{method:'POST',body:'event=synthetic-crank-1',headers:{'content-type':'application'+'/x-www-form-urlencoded'}})).status,404);
  const before=checkpoints(await archive(h));
  let listener=await h.post(base+'/samples/listen',{},h.owner,201);
  await inspect({h,w,state:'waiting',listener});
  assert.equal((await deliver(h,listener.url,{method:'GET'})).status,405);
  const captured=await deliver(h,listener.url+'?campaign=autumn&tag=one&tag=two',{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded','x-sample-label':'synthetic-crank-1','authorization':'synthetic-crank-private','x-api-key':'synthetic-crank-private'},body:'event=synthetic-crank-1&email=lead%40example.test&utm=hidden-value&answer=one&answer=two'});
  assert.equal(captured.status,201,captured.text);
  assert.deepEqual(captured.value,{captured:true,sample_id:captured.value.sample_id});
  assert.equal((await deliver(h,listener.url,{method:'POST',body:'event=again'})).status,404);
  const state=await h.get(base+'/samples'),sample=state.samples.find(s=>s.id===captured.value.sample_id);
  assert.equal(sample.source,'webhook');assert.equal(sample.selected,true);assert.equal(sample.tested,false);
  assert.deepEqual(sample.payload.body,{event:'synthetic-crank-1',email:'lead@example.test',utm:'hidden-value',answer:['one','two']});
  assert.deepEqual(sample.payload.query,{campaign:'autumn',tag:['one','two']});assert.deepEqual(sample.payload.files,{});
  assert.equal(sample.payload.raw,'event=synthetic-crank-1&email=lead%40example.test&utm=hidden-value&answer=one&answer=two');
  assert.equal(sample.payload.method,'POST');assert.equal(sample.payload.headers['x-sample-label'],'synthetic-crank-1');
  assert.equal(sample.payload.headers.authorization,undefined);assert.equal(sample.payload.headers['x-api-key'],undefined);
  const preview=await h.post(base+'/preview',{});
  assert.equal(preview.source.id,sample.id);assert.equal(preview.source.source,'webhook');
  assert.deepEqual(preview.steps.map(s=>s.path),['mapped','upper','qualify','notify']);
  assert.deepEqual(preview.steps[0].output,{utm:'hidden-value',email:'lead@example.test'});assert.equal(preview.steps[1].output,'HIDDEN-VALUE');assert.equal(preview.steps[2].pass,true);assert.equal(preview.steps[3].outcome,'not run in preview');
  assert.ok(preview.steps.every(step=>step.source.id===sample.id));assert.equal(edge.requests.length,0);
  assert.deepEqual(checkpoints(await archive(h)),before,'capture and previews change no production admission, dedup, polling, usage or notice records');
  await inspect({h,w,state:'captured',sample,preview});
  listener=await h.post(base+'/samples/listen',{},h.owner,201);
  const multipart=new FormData();multipart.set('event','synthetic-crank-2');multipart.set('email','file@example.test');multipart.set('utm','file-source');multipart.set('attachment',new File(['retained file bytes'],'lead.txt',{type:'text'+'/plain'}));
  const upload=await deliver(h,listener.url,{method:'POST',body:multipart});assert.equal(upload.status,201,upload.text);
  const fileSample=(await h.get(base+'/samples')).samples.find(s=>s.id===upload.value.sample_id);
  assert.equal(fileSample.payload.files.attachment.name,'lead.txt');assert.equal(fileSample.payload.files.attachment.type,'text'+'/plain');assert.equal(fileSample.payload.files.attachment.size,19);assert.match(fileSample.payload.files.attachment.sha256,/^[a-f0-9]{64}$/);
  const stored=portable(await archive(h),'crank_workflow_samples').find(s=>s.id===fileSample.id);
  assert.equal(Buffer.from(JSON.parse(stored.uploads_json)[0].content_base64,'base64').toString(),'retained file bytes');
  const stale=await h.post(base+'/samples/fields',{fields:['body.email','body.utm','body.new_question']});
  assert.ok(stale.warnings.some(w=>w==='Stale sample: missing fields body.new_question'));
  const validation=await h.post(base+'/validate',{});assert.ok(validation.warnings.some(w=>w.includes('body.new_question')));assert.ok(validation.warnings.some(w=>w.includes('Step notify')&&w.includes('schema sample')));
  await inspect({h,w,state:'stale'});
  const manual=await h.post(base+'/samples',{sample:{body:{email:'manual@example.test',utm:'manual-source',new_question:'yes'}}},h.owner,201);
  const manualId=manual.samples.find(s=>s.source==='manual').id;
  const manualPreview=await h.post(base+'/preview',{sample_id:manualId});assert.equal(manualPreview.sample_source,'manual sample');assert.equal(manualPreview.steps[1].output,'MANUAL-SOURCE');
  assert.equal((await h.get(base+'/samples')).warnings.some(w=>w.includes('Stale sample')),false);
  await inspect({h,w,state:'manual',sample:manual.samples.find(s=>s.id===manualId),preview:manualPreview});
  const schema=await h.post(base+'/samples',{source:'schema',step_path:'notify',sample:{contact_id:'synthetic-crank-schema'}},h.owner,201);
  assert.equal(schema.samples.find(s=>s.source==='schema').tested,false);assert.match(schema.samples.find(s=>s.source==='schema').label,/not tested/);
  await h.post(base+'/samples/select',{sample_id:sample.id});
  const publication=await h.post(base+'/publish',{},h.owner,201);assert.ok(publication.warnings.some(w=>w.includes('Step notify')&&w.includes('not tested')));
  // A captured event has not spent its production dedup identity.
  const real=await deliver(h,productionUrl,{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded'},body:'event=synthetic-crank-1&email=lead%40example.test&utm=hidden-value'});
  assert.equal(real.status,200,real.text);assert.equal(real.value.accepted,true);
  const run=await settled(h,real.value.run_id);assert.equal(run.mode,'production');assert.equal(edge.requests.length,1);
  const history=await h.post(base+'/samples',{source:'history',run_id:run.id},h.owner,201);
  const chosen=history.samples.find(s=>s.source==='history');assert.equal(chosen.source_id,run.id);assert.equal(chosen.source_time,run.received_at);assert.deepEqual(chosen.payload,run.trigger);
  const historicalPreview=await h.post(base+'/preview',{});assert.equal(historicalPreview.source.source_id,run.id);assert.match(historicalPreview.sample_source,new RegExp(run.id));assert.equal(historicalPreview.steps[1].output,'HIDDEN-VALUE');
  await inspect({h,w,state:'history',sample:chosen,preview:historicalPreview});
  const invited=await h.send('/auth/invite',{email:'sample-reader@example.test',displayName:'Sample reader',role:'member'},h.owner);assert.equal(invited.status,202);
  const token=new URL(h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
  const reader=(await h.send('/auth/confirm',{token})).cookie;
  assert.equal((await h.get('workflow-runs/'+run.id,reader)).payload,'restricted');
  await h.get(base+'/samples',reader,403);await h.post(base+'/samples',{source:'history',run_id:run.id},reader,403);await h.post(base+'/preview',{sample_id:chosen.id},reader,403);
  assert.equal(edge.requests.length,1);
  const foreign=await h.post('workflows',{name:'Other sample workflow',graph:graph()},h.owner,201);
  await h.post(`workflows/${foreign.id}/samples`,{source:'history',run_id:run.id},h.owner,422);
  await h.post(`workflows/${foreign.id}/preview`,{sample_id:chosen.id},h.owner,422);
  const outstanding=await h.post(base+'/samples/listen',{},h.owner,201);
  const exported=await archive(h),receiving=await harness('http://127.0.0.1:9',{edge:edge.edge});
  try {
   assert.equal(portable(exported,'crank_sample_listeners').length,0);
   const oldTime='2026-10-24T12:00:00.000Z';
   const earlier=await rewritten(exported,(table,row)=>{if(table==='crank_wf_runs'&&row.id===run.id)row.received_at=oldTime});
   await receiving.post('data'+'/restore',{archive:earlier,confirm:'RESTORE'});
   const restored=await archive(receiving);
   assert.deepEqual(portable(restored,'crank_workflow_samples'),portable(exported,'crank_workflow_samples'));
   assert.deepEqual(portable(restored,'crank_sample_fields'),portable(exported,'crank_sample_fields'));
   assert.ok((await receiving.get(base+'/samples')).samples.every(s=>!s.selected));
   await receiving.post(base+'/samples/select',{sample_id:chosen.id},receiving.owner,409);
   await receiving.post(base+'/samples/listen',{},receiving.owner,409);
   assert.equal((await deliver(receiving,outstanding.url.replace(h.origin,receiving.origin),{method:'POST',body:'event=restored'})).status,404);
   assert.equal((await receiving.get(base)).status,'paused');
   const review=(await receiving.get(base)).restore;
   await receiving.post(base+'/publish',{restore_snapshot:review.snapshot,restore_decisions:{}},receiving.owner,201);
   const oldHistory=await receiving.post(base+'/samples',{source:'history',run_id:run.id},receiving.owner,201);
   assert.equal(oldHistory.samples.find(s=>s.selected&&s.step_path==='trigger').source_time,oldTime);
   assert.equal((await receiving.post(base+'/preview',{})).source.source_id,run.id);
  } finally {await receiving.close()}
  const hold=await h.post('data'+'/holds',{kind:'workflow',workflow_id:w.id,reason:'Retain sample review'},h.owner,201);
  await h.post(base+'/samples/delete',{sample_id:fileSample.id},h.owner,409);
  await h.post(`data`+`/holds/${hold.id}/release`);
  await h.post(base+'/samples/delete',{sample_id:fileSample.id});
  assert.equal(portable(await archive(h),'crank_workflow_samples').some(s=>s.id===fileSample.id),false);
  // Erasing the source removes the independently retained history copy too.
  await h.post(base+'/pause');await h.post('data'+'/erase',{workflow_run_id:run.id,confirm:'ERASE'});
  assert.equal((await h.get(base+'/samples')).samples.some(s=>s.source_id===run.id),false);
  return {samples:6};
 } finally {await h.close()}
}

export async function sampleAuthorityJourney() {
 const edge=fakeEdge();edge.routes.set('sample-poll.example',()=>jsonResponse([{id:'synthetic-crank-poll-1',email:'synthetic-crank@example.test'}]));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const original={trigger:{type:'webhook'},steps:[{id:'keep',type:'map',input:{email:'{{trigger.body.email}}'}}]};
  const w=await publish(h,'Protected draft capture',{trigger:{type:'url_poll',url:'https://sample-poll.example/leads',items_path:'',interval_minutes:1,backfill:'from_now'},steps:[]}),base=`workflows/${w.id}`;
  await h.tick();
  assert.ok(portable(await archive(h),'crank_seen_items').length>0,'a real production watermark exists before capture');
  await h.post(base+'/draft',{graph:original});
  await h.post(base+'/samples/listen',{},'',401);
  const obsolete=await h.post(base+'/samples/listen',{},h.owner,201);
  await h.post(base+'/draft',{graph:{...original,trigger:{type:'webhook',name:'Changed trigger'}}});
  const stale=await deliver(h,obsolete.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:'synthetic-crank@example.test'})});
  assert.equal(stale.status,404);assert.equal((await h.get(base+'/samples')).samples.length,0);
  const current=await h.post(base+'/samples/listen',{},h.owner,201);
  assert.equal((await deliver(h,current.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:'{invalid'})).status,400);
  const beforeCapture=checkpoints(await archive(h));
  const replies=await Promise.all([1,2].map(()=>deliver(h,current.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:'synthetic-crank@example.test'})})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[201,404]);
  assert.deepEqual(checkpoints(await archive(h)),beforeCapture,'draft capture does not advance an existing published poll or dedup watermark');assert.equal((await h.get(base+'/samples')).samples.length,1);
  await h.post('data'+'/classes',{workflow_id:w.id,data_class:'customer'});
  await h.tick();
  const sealedRows=portable(await archive(h),'crank_workflow_samples');
  assert.equal(sealedRows.length,1);assert.equal(JSON.parse(sealedRows[0].payload_json).sealed,'crank-payload-v1');assert.equal(sealedRows[0].payload_json.includes('synthetic-crank@example.test'),false);
  const revoked=await h.post(base+'/samples/listen',{},h.owner,201);
  assert.equal((await h.send('/auth/signout',{},h.owner)).status,204);
  assert.equal((await deliver(h,revoked.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:'synthetic-crank@example.test'})})).status,404);

 } finally {await h.close()}
}
