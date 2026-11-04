import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
export const contactScope='crm.objects.contacts.read';
export const address=['synthetic-crank-person','example.test'].join('@');
export const hostileName='<img src=x onerror="globalThis.hubspotInjected=true"> synthetic-crank-name';
export const contact=(id,mail=address,name=hostileName)=>({id,properties:{email:mail,firstname:name,lastname:'synthetic-crank-family',unselected:'synthetic-crank-private'},archived:false});
export const hubspotStep=id=>({id:'search',name:'HubSpot contact lookup',type:'hubspot.find_contact',connection_id:id,no_match:'continue',multi_match:'all',limit:10,sort:{field:'id',direction:'asc'},max_pages:3,retry_policy:{read_attempts:2,base_delay_ms:1},input:{email:'{{trigger.input.email}}'}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'map',input:{outcome:'{{steps.search.outcome}}',count:'{{steps.search.count}}'}}]});
const result=run=>stepOf(run,'search').output;
function assertRead(request,token='synthetic-crank-701') {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.url.origin,'https://api.hubapi.com');assert.equal(request.url.pathname,'/crm/v3/objects/contacts');
 assert.equal(request.headers.authorization,'Bearer '+token);assert.equal(request.url.searchParams.get('limit'),'100');assert.equal(request.url.searchParams.get('properties'),'email,firstname,lastname');assert.equal(request.url.searchParams.get('archived'),'false');
 assert.ok([...request.url.searchParams.keys()].every(key=>['limit','properties','archived','after'].includes(key)),'no query addresses or arbitrary endpoint parameters are transmitted');
}
async function fixture() {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'hubspot',auth_kind:'oauth2',label:'Selected CRM',scopes:[contactScope],secret:{access_token:'synthetic-crank-701'}});
 let mode='pages';
 fake.routes.set('api.hubapi.com',request=>{
  assertRead(request);
  const after=request.url.searchParams.get('after');
  if(mode==='empty')return jsonResponse({results:[]});
  if(mode==='one')return jsonResponse({results:[contact('synthetic-crank-b')]});
  if(mode==='park'&&after)return jsonResponse({},429,{'retry-after':'60'});
  return jsonResponse(after?{results:[contact('synthetic-crank-b'),contact('synthetic-crank-a',' '+address.toUpperCase()+' '),contact('synthetic-crank-b')]}:{results:[contact('synthetic-crank-unmatched',['other','example.test'].join('@'))],paging:{next:{after:'synthetic-crank-page',link:'https://evil.example/mutations'}}});
 });
 return {h,c,fake,setMode(value){mode=value}};
}
const flow=(h,c,patch={})=>publish(h,'HubSpot read only contact lookup',graph({...hubspotStep(c.id),...patch}));

