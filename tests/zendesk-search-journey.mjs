import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
const host='synthetic-crank.zendesk.com',query='type:ticket tags:bug';
export const hostileTicketSubject='<img src=x onerror="globalThis.zendeskInjected=true"> synthetic-crank-subject';
export const zendeskStep=connectionId=>({id:'tickets',type:'zendesk.search_tickets',connection_id:connectionId,subdomain:'synthetic-crank',metadata_fields:['subject','status','priority','requester_id','updated_at'],no_match:'continue',multi_match:'all',limit:10,sort:{field:'id',direction:'desc'},retry_policy:{read_attempts:2,base_delay_ms:1},input:{query:'{{trigger.input.query}}'}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'map',input:{outcome:'{{steps.tickets.outcome}}',count:'{{steps.tickets.count}}'}}]});
const ticket=(id,subject=hostileTicketSubject)=>({id,result_type:'ticket',url:`https://${host}/api/v2/tickets/${id}.json`,subject,status:'open',priority:'high',requester_id:701,updated_at:'2026-11-10T14:00:00Z',description:'synthetic-crank-description',comments:[{body:'synthetic-crank-comment'}],attachments:[{content_url:'https://files.example/private'}]});
const next=(url,page)=>{const value=new URL(url);value.searchParams.set('page',String(page));return value.href};
export async function zendeskFixture(){
 const fake=fakeEdge(),token='synthetic-crank-701';let mode='normal',parked=false;
 fake.routes.set(host,({url,method,headers})=>{
  assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer '+token);
  if(url.pathname==='/api/v2/tickets.json')return jsonResponse({tickets:[ticket(99)],meta:{has_more:false}});
  assert.equal(url.pathname,'/api/v2/search.json');
  assert.equal(url.searchParams.get('sort_by'),'created_at');assert.equal(url.searchParams.get('sort_order'),'asc');assert.equal(url.searchParams.get('per_page'),'100');
  const q=url.searchParams.get('query'),page=Number(url.searchParams.get('page'));
  if(q==='type:ticket tags:zero')return jsonResponse({count:0,results:[],next_page:null});
  if(q==='type:ticket tags:one')return jsonResponse({count:1,results:[ticket(1)],next_page:null});
  if(q==='type:ticket tags:permission')return jsonResponse({},403);
  if(q==='type:ticket tags:provider')return jsonResponse({},500);
  if(q==='type:ticket tags:bad-json')return new Response('{');
  if(q==='type:ticket tags:limit')return jsonResponse({count:1001,results:Array.from({length:100},(_,i)=>ticket((page-1)*100+i+1)),next_page:next(url,page+1)});
  if(q==='type:ticket tags:oversized')return jsonResponse({count:101,results:Array.from({length:101},(_,i)=>ticket(i+1)),next_page:null});
  if(q==='type:ticket tags:bad-count')return jsonResponse({count:'2',results:[ticket(1)],next_page:null});
  if(q==='type:ticket tags:negative-count')return jsonResponse({count:-1,results:[],next_page:null});
  if(q==='type:ticket tags:short')return jsonResponse({count:2,results:[],next_page:null});
  if(q==='type:ticket tags:non-ticket')return jsonResponse({count:1,results:[{...ticket(1),result_type:'user'}],next_page:null});
  if(q==='type:ticket tags:bad-id')return jsonResponse({count:1,results:[{...ticket(1),id:'1'}],next_page:null});
  if(q==='type:ticket tags:wrong-url')return jsonResponse({count:1,results:[{...ticket(1),url:`https://${host}/api/v2/tickets/2.json`}],next_page:null});
  if(q==='type:ticket tags:bad-time')return jsonResponse({count:1,results:[{...ticket(1),updated_at:'2026-02-30T14:00:00Z'}],next_page:null});
  if(q==='type:ticket tags:missing-field')return jsonResponse({count:1,results:[{...ticket(1),subject:undefined}],next_page:null});
  if(q==='type:ticket tags:oversized-subject')return jsonResponse({count:1,results:[ticket(1,'x'.repeat(4097))],next_page:null});
  if(q==='type:ticket tags:changed-count')return jsonResponse({count:page===1?2:3,results:[ticket(page)],next_page:page===1?next(url,2):null});
  if(q==='type:ticket tags:conflict')return jsonResponse({count:2,results:[ticket(1,page===1?'original':'changed')],next_page:page===1?next(url,2):null});
  if(q?.startsWith('type:ticket tags:link-')){
   const kind=q.split('link-')[1],link=new URL(next(url,2));
   if(kind==='tenant')link.hostname='foreign.zendesk.com';
   if(kind==='query')link.searchParams.set('query','type:user');
   if(kind==='cycle')link.searchParams.set('page','1');
   if(kind==='path')link.pathname='/api/v2/tickets/1/comments.json';
   if(kind==='credentials')link.username='synthetic-crank';
   if(kind==='extra')link.searchParams.append('query',query);
   if(kind==='sort')link.searchParams.set('sort_order','desc');
   if(kind==='previous')return jsonResponse({count:2,results:[ticket(1)],next_page:link.href,previous_page:link.href});
   return jsonResponse({count:2,results:[ticket(1)],next_page:link.href});
  }
  assert.equal(q,query,'the supported query reaches the provider exactly');
  if(mode==='park'&&page===2&&!parked){parked=true;return jsonResponse({},429,{'retry-after':'31'})}
  return jsonResponse(page===1?{count:2,results:[ticket(1)],next_page:next(url,2)}:{count:2,results:[ticket(1),ticket(2)],next_page:null});
 });
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'zendesk',auth_kind:'bearer',domains:[host],label:'Selected Zendesk tenant',scopes:['read'],secret:{token}});
 return {h,c,fake,token,setMode(value){mode=value;parked=false}};
}
export async function zendeskSearchJourney({onScreen}={}){
 const f=await zendeskFixture(),{h,c,fake,token}=f;
 try{
  const poll=await publish(h,'Existing ticket comparison baseline',{trigger:{type:'app_poll',provider:'zendesk',resource:'tickets',subdomain:'synthetic-crank',connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['status'],identity:'change'},steps:[{id:'observe',type:'map',input:{id:'{{trigger.record_id}}'}}]});
  await h.tick(Date.parse((await h.get(`workflows/${poll.id}/trigger`)).poll.next_due_at));await h.post(`workflows/${poll.id}/unpublish`);
  const pollingBefore=inventory(await archive(h)).filter(row=>JSON.parse(row).table.startsWith('crank_app_'));assert.ok(pollingBefore.some(row=>JSON.parse(row).table==='crank_app_snapshots'),'the unchanged baseline assertion uses real stored comparison data');
  const beforeSearch=fake.requests.length;
  const draft=await h.post('workflows',{name:'Zendesk ticket metadata review',graph:graph(zendeskStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{query}},h.owner,201);
  assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{query}),output=stepOf(good,'tickets').output;
  assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(output.count,2);assert.equal(output.provider_count,2);
  assert.deepEqual(output.records.map(item=>item.ticket_id),[2,1]);assert.equal(output.record.subject,hostileTicketSubject);assert.equal(output.record.requester_id,701);
  assert.equal(output.record.ticket_url,`https://${host}/agent/tickets/2`);assert.equal(output.record.status,'open');assert.equal(output.record.priority,'high');assert.equal(output.record.updated_at,'2026-11-10T14:00:00Z');
  assert.deepEqual(stepOf(good,'outcome').output,{outcome:'found',count:2});
  for(const excluded of ['synthetic-crank-description','synthetic-crank-comment','content_url',token])assert.ok(!JSON.stringify(good).includes(excluded));
  assert.equal(fake.requests.length,beforeSearch+4,'draft test and published run each scan both pages');
  const flows=await h.get('data'+'/'+'flows'),flow=flows.flows.find(item=>item.kind==='zendesk.search_tickets');
  assert.deepEqual(flow.recipients,['https://'+host]);assert.ok(flow.fields.includes('query'));assert.ok(flow.fields.includes('metadata_fields'));assert.match(flow.credentials,/bearer/i);assert.match(flow.region,/not verified/);assert.ok(!JSON.stringify(flows).includes(query));
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  const address=['synthetic-crank-observer','example.test'].join('@');
  assert.equal((await h.send('/auth/invite',{email:address,displayName:'Ticket observer',role:'member'},h.owner)).status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});
  const observer=(await h.send('/auth/operators',undefined,h.owner)).value.find(item=>item.displayName==='Ticket observer');
  await h.post('team/'+observer.id,{grants:[{role:'viewer',workflow_ids:[draft.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(item=>!('output'in item)&&!('input'in item)));assert.ok(!JSON.stringify(restricted).includes(hostileTicketSubject));
  await h.get('data'+'/'+'flows',signed.cookie,403);
  const zero=await startRun(h,draft,{query:'type:ticket tags:zero'});assert.equal(stepOf(zero,'outcome').output.outcome,'not found');assert.deepEqual(stepOf(zero,'tickets').output.records,[]);
  const one=await startRun(h,draft,{query:'type:ticket tags:one'});assert.equal(stepOf(one,'tickets').output.count,1);
  for(const [settings,q,outcome,status]of[
   [{no_match:'halt'},'type:ticket tags:zero','not found','stopped_by_search'],
   [{multi_match:'first'},query,'found','succeeded'],
   [{multi_match:'stop'},query,'multiple matches','stopped_by_search'],
   [{multi_match:'stop',on_multiple:'continue'},query,'multiple matches','succeeded'],
   [{limit:1},query,'truncated','succeeded'],
   [{max_pages:1},query,'truncated','succeeded'],
   [{limit:2},'type:ticket tags:limit','truncated','succeeded'],
  ]){
   const w=await publish(h,'Declared ticket search outcome',graph({...zendeskStep(c.id),...settings})),run=await startRun(h,w,{query:q});
   assert.equal(run.status,status,JSON.stringify(run.error));assert.equal(stepOf(run,'tickets').output.outcome,outcome);
   if(settings.multi_match==='first')assert.equal(stepOf(run,'tickets').output.record.id,2);
   if(status==='stopped_by_search')assert.ok(!run.steps.some(item=>item.step_id==='outcome'));
   if(q.endsWith(':limit'))assert.equal(stepOf(run,'tickets').output.provider_count,1001);
  }
  for(const multi_match of ['first','stop']){
   const w=await publish(h,'Incomplete ticket search refuses a decision',graph({...zendeskStep(c.id),multi_match,max_pages:1})),run=await startRun(h,w,{query});
   assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/);assert.ok(!run.steps.some(item=>item.step_id==='outcome'));
   if(onScreen&&multi_match==='first')await onScreen({h,w,run,state:'incomplete'});
  }
  for(const mode of ['permission','provider','bad-json','oversized','bad-count','negative-count','short','non-ticket','bad-id','wrong-url','bad-time','missing-field','oversized-subject','changed-count','conflict','link-tenant','link-query','link-cycle','link-path','link-credentials','link-extra','link-sort','link-previous']){
   const before=fake.requests.length,run=await startRun(h,draft,{query:'type:ticket tags:'+mode});
   assert.ok(!['succeeded','stopped_by_search'].includes(run.status),mode+' never means not found');assert.ok(!run.steps.some(item=>item.step_id==='outcome'));
   if(mode.startsWith('link-'))assert.equal(fake.requests.length,before+1,'invalid pagination refuses before any credential-bearing continuation');
  }
  for(const badQuery of ['','type:user','type:ticket OR type:user','type:ticket type:user','type:ticket description:secret','type:ticket tags:bug\nstatus:open','type:ticket requester:me']){
   const count=fake.requests.length,run=await startRun(h,draft,{query:badQuery});assert.equal(run.status,'failed');assert.equal(fake.requests.length,count);
  }
  for(const patch of [{create_if_not_found:{}},{sort:{field:'subject',direction:'asc'}},{metadata_fields:['description']},{metadata_fields:['comments']},{metadata_fields:['subject','subject']},{subdomain:'other.example/path'},{input:{query,include:'comments'}}])await h.post('workflows',{name:'Unsupported Zendesk search',graph:graph({...zendeskStep(c.id),...patch})},h.owner,422);
  for(const account of [
   await connection(h,{app:'zendesk',auth_kind:'bearer',domains:['foreign.zendesk.com'],label:'Wrong tenant',scopes:['read'],secret:{token:'synthetic-crank-702'}}),
   await connection(h,{app:'zendesk',auth_kind:'bearer',domains:[host],label:'Write scope only',scopes:['write'],secret:{token:'synthetic-crank-703'}}),
   await connection(h,{app:'http',auth_kind:'bearer',domains:[host],label:'Wrong app',scopes:['read'],secret:{token:'synthetic-crank-704'}}),
  ]){
   const w=await publish(h,'Refuse missing tenant read authority',graph(zendeskStep(account.id))),count=fake.requests.length,run=await startRun(h,w,{query});assert.notEqual(run.status,'succeeded');assert.equal(fake.requests.length,count);
  }
  f.setMode('park');const parked=await startRun(h,draft,{query});assert.equal(parked.status,'waiting');
  const checkpointRows=inventory(await archive(h)).map(JSON.parse).filter(item=>item.table==='crank_request_checkpoint_chunks'&&item.row.run_id===parked.id);assert.equal(checkpointRows.length,1);
  const retained=Buffer.from(checkpointRows[0].row.content_base64,'base64').toString();for(const excluded of ['description','comments','attachments','synthetic-crank-description','synthetic-crank-comment'])assert.ok(!retained.includes(excluded),'the unfinished checkpoint holds only declared metadata');assert.equal(JSON.parse(retained).results[0].subject,hostileTicketSubject);
  await h.post(`connections/${c.id}/rotate`,{scopes:['write'],secret:{token}});const count=fake.requests.length;
  await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+parked.id)).status,'succeeded');assert.equal(fake.requests.length,count,'cached reads require current read consent');
  await h.post(`connections/${c.id}/revoke`);assert.notEqual((await startRun(h,draft,{query})).status,'succeeded');assert.equal(fake.requests.length,count);
  assert.ok(fake.requests.slice(beforeSearch).every(item=>item.method==='GET'&&item.url.hostname===host&&item.url.pathname==='/api/v2/search.json'),'zero writes, content reads or foreign-tenant requests');
  assert.deepEqual(inventory(await archive(h)).filter(row=>JSON.parse(row).table.startsWith('crank_app_')),pollingBefore,'search never changes trigger snapshots or view membership');
 }finally{await h.close()}
}

