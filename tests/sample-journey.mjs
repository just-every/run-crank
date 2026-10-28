import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {deliver,hookUrl,publish,fakeEdge,jsonResponse,settled} from './kit.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';

const address=name=>['synthetic-crank-'+name,'example.test'].join('@');
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
  const captured=await deliver(h,listener.url+'?campaign=autumn&tag=one&tag=two',{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded','x-sample-label':'synthetic-crank-1','authorization':'synthetic-crank-private','x-api-key':'synthetic-crank-private'},body:'event=synthetic-crank-1&email=synthetic-crank-lead%40example.test&utm=hidden-value&answer=one&answer=two'});
  assert.equal(captured.status,201,captured.text);
  assert.deepEqual(captured.value,{captured:true,sample_id:captured.value.sample_id});
  assert.equal((await deliver(h,listener.url,{method:'POST',body:'event=again'})).status,404);
  const state=await h.get(base+'/samples'),sample=state.samples.find(s=>s.id===captured.value.sample_id);
  assert.equal(sample.source,'webhook');assert.equal(sample.selected,true);assert.equal(sample.tested,false);
  assert.deepEqual(sample.payload.body,{event:'synthetic-crank-1',email:address('lead'),utm:'hidden-value',answer:['one','two']});
  assert.deepEqual(sample.payload.query,{campaign:'autumn',tag:['one','two']});assert.deepEqual(sample.payload.files,{});
  assert.equal(sample.payload.raw,'event=synthetic-crank-1&email=synthetic-crank-lead%40example.test&utm=hidden-value&answer=one&answer=two');
  assert.equal(sample.payload.method,'POST');assert.equal(sample.payload.headers['x-sample-label'],'synthetic-crank-1');
  assert.equal(sample.payload.headers.authorization,undefined);assert.equal(sample.payload.headers['x-api-key'],undefined);
  const preview=await h.post(base+'/preview',{});
  assert.equal(preview.source.id,sample.id);assert.equal(preview.source.source,'webhook');
  assert.deepEqual(preview.steps.map(s=>s.path),['mapped','upper','qualify','notify']);
  assert.deepEqual(preview.steps[0].output,{utm:'hidden-value',email:address('lead')});assert.equal(preview.steps[1].output,'HIDDEN-VALUE');assert.equal(preview.steps[2].pass,true);assert.equal(preview.steps[3].outcome,'not run in preview');
  assert.ok(preview.steps.every(step=>step.source.id===sample.id));assert.equal(edge.requests.length,0);
  assert.deepEqual(checkpoints(await archive(h)),before,'capture and previews change no production admission, dedup, polling, usage or notice records');
  await inspect({h,w,state:'captured',sample,preview});
  listener=await h.post(base+'/samples/listen',{},h.owner,201);
  const multipart=new FormData();multipart.set('event','synthetic-crank-2');multipart.set('email',address('file'));multipart.set('utm','file-source');multipart.set('attachment',new File(['retained file bytes'],'lead.txt',{type:'text'+'/plain'}));
  const upload=await deliver(h,listener.url,{method:'POST',body:multipart});assert.equal(upload.status,201,upload.text);
  const fileSample=(await h.get(base+'/samples')).samples.find(s=>s.id===upload.value.sample_id);
  assert.equal(fileSample.payload.files.attachment.name,'lead.txt');assert.equal(fileSample.payload.files.attachment.type,'text'+'/plain');assert.equal(fileSample.payload.files.attachment.size,19);assert.match(fileSample.payload.files.attachment.sha256,/^[a-f0-9]{64}$/);
  const stored=portable(await archive(h),'crank_workflow_samples').find(s=>s.id===fileSample.id);
  assert.equal(Buffer.from(JSON.parse(stored.uploads_json)[0].content_base64,'base64').toString(),'retained file bytes');
  const stale=await h.post(base+'/samples/fields',{fields:['body.email','body.utm','body.new_question']});
  assert.ok(stale.warnings.some(w=>w==='Stale sample: missing fields body.new_question'));
  const validation=await h.post(base+'/validate',{});assert.ok(validation.warnings.some(w=>w.includes('body.new_question')));assert.ok(validation.warnings.some(w=>w.includes('Step notify')&&w.includes('schema sample')));
  await inspect({h,w,state:'stale'});
  const manual=await h.post(base+'/samples',{sample:{body:{email:address('manual'),utm:'manual-source',new_question:'yes'}}},h.owner,201);
  const manualId=manual.samples.find(s=>s.source==='manual').id;
  const manualPreview=await h.post(base+'/preview',{sample_id:manualId});assert.equal(manualPreview.sample_source,'manual sample');assert.equal(manualPreview.steps[1].output,'MANUAL-SOURCE');
  assert.equal((await h.get(base+'/samples')).warnings.some(w=>w.includes('Stale sample')),false);
  await inspect({h,w,state:'manual',sample:manual.samples.find(s=>s.id===manualId),preview:manualPreview});
  const schema=await h.post(base+'/samples',{source:'schema',step_path:'notify',sample:{contact_id:'synthetic-crank-schema'}},h.owner,201);
  assert.equal(schema.samples.find(s=>s.source==='schema').tested,false);assert.match(schema.samples.find(s=>s.source==='schema').label,/not tested/);
  await h.post(base+'/samples/select',{sample_id:sample.id});
  const publication=await h.post(base+'/publish',{},h.owner,201);assert.ok(publication.warnings.some(w=>w.includes('Step notify')&&w.includes('not tested')));
  // A captured event has not spent its production dedup identity.
  const real=await deliver(h,productionUrl,{method:'POST',headers:{'content-type':'application'+'/x-www-form-urlencoded'},body:'event=synthetic-crank-1&email=synthetic-crank-lead%40example.test&utm=hidden-value'});
  assert.equal(real.status,200,real.text);assert.equal(real.value.accepted,true);
  const run=await settled(h,real.value.run_id);assert.equal(run.mode,'production');assert.equal(edge.requests.length,1);
  const history=await h.post(base+'/samples',{source:'history',run_id:run.id},h.owner,201);
  const chosen=history.samples.find(s=>s.source==='history');assert.equal(chosen.source_id,run.id);assert.equal(chosen.source_time,run.received_at);assert.deepEqual(chosen.payload,run.trigger);
  const historicalPreview=await h.post(base+'/preview',{});assert.equal(historicalPreview.source.source_id,run.id);assert.match(historicalPreview.sample_source,new RegExp(run.id));assert.equal(historicalPreview.steps[1].output,'HIDDEN-VALUE');
  await inspect({h,w,state:'history',sample:chosen,preview:historicalPreview});
  const invited=await h.send('/auth/invite',{email:address('reader'),displayName:'Sample reader',role:'member'},h.owner);assert.equal(invited.status,202);
  const token=new URL(h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
  const reader=(await h.send('/auth/confirm',{token})).cookie;
  const readerPeople=await h.send('/auth/operators',undefined,h.owner),readerId=readerPeople.value.find(p=>p.displayName==='Sample reader').id;
  await h.post('team/'+readerId,{role:'viewer',workflow_ids:[w.id],connection_ids:[]});
  assert.equal((await h.get('workflow-runs/'+run.id,reader)).payload,'restricted');
  await h.get(base+'/samples',reader,403);await h.post(base+'/samples',{source:'history',run_id:run.id},reader,403);await h.post(base+'/preview',{sample_id:chosen.id},reader,403);
  await h.post(base+'/samples/fields',{fields:['body.email','body.private_question']});
  const ownerWarnings=(await h.post(base+'/validate',{})).warnings;
  assert.ok(ownerWarnings.some(w=>w.includes('body.private_question')));
  assert.equal(ownerWarnings.some(w=>w.includes('body.email')),false);
  const restrictedValidation=await h.post(base+'/validate',{},reader,403);
  assert.equal(restrictedValidation.warnings,undefined,'a payload-restricted viewer cannot obtain sample validation');
  assert.equal(JSON.stringify(restrictedValidation).includes('body.private_question'),false,'refusal cannot disclose retained sample field presence');
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
  const adminInvite=await h.send('/auth/invite',{email:address('admin'),displayName:'Sample admin',role:'admin'},h.owner);assert.equal(adminInvite.status,202);
  const adminToken=new URL(h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
  const admin=(await h.send('/auth/confirm',{token:adminToken})).cookie;
  const people=await h.send('/auth/operators',undefined,h.owner),adminId=people.value.find(p=>p.displayName==='Sample admin').id;
  await h.post('team/'+adminId,{role:'builder',workflow_ids:[foreign.id],connection_ids:[]});
  const adminSamples=await h.post(`workflows/${foreign.id}/samples`,{sample:{body:{email:address('admin-payload')}}},admin,201);
  const adminSampleId=adminSamples.samples[0].id;
  assert.equal(portable(await archive(h),'crank_workflow_samples').find(s=>s.id===adminSampleId).created_by,adminId);
  assert.equal((await h.send('/auth/operator/status',{operatorId:adminId,status:'inactive'},h.owner)).status,200);
  const erased=await h.post('data'+'/erase',{operator_id:adminId,confirm:'ERASE'});
  const erasedSample=portable(await archive(h),'crank_workflow_samples').find(s=>s.id===adminSampleId);
  assert.equal(erasedSample.created_by,erased.label);assert.notEqual(erasedSample.created_by,adminId);
  assert.deepEqual(JSON.parse(erasedSample.payload_json),{body:{email:address('admin-payload')}});
  // Erasing the source removes the independently retained history copy too.
  await h.post(base+'/pause');await h.post('data'+'/erase',{workflow_run_id:run.id,confirm:'ERASE'});
  assert.equal((await h.get(base+'/samples')).samples.some(s=>s.source_id===run.id),false);
  await conditionPreviews(h,edge,inspect);
  return {samples:6};
 } finally {await h.close()}
}

/** One retained lead journey checks previews against deliberate destination readback. */
async function conditionPreviews(h,edge,inspect) {
 const note=id=>({id,type:'map',input:{branch:id}});
 const routing={trigger:{type:'webhook'},steps:[
  {id:'present',type:'filter',when:[[
   {field:'trigger.body.key',op:'exists'},
   {field:'trigger.body.missing',op:'not_exists'},
   {field:'trigger.body.nil',op:'not_exists'},
   {field:'trigger.body.blank',op:'is_empty'}
  ]]},
  {id:'route',type:'paths',mode:'parallel',branches:[
   {id:'premium',name:'Qualified lead',when:[[{field:'trigger.body.amount',op:'number.gt',value:5000}]],steps:[note('premium_note')]},
   {id:'regional',name:'Regional lead',when:[[{field:'trigger.body.state',op:'text.in',value:['TX','OK','LA']}]],steps:[note('regional_note')]}
  ],fallback:{steps:[note('fallback_note')]}},
  {id:'summary',type:'map',input:{matched:'{{steps.route.matched}}',key:'{{trigger.body.key}}'}},
  {id:'notify',type:'http',input:{method:'POST',url:'https://crm.example/contacts',body:'{{steps.summary}}'}}
 ]};
 const w=await h.post('workflows',{name:'Lead condition previews',graph:routing},h.owner,201),base=`workflows/${w.id}`;
 const payload={key:'synthetic-crank-preview',amount:'6000',state:'TX',nil:null,blank:''};
 const listener=await h.post(base+'/samples/listen',{},h.owner,201);
 const captured=await deliver(h,listener.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify(payload)});
 assert.equal(captured.status,201,captured.text);
 await h.restart();
 const stored=(await h.get(base+'/samples')).samples.find(sample=>sample.id===captured.value.sample_id);
 const initialWrites=edge.requests.length;
 const preview=async(state,matched,error=false)=>{
  const result=await h.post(base+'/preview',{}),route=result.steps.find(step=>step.path==='route');
  assert.deepEqual(route.matched,matched);
  assert.equal(route.outcome,error?'type mismatch':'routed');
  assert.equal(result.source.id,(await h.get(base+'/samples')).samples.find(sample=>sample.selected).id);
  assert.ok(result.steps.every(step=>step.source.id===result.source.id));
  const kinds=result.steps[0].trace.groups[0].rules.map(rule=>[rule.kind,rule.result]);
  assert.deepEqual(kinds,[['value',true],['missing',true],['null',true],['empty',true]]);
  if(error) {
   assert.equal(route.error.category,'type_mismatch');
   assert.equal(route.trace[0].trace.groups[0].rules[0].result,'type_mismatch');
   assert.deepEqual(result.steps.map(step=>step.path),['present','route']);
  } else {
   assert.deepEqual(result.steps.find(step=>step.path==='summary').output,{matched,key:payload.key});
   assert.equal(result.steps.at(-1).outcome,'not run in preview');
  }
  assert.equal(edge.requests.length,initialWrites,'preview sends no destination request');
  await inspect({h,w,state,sample:(await h.get(base+'/samples')).samples.find(sample=>sample.selected),preview:result});
  return result;
 };
 const capturedPreview=await preview('condition-captured',['premium','regional']);
 assert.equal(capturedPreview.sample_source,`webhook sample ${stored.id}`);
 assert.deepEqual(capturedPreview.steps[1].trace.map(branch=>branch.trace.groups[0].rules.map(rule=>[rule.left,rule.right,rule.result])),[[['6000',5000,true]],[['TX',['TX','OK','LA'],true]]]);
 await h.post(base+'/samples',{sample:{body:{...payload,amount:'abc'}}},h.owner,201);
 await preview('condition-mismatch',[],true);
 await h.post(base+'/samples',{sample:{body:{...payload,amount:'100',state:'CA'}}},h.owner,201);
 await preview('condition-fallback',['fallback']);
 await h.post(base+'/samples/select',{sample_id:stored.id});
 const exclusive=structuredClone(routing);exclusive.steps[1].mode='exclusive';
 await h.post(base+'/draft',{graph:exclusive});
 await preview('condition-exclusive',['premium']);
 const routed=structuredClone(routing);routed.steps[1].on_type_mismatch='fallback';
 await h.post(base+'/draft',{graph:routed});
 await h.post(base+'/samples',{sample:{body:{...payload,amount:'abc'}}},h.owner,201);
 const mismatchPreview=await preview('condition-routed',['fallback']);
 assert.equal(mismatchPreview.steps[1].trace[0].trace.groups[0].rules[0].result,'type_mismatch');
 // Deliberate execution is separate from preview; the destination sees the same route.
 await h.post(base+'/publish',{},h.owner,201);
 const hook=await hookUrl(h,w),sent=await deliver(h,hook,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({...payload,amount:'abc'})});
 assert.equal(sent.status,200,sent.text);
 const run=await settled(h,sent.value.run_id);assert.equal(run.status,'succeeded');
 assert.deepEqual(run.steps.find(step=>step.path==='route').output.matched,['fallback']);
 assert.deepEqual(JSON.parse(edge.requests.at(-1).body),{matched:['fallback'],key:payload.key});
 await h.post(base+'/samples',{source:'history',run_id:run.id},h.owner,201);
 const history=await h.post(base+'/preview',{});
 assert.equal(history.source.source_id,run.id);assert.deepEqual(history.steps.find(step=>step.path==='route').matched,['fallback']);
 assert.equal(edge.requests.length,initialWrites+1,'history previews do not repeat an effect');
 // A stopped branch must not hide a later parallel branch or manufacture a continuation.
 const mixed=structuredClone(routing),stop={id:'stop',type:'filter',when:[[{field:'trigger.body.never',op:'exists'}]]};
 mixed.steps[1].branches[0].steps=[stop];
 await h.post(base+'/draft',{graph:mixed});await h.post(base+'/samples/select',{sample_id:stored.id});
 const continued=await h.post(base+'/preview',{});
 assert.deepEqual(continued.steps.find(step=>step.path==='summary').output.matched,['premium','regional']);
 mixed.steps[1].branches[1].steps=[{...stop,id:'stop_regional'}];
 await h.post(base+'/draft',{graph:mixed});
 const stopped=await h.post(base+'/preview',{});
 assert.equal(stopped.steps.some(step=>step.path==='summary'),false,'all stopped branches end the preview');
 const always=structuredClone(routing);delete always.steps[1].fallback;always.steps[1].always={steps:[note('always_note')]};
 await h.post(base+'/draft',{graph:always});
 const withAlways=await h.post(base+'/preview',{});
 assert.deepEqual(withAlways.steps.find(step=>step.path==='summary').output.matched,['premium','regional','always']);
 assert.equal(edge.requests.length,initialWrites+1);
}

