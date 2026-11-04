import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:01:01Z';
const project='12001',scope='tasks:read',readCredential='synthetic-crank-asana-701';
const offset='synthetic-crank-page+/=&?%';
const fields='gid,resource_type,name,completed,due_on,due_at,permalink_url';
export const hostileName='<img src=x onerror="globalThis.asanaInjected=true"> synthetic-crank-task';
export const asanaStep=connection_id=>({id:'search',name:'Asana exact task search',type:'asana.find_task',connection_id,multi_match:'all',limit:10,sort:{field:'id',direction:'asc'},retry_policy:{read_attempts:2,base_delay_ms:1},input:{project_id:project,name:hostileName}});
const tasks=[
 {gid:'12011',resource_type:'task',name:hostileName,completed:false,due_on:null,due_at:null,permalink_url:null},
 {gid:'12012',resource_type:'task',name:hostileName,completed:true,due_on:'2026-11-12',due_at:'2026-11-12T15:30:00Z',permalink_url:'https://app.asana.com/0/12001/12012'},
 {gid:'12013',resource_type:'task',name:hostileName,permalink_url:'https://app.asana.com/1/12000/task/12013'},
];
const unrelated={gid:'12010',resource_type:'task',name:'Unrelated task'};
const found=run=>stepOf(run,'search')?.output;
const downstream={id:'outcome',type:'map',input:{outcome:'{{steps.search.outcome}}',count:'{{steps.search.count}}'}};
const graph=(c,patch={},after=[downstream])=>({trigger:{type:'manual'},steps:[{...asanaStep(c.id),...patch},...after]});
const flow=(h,c,patch={},after)=>publish(h,'Find exact Asana task',graph(c,patch,after));
const page=(data,next_page=null)=>({data,next_page});
function nextPage(request,value=offset) {
 const url=new URL(request.url);url.searchParams.set('offset',value);
 return {offset:value,path:url.pathname.replace(/^\/api\/1\.0/,'')+url.search,uri:url.href};
}
function assertRead(request,credential=readCredential,projectId=project) {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.headers.authorization,'Bearer '+credential);
 assert.equal(request.url.origin,'https://app.asana.com');assert.equal(request.url.pathname,`/api/1.0/projects/${projectId}/tasks`);
 assert.deepEqual([...request.url.searchParams.keys()].sort(),['completed_since','limit','opt_fields',...(request.url.searchParams.has('offset')?['offset']:[])].sort());
 assert.equal(request.url.searchParams.get('limit'),'100');assert.equal(request.url.searchParams.get('opt_fields'),fields);assert.equal(request.url.searchParams.get('completed_since'),'1970-01-01T00:00:00.000Z');
}
async function fixture() {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'asana',auth_kind:'bearer',label:'Selected Asana account',scopes:[scope],secret:{token:readCredential}});
 return {h,c,fake};
}
function installPages(fake) {
 fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(request.url.searchParams.has('offset')?page([tasks[0],tasks[1],tasks[2]]):page([unrelated,tasks[2]],nextPage(request)))});
}
function assertNoDecision(run,label) {
 assert.equal(run.status,'failed',label);assert.equal(found(run),null,label);assert.equal(stepOf(run,'outcome'),undefined,label);
}
function assertInventory(source,received) {
 const original=inventory(source),actual=inventory(received),known=new Set(original),added=actual.filter(row=>!known.has(row));
 assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(actual.filter(row=>row!==added[0]),original,'all portable records round trip');
}

