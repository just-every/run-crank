import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {harness} from './harness.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

export const zone=['America','Chicago'].join('/');
export const interval={calendar_id:'synthetic-crank-calendar',time_min:'2026-11-01T00:00:00-05:00',time_max:'2026-11-03T00:00:00-06:00',time_zone:zone};
const scope='https://www.googleapis.com/auth/calendar.events.readonly';
const clock='2026-11-10T15:00:00Z';
export const searchStep=connection_id=>({id:'search',name:'Calendar event search',type:'google_calendar.search_events',connection_id,sort:{field:'id',direction:'asc'},retry_policy:{read_attempts:2,base_delay_ms:1},input:interval});
export const events=[
 {id:'synthetic-crank-b',status:'confirmed',summary:'Repeated hour first occurrence',recurringEventId:'synthetic-crank-series',originalStartTime:{dateTime:'2026-11-01T01:30:00-05:00',timeZone:zone},start:{dateTime:'2026-11-01T01:30:00-05:00',timeZone:zone},end:{dateTime:'2026-11-01T01:45:00-05:00',timeZone:zone}},
 {id:'synthetic-crank-a',status:'cancelled',summary:'Repeated hour second occurrence',recurringEventId:'synthetic-crank-series',originalStartTime:{dateTime:'2026-11-01T01:30:00-06:00',timeZone:zone},start:{dateTime:'2026-11-01T01:30:00-06:00',timeZone:zone},end:{dateTime:'2026-11-01T01:45:00-06:00',timeZone:zone}},
 {id:'synthetic-crank-c',status:'tentative',summary:'<img src=x onerror=alert(1)> synthetic-crank-person',start:{date:'2026-11-01'},end:{date:'2026-11-02'}},
];
async function fixture() {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'google',auth_kind:'oauth2',label:'Managed read calendar',scopes:[scope],secret:{access_token:'synthetic-crank-501'}});
 return {fake,h,c};
}
const flow=(h,c,patch={},after=[])=>publish(h,'Read Calendar events',{trigger:{type:'manual'},steps:[{...searchStep(c.id),...patch},...after]});
const found=run=>stepOf(run,'search')?.output;
function assertRead(request,token='synthetic-crank-501',calendar=interval.calendar_id) {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.headers.authorization,'Bearer '+token);
 assert.equal(decodeURIComponent(request.url.pathname),`/calendar/v3/calendars/${calendar}/events`);
 for(const [key,value] of Object.entries({timeMin:interval.time_min,timeMax:interval.time_max,timeZone:zone,singleEvents:'true',showDeleted:'true',maxResults:'100'}))assert.equal(request.url.searchParams.get(key),value);
 assert.equal(request.url.searchParams.has('sendUpdates'),false);
}
export async function googleCalendarSearchJourney({onScreen}={}) {
 const {fake,h,c}=await fixture();let restored,erased;
 try {
  let mode='pages',calls=0;
  fake.routes.set('www.googleapis.com',request=>{
   assertRead(request);calls++;
   const cursor=request.url.searchParams.get('pageToken');
   if(mode==='empty')return jsonResponse({items:[]});
   if(mode==='error')return jsonResponse({error:'synthetic-crank-provider'},500);
   if(mode==='forbidden')return jsonResponse({},403);
   if(mode==='malformed')return new Response('not JSON');
   if(mode==='bad_items')return jsonResponse({items:[{id:'synthetic-crank-no-time',status:'confirmed'}]});
   if(mode==='bad_date')return jsonResponse({items:[{...events[0],start:{date:'2026-02-30'}}]});
   if(mode==='loop')return jsonResponse({items:[events[0]],nextPageToken:'synthetic-crank-loop'});
   if(mode==='bad_token')return jsonResponse({items:[],nextPageToken:{value:'bad'}});
   if(mode==='changed_duplicate')return jsonResponse(cursor?{items:[{...events[0],summary:'Changed between pages'}]}:{items:[events[0]],nextPageToken:'synthetic-crank-page'});
   if(mode==='park'&&cursor)return jsonResponse({},429,{'retry-after':'60'});
   return jsonResponse(cursor?{items:[events[1],events[2],events[0]]}:{items:[events[0]],nextPageToken:'synthetic-crank-page'});
  });
  const all=await flow(h,c,{multi_match:'all',limit:10,input:{...interval,query:'synthetic-crank exact text'}});
  const complete=await startRun(h,all,{});
  assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));assert.equal(calls,2);assert.equal(found(complete).count,3);assert.equal(found(complete).complete,true);
  assert.deepEqual(found(complete).records.map(e=>e.id),['synthetic-crank-a','synthetic-crank-b','synthetic-crank-c']);
  assert.equal(fake.requests[0].url.searchParams.get('q'),'synthetic-crank exact text');
  const [second,first,day]=found(complete).records;
  assert.equal(second.recurring_event_id,first.recurring_event_id);assert.notEqual(second.id,first.id);assert.equal(second.status,'cancelled');assert.equal(first.status,'confirmed');
  assert.deepEqual(second.original_start_time,events[1].originalStartTime);assert.deepEqual(first.start,events[0].start);assert.equal(second.start_at,'2026-11-01T07:30:00.000Z');assert.equal(first.start_at,'2026-11-01T06:30:00.000Z');
  assert.deepEqual(day.start,{date:'2026-11-01'});assert.deepEqual(day.end,{date:'2026-11-02'});assert.equal(day.start_at,'2026-11-01T05:00:00.000Z');assert.equal(day.time_zone,zone);
  if(onScreen)await onScreen({h,w:all,run:complete,state:'complete'});
  const ordered=await startRun(h,await flow(h,c,{multi_match:'first',sort:{field:'start_at',direction:'asc'}}),{});assert.equal(found(ordered).record.id,'synthetic-crank-c');assert.equal(found(ordered).count,3);
  const latest=await startRun(h,await flow(h,c,{multi_match:'first',sort:{field:'start_at',direction:'desc'}}),{});assert.equal(found(latest).record.id,'synthetic-crank-a');
  const stopped=await startRun(h,await flow(h,c,{multi_match:'stop'}),{});assert.equal(stopped.status,'stopped_by_search');assert.equal(found(stopped).outcome,'multiple matches');
  const routed=await startRun(h,await flow(h,c,{multi_match:'stop',on_multiple:'continue'},[{id:'route',type:'respond',input:{body:{outcome:'{{steps.search.outcome}}'}}}]),{});assert.equal(routed.status,'succeeded');assert.deepEqual(routed.response.body,{outcome:'multiple matches'});
  const limited=await startRun(h,await flow(h,c,{multi_match:'all',limit:2}),{});assert.equal(found(limited).outcome,'truncated');assert.equal(found(limited).count,2);assert.equal(found(limited).truncated,true);assert.equal(found(limited).complete,true);
  for(const multi_match of ['first','stop']) {
   const incomplete=await startRun(h,await flow(h,c,{multi_match,max_pages:1}),{});assert.equal(incomplete.status,'failed');assert.match(incomplete.error.message,/incomplete/);assert.notEqual(found(incomplete)?.outcome,'not found');
  }
  const bounded=await startRun(h,await flow(h,c,{multi_match:'all',max_pages:1}),{});assert.equal(found(bounded).outcome,'truncated');assert.equal(found(bounded).complete,false);assert.equal(found(bounded).pages,1);
  mode='empty';
  const halt=await startRun(h,await flow(h,c,{no_match:'halt'}),{});assert.equal(halt.status,'stopped_by_search');assert.equal(found(halt).outcome,'not found');
  const none=await startRun(h,await flow(h,c,{no_match:'continue'},[{id:'route',type:'respond',input:{body:{outcome:'{{steps.search.outcome}}',records:'{{steps.search.records}}'}}}]),{});assert.equal(none.status,'succeeded');assert.deepEqual(none.response.body,{outcome:'not found',records:[]});
  mode='pages';fake.routes.set('www.googleapis.com',request=>{assertRead(request);return jsonResponse({items:[events[0]]})});
  const one=await startRun(h,all,{});assert.equal(found(one).count,1);assert.equal(found(one).record.id,events[0].id);
  // Restore the common edge for malformed and error cases.
  const responses=[['malformed',()=>new Response('not JSON')],['bad items',()=>jsonResponse({items:{}})],['bad event',()=>jsonResponse({items:[{id:'synthetic-crank-no-time',status:'confirmed'}]})],['bad date',()=>jsonResponse({items:[{...events[0],start:{date:'2026-02-30'}}]})],['mixed time kinds',()=>jsonResponse({items:[{...events[0],start:{date:'2026-11-01'}}]})],['provider error',()=>jsonResponse({},500)],['permission',()=>jsonResponse({},403)],['cursor loop',()=>jsonResponse({items:[events[0]],nextPageToken:'synthetic-crank-loop'})],['bad token',()=>jsonResponse({items:[],nextPageToken:{bad:true}})],['too many events',()=>jsonResponse({items:Array(101).fill(events[0])})],['changed duplicate',({url})=>jsonResponse(url.searchParams.has('pageToken')?{items:[{...events[0],summary:'changed'}]}:{items:[events[0]],nextPageToken:'synthetic-crank-page'})]];
  for(const [label,reply] of responses) {
   fake.routes.set('www.googleapis.com',request=>{assertRead(request);return reply(request)});
   const bad=await startRun(h,all,{});assert.equal(bad.status,'failed',label);assert.notEqual(bad.error.category,'not_found',label);assert.equal(found(bad),null,label);
  }
  // Static declarations and resolved mapped inputs both refuse before dispatch.
  let before=fake.requests.length;
  for(const patch of [{create_if_not_found:{}},{max_pages:0},{sort:{field:'summary',direction:'asc'}},{input:{...interval,calendar_id:'primary'}},{input:{...interval,time_zone:''}},{input:{...interval,time_min:'2026-11-01T01:30:00-04:00'}},{input:{...interval,time_max:interval.time_min}},{input:{...interval,time_max:'2028-11-01T00:00:00-05:00'}},{input:{...interval,extra:true}}]) {
   await h.post('workflows',{name:'Invalid calendar search',graph:{trigger:{type:'manual'},steps:[{...searchStep(c.id),...patch}]}},h.owner,422);
  }
  const mapped=await flow(h,c,{input:{...interval,calendar_id:'{{trigger.input.calendar}}'}});
  const invalid=await startRun(h,mapped,{calendar:''});assert.equal(invalid.status,'failed');assert.equal(invalid.error.category,'validation');assert.equal(fake.requests.length,before);
  const wrong=await connection(h,{app:'http',auth_kind:'bearer',domains:['www.googleapis.com'],label:'No Google authority',secret:{token:'synthetic-crank-502'}});
  const insufficient=await connection(h,{app:'google',auth_kind:'oauth2',scopes:['https://www.googleapis.com/auth/calendar.freebusy'],label:'No event read authority',secret:{access_token:'synthetic-crank-503'}});
  for(const refused of [wrong,insufficient])assert.notEqual((await startRun(h,await flow(h,refused),{})).status,'succeeded');
  assert.equal(fake.requests.length,before,'wrong credentials and freebusy-only consent send no event request');
  const other=await connection(h,{app:'google',auth_kind:'oauth2',scopes:[scope],label:'Separate managed account',secret:{access_token:'synthetic-crank-504'}});
  fake.routes.set('www.googleapis.com',request=>{assertRead(request,'synthetic-crank-504','synthetic-crank-other-calendar');return jsonResponse({items:[{...events[0],id:'synthetic-crank-other-event'}]})});
  fake.routes.set('www.googleapis.com',request=>{assertRead(request,'synthetic-crank-504','synthetic-crank-other-calendar');return jsonResponse({items:[{id:'synthetic-crank-cancelled',status:'cancelled'}]})});
  const sparse=await startRun(h,await flow(h,other,{input:{...interval,calendar_id:'synthetic-crank-other-calendar'}}),{});assert.equal(sparse.status,'succeeded');assert.equal(found(sparse).record.status,'cancelled');assert.equal(found(sparse).record.start,null);assert.equal(found(sparse).record.end,null);
  fake.routes.set('www.googleapis.com',request=>{assertRead(request,'synthetic-crank-504','synthetic-crank-other-calendar');return jsonResponse({items:[{...events[0],id:'synthetic-crank-other-event'}]})});
  const isolated=await startRun(h,await flow(h,other,{input:{...interval,calendar_id:'synthetic-crank-other-calendar'}}),{});assert.equal(found(isolated).record.id,'synthetic-crank-other-event');assert.equal(found(complete).records.some(e=>e.id==='synthetic-crank-other-event'),false);
  // A later-page request is parked. Restart must reconstruct the completed page.
  fake.routes.set('www.googleapis.com',request=>{assertRead(request);return request.url.searchParams.has('pageToken')?jsonResponse({},429,{'retry-after':'60'}):jsonResponse({items:[events[0]],nextPageToken:'synthetic-crank-page'})});
  const parked=await startRun(h,all,{});assert.equal(parked.status,'waiting');const operation=stepOf(parked,'search').operation_key;before=fake.requests.length;
  const exported=await archive(h);assert.ok(!exported.includes('synthetic-crank-501'));assert.ok(!exported.includes('synthetic-crank-504'));
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
  const original=inventory(exported),received=inventory(await archive(restored)),additions=received.filter(row=>!new Set(original).has(row));
  assert.equal(additions.length,1);assert.equal(JSON.parse(additions[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==additions[0]),original,'every portable record survives inactive restoration');
  assert.ok((await restored.get('connections')).every(c=>c.status==='needs_reconnect'));assert.ok((await restored.get('workflows')).every(w=>['paused','draft'].includes(w.status)));
  await restored.restart();await restored.tick('2026-11-10T15:02:01Z');assert.equal(fake.requests.length,before,'inactive restore never resumes provider reads');
  fake.routes.set('www.googleapis.com',request=>{assertRead(request);assert.equal(request.url.searchParams.get('pageToken'),'synthetic-crank-page','retained first page is not fetched again');return jsonResponse({items:[events[1],events[2]]})});
  await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');
  const resumed=await h.get('workflow-runs/'+parked.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.equal(found(resumed).count,3);assert.equal(stepOf(resumed,'search').operation_key,operation);assert.equal(fake.requests.length,before+1);
  assert.deepEqual(JSON.parse((await h.db.prepare('SELECT scopes_json FROM crank_connections WHERE id=?').bind(c.id).first()).scopes_json),[scope],'read operations never widen consent');
  // Revocation while parked and scope reduction between pages stop the next request.
  fake.routes.set('www.googleapis.com',request=>{assertRead(request);return jsonResponse({},429,{'retry-after':'60'})});
  const revoked=await startRun(h,all,{});assert.equal(revoked.status,'waiting');before=fake.requests.length;await h.post('connections/'+c.id+'/revoke');await h.restart({clock:'2026-11-10T15:02:02Z'});await h.tick('2026-11-10T15:02:02Z');assert.equal((await h.get('workflow-runs/'+revoked.id)).status,'paused');assert.equal(fake.requests.length,before);
  await h.post('connections/'+c.id+'/rotate',{secret:{access_token:'synthetic-crank-501'},scopes:[scope]});
  fake.routes.set('www.googleapis.com',async request=>{assertRead(request);await h.post('connections/'+c.id+'/rotate',{secret:{access_token:'synthetic-crank-501'},scopes:['https://www.googleapis.com/auth/calendar.freebusy']});return jsonResponse({items:[events[0]],nextPageToken:'synthetic-crank-page'})});
  const denied=await startRun(h,all,{});assert.notEqual(denied.status,'succeeded');assert.equal(fake.requests.length,before+1,'current read consent is checked for every page');
  assert.ok(fake.to('www.googleapis.com').every(r=>r.method==='GET'),'native search has zero provider writes');
  const disclosure=(await h.get('data/flows')).flows.find(f=>f.kind==='google_calendar.search_events');assert.deepEqual(disclosure.recipients,['https://www.googleapis.com']);for(const field of ['calendar_id','time_min','time_max','time_zone','page_token'])assert.ok(disclosure.fields.includes(field));assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(interval.calendar_id));
 }finally{await erased?.close();await restored?.close();await h.close()}
}



