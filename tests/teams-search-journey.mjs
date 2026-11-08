import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
export const directoryScope='User.ReadBasic.All';
export const address=['synthetic-crank-person','example.test'].join('@');
export const hostileName='<img src=x onerror="globalThis.teamsInjected=true"> synthetic-crank-name';
export const directoryUser=(id,mail=address,name=hostileName)=>({id,displayName:name,mail,userPrincipalName:address,unselected:'synthetic-crank-private'});
export const teamsStep=id=>({id:'search',name:'Teams directory lookup',type:'microsoft_teams.find_user_by_email',connection_id:id,no_match:'continue',multi_match:'all',limit:10,sort:{field:'id',direction:'asc'},max_pages:3,retry_policy:{read_attempts:2,base_delay_ms:1},input:{email:'{{trigger.input.email}}'}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'map',input:{outcome:'{{steps.search.outcome}}',count:'{{steps.search.count}}'}}]});
const result=run=>stepOf(run,'search').output;
const filter=email=>`(mail eq '${email.replaceAll("'","''")}' or userPrincipalName eq '${email.replaceAll("'","''")}')`;
function assertRead(request,token='synthetic-crank-801',email=address) {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.url.origin,'https://graph.microsoft.com');assert.equal(request.url.pathname,'/v1.0/users');assert.equal(request.headers.authorization,'Bearer '+token);
 for(const [key,value] of Object.entries({$filter:filter(email),$select:'id,displayName,mail,userPrincipalName',$top:'100'}))assert.equal(request.url.searchParams.get(key),value);
 assert.ok([...request.url.searchParams.keys()].every(key=>['$filter','$select','$top','$skiptoken'].includes(key)));
}
function nextLink(request,token='synthetic-crank-page') {const url=new URL(request.url);url.searchParams.set('$skiptoken',token);return url.href}
async function fixture() {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'microsoft_graph',auth_kind:'bearer',label:'Selected directory',scopes:[directoryScope],secret:{token:'synthetic-crank-801'}});
 let mode='pages';
 fake.routes.set('graph.microsoft.com',request=>{
  assertRead(request);const after=request.url.searchParams.get('$skiptoken');
  if(mode==='empty')return jsonResponse({value:[]});
  if(mode==='one')return jsonResponse({value:[directoryUser('synthetic-crank-b',null)]});
  if(mode==='park'&&after)return jsonResponse({},429,{'retry-after':'60'});
  return jsonResponse(after?{value:[directoryUser('synthetic-crank-b'),directoryUser('synthetic-crank-a',address.toUpperCase()),directoryUser('synthetic-crank-b')]}:{value:[directoryUser('synthetic-crank-c')],'@odata.nextLink':nextLink(request)});
 });
 return {h,c,fake,setMode(value){mode=value}};
}
const flow=(h,c,patch={})=>publish(h,'Teams read only directory lookup',graph({...teamsStep(c.id),...patch}));