/** Native draft-test, publication, HTTP run and Cron; only the provider edge is faked. */
export async function hubspotSearchJourney({onScreen}={}) {
 const f=await fixture(),{h,c,fake}=f;
 try {
  // Seed a real polling baseline through its native Cron door, then pause it.
  const contactsEdge=fake.routes.get('api.hubapi.com');
  fake.routes.set('api.hubapi.com',request=>request.url.pathname.endsWith('/deals')?jsonResponse({results:[{id:'synthetic-crank-poll',updatedAt:clock,properties:{dealstage:'open'}}]}):contactsEdge(request));
  const poll=await publish(h,'Independent CRM baseline',{trigger:{type:'app_poll',provider:'hubspot',resource:'deals',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['dealstage']},steps:[]});
  await h.tick(Date.parse(clock)+60001);await h.post(`workflows/${poll.id}/pause`);
  const pollRows=async()=>inventory(await archive(h)).filter(row=>/^crank_app_|^crank_polls$/.test(JSON.parse(row).table));
  const baseline=await pollRows();assert.ok(baseline.some(row=>JSON.parse(row).table==='crank_app_snapshots'),'poll comparison data is populated');
  fake.requests.length=0;fake.routes.set('api.hubapi.com',contactsEdge);
  const draft=await h.post('workflows',{name:'HubSpot exact email review',graph:graph(hubspotStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{email:address}},h.owner,201);assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assert.equal(result(tested).count,2);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{email:address}),output=result(good);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(output.pages,2);assert.equal(output.complete,true);assert.deepEqual(output.records.map(r=>r.id),['synthetic-crank-a','synthetic-crank-b']);assert.equal(output.records[0].first_name,hostileName);assert.equal(output.records[0].last_name,'synthetic-crank-family');assert.equal(stepOf(good,'outcome').output.outcome,'found');
  for(const discarded of ['synthetic-crank-private','https://evil.example','synthetic-crank-701'])assert.ok(!JSON.stringify(good).includes(discarded));
  const retained=inventory(await archive(h)).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks');for(const chunk of retained)assert.ok(!Buffer.from(chunk.row.content_base64,'base64').toString().includes('synthetic-crank-private'),'unsolicited properties never enter checkpoint custody');
  const disclosure=(await h.get('data/flows')).flows.find(row=>row.kind==='hubspot.find_contact');assert.deepEqual(disclosure.recipients,['https://api.hubapi.com']);for(const key of ['email','properties','after'])assert.ok(disclosure.fields.includes(key));assert.match(disclosure.credentials,/oauth/i);assert.match(disclosure.region,/not verified/);assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(address));
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  for(const patch of [{multi_match:'first',sort:{field:'id',direction:'desc'}},{multi_match:'stop'},{multi_match:'stop',on_multiple:'continue'},{limit:1}]) {
   const run=await startRun(h,await flow(h,c,patch),{email:address});
   assert.equal(run.status,patch.multi_match==='stop'&&!patch.on_multiple?'stopped_by_search':'succeeded',JSON.stringify(run.error));
   if(patch.multi_match==='first'){assert.equal(result(run).record.id,'synthetic-crank-b');assert.equal(result(run).count,2);assert.equal(result(run).pages,2,'first waits for the complete scan')}
   if(patch.multi_match==='stop'){assert.equal(result(run).outcome,'multiple matches');assert.equal(run.steps.some(s=>s.step_id==='outcome'),!!patch.on_multiple)}
   if(patch.limit){assert.equal(result(run).outcome,'truncated');assert.equal(result(run).complete,true);assert.equal(result(run).count,1)}
  }
  const incomplete=await startRun(h,await flow(h,c,{max_pages:1}),{email:address});assert.equal(incomplete.status,'succeeded');assert.equal(result(incomplete).complete,false);assert.equal(result(incomplete).outcome,'truncated');assert.equal(result(incomplete).count,0,'an incomplete empty result is not absence');
  for(const multi_match of ['first','stop']) {
   const w=await flow(h,c,{multi_match,max_pages:1}),run=await startRun(h,w,{email:address});assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/);assert.ok(!run.steps.some(s=>s.step_id==='outcome'));
   if(onScreen&&multi_match==='first')await onScreen({h,w,run,state:'incomplete'});
  }
  f.setMode('empty');for(const no_match of ['halt','continue']){const run=await startRun(h,await flow(h,c,{no_match}),{email:address});assert.equal(run.status,no_match==='halt'?'stopped_by_search':'succeeded');assert.equal(result(run).outcome,'not found');assert.equal(result(run).complete,true);assert.equal(run.steps.some(s=>s.step_id==='outcome'),no_match==='continue')}
  f.setMode('one');assert.equal(result(await startRun(h,draft,{email:address})).count,1);
  // Exact whole-address equality, including aliases, and absent optional fields.
  fake.routes.set('api.hubapi.com',request=>{assertRead(request);return jsonResponse({results:[contact('synthetic-crank-exact',address.toUpperCase()),contact('synthetic-crank-prefix','prefix'+address),contact('synthetic-crank-alias',address.replace('@','+alias@')),{id:'synthetic-crank-empty',properties:{email:null}},{id:'synthetic-crank-missing',properties:{}}]})});
  const exact=await startRun(h,draft,{email:' '+address+' '});assert.equal(exact.status,'succeeded');assert.equal(result(exact).count,1);assert.equal(result(exact).record.id,'synthetic-crank-exact');
  const wrongs=[['bad JSON',()=>new Response('{')],['bad results',()=>jsonResponse({results:{}})],['oversized page',()=>jsonResponse({results:Array(101).fill(contact('synthetic-crank-a'))})],['invalid id',()=>jsonResponse({results:[{...contact('synthetic-crank-a'),id:0}]})],['bad email',()=>jsonResponse({results:[contact('synthetic-crank-a','bad')]})],['bad name',()=>jsonResponse({results:[contact('synthetic-crank-a',address,42)]})],['bad cursor',()=>jsonResponse({results:[],paging:{next:{after:{}}}})],['loop',()=>jsonResponse({results:[],paging:{next:{after:'same'}}})],['conflicting id',request=>jsonResponse(request.url.searchParams.has('after')?{results:[contact('synthetic-crank-a',address,'changed')]}:{results:[contact('synthetic-crank-a')],paging:{next:{after:'next'}}})],['provider failure',()=>jsonResponse({message:'synthetic-crank-private'},500)],['permission failure',()=>jsonResponse({},403)],['redirect',()=>new Response('',{status:302,headers:{location:'https://evil.example/write'}})]];
  for(const [label,reply] of wrongs){fake.routes.set('api.hubapi.com',request=>{assertRead(request);return reply(request)});const run=await startRun(h,draft,{email:address});assert.notEqual(run.status,'succeeded',label);assert.notEqual(run.status,'stopped_by_search',label);assert.ok(!run.steps.some(s=>s.step_id==='outcome'),label)}
  const before=fake.requests.length;
  for(const input of [{email:''},{email:42},{email:null},{email:['synthetic-crank-a']},{email:'not an email'}]){const run=await startRun(h,draft,input);assert.equal(run.status,'failed');assert.equal(run.error.category,'validation')}
  for(const patch of [{create_if_not_found:{}},{max_pages:0},{input:{email:address,query:'ignored'}},{sort:{field:'email',direction:'asc'}},{input:{email:42}}])await h.post('workflows',{name:'Unsupported HubSpot lookup',graph:graph({...hubspotStep(c.id),...patch})},h.owner,422);
  assert.equal(fake.requests.length,before,'invalid declarations and resolved inputs make no provider request');
  for(const options of [{app:'hubspot',auth_kind:'oauth2',scopes:['crm.objects.contacts.write'],secret:{access_token:'synthetic-crank-702'}},{app:'http',auth_kind:'bearer',domains:['api.hubapi.com'],secret:{token:'synthetic-crank-703'}}]) {
   const denied=await connection(h,{label:'No contact read authority',...options});assert.notEqual((await startRun(h,await flow(h,denied),{email:address})).status,'succeeded');
  }
  assert.equal(fake.requests.length,before,'write scope and arbitrary credentials do not supply contact-read authority');
  assert.deepEqual(await pollRows(),baseline,'contact lookup never advances or changes existing polling snapshots and cursors');
  // A throttled account does not block another selected connection.
  const other=await connection(h,{app:'hubspot',auth_kind:'oauth2',label:'Independent CRM',scopes:[contactScope],secret:{access_token:'synthetic-crank-704'}}),otherFlow=await flow(h,other);
  fake.routes.set('api.hubapi.com',request=>{const second=request.headers.authorization==='Bearer synthetic-crank-704';assertRead(request,second?'synthetic-crank-704':'synthetic-crank-701');return second?jsonResponse({results:[contact('synthetic-crank-other',address,'synthetic-crank-other-person')]}):jsonResponse({},429,{'retry-after':'60'})});
  const [blocked,second]=await Promise.all([startRun(h,draft,{email:address}),startRun(h,otherFlow,{email:address})]);assert.equal(blocked.status,'waiting');assert.equal(second.status,'succeeded');assert.equal(result(second).record.id,'synthetic-crank-other');assert.ok(!JSON.stringify(second).includes(hostileName));
  await h.post(`connections/${c.id}/revoke`);const count=fake.requests.length;await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+blocked.id)).status,'succeeded');assert.equal(fake.requests.length,count,'revocation refuses pending dispatch');
  await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:[contactScope]});
  // Scope reduction between pages refuses the next dispatch.
  fake.routes.set('api.hubapi.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:['crm.objects.contacts.write']});return jsonResponse({results:[contact('synthetic-crank-a')],paging:{next:{after:'next'}}})});
  const denied=await startRun(h,draft,{email:address});assert.notEqual(denied.status,'succeeded');assert.equal(fake.requests.length,count+1);
  // Consent withdrawn while the last response is in flight cannot release it.
  await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:[contactScope]});
  fake.routes.set('api.hubapi.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:['crm.objects.contacts.write']});return jsonResponse({results:[contact('synthetic-crank-last-page')]})});
  const last=await startRun(h,draft,{email:address});assert.notEqual(last.status,'succeeded','read consent must still hold when the final page is consumed');assert.ok(!last.steps.some(s=>s.step_id==='outcome'));assert.equal(result(last),null,'a withdrawn read grant releases no contact result');
  await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:[contactScope]});
  fake.routes.set('api.hubapi.com',async request=>{assertRead(request);await h.post(`workflows/${draft.id}/pause`);return jsonResponse({results:[contact('synthetic-crank-paused')]})});
  const paused=await startRun(h,draft,{email:address});assert.notEqual(paused.status,'succeeded');assert.equal(result(paused),null,'pausing an in-flight lookup releases no result');assert.ok(!paused.steps.some(s=>s.step_id==='outcome'));
  assert.ok(fake.requests.every(r=>r.method==='GET'&&r.url.pathname==='/crm/v3/objects/contacts'),'zero provider mutations or other resource reads');
 }finally{await h.close()}
}