export async function googleCalendarSearchCustodyJourney({onScreen}={}) {
 const {fake,h,c}=await fixture();let restored,erased;
 try {
  const w=await flow(h,c,{multi_match:'all',limit:10});
  await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['id','summary']});await h.post(`workflows/${w.id}/resume`);
  let items=[{description:'x'.repeat(70000),...events[0]}],parking=true;
  fake.routes.set('www.googleapis.com',request=>{assertRead(request);return request.url.searchParams.has('pageToken')?(parking?jsonResponse({},429,{'retry-after':'60'}):jsonResponse({items:[events[1],events[2]]})):jsonResponse({items,nextPageToken:'synthetic-crank-private-page'})});
  const parked=await startRun(h,w,{});assert.equal(parked.status,'waiting');
  const chunks=async id=>(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=? ORDER BY ordinal,chunk_index').bind(id).all()).results;
  const metadata=await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(parked.id).first();assert.ok(!metadata.response_json.includes(interval.calendar_id),'resource identifiers stay out of plaintext checkpoint metadata');
  const raw=await chunks(parked.id);assert.equal(raw.length,2,'a completed page crosses the binary chunk boundary');assert.ok(raw.every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'));assert.ok(!raw[0].content_base64.includes(events[0].summary));
  // Upgrade fixture: older sealed runs retained completed pages as raw base64,
  // without a subject index, even though their run key metadata was current.
  const legacy=Buffer.from(JSON.stringify({items,nextPageToken:'synthetic-crank-private-page'}));
  await h.db.batch([
   ...Array.from({length:Math.ceil(legacy.length/65536)},(_,index)=>h.db.prepare('UPDATE crank_request_checkpoint_chunks SET content_base64=? WHERE run_id=? AND ordinal=0 AND chunk_index=?').bind(legacy.subarray(index*65536,(index+1)*65536).toString('base64'),parked.id,index)),
   h.db.prepare('DELETE FROM crank_blind_index WHERE run_id=?').bind(parked.id),
  ]);
  assert.deepEqual((await h.post('data/subject',{subject:events[0].id})).workflow_runs.map(r=>r.id),[parked.id],'plaintext legacy pages remain discoverable before maintenance');
  await h.db.exec(`CREATE TRIGGER interrupt_checkpoint_index BEFORE INSERT ON crank_blind_index WHEN NEW.run_id='${parked.id}' BEGIN SELECT RAISE(ABORT,'synthetic-crank-index-interruption'); END;`);
  await h.tick('2026-11-10T15:00:10Z');
  assert.ok((await chunks(parked.id)).every(row=>!row.content_base64.startsWith('{')),'failed indexing rolls back checkpoint sealing');
  await h.db.exec('DROP TRIGGER interrupt_checkpoint_index');
  await h.restart();await h.tick('2026-11-10T15:00:20Z');
  assert.ok((await chunks(parked.id)).every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'),'restart seals all legacy chunks with their subject index');
  assert.equal((await h.post('data/subject',{subject:events[0].id})).sealed_unmatched.length,0);
  // The upgrade migration also marks pages already sealed by older maintenance
  // for re-indexing; losing that index must block erasure until the pass finishes.
  await h.db.prepare('DELETE FROM crank_blind_index WHERE run_id=?').bind(parked.id).run();
  await h.db.prepare(await readFile(new URL('../migrations/core/0086_checkpoint_subjects.sql',import.meta.url),'utf8')).run();
  assert.equal((await h.post('data/subject',{subject:events[0].id})).blocked,true);
  await h.tick('2026-11-10T15:00:30Z');
  const preview=await h.post('data/subject',{subject:events[0].id});assert.deepEqual(preview.workflow_runs.map(r=>r.id),[parked.id]);assert.equal(preview.blocked,true,'unfinished page is a retained subject even before a step result');
  const hold=await h.post('data/holds',{kind:'subject',subject:events[0].id,reason:'Calendar record under review'},h.owner,201);
  assert.match((await h.post('data/subject',{subject:events[0].id})).workflow_runs[0].blocked,/legal hold/);
  const exported=await archive(h);assert.ok(!exported.includes('synthetic-crank-501'));assert.ok(!exported.includes(events[0].summary));assert.ok(!exported.includes('synthetic-crank-private-page'));
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
  const original=inventory(exported),received=inventory(await archive(restored)),originalSet=new Set(original),added=received.filter(row=>!originalSet.has(row));assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==added[0]),original,'sealed unfinished pages and every portable record restore unchanged');
  assert.equal((await restored.get('workflow-runs/'+parked.id)).steps[0].status,'waiting','read-only interrupted history is not a possible write');
  const unavailable=await restored.post('data/subject',{subject:events[0].id});assert.equal(unavailable.blocked,true);assert.match(unavailable.sealed_unmatched.join(' '),/key file/);
  const before=fake.requests.length;await restored.restart();await restored.tick('2026-11-10T15:02:01Z');assert.equal(fake.requests.length,before,'sealed inactive restore issues no provider requests');
  const rotation=await h.post('data/keys/rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick('2026-11-10T15:00:10Z');
  assert.ok((await chunks(parked.id)).every(row=>JSON.parse(row.content_base64).k===rotation.key_id),'rotation re-seals every unfinished page chunk');
  assert.deepEqual((await h.post('data/subject',{subject:events[0].id})).workflow_runs.map(r=>r.id),[parked.id],'rotation preserves declared subject discovery');
  parking=false;const calls=fake.requests.length;
  fake.routes.set('www.googleapis.com',request=>{assertRead(request);assert.equal(request.url.searchParams.get('pageToken'),'synthetic-crank-private-page');return jsonResponse({items:[events[1],events[2]]})});
  await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');
  const done=await h.get('workflow-runs/'+parked.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(found(done).count,3);assert.deepEqual(found(done).records.map(r=>r.id),['synthetic-crank-a','synthetic-crank-b','synthetic-crank-c']);assert.equal(fake.requests.length,calls+1);
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=?').bind(done.id).first();assert.equal(JSON.parse(stored.output_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');
  const invitation=await h.send('/auth/invite',{email:['synthetic-crank-viewer','example.test'].join('@'),displayName:'Calendar history viewer',role:'member'},h.owner);assert.equal(invitation.status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');const token=new URL(link,h.origin).searchParams.get('token');const signed=await h.send('/auth/confirm',{token});assert.equal(signed.status,303);
  const people=await h.send('/auth/operators',undefined,h.owner);const viewer=people.value.find(p=>p.displayName==='Calendar history viewer');await h.post('team/'+viewer.id,{role:'viewer',workflow_ids:[w.id],connection_ids:[c.id]});
  const restricted=await h.get('workflow-runs/'+done.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.equal(stepOf(restricted,'search').output,undefined);assert.ok(!JSON.stringify(restricted).includes(events[0].summary),'status-only readers cannot see retained search payloads');

  const policy={payload_days:1,attachment_days:1,history_days:30};
  const dry=await h.post('data/retention/preview',{...policy,at:'2026-11-12T15:01:01Z'});assert.ok(dry.payload.kept.some(r=>r.id===done.id&&r.reason==='legal hold'));
  await h.post(`workflows/${w.id}/pause`);
  const held=await h.post('data/subject',{subject:events[0].id});await h.post('data/erase',{subject:events[0].id,digest:held.digest,confirm:'ERASE'},h.owner,409);
  await h.post('data/holds/'+hold.id+'/release');
  const canErase=await h.post('data/subject',{subject:events[0].id});assert.equal(canErase.blocked,false);await h.post('data/erase',{subject:events[0].id,digest:canErase.digest,confirm:'ERASE'});await h.get('workflow-runs/'+done.id,h.owner,404);assert.deepEqual(await chunks(done.id),[]);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await erased.post('data/restore',{archive:exported,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'erasure journal refuses resurrecting an old retained page');
  // Completed page payloads expire under the ordinary policy and cannot replay.
  await h.post(`workflows/${w.id}/resume`);fake.routes.set('www.googleapis.com',request=>{assertRead(request);return jsonResponse({items:[{...events[0],id:'synthetic-crank-expiring'}]})});
  const expiring=await startRun(h,w,{});assert.equal(expiring.status,'succeeded');
  const retention=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:retention.digest});
  await h.restart({clock:'2026-11-12T15:02:02Z'});await h.tick('2026-11-12T15:02:02Z');assert.deepEqual(await chunks(expiring.id),[]);const expired=await h.get('workflow-runs/'+expiring.id);assert.ok(expired.payload_expired_at);assert.equal(stepOf(expired,'search').output,null);
  assert.match((await h.get(`workflow-runs/${expiring.id}/replay`)).blocked_reason,/expired/);assert.ok(fake.requests.every(r=>r.method==='GET'));
 }finally{await erased?.close();await restored?.close();await h.close()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await googleCalendarSearchJourney();await googleCalendarSearchCustodyJourney();console.log('Google Calendar bounded reads, authority, sealed pages, holds, erasure and inactive custody PASS')}
