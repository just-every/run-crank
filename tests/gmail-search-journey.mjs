import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
export const gmailScope='https://www.googleapis.com/auth/gmail.readonly';
export const hostileSubject='<img src=x onerror="globalThis.gmailInjected=true"> synthetic-crank-subject';
const query='from:billing has:attachment label:invoices';
export const gmailStep=connectionId=>({id:'mail',type:'gmail.search_threads',connection_id:connectionId,metadata_headers:['Subject','From'],no_match:'continue',multi_match:'all',limit:10,sort:{field:'latest_internal_date',direction:'desc'},retry_policy:{read_attempts:2,base_delay_ms:1},input:{query:'{{trigger.input.query}}'}});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'map',input:{outcome:'{{steps.mail.outcome}}',count:'{{steps.mail.count}}'}}]});
function message(id,subject=hostileSubject){return {id:'message-'+id,threadId:id,internalDate:id==='thread-a'?'100':'200',labelIds:['INBOX','Label_1'],payload:{headers:[{name:'Subject',value:subject},{name:'From',value:'synthetic-crank-person'},{name:'X-Unselected',value:'synthetic-crank-unselected'}],body:{data:'synthetic-crank-body'},parts:[{body:{attachmentId:'synthetic-crank-attachment'}}]},snippet:'synthetic-crank-snippet'}}

export async function gmailFixture(){
 const fake=fakeEdge(),token='synthetic-crank-601';let mode='normal',parked=false;
 fake.routes.set('gmail.googleapis.com',({url,method,headers})=>{
  if(headers.authorization==='Bearer synthetic-crank-605'){
   assert.equal(method,'GET');assert.ok(url.pathname.startsWith('/gmail/v1/users/me/threads'));
   const other=message('thread-other','synthetic-crank-other-mailbox');other.payload.headers.find(item=>item.name==='From').value='synthetic-crank-other-person';
   return jsonResponse(url.pathname.endsWith('/threads')?{threads:[{id:'thread-other'}]}:{id:'thread-other',messages:[other]});
  }
  assert.equal(method,'GET','Gmail never writes');assert.equal(headers.authorization,'Bearer '+token);
  assert.ok(url.pathname.startsWith('/gmail/v1/users/me/threads'),'only the selected managed mailbox is read');
  if(url.pathname.endsWith('/threads')){
   const q=url.searchParams.get('q'),page=url.searchParams.get('pageToken');
   assert.equal(url.searchParams.get('maxResults'),'25');assert.equal(url.searchParams.get('fields'),'threads(id),nextPageToken');
   if(q==='zero')return jsonResponse({});
   if(q==='provider')return jsonResponse({error:'synthetic-crank-provider'},500);
   if(q==='permission')return jsonResponse({},403);
   if(q==='malformed')return jsonResponse({threads:'bad'});
   if(q==='bad-json')return new Response('{', {headers:{'content-type':'application'+'/'+'json'}});
   if(q==='cycle')return jsonResponse({threads:[],nextPageToken:'same'});
   if(q==='incomplete')return jsonResponse({threads:[],nextPageToken:'page-'+(Number(page?.slice(5)??0)+1)});
   if(q==='one')return jsonResponse({threads:[{id:'thread-a'}]});
   if(q==='headers'||q==='wrong-thread'||q==='duplicate-message')return jsonResponse({threads:[{id:'thread-a'}]});
   if(q==='large-metadata')return jsonResponse({threads:[{id:'thread-a'},{id:'thread-b'},{id:'thread-c'}]});
   assert.equal(q,query,'the supported Gmail query reaches the provider without rewriting');
   return jsonResponse(page?{threads:[{id:'thread-a'},{id:'thread-b'}]}:{threads:[{id:'thread-a'}],nextPageToken:'second'});
  }
  const id=url.pathname.split('/').at(-1);
  assert.equal(url.searchParams.get('format'),'metadata');assert.deepEqual(url.searchParams.getAll('metadataHeaders'),['subject','from']);
  assert.equal(url.searchParams.get('fields'),'id,messages(id,threadId,labelIds,internalDate,payload(headers(name,value)))');
  if(mode==='park'&&id==='thread-b'&&!parked){parked=true;return jsonResponse({},429,{'retry-after':'31'})}
  const item=message(id,mode==='headers'?'x'.repeat(2049):hostileSubject);
  if(mode==='large-metadata')item.payload.headers=Array.from({length:100},()=>({name:'Subject',value:'x'.repeat(2048)}));
  if(mode==='wrong-thread')item.threadId='foreign-thread';
  return jsonResponse({id,messages:mode==='duplicate-message'?[item,item]:[item],snippet:'synthetic-crank-snippet'});
 });
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'google',auth_kind:'oauth2',label:'Selected mailbox',scopes:[gmailScope],secret:{access_token:token}});
 return {h,c,fake,token,setMode(value){mode=value;parked=false}};
}

