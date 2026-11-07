import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z',scope='responses:read';
export const form='synthetic-crank-form',responseId='synthetic-crank-response';
export const selected=[{id:'synthetic-crank-text',type:'text'},{id:'synthetic-crank-number',type:'number'},{id:'synthetic-crank-boolean',type:'boolean'},{id:'synthetic-crank-null',type:'text'},{id:'synthetic-crank-empty',type:'text'},{id:'synthetic-crank-missing',type:'text'}];
export const typeformStep=connectionId=>({id:'response',name:'Typeform completed response',type:'typeform.find_response',connection_id:connectionId,form_id:form,fields:selected,hidden_fields:['utm_source','empty','null_value','missing'],no_match:'continue',input:{response_id:'{{trigger.input.response_id}}'},retry_policy:{read_attempts:2,base_delay_ms:1}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'mapped',type:'map',input:{outcome:'{{steps.response.outcome}}',record:'{{steps.response.record}}'}}]});
export const payload=(id=responseId)=>({total_items:1,page_count:1,items:[{response_id:id,response_type:'completed',submitted_at:'2026-11-01T12:00:00Z',landed_at:'2026-11-01T11:59:00Z',metadata:{network_id:'synthetic-crank-private'},hidden:{utm_source:'synthetic-crank-person',empty:'',null_value:null,unselected:'synthetic-crank-hidden-private'},answers:[
 {field:{id:selected[0].id,ref:'synthetic-crank-ref'},type:'text',text:'<img src=x onerror=alert(1)> synthetic-crank-answer'},
 {field:{id:selected[1].id},type:'number',number:0},
 {field:{id:selected[2].id},type:'boolean',boolean:false},
 {field:{id:selected[3].id},type:'text',text:null},
 {field:{id:selected[4].id},type:'text',text:''},
 {field:{id:'synthetic-crank-upload'},type:'file_url',file_url:'https://uploads.example/private-file'},
]}]});
function exact(request,token='synthetic-crank-701',formId=form,id=responseId){
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.url.origin,'https://api.typeform.com');assert.equal(request.url.pathname,`/forms/${formId}/responses`);
 assert.deepEqual([...request.url.searchParams],[['included_response_ids',id],['page_size','1'],['response_type','completed']]);assert.equal(request.headers.authorization,'Bearer '+token);
}
async function fixture(){
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'typeform',auth_kind:'bearer',label:'Selected Typeform account',scopes:[scope],secret:{token:'synthetic-crank-701'}});
 fake.routes.set('api.typeform.com',request=>{exact(request);return jsonResponse(payload())});return{h,c,fake};
}
function assertValues(result){
 assert.equal(result.outcome,'found');assert.equal(result.count,1);assert.equal(result.record.response_id,responseId);assert.equal(result.record.form_id,form);
 assert.equal(result.record.submitted_at,'2026-11-01T12:00:00Z');assert.equal(result.record.landed_at,'2026-11-01T11:59:00Z');
 assert.deepEqual(result.record.answers.map(answer=>[answer.field.id,answer.type,answer.value]),[[selected[0].id,'text','<img src=x onerror=alert(1)> synthetic-crank-answer'],[selected[1].id,'number',0],[selected[2].id,'boolean',false],[selected[3].id,'text',null],[selected[4].id,'text','']]);
 assert.equal(result.record.answers[0].field.ref,'synthetic-crank-ref');assert.ok(!result.record.answers.some(answer=>answer.field.id===selected[5].id));
 assert.deepEqual(result.record.hidden,{utm_source:'synthetic-crank-person',empty:'',null_value:null});assert.equal(Object.hasOwn(result.record.hidden,'missing'),false);
 assert.match(result.freshness,/delay/);assert.match(result.freshness,/does not detect submissions instantly/);
 for(const privateValue of ['uploads.example','private-file','synthetic-crank-private','synthetic-crank-hidden-private'])assert.ok(!JSON.stringify(result).includes(privateValue));
}
export async function typeformSearchJourney({onScreen}={}){
 const {h,c,fake}=await fixture();console.log('Typeform lookup: fixture ready');
 try{
  const draft=await h.post('workflows',{name:'Read a selected Typeform response',graph:graph(typeformStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{response_id:responseId}},h.owner,201);assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assertValues(stepOf(tested,'response').output);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{response_id:responseId});assert.equal(good.status,'succeeded',JSON.stringify(good.error));assertValues(stepOf(good,'response').output);assert.equal(stepOf(good,'mapped').output.record.id,responseId);
  if(onScreen)await onScreen({h,w:draft,run:good});
  const disclosure=(await h.get('data/flows')).flows.find(item=>item.kind==='typeform.find_response');assert.deepEqual(disclosure.recipients,['https://api.typeform.com']);for(const name of ['form_id','response_id','response_type','page_size'])assert.ok(disclosure.fields.includes(name));assert.match(disclosure.credentials,/bearer/i);assert.match(disclosure.region,/not verified/);assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(responseId));
  fake.routes.set('api.typeform.com',request=>{exact(request);return jsonResponse({total_items:0,page_count:0,items:[]})});
  const empty=await startRun(h,draft,{response_id:responseId});assert.equal(empty.status,'succeeded');assert.equal(stepOf(empty,'mapped').output.outcome,'not found');assert.equal(stepOf(empty,'response').output.record,null);
  const stop=await publish(h,'Halt when response is not yet visible',graph({...typeformStep(c.id),no_match:'halt'})),halt=await startRun(h,stop,{response_id:responseId});assert.equal(halt.status,'stopped_by_search');assert.ok(!stepOf(halt,'mapped'));
  const mutations=[
   v=>({...v,total_items:2}),v=>({...v,page_count:2}),v=>({...v,total_items:0}),v=>({...v,items:[...v.items,...v.items]}),
   v=>({...v,items:[{...v.items[0],response_id:'synthetic-crank-foreign'}]}),v=>({...v,items:[{...v.items[0],form_id:'synthetic-crank-other-form'}]}),
   v=>({...v,items:[{...v.items[0],response_type:'partial'}]}),v=>({...v,items:[{...v.items[0],submitted_at:'2026-02-30T12:00:00Z'}]}),
   v=>({...v,items:[{...v.items[0],answers:[{field:{id:selected[0].id},type:'file_url',file_url:'https://uploads.example/private-file'}]}]}),
   v=>({...v,items:[{...v.items[0],answers:[{field:{id:selected[0].id},type:'text'}]}]}),
   v=>({...v,items:[{...v.items[0],answers:[{field:{id:selected[1].id},type:'number',number:'0'}]}]}),
   v=>({...v,items:[{...v.items[0],hidden:{utm_source:1}}]}),
   v=>({...v,items:[{...v.items[0],answers:[v.items[0].answers[0],v.items[0].answers[0]]}]}),
   v=>({...v,items:[{...v.items[0],answers:[{field:{id:selected[0].id},type:'text',text:'x'.repeat(16385)}]}]}),
  ];
  for(const change of mutations){fake.routes.set('api.typeform.com',request=>{exact(request);return jsonResponse(change(payload()))});const bad=await startRun(h,draft,{response_id:responseId});assert.equal(bad.status,'failed',JSON.stringify(change(payload())));assert.equal(bad.error.category,'provider');assert.equal(stepOf(bad,'response').output,null);assert.ok(!stepOf(bad,'mapped'))}
  for(const reply of [()=>new Response('{'),()=>jsonResponse({private:'synthetic-crank-error-body'},500),()=>jsonResponse({},403),()=>jsonResponse({},404),()=>new Response('x'.repeat(262145)),()=>new Response(null,{status:302,headers:{location:'https://uploads.example/private-file'}})]){
   fake.routes.set('api.typeform.com',request=>{exact(request);return reply()});const bad=await startRun(h,draft,{response_id:responseId});assert.ok(!['succeeded','stopped_by_search'].includes(bad.status));assert.ok(!stepOf(bad,'mapped'));assert.ok(!JSON.stringify(bad).includes('synthetic-crank-error-body'));
  }
  const before=fake.requests.length;
  for(const patch of [{form_id:'{{trigger.input.form}}'},{form_id:'../forms'},{fields:[{id:'synthetic-crank-upload',type:'file_url'}]},{hidden_fields:['utm_source','utm_source']},{fields:[selected[0],selected[0]]},{create_if_not_found:{}},{input:{response_id:responseId,page:1}},{input:{response_id:'a,b'}}])await h.post('workflows',{name:'Unsupported form lookup',graph:graph({...typeformStep(c.id),...patch})},h.owner,422);
  for(const response_id of ['',null,1,'a,b','x'.repeat(129)]){const bad=await startRun(h,draft,{response_id});assert.equal(bad.status,'failed');assert.ok(!stepOf(bad,'mapped'))}
  assert.equal(fake.requests.length,before,'invalid declarations and resolved IDs send no requests');
  for(const account of [await connection(h,{app:'typeform',auth_kind:'bearer',label:'No response consent',scopes:['forms:read'],secret:{token:'synthetic-crank-702'}}),await connection(h,{app:'http',auth_kind:'bearer',domains:['api.typeform.com'],label:'Wrong credential kind',secret:{token:'synthetic-crank-703'}})]){
   const w=await publish(h,'Missing response authority',graph(typeformStep(account.id))),count=fake.requests.length,bad=await startRun(h,w,{response_id:responseId});assert.notEqual(bad.status,'succeeded');assert.equal(fake.requests.length,count);
  }
  const other=await connection(h,{app:'typeform',auth_kind:'bearer',label:'Second form account',scopes:[scope],secret:{token:'synthetic-crank-704'}});
  fake.routes.set('api.typeform.com',request=>{exact(request,'synthetic-crank-704','synthetic-crank-other-form','synthetic-crank-other-response');return jsonResponse(payload('synthetic-crank-other-response'))});
  const isolated=await startRun(h,await publish(h,'Separate form and account',graph({...typeformStep(other.id),form_id:'synthetic-crank-other-form'})),{response_id:'synthetic-crank-other-response'});assert.equal(isolated.status,'succeeded');assert.equal(stepOf(isolated,'response').output.record.form_id,'synthetic-crank-other-form');assert.equal(stepOf(good,'response').output.record.id,responseId);
  let parked=true;fake.routes.set('api.typeform.com',request=>{exact(request);return parked?jsonResponse({},429,{'retry-after':'60'}):jsonResponse(payload())});
  const waiting=await startRun(h,draft,{response_id:responseId});assert.equal(waiting.status,'waiting');const count=fake.requests.length,operation=stepOf(waiting,'response').operation_key;parked=false;
  await h.restart({clock:later});await h.tick(Date.parse(later));const resumed=await h.get('workflow-runs/'+waiting.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assertValues(stepOf(resumed,'response').output);assert.equal(stepOf(resumed,'response').operation_key,operation);assert.equal(fake.requests.length,count+1);
  parked=true;const revoked=await startRun(h,draft,{response_id:responseId});assert.equal(revoked.status,'waiting');await h.post(`connections/${c.id}/revoke`);const afterRevoke=fake.requests.length;await h.restart({clock:'2026-11-10T15:04:01Z'});await h.tick('2026-11-10T15:04:01Z');assert.notEqual((await h.get('workflow-runs/'+revoked.id)).status,'succeeded');assert.equal(fake.requests.length,afterRevoke);
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  fake.routes.set('api.typeform.com',async request=>{exact(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:['forms:read']});return jsonResponse(payload())});
  const lostConsent=await startRun(h,draft,{response_id:responseId});assert.notEqual(lostConsent.status,'succeeded');assert.ok(!stepOf(lostConsent,'mapped'),'cached response consumption also checks current consent');
  const plainChunks=(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(lostConsent.id).all()).results;assert.equal(plainChunks.length,1);
  const projected=JSON.parse(Buffer.from(plainChunks[0].content_base64,'base64').toString());assert.deepEqual(projected.records,[stepOf(good,'response').output.record],'private checkpoint retains only the validated projection');
  const badProjection={records:[{...projected.records[0],file_url:'https://uploads.example/private-file'}]},badBytes=Buffer.from(JSON.stringify(badProjection));
  const badArchive=await rewritten(await archive(h),(table,row)=>{if(row.run_id!==lostConsent.id)return;if(table==='crank_request_checkpoint_chunks')row.content_base64=badBytes.toString('base64');if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.body_bytes=badBytes.length;response.chunk_count=1;row.response_json=JSON.stringify(response)}});
  const foreignProjection={records:[{...projected.records[0],id:'synthetic-crank-foreign',response_id:'synthetic-crank-foreign'}]},foreignBytes=Buffer.from(JSON.stringify(foreignProjection));
  const saved=await archive(h),foreignArchive=await rewritten(saved,(table,row)=>{if(row.run_id!==lostConsent.id)return;if(table==='crank_request_checkpoint_chunks')row.content_base64=foreignBytes.toString('base64');if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.body_bytes=foreignBytes.length;response.chunk_count=1;row.response_json=JSON.stringify(response)}});
  const rejected=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});try{
   for(const invalid of [badArchive,foreignArchive]){await rejected.post('data/restore',{archive:invalid,confirm:'RESTORE'},rejected.owner,400);assert.deepEqual(await rejected.get('workflows'),[],'checksummed projection and mapped response identity mismatches are refused atomically')}
  }finally{await rejected.close()}
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  const mismatched=await startRun(h,draft,{response_id:responseId});assert.equal(mismatched.status,'paused');
  const checkpoint=await h.db.prepare('SELECT request_key,response_json FROM crank_request_checkpoints WHERE run_id=?').bind(mismatched.id).first();
  const metadata=JSON.parse(checkpoint.response_json);metadata.body_bytes=foreignBytes.length;metadata.chunk_count=1;
  await h.db.prepare('UPDATE crank_request_checkpoint_chunks SET content_base64=? WHERE run_id=?').bind(foreignBytes.toString('base64'),mismatched.id).run();
  await h.db.prepare('UPDATE crank_request_checkpoints SET response_json=? WHERE run_id=?').bind(JSON.stringify(metadata),mismatched.id).run();
  assert.equal((await h.db.prepare('SELECT request_key FROM crank_request_checkpoints WHERE run_id=?').bind(mismatched.id).first()).request_key,checkpoint.request_key);
  assert.equal(JSON.parse((await h.db.prepare('SELECT input_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(mismatched.id,'response').first()).input_json).response_id,responseId);
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  const beforeMismatch=fake.requests.length;await h.restart();
  const refused=await h.post(`workflow-runs/${mismatched.id}/resume`);assert.equal(refused.status,'failed');assert.equal(refused.error.category,'provider');assert.match(refused.error.message,/response ID binding/);assert.equal(stepOf(refused,'response').output,null);assert.ok(!stepOf(refused,'mapped'));assert.equal(fake.requests.length,beforeMismatch,'a foreign cached response is refused without another provider read');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:['forms:read']});
  const cachedCount=fake.requests.length;await h.restart();
  const noConsent=await h.post(`workflow-runs/${lostConsent.id}/resume`);assert.notEqual(noConsent.status,'succeeded');assert.equal(fake.requests.length,cachedCount,'cached consumption cannot bypass removed consent');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  const cached=await h.post(`workflow-runs/${lostConsent.id}/resume`);assert.equal(cached.status,'succeeded',JSON.stringify(cached.error));assertValues(stepOf(cached,'response').output);assert.equal(fake.requests.length,cachedCount,'restored consent consumes only the exact validated checkpoint');
  assert.ok(fake.requests.every(request=>request.method==='GET'&&request.url.host==='api.typeform.com'&&/^\/forms\/[A-Za-z0-9_-]+\/responses$/.test(request.url.pathname)),'zero provider writes and zero upload downloads');
  assert.deepEqual((await h.db.prepare('SELECT * FROM crank_polls').all()).results,[],'response reads create no polling state');
 }finally{await h.close()}
}