/** Native draft tests, publication and HTTP execution; providers alone are faked. */
export async function asanaSearchJourney({onScreen}={}) {
 const {h,c,fake}=await fixture();
 try {
  installPages(fake);
  const draft=await h.post('workflows',{name:'Asana exact task review',graph:graph(c,{input:{project_id:project,name:'{{trigger.input.name}}'}})},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{name:hostileName}},h.owner,201);
  assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const calls=fake.requests.length,complete=await startRun(h,draft,{name:hostileName}),output=found(complete);
  assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));assert.equal(fake.requests.length,calls+2);
  assert.deepEqual(output.records.map(record=>record.id),['12011','12012','12013']);assert.equal(output.count,3);assert.equal(output.outcome,'found');assert.equal(output.complete,true);assert.equal(output.pages,2);assert.equal(output.project_id,project);assert.equal(output.truncated,false);
  assert.deepEqual(output.records[0],{id:'12011',...tasks[0],project_id:project});assert.deepEqual(output.records[1],{id:'12012',...tasks[1],project_id:project});assert.deepEqual(output.records[2],{id:'12013',...tasks[2],project_id:project},'missing optional fields stay missing');
  assert.deepEqual(stepOf(complete,'outcome').output,{outcome:'found',count:3});assert.ok(!JSON.stringify(complete).includes(readCredential));
  if(onScreen)await onScreen({h,w:draft,run:complete,state:'complete'});
  for(const direction of ['asc','desc']) {
   const first=await startRun(h,await flow(h,c,{multi_match:'first',sort:{field:'id',direction}}),{});
   assert.equal(first.status,'succeeded');assert.equal(found(first).record.id,direction==='asc'?'12011':'12013');assert.equal(found(first).count,3);
  }
  const stopped=await startRun(h,await flow(h,c,{multi_match:'stop'}),{});assert.equal(stopped.status,'stopped_by_search');assert.equal(found(stopped).outcome,'multiple matches');assert.equal(stepOf(stopped,'outcome'),undefined);
  const continued=await startRun(h,await flow(h,c,{multi_match:'stop',on_multiple:'continue'}),{});assert.equal(continued.status,'succeeded');assert.equal(found(continued).record,null);assert.deepEqual(stepOf(continued,'outcome').output,{outcome:'multiple matches',count:3});
  const limited=await startRun(h,await flow(h,c,{limit:2}),{});assert.equal(found(limited).outcome,'truncated');assert.equal(found(limited).truncated,true);assert.equal(found(limited).complete,true);assert.equal(found(limited).count,2);assert.equal(found(limited).pages,2);
  for(const multi_match of ['all','first','stop']) {
   const w=await flow(h,c,{multi_match,max_pages:1}),incomplete=await startRun(h,w,{});assertNoDecision(incomplete,multi_match);assert.match(incomplete.error.message,/incomplete/i);
   if(onScreen&&multi_match==='all')await onScreen({h,w,run:incomplete,state:'incomplete'});
  }
  // Equality is exact: whitespace, case and provider query syntax are not normalized.
  for(const name of [hostileName.toUpperCase(),' '+hostileName,hostileName+' ']) {
   const miss=await startRun(h,draft,{name});assert.equal(miss.status,'succeeded');assert.equal(found(miss).outcome,'not found');assert.deepEqual(found(miss).records,[]);assert.equal(found(miss).complete,true);
  }
  fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(page([]))});
  const halted=await startRun(h,await flow(h,c,{no_match:'halt'}),{});assert.equal(halted.status,'stopped_by_search');assert.equal(found(halted).outcome,'not found');assert.equal(found(halted).pages,1);assert.equal(found(halted).complete,true);
  const absent=await startRun(h,draft,{name:hostileName});assert.equal(found(absent).record,null);assert.deepEqual(found(absent).records,[]);assert.equal(found(absent).count,0);
  fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(page([tasks[0]]))});
  const one=await startRun(h,draft,{name:hostileName});assert.equal(found(one).count,1);assert.equal(found(one).record.id,'12011');assert.equal(found(one).record.completed,false);
  // A match only on page two must still be found; nonmatching records are validated too.
  fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(request.url.searchParams.has('offset')?page([tasks[1]]):page([unrelated],nextPage(request)))});
  const late=await startRun(h,draft,{name:hostileName});assert.equal(found(late).count,1);assert.equal(found(late).record.id,'12012');assert.equal(found(late).pages,2);
  // API-relative paths and full API paths retain the exact mapped permalink.
  for(const [pathPrefix,permalink] of [
   ['',tasks[2].permalink_url],
   ['/api/1.0','https://app.asana.com/1/12000/project/12001/task/12013/f'],
   ['/api/1.0','https://app.asana.com/0/12001/12013/f'],
   ['',undefined],
  ]) {
   fake.routes.set('app.asana.com',request=>{
    assertRead(request);
    if(request.url.searchParams.has('offset'))return jsonResponse(page([{...tasks[2],permalink_url:permalink}]));
    const next=nextPage(request);next.path=pathPrefix+next.path;
    return jsonResponse(page([unrelated],next));
   });
   const mapped=await startRun(h,draft,{name:hostileName}),result=found(mapped);
   assert.equal(mapped.status,'succeeded',JSON.stringify(mapped.error));assert.equal(result.pages,2);assert.equal(result.count,1);assert.equal(result.record.id,'12013');
   if(permalink===undefined)assert.ok(!('permalink_url'in result.record),'missing optional permalink stays missing');
   else assert.equal(result.record.permalink_url,permalink,'the exact provider URL remains a mapped output');
  }
  const badTask=patch=>()=>jsonResponse(page([{...tasks[0],...patch}]));
  const invalidResponses=[
   ['invalid JSON',()=>new Response('not JSON')],['missing data',()=>jsonResponse({next_page:null})],['data shape',()=>jsonResponse(page({}))],['missing next_page',()=>jsonResponse({data:[]})],
   ['missing gid',badTask({gid:undefined})],['nonnumeric gid',badTask({gid:'task-a'})],['wrong resource type',badTask({resource_type:'project'})],['missing name',badTask({name:undefined})],['wrong completed type',badTask({completed:'false'})],['null completed',badTask({completed:null})],
   ['bad due date',badTask({due_on:'2026-02-30'})],['bad due timestamp',badTask({due_at:'tomorrow'})],['unsafe permalink',badTask({permalink_url:'javascript:alert(1)'})],['foreign permalink',badTask({permalink_url:'https://app.asana.com.evil.test/0/12001/12011'})],['wrong task permalink',badTask({permalink_url:'https://app.asana.com/0/12001/12012'})],['wrong canonical task permalink',badTask({permalink_url:'https://app.asana.com/1/12000/task/12012'})],['foreign canonical permalink',badTask({permalink_url:'https://evil.example/1/12000/task/12011'})],
   ['too many tasks',()=>jsonResponse(page(Array(101).fill(tasks[0])))],['provider error',()=>jsonResponse({},500)],['permission refused',()=>jsonResponse({},403)],
   ['invalid next page',()=>jsonResponse(page([],{offset:42}))],['blank cursor',()=>jsonResponse(page([],{offset:''}))],['control cursor',()=>jsonResponse(page([],{offset:'bad\ncursor'}))],['long cursor',()=>jsonResponse(page([],{offset:'x'.repeat(2049)}))],
   ['cursor loop',()=>jsonResponse(page([tasks[0]],{offset}))],
   ['changed duplicate',request=>jsonResponse(request.url.searchParams.has('offset')?page([{...tasks[2],completed:true}]):page([tasks[2]],nextPage(request)))],
   ['malformed nonmatch',()=>jsonResponse(page([{...unrelated,completed:'yes'}]))],
  ];
  for(const [label,reply] of invalidResponses) {
   fake.routes.set('app.asana.com',request=>{assertRead(request);return reply(request)});
   const bad=await startRun(h,draft,{name:hostileName});assertNoDecision(bad,label);assert.notEqual(bad.error.category,'not_found',label);
  }
  for(const [label,alter] of [
   ['network-relative path',next=>({...next,path:'//evil.example'+next.path})],
   ['absolute path metadata',next=>({...next,path:next.uri})],
   ['foreign origin',next=>({...next,uri:next.uri.replace('app.asana.com','evil.example')})],
   ['foreign project',next=>({...next,path:next.path.replace('/12001/','/12002/')})],
   ['escaped endpoint',next=>({...next,path:next.path.replace('/12001/tasks','/12001/../users')})],
   ['extra query',next=>({...next,uri:next.uri+'&workspace=12002'})],
   ['changed offset',next=>({...next,uri:next.uri.replace('offset=','offset=other')})],
   ['missing query',next=>({...next,path:'/api/1.0/projects/12001/tasks?offset='+encodeURIComponent(offset)})],
   ['URL fragment',next=>({...next,uri:next.uri+'#ignored'})],
  ]) {
   const before=fake.requests.length;fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(page([tasks[0]],alter(nextPage(request))))});
   assertNoDecision(await startRun(h,draft,{name:hostileName}),label);assert.equal(fake.requests.length,before+1,label+' is rejected before another dispatch');
  }
  const before=fake.requests.length;
  for(const patch of [{create_if_not_found:{}},{max_pages:0},{max_pages:21},{sort:undefined},{sort:{field:'name',direction:'asc'}},{sort:{field:'id',direction:'sideways'}},{connection_id:'{{trigger.input.connection}}'},{input:{project_id:12001,name:'task'}},{input:{project_id:'12001/../12002',name:'task'}},{input:{project_id:'{{trigger.input.project}}',name:'task'}},{input:{project_id:project,name:' '}},{input:{project_id:project,name:42}},{input:{project_id:project,name:'x'.repeat(8193)}},{input:{project_id:project,name:'task',workspace_id:'12002'}}]) {
   await h.post('workflows',{name:'Invalid Asana task search',graph:graph(c,patch)},h.owner,422);
  }
  for(const name of ['', ' ',42,null]) {const bad=await startRun(h,draft,{name});assertNoDecision(bad,'mapped name validation');assert.equal(bad.error.category,'validation')}
  for(const account of [
   await connection(h,{app:'asana',auth_kind:'bearer',label:'No task authority',scopes:[],secret:{token:'synthetic-crank-asana-702'}}),
   await connection(h,{app:'http',auth_kind:'bearer',label:'Arbitrary bearer',domains:['app.asana.com'],secret:{token:'synthetic-crank-asana-703'}}),
  ])assert.notEqual((await startRun(h,await flow(h,account),{})).status,'succeeded');
  for(const input of [{method:'POST',url:`https://app.asana.com/api/1.0/projects/${project}/tasks`,body:{name:'Unauthorized write'}},{method:'GET',url:'https://app.asana.com/api/1.0/users/me'}]) {
   const denied=await startRun(h,await publish(h,'Asana credential cannot become arbitrary HTTP',{trigger:{type:'manual'},steps:[{id:'request',type:'http',connection_id:c.id,input}]}),{});assert.notEqual(denied.status,'succeeded');
  }
  assert.equal(fake.requests.length,before,'invalid inputs, missing consent and credential escape never reach Asana');
  const other=await connection(h,{app:'asana',auth_kind:'bearer',label:'Separate Asana account',scopes:[scope],secret:{token:'synthetic-crank-asana-704'}});
  fake.routes.set('app.asana.com',request=>{assertRead(request,'synthetic-crank-asana-704','12002');return jsonResponse(page([{gid:'12021',resource_type:'task',name:hostileName}]))});
  const isolated=await startRun(h,await flow(h,other,{input:{project_id:'12002',name:hostileName}}),{});assert.equal(isolated.status,'succeeded');assert.equal(found(isolated).record.id,'12021');assert.equal(found(isolated).record.project_id,'12002');assert.ok(!JSON.stringify(complete).includes('12021'));
  // A completed page cannot be combined with a replacement token's results.
  fake.routes.set('app.asana.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-705'},scopes:[scope]});return jsonResponse(page([tasks[0]],nextPage(request)))});
  const priorCalls=fake.requests.length;const changed=await startRun(h,draft,{name:hostileName});assert.equal(changed.status,'paused');assert.equal(found(changed),null);assert.equal(fake.requests.length,priorCalls+1,'replacement credentials never dispatch a later page of the old scan');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:readCredential},scopes:[scope]});
  const disclosure=(await h.get('data/flows')).flows.find(item=>item.kind==='asana.find_task');assert.deepEqual(disclosure.recipients,['https://app.asana.com']);for(const field of ['project_id','name','offset'])assert.ok(disclosure.fields.includes(field));assert.match(disclosure.region,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(hostileName));
  assert.ok(fake.requests.every(request=>request.method==='GET'&&request.url.pathname.match(/^\/api\/1\.0\/projects\/\d+\/tasks$/)),'native search dispatches only the fixed read endpoint');
 }finally{await h.close()}
}