/** Native draft-test, publication, HTTP run and Cron; only the Graph edge is faked. */
export async function teamsSearchJourney({onScreen}={}) {
 const f=await fixture(),{h,c,fake}=f;
 try {
  const draft=await h.post('workflows',{name:'Teams exact email review',graph:graph(teamsStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{email:address}},h.owner,201);assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assert.equal(result(tested).count,3);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{email:address}),output=result(good);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(output.pages,2);assert.equal(output.complete,true);assert.deepEqual(output.records.map(r=>r.id),['synthetic-crank-a','synthetic-crank-b','synthetic-crank-c']);assert.equal(output.records[0].displayName,hostileName);assert.equal(output.records[0].mail,address.toUpperCase());assert.equal(output.records[0].userPrincipalName,address);assert.equal(stepOf(good,'outcome').output.outcome,'found');
  for(const discarded of ['synthetic-crank-private','synthetic-crank-801'])assert.ok(!JSON.stringify(good).includes(discarded));
  const retained=inventory(await archive(h)).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks');for(const chunk of retained)assert.ok(!Buffer.from(chunk.row.content_base64,'base64').toString().includes('synthetic-crank-private'),'unselected properties never enter checkpoint custody');
  const disclosure=(await h.get('data/flows')).flows.find(row=>row.kind==='microsoft_teams.find_user_by_email');assert.deepEqual(disclosure.recipients,['https://graph.microsoft.com']);for(const key of ['email','filter','projection','page_token'])assert.ok(disclosure.fields.includes(key));assert.match(disclosure.credentials,/bearer/i);assert.match(disclosure.region,/not verified/);assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(address));
  const operation=(await h.get('catalog')).apps.find(row=>row.app==='microsoft_teams');assert.equal(operation.actions.length,0);assert.equal(operation.triggers.length,0);assert.match(operation.restrictions.join(' '),/neither Teams licensing.*tenant identity/);
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  for(const patch of [{multi_match:'first',sort:{field:'id',direction:'desc'}},{multi_match:'first'},{multi_match:'stop'},{multi_match:'stop',on_multiple:'continue'},{limit:1}]) {
   const run=await startRun(h,await flow(h,c,patch),{email:address});assert.equal(run.status,patch.multi_match==='stop'&&!patch.on_multiple?'stopped_by_search':'succeeded',JSON.stringify(run.error));
   if(patch.multi_match==='first'){assert.equal(result(run).record.id,patch.sort?'synthetic-crank-c':'synthetic-crank-a');assert.equal(result(run).count,3);assert.equal(result(run).pages,2,'first waits for the complete scan')}
   if(patch.multi_match==='stop'){assert.equal(result(run).outcome,'multiple matches');assert.equal(run.steps.some(s=>s.step_id==='outcome'),!!patch.on_multiple)}
   if(patch.limit){assert.equal(result(run).outcome,'truncated');assert.equal(result(run).complete,true);assert.equal(result(run).count,1)}
  }
  const incomplete=await startRun(h,await flow(h,c,{max_pages:1}),{email:address});assert.equal(incomplete.status,'succeeded');assert.equal(result(incomplete).complete,false);assert.equal(result(incomplete).outcome,'truncated');assert.equal(result(incomplete).count,1);
  fake.routes.set('graph.microsoft.com',request=>{assertRead(request);return jsonResponse({value:[],'@odata.nextLink':nextLink(request)})});
  const emptyBound=await startRun(h,await flow(h,c,{max_pages:1}),{email:address});assert.equal(result(emptyBound).outcome,'truncated');assert.equal(result(emptyBound).count,0,'incomplete empty scans cannot establish absence');
  for(const multi_match of ['first','stop']) {
   const w=await flow(h,c,{multi_match,max_pages:1}),run=await startRun(h,w,{email:address});assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/);assert.ok(!run.steps.some(s=>s.step_id==='outcome'));
   if(onScreen&&multi_match==='first')await onScreen({h,w,run,state:'incomplete'});
  }
  fake.routes.set('graph.microsoft.com',request=>{assertRead(request);return jsonResponse({value:[]})});
  for(const no_match of ['halt','continue']){const run=await startRun(h,await flow(h,c,{no_match}),{email:address});assert.equal(run.status,no_match==='halt'?'stopped_by_search':'succeeded');assert.equal(result(run).outcome,'not found');assert.equal(result(run).complete,true);assert.equal(run.steps.some(s=>s.step_id==='outcome'),no_match==='continue')}
  fake.routes.set('graph.microsoft.com',request=>{assertRead(request);return jsonResponse({value:[directoryUser('synthetic-crank-one',null)]})});assert.equal(result(await startRun(h,draft,{email:address})).record.mail,null,'UPN can supply the exact match when mail is null');
  const escaped=["synthetic-crank-o'hara",'example.test'].join('@');
  fake.routes.set('graph.microsoft.com',request=>{assertRead(request,'synthetic-crank-801',escaped);return jsonResponse(request.url.searchParams.has('$skiptoken')?{value:[{...directoryUser('synthetic-crank-escaped',escaped),userPrincipalName:escaped}]}:{value:[],'@odata.nextLink':nextLink(request)})});
  const exact=await startRun(h,draft,{email:escaped});assert.equal(exact.status,'succeeded',JSON.stringify(exact.error));assert.equal(result(exact).record.id,'synthetic-crank-escaped');
  const wrongs=[['bad JSON',()=>new Response('{')],['bad value',()=>jsonResponse({value:{}})],['oversized page',()=>jsonResponse({value:Array(101).fill(directoryUser('synthetic-crank-a'))})],['invalid id',()=>jsonResponse({value:[{...directoryUser('synthetic-crank-a'),id:0}]})],['bad name',()=>jsonResponse({value:[directoryUser('synthetic-crank-a',address,42)]})],['outside filter',()=>jsonResponse({value:[{...directoryUser('synthetic-crank-a',['other','example.test'].join('@')),userPrincipalName:['other','example.test'].join('@')}]})],['bad cursor',()=>jsonResponse({value:[],'@odata.nextLink':{}})],['loop',request=>jsonResponse({value:[],'@odata.nextLink':nextLink(request,'same')})],['conflicting id',request=>jsonResponse(request.url.searchParams.has('$skiptoken')?{value:[directoryUser('synthetic-crank-a',address,'changed')]}:{value:[directoryUser('synthetic-crank-a')],'@odata.nextLink':nextLink(request)})],['provider failure',()=>jsonResponse({error:'synthetic-crank-private'},500)],['permission failure',()=>jsonResponse({},403)],['redirect',()=>new Response('',{status:302,headers:{location:'https://evil.example/write'}})]];
  for(const [label,reply] of wrongs){fake.routes.set('graph.microsoft.com',request=>{assertRead(request);return reply(request)});const run=await startRun(h,draft,{email:address});assert.notEqual(run.status,'succeeded',label);assert.notEqual(run.status,'stopped_by_search',label);assert.ok(!run.steps.some(s=>s.step_id==='outcome'),label)}
  // Every hostile provider-supplied URL is rejected on its first page, before
  // the transport can attach a credential to that URL.
  for(const [label,change] of [
   ['foreign origin',url=>{url.hostname='evil.example'}],['other Graph resource',url=>{url.pathname='/v1.0/groups'}],['different version',url=>{url.pathname='/beta/users'}],['changed filter',url=>url.searchParams.set('$filter',"mail ne ''")],['changed projection',url=>url.searchParams.set('$select','id,passwordProfile')],['changed page size',url=>url.searchParams.set('$top','999')],['duplicate query',url=>url.searchParams.append('$filter',filter(address))],['extra parameter',url=>url.searchParams.set('$expand','manager')],['missing token',url=>url.searchParams.delete('$skiptoken')],['credentials',url=>{url.username='synthetic-crank-injected'}],['fragment',url=>{url.hash='injected'}],
  ]) {
   const before=fake.requests.length;fake.routes.set('graph.microsoft.com',request=>{assertRead(request);const url=new URL(nextLink(request));change(url);return jsonResponse({value:[],'@odata.nextLink':url.href})});
   const run=await startRun(h,draft,{email:address});assert.equal(run.status,'failed',label);assert.equal(fake.requests.length,before+1,label);assert.equal(result(run),null,label);
  }
  const before=fake.requests.length;
  for(const input of [{email:''},{email:42},{email:null},{email:['synthetic-crank-a']},{email:'not an email'},{email:' '+address}]){const run=await startRun(h,draft,input);assert.equal(run.status,'failed');assert.equal(run.error.category,'validation')}
  for(const patch of [{create_if_not_found:{}},{max_pages:0},{input:{email:address,query:'ignored'}},{sort:{field:'mail',direction:'asc'}},{input:{email:42}}])await h.post('workflows',{name:'Unsupported Teams lookup',graph:graph({...teamsStep(c.id),...patch})},h.owner,422);
  assert.equal(fake.requests.length,before,'invalid declarations and resolved inputs make no provider request');
  for(const options of [{app:'microsoft_graph',auth_kind:'bearer',scopes:['User.Read'],secret:{token:'synthetic-crank-802'}},{app:'http',auth_kind:'bearer',domains:['graph.microsoft.com'],secret:{token:'synthetic-crank-803'}}]) {const denied=await connection(h,{label:'No directory read authority',...options});assert.notEqual((await startRun(h,await flow(h,denied),{email:address})).status,'succeeded')}
  assert.equal(fake.requests.length,before,'self-only consent and arbitrary credentials grant no directory-read authority');
  const other=await connection(h,{app:'microsoft_graph',auth_kind:'bearer',label:'Independent directory',scopes:[directoryScope],secret:{token:'synthetic-crank-804'}}),otherFlow=await flow(h,other);
  fake.routes.set('graph.microsoft.com',request=>{const second=request.headers.authorization==='Bearer synthetic-crank-804';assertRead(request,second?'synthetic-crank-804':'synthetic-crank-801');return second?jsonResponse({value:[directoryUser('synthetic-crank-other',address,'synthetic-crank-other-person')]}):jsonResponse({},429,{'retry-after':'60'})});
  const [blocked,second]=await Promise.all([startRun(h,draft,{email:address}),startRun(h,otherFlow,{email:address})]);assert.equal(blocked.status,'waiting');assert.equal(second.status,'succeeded');assert.equal(result(second).record.id,'synthetic-crank-other');assert.ok(!JSON.stringify(second).includes(hostileName));
  await h.post(`connections/${c.id}/revoke`);const count=fake.requests.length;await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+blocked.id)).status,'succeeded');assert.equal(fake.requests.length,count,'revocation refuses pending dispatch');
  for(const last of [false,true]) {
   await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-801'},scopes:[directoryScope]});
   fake.routes.set('graph.microsoft.com',async request=>{assertRead(request);await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-801'},scopes:['User.Read']});return jsonResponse({value:[directoryUser('synthetic-crank-a')],...(!last?{'@odata.nextLink':nextLink(request)}:{})})});
   const denied=await startRun(h,draft,{email:address});assert.notEqual(denied.status,'succeeded');assert.equal(result(denied),null,'withdrawn consent releases no page or final result');
  }
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-801'},scopes:[directoryScope]});
  fake.routes.set('graph.microsoft.com',async request=>{assertRead(request);await h.post(`workflows/${draft.id}/pause`);return jsonResponse({value:[directoryUser('synthetic-crank-paused')]})});const paused=await startRun(h,draft,{email:address});assert.notEqual(paused.status,'succeeded');assert.equal(result(paused),null,'paused in-flight reads release no result');
  assert.deepEqual(JSON.parse((await h.db.prepare('SELECT scopes_json FROM crank_connections WHERE id=?').bind(c.id).first()).scopes_json),[directoryScope],'lookup never widens directory consent');
  assert.ok(fake.requests.every(r=>r.method==='GET'&&r.url.origin==='https://graph.microsoft.com'&&r.url.pathname==='/v1.0/users'),'zero provider mutations or other resource reads');
 }finally{await h.close()}
}