/** A few complete sanity journeys use native draft tests, publication, run and Cron doors. */
export async function gmailSearchJourney({onScreen}={}){
 const f=await gmailFixture(),{h,c,fake,token}=f;
 try{
  const draft=await h.post('workflows',{name:'Gmail metadata review',graph:graph(gmailStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{query}},h.owner,201);
  assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{query}),output=stepOf(good,'mail').output;
  assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(output.count,2);
  assert.deepEqual(output.records.map(item=>item.thread_id),['thread-b','thread-a']);
  assert.equal(output.records[0].messages[0].id,'message-thread-b');
  assert.equal(output.records[0].messages[0].internal_date,'200');assert.deepEqual(output.records[0].messages[0].label_ids,['INBOX','Label_1']);
  assert.equal(output.records[0].messages[0].headers.subject[0],hostileSubject);
  assert.deepEqual(output.records[0].messages[0].headers.from,['synthetic-crank-person']);
  assert.deepEqual(stepOf(good,'outcome').output,{outcome:'found',count:2});
  for(const value of ['synthetic-crank-body','synthetic-crank-snippet','synthetic-crank-attachment','synthetic-crank-unselected',token])assert.ok(!JSON.stringify(good).includes(value));
  const calls=fake.to('gmail.googleapis.com').slice(-4);assert.equal(calls.length,4);assert.equal(calls.filter(call=>call.url.pathname.endsWith('/thread-a')).length,1,'duplicate page IDs cause one metadata read');
  const flows=await h.get('data'+'/'+'flows'),flow=flows.flows.find(item=>item.kind==='gmail.search_threads');
  assert.deepEqual(flow.recipients,['https://gmail.googleapis.com']);assert.ok(flow.fields.includes('query'));assert.ok(flow.fields.includes('metadata_headers'));assert.match(flow.credentials,/oauth/i);assert.match(flow.region,/not verified/);
  assert.ok(!JSON.stringify(flows).includes(query),'disclosure contains field categories, never query literals');
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  const displayName='Synthetic mailbox observer',address=['synthetic-crank-observer','example.test'].join('@');
  const invited=await h.send('/auth/invite',{email:address,displayName,role:'member'},h.owner);assert.equal(invited.status,202,invited.text);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const observer=(await h.send('/auth/operators',undefined,h.owner)).value.find(item=>item.displayName===displayName);
  await h.post('team/'+observer.id,{grants:[{role:'viewer',workflow_ids:[draft.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+good.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(item=>!('output'in item)&&!('input'in item)));assert.ok(!JSON.stringify(restricted).includes('synthetic-crank-person'));
  await h.get('data'+'/'+'flows',signed.cookie,403);
  const zero=await startRun(h,draft,{query:'zero'});assert.deepEqual(stepOf(zero,'mail').output.records,[]);assert.equal(stepOf(zero,'outcome').output.outcome,'not found');
  const one=await startRun(h,draft,{query:'one'});assert.equal(stepOf(one,'mail').output.count,1);
  for(const [settings,input,expected,status]of[
   [{no_match:'halt'},'zero','not found','stopped_by_search'],
   [{multi_match:'first'},query,'found','succeeded'],
   [{multi_match:'stop'},query,'multiple matches','stopped_by_search'],
   [{multi_match:'stop',on_multiple:'continue'},query,'multiple matches','succeeded'],
   [{limit:1},query,'truncated','succeeded'],
   [{},'incomplete','truncated','succeeded'],
  ]){
   const w=await publish(h,'Gmail declared outcome',graph({...gmailStep(c.id),...settings})),run=await startRun(h,w,{query:input});
   assert.equal(run.status,status,JSON.stringify(run.error));assert.equal(stepOf(run,'mail').output.outcome,expected);
   if(settings.multi_match==='first')assert.equal(stepOf(run,'mail').output.record.id,'thread-b');
   if(settings.multi_match==='stop'&&status==='stopped_by_search')assert.ok(!run.steps.some(item=>item.step_id==='outcome'));
  }
  for(const multi_match of ['first','stop']){
   const w=await publish(h,'Incomplete search refuses a decision',graph({...gmailStep(c.id),multi_match})),run=await startRun(h,w,{query:'incomplete'});
   assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/i);assert.ok(!run.steps.some(item=>item.step_id==='outcome'));
   if(onScreen&&multi_match==='first')await onScreen({h,w,run,state:'incomplete'});
  }
  for(const mode of ['cycle','provider','permission','malformed','bad-json','headers','large-metadata','wrong-thread','duplicate-message']){
   f.setMode(mode);const run=await startRun(h,draft,{query:mode});
   assert.ok(!['succeeded','stopped_by_search'].includes(run.status),mode+' never means no match');
   assert.ok(!run.steps.some(item=>item.step_id==='outcome'),mode+' sends no downstream work');
  }
  f.setMode('normal');
  const before=fake.requests.length,empty=await startRun(h,draft,{query:'  '});assert.equal(empty.status,'failed');assert.match(empty.error.message,/query/);assert.equal(fake.requests.length,before);
  for(const patch of [{create_if_not_found:{}},{sort:{field:'subject',direction:'desc'}},{metadata_headers:['Subject','subject']},{input:{query:'one',format:'full'}},{metadata_headers:['Subject\nInjected']}])await h.post('workflows',{name:'Unsupported Gmail search',graph:graph({...gmailStep(c.id),...patch})},h.owner,422);
  for(const account of [
   await connection(h,{app:'google',auth_kind:'oauth2',label:'Calendar scope only',scopes:['https://www.googleapis.com/auth/calendar.events'],secret:{access_token:'synthetic-crank-602'}}),
   await connection(h,{app:'google',auth_kind:'oauth2',label:'Metadata scope cannot search',scopes:['https://www.googleapis.com/auth/gmail.metadata'],secret:{access_token:'synthetic-crank-606'}}),
   await connection(h,{app:'http',auth_kind:'bearer',label:'Arbitrary credential',domains:['gmail.googleapis.com'],secret:{token:'synthetic-crank-603'}}),
  ]){
   const w=await publish(h,'Missing Gmail consent',graph(gmailStep(account.id))),count=fake.requests.length,run=await startRun(h,w,{query:'one'});
   assert.notEqual(run.status,'succeeded');assert.equal(fake.requests.length,count,'wrong credential or insufficient read consent never dispatches');
  }
  const other=await connection(h,{app:'google',auth_kind:'oauth2',label:'Second managed mailbox',scopes:[gmailScope],secret:{access_token:'synthetic-crank-605'}}),otherFlow=await publish(h,'Second mailbox search',graph(gmailStep(other.id)));
  const second=await startRun(h,otherFlow,{query:'one'});assert.equal(second.status,'succeeded');assert.equal(stepOf(second,'mail').output.record.thread_id,'thread-other');assert.ok(!JSON.stringify(second).includes('synthetic-crank-person'),'a second connection never returns the first mailbox metadata');
  f.setMode('park');const interrupted=await startRun(h,draft,{query});assert.equal(interrupted.status,'waiting');
  await h.post(`connections/${c.id}/revoke`);const count=fake.requests.length;
  await h.restart({clock:later});await h.tick(Date.parse(later));assert.notEqual((await h.get('workflow-runs/'+interrupted.id)).status,'succeeded');assert.equal(fake.requests.length,count,'revocation fences a retained-page continuation before another physical request');
  assert.notEqual((await startRun(h,draft,{query:'one'})).status,'succeeded');assert.equal(fake.requests.length,count);
  assert.ok(fake.requests.every(item=>item.method==='GET'&&/^\/gmail\/v1\/users\/me\/threads(?:\/[A-Za-z0-9_-]+)?$/.test(item.url.pathname)),'there are zero writes, body fetches or file downloads');
 }finally{await h.close()}
}

export async function gmailCustodyJourney(){
 const f=await gmailFixture(),{h,c,fake,token}=f;let receiving,waitingReceiving,erased;
 try{
  const w=await publish(h,'Sealed mailbox search',graph(gmailStep(c.id)));
  await h.post(`workflows/${w.id}/pause`);
  await h.post('data'+'/'+'classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['from']});
  await h.post(`workflows/${w.id}/resume`);
  f.setMode('park');const parked=await startRun(h,w,{query});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));
  const completed=fake.requests.filter(item=>!item.url.pathname.endsWith('/thread-b')).map(item=>item.url.href);
  assert.equal(completed.length,3,'both search pages and the first thread completed before parking');
  let saved=await archive(h);assert.ok(!saved.includes(token));
  const chunks=inventory(saved).map(JSON.parse).filter(item=>item.table==='crank_request_checkpoint_chunks');assert.equal(chunks.length,3);assert.ok(chunks.every(item=>item.row.content_base64.startsWith('{"sealed":"crank-payload-v1"')),'unfinished pages and metadata are sealed');
  assert.ok(!saved.includes(hostileSubject));
  waitingReceiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await waitingReceiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const waitingRows=inventory(saved),receivedWaiting=inventory(await archive(waitingReceiving)),waitingSet=new Set(waitingRows),waitingExtra=receivedWaiting.filter(item=>!waitingSet.has(item));
  assert.equal(waitingExtra.length,1);assert.equal(JSON.parse(waitingExtra[0]).row.action,'data.restore');assert.deepEqual(receivedWaiting.filter(item=>item!==waitingExtra[0]),waitingRows,'unfinished sealed pages restore completely');
  const beforeInactive=fake.requests.length;await waitingReceiving.restart();await waitingReceiving.tick(Date.parse(later));assert.equal(fake.requests.length,beforeInactive,'restored unfinished pages convey no mailbox authority');
  await waitingReceiving.close();waitingReceiving=null;
  const rotated=await h.post('data'+'/'+'keys'+'/'+'rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick();
  const rotatedChunks=inventory(await archive(h)).map(JSON.parse).filter(item=>item.table==='crank_request_checkpoint_chunks');assert.ok(rotatedChunks.every(item=>JSON.parse(item.row.content_base64).k===rotated.key_id),'parked pages rotate with their run');
  const held=await h.post('data'+'/'+'holds',{kind:'subject',subject:'synthetic-crank-person',reason:'Mailbox retention review'},h.owner,201);
  await h.post(`workflows/${w.id}/pause`);
  const heldPreview=await h.post('data'+'/'+'subject',{subject:'synthetic-crank-person'});assert.ok(heldPreview.workflow_runs.some(item=>item.id===parked.id));assert.equal(heldPreview.blocked,true,'a subject found only in unfinished sealed metadata is held');
  await h.post('data'+'/'+'erase',{subject:'synthetic-crank-person',digest:heldPreview.digest,confirm:'ERASE'},h.owner,409);
  await h.post(`workflows/${w.id}/resume`);
  await h.restart({clock:later});await h.tick(Date.parse(later));
  const good=await h.get('workflow-runs/'+parked.id);assert.equal(good.status,'succeeded',JSON.stringify(good.error));
  assert.equal(stepOf(good,'mail').output.count,2);assert.equal(fake.requests.length,5,'restart retains all three completed reads and retries only the parked thread');
  for(const url of completed)assert.equal(fake.requests.filter(item=>item.url.href===url).length,1);
  const policy={payload_days:1,attachment_days:null,history_days:30},preview=await h.post('data'+'/'+'retention'+'/'+'preview',policy);await h.post('data'+'/'+'retention',{...policy,digest:preview.digest});
  const future=Date.parse(later)+2*86400000;await h.tick(future);assert.equal((await h.get('workflow-runs/'+good.id)).payload_expired_at,null,'legal hold retains metadata and completed pages');
  saved=await archive(h);receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await receiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),returned=inventory(await archive(receiving)),source=new Set(original),extra=returned.filter(item=>!source.has(item));
  assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(returned.filter(item=>item!==extra[0]),original,'every portable record, sealed page and metadata result round trips');
  const there=await receiving.get('workflow-runs/'+good.id);assert.equal(stepOf(there,'mail').output.sealed,true,'restored metadata stays unreadable without the owner key file');
  const count=fake.requests.length;await receiving.restart();await receiving.tick(future);assert.equal(fake.requests.length,count);assert.ok((await receiving.get('connections')).every(item=>item.status!=='active'));assert.ok((await receiving.get('workflows')).every(item=>item.status!=='published'));
  await h.post(`data/holds/${held.id}/release`,{confirm:'RELEASE'});
  await h.tick(future);const expired=await h.get('workflow-runs/'+good.id);assert.ok(expired.payload_expired_at);assert.equal(stepOf(expired,'mail').output,null);
  const after=inventory(await archive(h)).map(JSON.parse);assert.ok(!after.some(item=>item.table.startsWith('crank_request_checkpoint')&&item.row.run_id===good.id),'expiry removes checkpoint pages too');
  assert.match((await h.get(`workflow-runs/${good.id}/replay`)).blocked_reason,/expired/);
  f.setMode('normal');const eraseMe=await startRun(h,w,{query:'one'});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);
  const erasePreview=await h.post('data'+'/'+'subject',{subject:'synthetic-crank-person'});assert.ok(erasePreview.workflow_runs.some(item=>item.id===eraseMe.id));
  await h.post('data'+'/'+'erase',{subject:'synthetic-crank-person',digest:erasePreview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await erased.post('data'+'/'+'restore',{archive:saved,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'older captured pages cannot resurrect erased data');
 }finally{await erased?.close();await waitingReceiving?.close();await receiving?.close();await h.close()}
}

export async function gmailOwnership(h,fake){
 fake.routes.set('gmail.googleapis.com',({url})=>jsonResponse(url.pathname.endsWith('/threads')?{threads:[{id:'thread-a'}]}:{id:'thread-a',messages:[message('thread-a')]}));
 const c=await connection(h,{app:'google',auth_kind:'oauth2',label:'Owned mailbox',scopes:[gmailScope],secret:{access_token:'synthetic-crank-604'}}),w=await publish(h,'Owned Gmail metadata',graph(gmailStep(c.id))),run=await startRun(h,w,{query:'one'});
 assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(stepOf(run,'mail').output.record.thread_id,'thread-a');return ['gmail.search_threads'];
}