/** Durable sealed pages, Cron recovery, access boundaries and portable custody. */
export async function asanaSearchRecoveryJourney({onScreen}={}) {
 const {h,c,fake}=await fixture();let receiving,erased;
 try {
  const w=await flow(h,c,{input:{project_id:project,name:'{{trigger.input.name}}'}});await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['id','gid','name']});await h.post(`workflows/${w.id}/resume`);
  const subject=tasks[2].gid,privateNotes='synthetic-crank-private-note'+'x'.repeat(70000);
  fake.routes.set('app.asana.com',request=>{assertRead(request);return request.url.searchParams.has('offset')?jsonResponse({},429,{'retry-after':'60'}):jsonResponse(page([{...tasks[2],notes:privateNotes}],nextPage(request)))});
  const parked=await startRun(h,w,{name:hostileName});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));assert.equal(found(parked),null);const operation=stepOf(parked,'search').operation_key;
  const chunks=async id=>(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=? ORDER BY ordinal,chunk_index').bind(id).all()).results;
  const retained=await chunks(parked.id);assert.equal(retained.length,2);assert.ok(retained.every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'));
  const metadata=await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(parked.id).first();assert.ok(!metadata.response_json.includes('/12001/'));assert.ok(!metadata.response_json.includes(offset));
  const preview=await h.post('data/subject',{subject});assert.ok(preview.workflow_runs.some(run=>run.id===parked.id));assert.equal(preview.blocked,true,'unfinished pages are discoverable and cannot be erased while active');
  const hold=await h.post('data/holds',{kind:'subject',subject,reason:'Asana retained page review'},h.owner,201);
  const saved=await archive(h);for(const value of [readCredential,hostileName,offset,privateNotes])assert.ok(!saved.includes(value),'private page bytes and credentials stay out of portable metadata');
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  for(const change of [
   (table,row)=>{if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.url='https://app.asana.com/api/1.0/users/me';row.response_json=JSON.stringify(response)}},
   (table,row)=>{if(table==='crank_workflow_versions'){const value=JSON.parse(row.graph_json);value.steps[0].input.project_id='{{trigger.input.project}}';row.graph_json=JSON.stringify(value)}},
  ]) {
   const invalid=await rewritten(saved,change);await receiving.post('data/restore',{archive:invalid,confirm:'RESTORE'},receiving.owner,400);assert.deepEqual(await receiving.get('workflows'),[],'malformed archives leave no partially restored workflows');
  }
  await receiving.post('data/restore',{archive:saved,confirm:'RESTORE'});assertInventory(saved,await archive(receiving));
  assert.equal(stepOf(await receiving.get('workflow-runs/'+parked.id),'search').status,'waiting');assert.ok((await receiving.get('connections')).every(account=>account.status==='needs_reconnect'));assert.ok((await receiving.get('workflows')).every(workflow=>['paused','draft'].includes(workflow.status)));
  const unavailable=await receiving.post('data/subject',{subject});assert.equal(unavailable.blocked,true);assert.match(unavailable.sealed_unmatched.join(' '),/key file/);
  let before=fake.requests.length;await receiving.restart();await receiving.tick(later);assert.equal(fake.requests.length,before,'inactive credential-free restore cannot dispatch parked reads');await receiving.close();receiving=null;
  const rotation=await h.post('data/keys/rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick(clock);assert.ok((await chunks(parked.id)).every(row=>JSON.parse(row.content_base64).k===rotation.key_id));
  fake.routes.set('app.asana.com',request=>{assertRead(request);assert.equal(request.url.searchParams.get('offset'),offset,'the completed first page must be retained');return jsonResponse(page([tasks[0],tasks[1]]))});
  before=fake.requests.length;await h.restart({clock:later});await h.tick(later);
  const done=await h.get('workflow-runs/'+parked.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(fake.requests.length,before+1);assert.equal(stepOf(done,'search').operation_key,operation);assert.equal(found(done).count,3);assert.equal(found(done).complete,true);assert.ok(!JSON.stringify(done).includes(privateNotes));
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=?').bind(done.id).first();assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(stored.output_json).sealed,'crank-payload-v1');
  if(onScreen)await onScreen({h,w,run:done,state:'recovered'});
  const invited=await h.send('/auth/invite',{email:'synthetic-crank-asana-viewer'+String.fromCharCode(64)+'example.test',displayName:'Asana history viewer',role:'member'},h.owner);assert.equal(invited.status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const viewer=(await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.displayName==='Asana history viewer');await h.post('team/'+viewer.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+done.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.equal(stepOf(restricted,'search').output,undefined);assert.ok(!JSON.stringify(restricted).includes(hostileName));
  const completeArchive=await archive(h);receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await receiving.post('data/restore',{archive:completeArchive,confirm:'RESTORE'});assertInventory(completeArchive,await archive(receiving));assert.equal(stepOf(await receiving.get('workflow-runs/'+done.id),'search').output.sealed,true);
  before=fake.requests.length;await receiving.restart();await receiving.tick('2026-11-12T15:02:02Z');assert.equal(fake.requests.length,before);await receiving.close();receiving=null;
  const policy={payload_days:1,attachment_days:1,history_days:30},future='2026-11-12T15:02:02Z';
  const heldPolicy=await h.post('data/retention/preview',{...policy,at:future});assert.ok(heldPolicy.payload.kept.some(run=>run.id===done.id&&run.reason==='legal hold'));
  await h.post(`workflows/${w.id}/pause`);const held=await h.post('data/subject',{subject});assert.match(held.workflow_runs.find(run=>run.id===done.id).blocked,/legal hold/);await h.post('data/erase',{subject,digest:held.digest,confirm:'ERASE'},h.owner,409);
  await h.post(`data/holds/${hold.id}/release`);const erasePreview=await h.post('data/subject',{subject});assert.equal(erasePreview.blocked,false);await h.post('data/erase',{subject,digest:erasePreview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+done.id,h.owner,404);assert.deepEqual(await chunks(done.id),[]);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await erased.post('data/restore',{archive:completeArchive,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[]);await erased.close();erased=null;
  await h.post(`workflows/${w.id}/resume`);fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse(page([tasks[0]]))});const expiring=await startRun(h,w,{name:hostileName});assert.equal(expiring.status,'succeeded');
  const retention=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:retention.digest});await h.restart({clock:future});await h.tick(future);
  const expired=await h.get('workflow-runs/'+expiring.id);assert.ok(expired.payload_expired_at);assert.equal(found(expired),null);assert.deepEqual(await chunks(expiring.id),[]);assert.match((await h.get(`workflow-runs/${expiring.id}/replay`)).blocked_reason,/expired/);
  // Revocation while parked must fence the next physical request after restart.
  fake.routes.set('app.asana.com',request=>{assertRead(request);return jsonResponse({},429,{'retry-after':'60'})});const revoked=await startRun(h,w,{name:hostileName});assert.equal(revoked.status,'waiting');before=fake.requests.length;await h.post(`connections/${c.id}/revoke`);await h.restart({clock:'2026-11-12T15:04:03Z'});await h.tick('2026-11-12T15:04:03Z');assert.equal((await h.get('workflow-runs/'+revoked.id)).status,'paused');assert.equal(fake.requests.length,before);
  await h.post(`connections/${c.id}/rotate`,{secret:{token:readCredential},scopes:[scope]});
  fake.routes.set('app.asana.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:readCredential},scopes:[]});return jsonResponse(page([tasks[0]],nextPage(request)))});
  const denied=await startRun(h,w,{name:hostileName});assert.notEqual(denied.status,'succeeded');assert.equal(fake.requests.length,before+1,'current task consent is checked between pages');assert.ok(fake.requests.every(request=>request.method==='GET'));
 }finally{await erased?.close();await receiving?.close();await h.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await asanaSearchJourney();await asanaSearchRecoveryJourney();console.log('Asana exact project reads, complete outcomes, sealed recovery and inactive custody PASS')}