export async function teamsCustodyJourney({onScreen}={}) {
 const f=await fixture(),{h,c,fake}=f;let receiving,erased,bad;
 try {
  const w=await flow(h,c);await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['displayName']});await h.post(`workflows/${w.id}/resume`);
  f.setMode('park');const parked=await startRun(h,w,{email:address});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));
  const chunks=async()=> (await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(parked.id).all()).results;
  assert.ok((await chunks()).length);assert.ok((await chunks()).every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'),'unfinished projected pages are sealed');
  const hold=await h.post('data/holds',{kind:'subject',subject:hostileName,reason:'directory record review'},h.owner,201);await h.post(`workflows/${w.id}/pause`);
  const unfinished=await h.post('data/subject',{subject:hostileName});assert.ok(unfinished.workflow_runs.some(row=>row.id===parked.id&&/legal hold/.test(row.blocked)));await h.post('data/erase',{subject:hostileName,digest:unfinished.digest,confirm:'ERASE'},h.owner,409);await h.post(`workflows/${w.id}/resume`);
  const checkpoint=await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(parked.id).first();assert.ok(!checkpoint.response_json.includes('synthetic-crank-page'));assert.ok(!checkpoint.response_json.includes(address));
  const saved=await archive(h);for(const value of ['synthetic-crank-801',hostileName,'synthetic-crank-private'])assert.ok(!saved.includes(value));
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),returned=inventory(await archive(receiving)),extra=returned.filter(row=>!new Set(original).has(row));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(returned.filter(row=>row!==extra[0]),original,'every unfinished page and portable record restores unchanged');
  const before=fake.requests.length;await receiving.restart();await receiving.tick(Date.parse(later));assert.equal(fake.requests.length,before);assert.ok((await receiving.get('connections')).every(row=>row.status==='needs_reconnect'));assert.ok((await receiving.get('workflows')).every(row=>['paused','draft'].includes(row.status)));
  for(const [label,change,movePage] of [
   ['foreign endpoint',row=>{const value=JSON.parse(row.response_json);value.url='https://evil.example/users';row.response_json=JSON.stringify(value)}],
   ['oversized page',row=>{const value=JSON.parse(row.response_json);value.body_bytes=1048577;row.response_json=JSON.stringify(value)}],
   ['followed redirect',row=>{const value=JSON.parse(row.response_json);value.redirects=1;row.response_json=JSON.stringify(value)}],
   ['page outside declared scan',row=>{row.ordinal=3},true],
   ['unselected header',row=>{const value=JSON.parse(row.response_json);value.headers=[['x-unselected','synthetic-crank-private']];row.response_json=JSON.stringify(value)}],
  ]) {
   bad=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});const corrupt=await rewritten(saved,(table,row)=>{if(table==='crank_request_checkpoints')change(row);else if(movePage&&table==='crank_request_checkpoint_chunks')row.ordinal=3});await bad.post('data/restore',{archive:corrupt,confirm:'RESTORE'},bad.owner,400);assert.deepEqual(await bad.get('workflows'),[],label+' restore is atomic');await bad.close();bad=null;
  }
  // Cached-page consumption is also refused when current read scope is gone.
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-801'},scopes:['User.Read']});await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+parked.id)).status,'succeeded');assert.equal(fake.requests.length,before);
  assert.equal((await h.post(`workflow-runs/${parked.id}/cancel`)).status,'cancelled');
  // A separate parked run continues using its completed first page after restart.
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-801'},scopes:[directoryScope]});
  const pending=await startRun(h,w,{email:address});assert.equal(pending.status,'waiting');const mark=fake.requests.length,op=stepOf(pending,'search').operation_key;
  fake.routes.set('graph.microsoft.com',request=>{assertRead(request);assert.equal(request.url.searchParams.get('$skiptoken'),'synthetic-crank-page','completed first page is never repeated');return jsonResponse({value:[directoryUser('synthetic-crank-a')]})});
  await h.restart({clock:'2026-11-10T15:04:00Z'});await h.tick(Date.parse('2026-11-10T15:04:00Z'));const good=await h.get('workflow-runs/'+pending.id);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(result(good).record.id,'synthetic-crank-a');assert.equal(stepOf(good,'search').operation_key,op);assert.equal(fake.requests.length,mark+1);
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(good.id,'search').first();assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(stored.output_json).sealed,'crank-payload-v1');
  const displayName='Synthetic directory observer';await h.send('/auth/invite',{email:['synthetic-crank-observer','example.test'].join('@'),displayName,role:'member'},h.owner);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const person=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.displayName===displayName);await h.post('team/'+person.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(row=>!('input'in row)&&!('output'in row)));assert.ok(!JSON.stringify(restricted).includes(hostileName));
  if(onScreen)await onScreen({h,w,run:good,state:'restricted',cookie:signed.cookie});
  await h.post(`workflows/${w.id}/pause`);
  const preview=await h.post('data/subject',{subject:hostileName});assert.ok(preview.workflow_runs.some(row=>row.id===good.id));assert.equal(preview.blocked,true);await h.post('data/erase',{subject:hostileName,digest:preview.digest,confirm:'ERASE'},h.owner,409);
  const policy={payload_days:1,attachment_days:null,history_days:30},dry=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:dry.digest});await h.tick(Date.parse('2026-11-12T15:04:00Z'));assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null,'legal holds preserve search results and pages');
  if(onScreen)await onScreen({h,w,run:good,state:'sealed'});
  const complete=await archive(h);await receiving.close();receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data/restore',{archive:complete,confirm:'RESTORE'});
  const source=inventory(complete),restored=inventory(await archive(receiving)),added=restored.filter(row=>!new Set(source).has(row));assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(restored.filter(row=>row!==added[0]),source,'complete sealed results and pages restore without credentials');assert.equal(stepOf(await receiving.get('workflow-runs/'+good.id),'search').output.sealed,true);
  if(onScreen)await onScreen({h:receiving,w,run:await receiving.get('workflow-runs/'+good.id),state:'restored'});
  await h.post(`data/holds/${hold.id}/release`);await h.tick(Date.parse('2026-11-12T15:04:00Z'));const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(result(expired),null);assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(good.id).first()).n,0);
  if(onScreen)await onScreen({h,w,run:expired,state:'expired'});
  await h.post(`workflows/${w.id}/resume`);fake.routes.set('graph.microsoft.com',request=>{assertRead(request);return jsonResponse({value:[directoryUser('synthetic-crank-erase')]})});const eraseMe=await startRun(h,w,{email:address});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);
  const erase=await h.post('data/subject',{subject:hostileName});assert.equal(erase.blocked,false);assert.ok(erase.workflow_runs.some(row=>row.id===eraseMe.id));await h.post('data/erase',{subject:hostileName,digest:erase.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await erased.post('data/restore',{archive:complete,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'old captures cannot resurrect erased users');
  assert.ok(fake.requests.every(row=>row.method==='GET'));
 }finally{await bad?.close();await erased?.close();await receiving?.close();await h.close()}
}


export async function teamsOwnership(h,fake) {
 fake.routes.set('graph.microsoft.com',request=>{assertRead(request,'synthetic-crank-805');return jsonResponse({value:[directoryUser('synthetic-crank-owned')]})});
 const c=await connection(h,{app:'microsoft_graph',auth_kind:'bearer',label:'Owned directory',scopes:[directoryScope],secret:{token:'synthetic-crank-805'}}),w=await flow(h,c),run=await startRun(h,w,{email:address});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(result(run).record.id,'synthetic-crank-owned');return ['microsoft_teams.find_user_by_email'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await teamsSearchJourney();await teamsCustodyJourney();console.log('Teams exact directory search, authority, admitted recovery and sealed inactive custody PASS')}