export async function typeformCustodyJourney(){
 const {h,c,fake}=await fixture();let receiving,refused;console.log('Typeform custody: fixture ready');
 try{
  const w=await publish(h,'Sealed selected form response',graph(typeformStep(c.id)));
  await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['utm_source']});await h.post(`workflows/${w.id}/resume`);
  fake.routes.set('api.typeform.com',async request=>{exact(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:['forms:read']});return jsonResponse(payload())});
  const good=await startRun(h,w,{response_id:responseId});assert.equal(good.status,'paused',JSON.stringify(good.error));
  const chunks=async id=>(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(id).all()).results;
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(good.id,'response').first();assert.equal(stored.output_json,null);assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse((await chunks(good.id))[0].content_base64).sealed,'crank-payload-v1');
  const metadata=JSON.parse((await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(good.id).first()).response_json);assert.equal(metadata.url,'https://api.typeform.com/responses');assert.equal(metadata.redirects,0);
  const invitation=await h.send('/auth/invite',{email:['synthetic-crank-form-viewer','example.test'].join('@'),displayName:'Form status observer',role:'member'},h.owner);assert.equal(invitation.status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const people=await h.send('/auth/operators',undefined,h.owner),viewer=people.value.find(person=>person.displayName==='Form status observer');await h.post('team/'+viewer.id,{role:'viewer',workflow_ids:[w.id],connection_ids:[c.id]});
  const held=await h.post('data/holds',{kind:'subject',subject:'synthetic-crank-person',reason:'Response retention review'},h.owner,201);
  await h.post(`workflows/${w.id}/pause`);const preview=await h.post('data/subject',{subject:'synthetic-crank-person'});assert.ok(preview.workflow_runs.some(run=>run.id===good.id));assert.equal(preview.blocked,true);await h.post('data/erase',{subject:'synthetic-crank-person',digest:preview.digest,confirm:'ERASE'},h.owner,409);
  const saved=await archive(h);assert.ok(!saved.includes('synthetic-crank-701'));assert.ok(!saved.includes('synthetic-crank-answer'));assert.ok(!saved.includes('private-file'));
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),received=inventory(await archive(receiving)),source=new Set(original),extra=received.filter(row=>!source.has(row));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==extra[0]),original,'every projected sealed result and portable record survives inactive restoration');
  assert.equal(stepOf(await receiving.get('workflow-runs/'+good.id),'response').output,null,'unfinished restoration imports no payload key');const before=fake.requests.length;await receiving.restart();await receiving.tick(later);assert.equal(fake.requests.length,before);assert.ok((await receiving.get('connections')).every(item=>item.status!=='active'));assert.ok((await receiving.get('workflows')).every(item=>item.status!=='published'));
  const unavailable=await receiving.post('data/subject',{subject:'synthetic-crank-person'});assert.equal(unavailable.blocked,true);
  const malformedArchives=[
   (table,row)=>{if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.url='https://uploads.example/private-file';row.response_json=JSON.stringify(response)}},
   (table,row)=>{if(table==='crank_request_checkpoints')row.ordinal=1;if(table==='crank_request_checkpoint_chunks')row.ordinal=1},
   (table,row)=>{if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.redirects=1;row.response_json=JSON.stringify(response)}},
   (table,row)=>{if(table==='crank_request_checkpoint_chunks'){const envelope=JSON.parse(row.content_base64);envelope.ct='broken';row.content_base64=JSON.stringify(envelope)}},
  ];
  refused=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});for(const change of malformedArchives){await refused.post('data/restore',{archive:await rewritten(saved,change),confirm:'RESTORE'},refused.owner,400);assert.deepEqual(await refused.get('workflows'),[],'malformed archive refusal is atomic')}
  await h.restart();await h.post(`workflows/${w.id}/resume`);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  const completed=await h.post(`workflow-runs/${good.id}/resume`);assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));assertValues(stepOf(completed,'response').output);assert.equal(fake.requests.length,before,'completed projected checkpoint survives restart without repeating the read');assert.deepEqual(await chunks(good.id),[],'terminal step discards private request custody');
  const completedStored=await h.db.prepare('SELECT output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(good.id,'response').first();assert.equal(JSON.parse(completedStored.output_json).sealed,'crank-payload-v1');
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.equal(stepOf(restricted,'response').output,undefined);assert.ok(!JSON.stringify(restricted).includes('synthetic-crank-person'));
  await receiving.close();receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});const finishedArchive=await archive(h);await receiving.post('data/restore',{archive:finishedArchive,confirm:'RESTORE'});
  const finishedRows=inventory(finishedArchive),finishedReceived=inventory(await archive(receiving)),finishedSet=new Set(finishedRows),finishedExtra=finishedReceived.filter(row=>!finishedSet.has(row));assert.equal(finishedExtra.length,1);assert.equal(JSON.parse(finishedExtra[0]).row.action,'data.restore');assert.deepEqual(finishedReceived.filter(row=>row!==finishedExtra[0]),finishedRows);assert.equal(stepOf(await receiving.get('workflow-runs/'+good.id),'response').output.sealed,true);
  const policy={payload_days:1,attachment_days:null,history_days:30},retention=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:retention.digest});await h.tick('2026-11-12T15:00:00Z');assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null,'legal hold retains response projection and checkpoint');
  await h.post(`data/holds/${held.id}/release`);await h.tick('2026-11-12T15:00:00Z');const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(stepOf(expired,'response').output,null);assert.deepEqual(await chunks(good.id),[]);assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);
  fake.routes.set('api.typeform.com',request=>{exact(request);return jsonResponse(payload())});await h.post(`workflows/${w.id}/resume`);const eraseMe=await startRun(h,w,{response_id:responseId});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);
  const erasePreview=await h.post('data/subject',{subject:'synthetic-crank-person'});assert.ok(erasePreview.workflow_runs.some(run=>run.id===eraseMe.id));await h.post('data/erase',{subject:'synthetic-crank-person',digest:erasePreview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);assert.deepEqual(await chunks(eraseMe.id),[]);
  const journal=await archive(h);await refused.post('data/restore',{archive:saved,journal,confirm:'RESTORE'},refused.owner,409);assert.deepEqual(await refused.get('workflows'),[],'old response captures cannot resurrect an erased person');assert.equal(fake.requests.length,before+1);
 }finally{await refused?.close();await receiving?.close();await h.close()}
}

export async function typeformOwnership(h,fake){
 const c=await connection(h,{app:'typeform',auth_kind:'bearer',label:'Owned form account',scopes:[scope],secret:{token:'synthetic-crank-705'}});
 fake.routes.set('api.typeform.com',request=>{exact(request,'synthetic-crank-705');return jsonResponse(payload())});
 const w=await publish(h,'Owned form lookup',graph(typeformStep(c.id))),run=await startRun(h,w,{response_id:responseId});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assertValues(stepOf(run,'response').output);return ['typeform.find_response'];
}
