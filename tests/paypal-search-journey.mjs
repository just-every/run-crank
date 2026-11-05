import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
export const invoiceScope='https://uri.paypal.com/services/invoicing';
export const invoiceId='synthetic-crank-801';
export const invoiceNumber='<img src=x onerror="globalThis.paypalInjected=true"> synthetic-crank-invoice';
export const invoice=(id=invoiceId)=>({id,detail:{invoice_number:invoiceNumber,note:'synthetic-crank-private'},status:'SENT',amount:{currency_code:'USD',value:'9007199254740993.0100'},primary_recipients:[{billing_info:{name:{given_name:'synthetic-crank-private'}}}],links:[{href:'https://evil.example/write'}]});
export const paypalStep=id=>({id:'search',name:'PayPal invoice lookup',type:'paypal.find_invoice',connection_id:id,no_match:'continue',multi_match:'all',limit:10,retry_policy:{read_attempts:2,base_delay_ms:1},input:{invoice_id:'{{trigger.input.invoice_id}}'}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'map',input:{outcome:'{{steps.search.outcome}}',count:'{{steps.search.count}}'}}]});
const result=run=>stepOf(run,'search').output;
const flow=(h,c,patch={})=>publish(h,'PayPal read only invoice lookup',graph({...paypalStep(c.id),...patch}));
function assertRead(request,token='synthetic-crank-802') {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.url.origin,'https://api-m.sandbox.paypal.com');assert.equal(request.url.pathname,'/v2/invoicing/invoices/'+invoiceId);
 assert.equal(request.url.search,'');assert.equal(request.headers.authorization,'Bearer '+token);
}
async function fixture(){
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'paypal',auth_kind:'bearer',label:'Selected sandbox',scopes:[invoiceScope],secret:{token:'synthetic-crank-802'}});
 fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return jsonResponse(invoice())});return {h,c,fake};
}