export async function sampleAuthorityJourney() {
 const edge=fakeEdge();edge.routes.set('sample-poll.example',()=>jsonResponse([{id:'synthetic-crank-poll-1',email:address('authority')}]));
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
  const stale=await deliver(h,obsolete.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:address('authority')})});
  assert.equal(stale.status,404);assert.equal((await h.get(base+'/samples')).samples.length,0);
  const current=await h.post(base+'/samples/listen',{},h.owner,201);
  assert.equal((await deliver(h,current.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:'{invalid'})).status,400);
  const beforeCapture=checkpoints(await archive(h));
  const replies=await Promise.all([1,2].map(()=>deliver(h,current.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:address('authority')})})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[201,404]);
  assert.deepEqual(checkpoints(await archive(h)),beforeCapture,'draft capture does not advance an existing published poll or dedup watermark');assert.equal((await h.get(base+'/samples')).samples.length,1);
  await h.post('data'+'/classes',{workflow_id:w.id,data_class:'customer'});
  await h.tick();
  const sealedRows=portable(await archive(h),'crank_workflow_samples');
  assert.equal(sealedRows.length,1);assert.equal(JSON.parse(sealedRows[0].payload_json).sealed,'crank-payload-v1');assert.equal(sealedRows[0].payload_json.includes(address('authority')),false);
  const revoked=await h.post(base+'/samples/listen',{},h.owner,201);
  assert.equal((await h.send('/auth/signout',{},h.owner)).status,204);
  assert.equal((await deliver(h,revoked.url,{method:'POST',headers:{'content-type':'application'+'/json'},body:JSON.stringify({email:address('authority')})})).status,404);

 } finally {await h.close()}
}