export async function hubspotCustodyJourney() {
 const f=await fixture(),{h,c,fake}=f;let receiving,erased,bad;
 try {
  const w=await flow(h,c);await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['firstname']});await h.post(`workflows/${w.id}/resume`);
  f.setMode('park');const parked=await startRun(h,w,{email:address});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));
  const chunks=async()=> (await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(parked.id).all()).results;
  assert.ok((await chunks()).length);assert.ok((await chunks()).every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'),'unfinished projected pages are sealed');
  const hold=await h.post('data/holds',{kind:'subject',subject:hostileName,reason:'CRM record review'},h.owner,201);await h.post(`workflows/${w.id}/pause`);
  const unfinished=await h.post('data/subject',{subject:hostileName});assert.ok(unfinished.workflow_runs.some(row=>row.id===parked.id&&/legal hold/.test(row.blocked)));await h.post('data/erase',{subject:hostileName,digest:unfinished.digest,confirm:'ERASE'},h.owner,409);await h.post(`workflows/${w.id}/resume`);
  const checkpoint=await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(parked.id).first();assert.ok(!checkpoint.response_json.includes('synthetic-crank-page'));assert.ok(!checkpoint.response_json.includes(address));
  const saved=await archive(h);for(const value of ['synthetic-crank-701',hostileName,'synthetic-crank-private'])assert.ok(!saved.includes(value));
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),returned=inventory(await archive(receiving)),extra=returned.filter(row=>!new Set(original).has(row));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(returned.filter(row=>row!==extra[0]),original,'every unfinished page and portable record restores unchanged');
  const before=fake.requests.length;await receiving.restart();await receiving.tick(Date.parse(later));assert.equal(fake.requests.length,before);assert.ok((await receiving.get('connections')).every(row=>row.status==='needs_reconnect'));assert.ok((await receiving.get('workflows')).every(row=>['paused','draft'].includes(row.status)));
  for(const [label,change,movePage] of [
   ['foreign endpoint',row=>{const value=JSON.parse(row.response_json);value.url='https://evil.example/contacts';row.response_json=JSON.stringify(value)}],
   ['oversized page',row=>{const value=JSON.parse(row.response_json);value.body_bytes=262145;row.response_json=JSON.stringify(value)}],
   ['followed redirect',row=>{const value=JSON.parse(row.response_json);value.redirects=1;row.response_json=JSON.stringify(value)}],
   ['page outside declared scan',row=>{row.ordinal=3},true],
   ['unselected header',row=>{const value=JSON.parse(row.response_json);value.headers=[['x-unselected','synthetic-crank-private']];row.response_json=JSON.stringify(value)}],
  ]) {
   bad=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});const corrupt=await rewritten(saved,(table,row)=>{if(table==='crank_request_checkpoints')change(row);else if(movePage&&table==='crank_request_checkpoint_chunks')row.ordinal=3});await bad.post('data/restore',{archive:corrupt,confirm:'RESTORE'},bad.owner,400);assert.deepEqual(await bad.get('workflows'),[],label+' restore is atomic');await bad.close();bad=null;
  }
  // Cached-page consumption is also refused when current read scope is gone.
  await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:['crm.objects.contacts.write']});await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+parked.id)).status,'succeeded');assert.equal(fake.requests.length,before);
  assert.equal((await h.post(`workflow-runs/${parked.id}/cancel`)).status,'cancelled');
  // A separate parked run continues using its completed first page after restart.
  await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-701'},scopes:[contactScope]});
  const pending=await startRun(h,w,{email:address});assert.equal(pending.status,'waiting');const mark=fake.requests.length,op=stepOf(pending,'search').operation_key;
  fake.routes.set('api.hubapi.com',request=>{assertRead(request);assert.equal(request.url.searchParams.get('after'),'synthetic-crank-page','completed first page is never repeated');return jsonResponse({results:[contact('synthetic-crank-a')]})});
  await h.restart({clock:'2026-11-10T15:04:00Z'});await h.tick(Date.parse('2026-11-10T15:04:00Z'));const good=await h.get('workflow-runs/'+pending.id);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(result(good).record.id,'synthetic-crank-a');assert.equal(stepOf(good,'search').operation_key,op);assert.equal(fake.requests.length,mark+1);
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(good.id,'search').first();assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(stored.output_json).sealed,'crank-payload-v1');
  const displayName='Synthetic CRM observer';await h.send('/auth/invite',{email:['synthetic-crank-observer','example.test'].join('@'),displayName,role:'member'},h.owner);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const person=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.displayName===displayName);await h.post('team/'+person.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(row=>!('input'in row)&&!('output'in row)));assert.ok(!JSON.stringify(restricted).includes(hostileName));
  await h.post(`workflows/${w.id}/pause`);
  const preview=await h.post('data/subject',{subject:hostileName});assert.ok(preview.workflow_runs.some(row=>row.id===good.id));assert.equal(preview.blocked,true);await h.post('data/erase',{subject:hostileName,digest:preview.digest,confirm:'ERASE'},h.owner,409);
  const policy={payload_days:1,attachment_days:null,history_days:30},dry=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:dry.digest});await h.tick(Date.parse('2026-11-12T15:04:00Z'));assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null,'legal holds preserve search results and pages');
  const complete=await archive(h);await receiving.close();receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:complete,confirm:'RESTORE'});
  const source=inventory(complete),restored=inventory(await archive(receiving)),added=restored.filter(row=>!new Set(source).has(row));assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(restored.filter(row=>row!==added[0]),source,'complete sealed results and pages restore without credentials');assert.equal(stepOf(await receiving.get('workflow-runs/'+good.id),'search').output.sealed,true);
  await h.post(`data/holds/${hold.id}/release`);await h.tick(Date.parse('2026-11-12T15:04:00Z'));const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(result(expired),null);assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(good.id).first()).n,0);
  await h.post(`workflows/${w.id}/resume`);fake.routes.set('api.hubapi.com',request=>{assertRead(request);return jsonResponse({results:[contact('synthetic-crank-erase')]})});const eraseMe=await startRun(h,w,{email:address});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);
  const erase=await h.post('data/subject',{subject:hostileName});assert.equal(erase.blocked,false);assert.ok(erase.workflow_runs.some(row=>row.id===eraseMe.id));await h.post('data/erase',{subject:hostileName,digest:erase.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await erased.post('data/restore',{archive:complete,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'old captures cannot resurrect erased contacts');
  assert.ok(fake.requests.every(row=>row.method==='GET'));
 }finally{await bad?.close();await erased?.close();await receiving?.close();await h.close()}
}

export async function hubspotOwnership(h,fake) {
 fake.routes.set('api.hubapi.com',request=>{assertRead(request,'synthetic-crank-705');return jsonResponse({results:[contact('synthetic-crank-owned')]})});
 const c=await connection(h,{app:'hubspot',auth_kind:'oauth2',label:'Owned CRM',scopes:[contactScope],secret:{access_token:'synthetic-crank-705'}}),w=await flow(h,c),run=await startRun(h,w,{email:address});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(result(run).record.id,'synthetic-crank-owned');return ['hubspot.find_contact'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await hubspotSearchJourney();await hubspotCustodyJourney();console.log('HubSpot exact search outcomes, authority, admitted recovery and sealed inactive custody PASS')}