/** Native draft tests, publication and HTTP runs; only PayPal's network edge is faked. */
export async function paypalSearchJourney({onScreen}={}) {
 const {h,c,fake}=await fixture();
 try {
  const draft=await h.post('workflows',{name:'PayPal exact invoice review',graph:graph(paypalStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{invoice_id:invoiceId}},h.owner,201);assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assert.equal(result(tested).record.id,invoiceId);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{invoice_id:invoiceId});assert.equal(good.status,'succeeded',JSON.stringify(good.error));
  assert.deepEqual(result(good),{outcome:'found',record:{id:invoiceId,number:invoiceNumber,status:'SENT',currency:'USD',total:'9007199254740993.0100'},records:[{id:invoiceId,number:invoiceNumber,status:'SENT',currency:'USD',total:'9007199254740993.0100'}],count:1,truncated:false});assert.equal(stepOf(good,'outcome').output.outcome,'found');
  for(const discarded of ['synthetic-crank-private','https://evil.example','synthetic-crank-802'])assert.ok(!JSON.stringify(good).includes(discarded));
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(good.id).first()).n,0,'completed steps discard continuation copies');
  const stored=await h.db.prepare('SELECT secret_iv,secret_ciphertext FROM crank_connections WHERE id=?').bind(c.id).first();assert.ok(stored.secret_iv);assert.ok(!stored.secret_ciphertext.includes('synthetic-crank-802'));
  const disclosure=(await h.get('data/flows')).flows.find(row=>row.kind==='paypal.find_invoice');assert.deepEqual(disclosure.recipients,['https://api-m.sandbox.paypal.com']);assert.ok(disclosure.fields.includes('invoice_id'));assert.match(disclosure.credentials,/bearer/i);for(const key of ['region','retention'])assert.match(disclosure[key],/not verified/);assert.ok(!JSON.stringify(disclosure).includes(invoiceId));
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  for(const multi_match of ['first','stop','all']){const run=await startRun(h,await flow(h,c,{multi_match}),{invoice_id:invoiceId});assert.equal(run.status,'succeeded');assert.equal(result(run).record.id,invoiceId);assert.equal(result(run).count,1)}
  fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return jsonResponse({name:'RESOURCE_NOT_FOUND',message:'synthetic-crank-private',details:[{issue:'INVALID_RESOURCE_ID'}]},404)});
  for(const no_match of ['halt','continue']){const w=await flow(h,c,{no_match}),run=await startRun(h,w,{invoice_id:invoiceId});assert.equal(run.status,no_match==='halt'?'stopped_by_search':'succeeded');assert.equal(result(run).outcome,'not found');assert.equal(result(run).count,0);assert.equal(run.steps.some(s=>s.step_id==='outcome'),no_match==='continue');if(no_match==='halt'&&onScreen)await onScreen({h,w,run,state:'not-found'})}
  const wrongs=[
   ['invalid JSON',()=>new Response('{')],['mismatched identity',()=>jsonResponse(invoice('synthetic-crank-wrong'))],
   ['empty number',()=>jsonResponse({...invoice(),detail:{invoice_number:''}})],['invalid status',()=>jsonResponse({...invoice(),status:'NOT_AN_INVOICE_STATUS'})],
   ['numeric total',()=>jsonResponse({...invoice(),amount:{currency_code:'USD',value:42}})],['exponent total',()=>jsonResponse({...invoice(),amount:{currency_code:'USD',value:'1e3'}})],['negative total',()=>jsonResponse({...invoice(),amount:{currency_code:'USD',value:'-1.00'}})],['invalid currency',()=>jsonResponse({...invoice(),amount:{currency_code:'usd',value:'1.00'}})],
   ['generic 404',()=>jsonResponse({},404)],['permission 404',()=>jsonResponse({name:'NOT_AUTHORIZED'},404)],['permission failure',()=>jsonResponse({name:'RESOURCE_NOT_FOUND'},403)],['expired bearer',()=>jsonResponse({},401)],['provider failure',()=>jsonResponse({name:'RESOURCE_NOT_FOUND'},500)],['null body',()=>jsonResponse(null)],
   ['oversized body',()=>jsonResponse({...invoice(),unexpected:'x'.repeat(262144)})],['redirect',()=>new Response('',{status:302,headers:{location:'https://evil.example/write'}})],
  ];
  for(const [label,reply] of wrongs){fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return reply(request)});const run=await startRun(h,await flow(h,c),{invoice_id:invoiceId});assert.notEqual(run.status,'succeeded',label);assert.notEqual(run.status,'stopped_by_search',label);assert.ok(!run.steps.some(s=>s.step_id==='outcome'),label);assert.equal(result(run),null,label)}
  const before=fake.requests.length;
  for(const value of ['',42,null,[],{},'../refund','%2frefund','a/b','a?refund=1',' a ','a#refund','a\n']){const run=await startRun(h,draft,{invoice_id:value});assert.equal(run.status,'failed');assert.equal(run.error.category,'validation')}
  for(const patch of [{create_if_not_found:{}},{sort:{field:'id',direction:'asc'}},{max_pages:2},{input:{invoice_id:invoiceId,endpoint:'https://evil.example/write'}},{url:'https://evil.example/write'},{method:'POST'},{arbitrary_setting:true},{input:{invoice_id:42}}])await h.post('workflows',{name:'Unsupported PayPal lookup',graph:graph({...paypalStep(c.id),...patch})},h.owner,422);
  for(const options of [{app:'paypal',auth_kind:'bearer',scopes:[],secret:{token:'synthetic-crank-803'}},{app:'http',auth_kind:'bearer',domains:['api-m.sandbox.paypal.com'],scopes:[invoiceScope],secret:{token:'synthetic-crank-804'}}]){const denied=await connection(h,{label:'No invoice read authority',...options});assert.notEqual((await startRun(h,await flow(h,denied),{invoice_id:invoiceId})).status,'succeeded')}
  assert.equal(fake.requests.length,before,'invalid inputs and missing native consent dispatch nothing');
  const other=await connection(h,{app:'paypal',auth_kind:'bearer',label:'Independent sandbox',scopes:[invoiceScope],secret:{token:'synthetic-crank-805'}}),otherFlow=await flow(h,other);
  fake.routes.set('api-m.sandbox.paypal.com',request=>{const second=request.headers.authorization==='Bearer synthetic-crank-805';assertRead(request,second?'synthetic-crank-805':'synthetic-crank-802');return second?jsonResponse({...invoice(),detail:{invoice_number:'synthetic-crank-other'},amount:{currency_code:'EUR',value:'0.00'}}):jsonResponse({},429,{'retry-after':'60'})});
  const [blocked,second]=await Promise.all([startRun(h,draft,{invoice_id:invoiceId}),startRun(h,otherFlow,{invoice_id:invoiceId})]);assert.equal(blocked.status,'waiting');assert.equal(second.status,'succeeded');assert.equal(result(second).record.number,'synthetic-crank-other');assert.equal(result(second).record.total,'0.00');assert.ok(!JSON.stringify(second).includes(invoiceNumber));
  await h.post(`connections/${c.id}/revoke`);const mark=fake.requests.length;await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+blocked.id)).status,'succeeded');assert.equal(fake.requests.length,mark,'revocation fences parked physical dispatch');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-802'},scopes:[invoiceScope]});
  fake.routes.set('api-m.sandbox.paypal.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-802'},scopes:[]});return jsonResponse(invoice())});
  const denied=await startRun(h,draft,{invoice_id:invoiceId});assert.notEqual(denied.status,'succeeded');assert.equal(result(denied),null,'withdrawn consent releases no in-flight invoice');assert.ok(!denied.steps.some(s=>s.step_id==='outcome'));
  assert.ok(fake.requests.every(r=>r.method==='GET'&&r.url.pathname==='/v2/invoicing/invoices/'+invoiceId),'zero provider mutations, redirects or other endpoints');
 }finally{await h.close()}
}