export async function zendeskCustodyJourney(){
 const f=await zendeskFixture(),{h,c,fake,token}=f;let receiving,waitingReceiving,erased;
 try{
  const w=await publish(h,'Sealed ticket search',graph(zendeskStep(c.id)));
  await h.post(`workflows/${w.id}/pause`);await h.post('data'+'/'+'classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['subject']});await h.post(`workflows/${w.id}/resume`);
  f.setMode('park');const parked=await startRun(h,w,{query});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));assert.equal(fake.requests.length,2);
  let saved=await archive(h);assert.ok(!saved.includes(token));assert.ok(!saved.includes(hostileTicketSubject));
  const chunks=inventory(saved).map(JSON.parse).filter(item=>item.table==='crank_request_checkpoint_chunks');assert.equal(chunks.length,1);assert.ok(chunks.every(item=>item.row.content_base64.startsWith('{"sealed":"crank-payload-v1"')));
  waitingReceiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await waitingReceiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const source=inventory(saved),received=inventory(await archive(waitingReceiving)),extra=received.filter(item=>!new Set(source).has(item));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(received.filter(item=>item!==extra[0]),source);
  const before=fake.requests.length;await waitingReceiving.restart();await waitingReceiving.tick(Date.parse(later));assert.equal(fake.requests.length,before,'inactive restored pages grant no dispatch authority');await waitingReceiving.close();waitingReceiving=null;
  for(const corrupt of ['envelope','tenant','size']){
   const invalid=await rewritten(saved,(table,row)=>{
    if(table==='crank_request_checkpoint_chunks'&&corrupt==='envelope'){const value=JSON.parse(row.content_base64);value.ct='invalid';row.content_base64=JSON.stringify(value)}
    if(table==='crank_request_checkpoints'&&corrupt!=='envelope'){const response=JSON.parse(row.response_json);if(corrupt==='tenant')response.url='https://foreign.zendesk.com/api/v2/search.json';else response.body_bytes=262145;row.response_json=JSON.stringify(response)}
   });
   const refused=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});try{await refused.post('data'+'/'+'restore',{archive:invalid,confirm:'RESTORE'},refused.owner,400);assert.deepEqual(await refused.get('workflows'),[])}finally{await refused.close()}
  }
  const rotated=await h.post('data'+'/'+'keys'+'/'+'rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick();assert.ok(inventory(await archive(h)).map(JSON.parse).filter(item=>item.table==='crank_request_checkpoint_chunks').every(item=>JSON.parse(item.row.content_base64).k===rotated.key_id));
  const held=await h.post('data'+'/'+'holds',{kind:'subject',subject:hostileTicketSubject,reason:'Ticket retention review'},h.owner,201);await h.post(`workflows/${w.id}/pause`);
  const heldPreview=await h.post('data'+'/'+'subject',{subject:hostileTicketSubject});assert.ok(heldPreview.workflow_runs.some(item=>item.id===parked.id));assert.equal(heldPreview.blocked,true);await h.post('data'+'/'+'erase',{subject:hostileTicketSubject,digest:heldPreview.digest,confirm:'ERASE'},h.owner,409);
  await h.post(`workflows/${w.id}/resume`);await h.restart({clock:later});await h.tick(Date.parse(later));const good=await h.get('workflow-runs/'+parked.id);assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(stepOf(good,'tickets').output.count,2);assert.equal(fake.requests.length,3,'restart retains the first completed page');assert.equal(fake.requests.filter(item=>item.url.searchParams.get('page')==='1').length,1);
  const policy={payload_days:1,attachment_days:null,history_days:30},preview=await h.post('data'+'/'+'retention'+'/'+'preview',policy);await h.post('data'+'/'+'retention',{...policy,digest:preview.digest});const future=Date.parse(later)+2*86400000;await h.tick(future);assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null);
  saved=await archive(h);receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await receiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),returned=inventory(await archive(receiving)),added=returned.filter(item=>!new Set(original).has(item));assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(returned.filter(item=>item!==added[0]),original,'all portable records round trip completely');
  assert.equal(stepOf(await receiving.get('workflow-runs/'+good.id),'tickets').output.sealed,true);const count=fake.requests.length;await receiving.restart();await receiving.tick(future);assert.equal(fake.requests.length,count);assert.ok((await receiving.get('connections')).every(item=>item.status!=='active'));assert.ok((await receiving.get('workflows')).every(item=>item.status!=='published'));
  await h.post(`data/holds/${held.id}/release`,{confirm:'RELEASE'});await h.tick(future);const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(stepOf(expired,'tickets').output,null);assert.ok(!inventory(await archive(h)).map(JSON.parse).some(item=>item.table.startsWith('crank_request_checkpoint')&&item.row.run_id===good.id));assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);
  f.setMode('normal');const eraseMe=await startRun(h,w,{query:'type:ticket tags:one'});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);const erasePreview=await h.post('data'+'/'+'subject',{subject:hostileTicketSubject});assert.ok(erasePreview.workflow_runs.some(item=>item.id===eraseMe.id));await h.post('data'+'/'+'erase',{subject:hostileTicketSubject,digest:erasePreview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await erased.post('data'+'/'+'restore',{archive:saved,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'old archives cannot resurrect erased subjects');
 }finally{await erased?.close();await waitingReceiving?.close();await receiving?.close();await h.close()}
}
export async function zendeskOwnership(h,fake){
 fake.routes.set(host,()=>jsonResponse({count:1,results:[ticket(1)],next_page:null}));
 const c=await connection(h,{app:'zendesk',auth_kind:'bearer',domains:[host],label:'Owned Zendesk',scopes:['read'],secret:{token:'synthetic-crank-705'}}),w=await publish(h,'Owned Zendesk metadata',graph(zendeskStep(c.id))),run=await startRun(h,w,{query:'type:ticket tags:one'});
 assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(stepOf(run,'tickets').output.record.ticket_id,1);return ['zendesk.search_tickets'];
}