/** Recover one sandbox read through Cron, then retain and erase its sealed custody. */
export async function paypalCustodyJourney(){
 const {h,c,fake}=await fixture();let receiving,bad,erased;
 try {
  await h.post('data/attestations',{data_class:'financial',agreements:['Synthetic provider-edge data only'],data_location:'Local test database',confirm:'ATTEST'},h.owner,201);
  const w=await flow(h,c);await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'financial',identifier_fields:['number','invoice_number']});await h.post(`workflows/${w.id}/resume`);
  fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return jsonResponse({},429,{'retry-after':'60'})});
  const parked=await startRun(h,w,{invoice_id:invoiceId});assert.equal(parked.status,'waiting');const op=stepOf(parked,'search').operation_key,mark=fake.requests.length;
  fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return jsonResponse(invoice())});
  await h.restart({clock:later});await h.tick(Date.parse(later));const good=await h.get('workflow-runs/'+parked.id);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(result(good).record.total,'9007199254740993.0100');assert.equal(stepOf(good,'search').operation_key,op);assert.equal(fake.requests.length,mark+1,'one resumed physical request');await h.tick(Date.parse(later));assert.equal(fake.requests.length,mark+1);
  const step=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(good.id,'search').first();assert.equal(JSON.parse(step.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(step.output_json).sealed,'crank-payload-v1');
  const displayName='Synthetic invoice observer';await h.send('/auth/invite',{email:['synthetic-crank-observer','example.test'].join('@'),displayName,role:'member'},h.owner);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const person=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.displayName===displayName);await h.post('team/'+person.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(row=>!('input'in row)&&!('output'in row)));assert.ok(!JSON.stringify(restricted).includes(invoiceNumber));
  // Revoke consent while a response is in flight: its sealed checkpoint survives,
  // but neither its first consumption nor a cached retry may release the invoice.
  fake.routes.set('api-m.sandbox.paypal.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-802'},scopes:[]});return jsonResponse(invoice())});
  const cached=await startRun(h,w,{invoice_id:invoiceId});assert.notEqual(cached.status,'succeeded');assert.equal(result(cached),null);const count=fake.requests.length;
  await h.post(`workflow-runs/${cached.id}/resume`);assert.equal(fake.requests.length,count,'cached reads with withdrawn consent make no request');assert.equal(result(await h.get('workflow-runs/'+cached.id)),null);

  const chunks=(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(cached.id).all()).results;assert.ok(chunks.length);assert.ok(chunks.every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'),'unfinished invoice response is sealed');
  const metadata=await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(cached.id).first();assert.ok(!metadata.response_json.includes(invoiceId),'invoice identity is not retained in plaintext request URLs');
  const hold=await h.post('data/holds',{kind:'subject',subject:invoiceNumber,reason:'Invoice record review'},h.owner,201);await h.post(`workflows/${w.id}/pause`);
  const preview=await h.post('data/subject',{subject:invoiceNumber});assert.ok(preview.workflow_runs.some(row=>row.id===good.id));assert.equal(preview.blocked,true);await h.post('data/erase',{subject:invoiceNumber,digest:preview.digest,confirm:'ERASE'},h.owner,409);
  const policy={payload_days:1,attachment_days:null,history_days:30},dry=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:dry.digest});await h.tick(Date.parse('2026-11-12T15:04:00Z'));assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null,'holds preserve invoice results and checkpoint');
  const complete=await archive(h);for(const value of ['synthetic-crank-802',invoiceNumber,'synthetic-crank-private'])assert.ok(!complete.includes(value));
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:complete,confirm:'RESTORE'});
  const source=inventory(complete),restored=inventory(await archive(receiving)),extra=restored.filter(row=>!new Set(source).has(row));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(restored.filter(row=>row!==extra[0]),source,'complete sealed custody restores unchanged and without credentials');assert.equal(result(await receiving.get('workflow-runs/'+good.id)).sealed,true);
  const readCount=fake.requests.length;await receiving.restart();await receiving.tick(Date.parse(later));assert.equal(fake.requests.length,readCount);assert.ok((await receiving.get('connections')).every(row=>row.status==='needs_reconnect'));assert.ok((await receiving.get('workflows')).every(row=>['paused','draft'].includes(row.status)));
  for(const [label,change,move] of [
   ['foreign endpoint',row=>{const value=JSON.parse(row.response_json);value.url='https://evil.example/invoices';row.response_json=JSON.stringify(value)}],
   ['retained resource identity',row=>{const value=JSON.parse(row.response_json);value.url+='synthetic-crank-801';row.response_json=JSON.stringify(value)}],
   ['oversized response',row=>{const value=JSON.parse(row.response_json);value.body_bytes=262145;row.response_json=JSON.stringify(value)}],
   ['redirect',row=>{const value=JSON.parse(row.response_json);value.redirects=1;row.response_json=JSON.stringify(value)}],
   ['second request',row=>{row.ordinal=1},true],
   ['unselected header',row=>{const value=JSON.parse(row.response_json);value.headers=[['x-private','synthetic-crank-private']];row.response_json=JSON.stringify(value)}],
  ]){bad=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});const corrupt=await rewritten(complete,(table,row)=>{if(table==='crank_request_checkpoints')change(row);else if(move&&table==='crank_request_checkpoint_chunks')row.ordinal=1});await bad.post('data/restore',{archive:corrupt,confirm:'RESTORE'},bad.owner,400);assert.deepEqual(await bad.get('workflows'),[],label+' restore is atomic');await bad.close();bad=null}
  await h.post(`workflows/${w.id}/resume`);
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-802'},scopes:[invoiceScope]});const resumed=await h.post(`workflow-runs/${cached.id}/resume`);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.equal(result(resumed).record.total,'9007199254740993.0100');assert.equal(fake.requests.length,count,'restored consent consumes the exact retained response without repeating the read');
  await h.post(`workflows/${w.id}/pause`);
  await h.post(`data/holds/${hold.id}/release`);await h.tick(Date.parse('2026-11-12T15:04:00Z'));const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(result(expired),null);assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(good.id).first()).n,0);
  await h.post(`workflows/${w.id}/resume`);fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request);return jsonResponse(invoice())});const eraseMe=await startRun(h,w,{invoice_id:invoiceId});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);
  const erase=await h.post('data/subject',{subject:invoiceNumber});assert.equal(erase.blocked,false);assert.ok(erase.workflow_runs.some(row=>row.id===eraseMe.id));await h.post('data/erase',{subject:invoiceNumber,digest:erase.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await erased.post('data/restore',{archive:complete,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'old captures cannot resurrect erased invoices');assert.ok(fake.requests.every(row=>row.method==='GET'));
 }finally{await bad?.close();await erased?.close();await receiving?.close();await h.close()}
}

export async function paypalOwnership(h,fake){
 fake.routes.set('api-m.sandbox.paypal.com',request=>{assertRead(request,'synthetic-crank-806');return jsonResponse(invoice())});
 const c=await connection(h,{app:'paypal',auth_kind:'bearer',label:'Owned PayPal sandbox',scopes:[invoiceScope],secret:{token:'synthetic-crank-806'}}),w=await flow(h,c),run=await startRun(h,w,{invoice_id:invoiceId});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(result(run).record.total,'9007199254740993.0100');return ['paypal.find_invoice'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await paypalSearchJourney();await paypalCustodyJourney();console.log('PayPal exact invoice outcomes, current authority, admitted recovery and sealed inactive custody PASS')}
