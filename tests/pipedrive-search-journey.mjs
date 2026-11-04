import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',tenant='synthetic-crank-701',host=tenant+'.pipedrive.com',token='synthetic-crank-702';
export const dealTitle='Synthetic Crank Deal <img src=x onerror="globalThis.pipedriveInjected=true">';
export const deals=[
 {id:10,title:dealTitle,status:'won',stage_id:4},
 {id:3,title:dealTitle,status:'open',stage_id:2},
 {id:2,title:dealTitle.toLowerCase(),status:'lost',stage_id:1},
 {id:1,title:dealTitle+' ',status:'open',stage_id:1},
];
const projected=raw=>({id:String(raw.id),title:raw.title,status:raw.status,stage_id:String(raw.stage_id)});
const page=(data,next_cursor=null)=>({success:true,data,additional_data:{next_cursor}});
export const pipedriveStep=connection_id=>({id:'search',name:'Pipedrive exact deal lookup',type:'pipedrive.find_deal',connection_id,subdomain:tenant,filter_id:'71',sort:{field:'id',direction:'asc'},multi_match:'all',retry_policy:{read_attempts:2,base_delay_ms:1},input:{title:'{{trigger.input.title}}'}});
const graph=(step,tail=[{id:'route',type:'respond',input:{body:{outcome:'{{steps.search.outcome}}',records:'{{steps.search.records}}'}}}])=>({trigger:{type:'manual'},steps:[step,...tail]});
const output=run=>stepOf(run,'search')?.output;
function requestIsRead(request,expectedHost=host,expectedToken=token,filter='71') {
 assert.equal(request.method,'GET');assert.equal(request.body,'');assert.equal(request.url.host,expectedHost);assert.equal(request.headers.authorization,'Bearer '+expectedToken);assert.equal(request.url.pathname,'/api/v2/deals');
 assert.deepEqual([...request.url.searchParams.keys()].sort(),['limit','sort_by','sort_direction',...(filter===null?[]:['filter_id']),...(request.url.searchParams.has('cursor')?['cursor']:[])].sort());
 assert.equal(request.url.searchParams.get('limit'),'100');assert.equal(request.url.searchParams.get('sort_by'),'id');assert.equal(request.url.searchParams.get('sort_direction'),'asc');assert.equal(request.url.searchParams.get('filter_id'),filter);
}
async function fixture() {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'pipedrive',auth_kind:'bearer',domains:[host],label:'Synthetic deal tenant',secret:{token}});
 fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse(request.url.searchParams.has('cursor')?page([deals[0],deals[1],deals[1]]):page([deals[2],deals[3]],'synthetic-crank-page'))});
 return {fake,h,c};
}
const flow=(h,c,patch={},tail)=>publish(h,'Pipedrive read-only deal lookup',graph({...pipedriveStep(c.id),...patch},tail));

/** Native HTTP draft-test, publication, run and Cron doors; only the provider edge is replaced. */
export async function pipedriveSearchJourney({onScreen}={}) {
 const {fake,h,c}=await fixture();
 try {
  // Populate and pause a genuine polling baseline before performing workflow reads.
  fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse(page(deals.map(raw=>({...raw,update_time:'2026-11-09T12:00:00Z'}))))});
  const poll=await publish(h,'Independent Pipedrive snapshots',{trigger:{type:'app_poll',provider:'pipedrive',resource:'deals',connection_id:c.id,subdomain:tenant,filter_id:'71',event:'updated',backfill:'from_now',interval_minutes:60,watched_fields:['status'],identity:'change'},steps:[{id:'seen',type:'map',input:{id:'{{trigger.record_id}}'}}]});
  await h.tick(clock);await h.post(`workflows/${poll.id}/pause`);
  const polling=async()=>Promise.all(['crank_polls','crank_poll_log','crank_app_snapshots','crank_app_field_values','crank_app_pending_rows','crank_trigger_events'].map(async table=>(await h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
  const baseline=await polling();assert.equal(baseline[2].length,4,'nonempty polling snapshots protect against accidental workflow-reader reuse');
  fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse(request.url.searchParams.has('cursor')?page([{...deals[0],custom_fields:{private:'synthetic-crank-unselected'}},deals[1],deals[1]]):page([deals[2],deals[3]],'synthetic-crank-page'))});
  const draft=await h.post('workflows',{name:'Pipedrive exact deal lookup',graph:graph(pipedriveStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{title:dealTitle}},h.owner,201);assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assert.deepEqual(output(tested).records,[projected(deals[1]),projected(deals[0])]);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const complete=await startRun(h,draft,{title:dealTitle});assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));assert.deepEqual(complete.response.body,{outcome:'found',records:[projected(deals[1]),projected(deals[0])]});assert.equal(output(complete).count,2);assert.equal(output(complete).pages,2);assert.equal(output(complete).complete,true);assert.ok(!JSON.stringify(complete).includes('synthetic-crank-unselected'));
  assert.deepEqual(output(await startRun(h,draft,{title:dealTitle.toLowerCase()})).records,[projected(deals[2])],'title equality is case sensitive');
  assert.deepEqual(output(await startRun(h,draft,{title:dealTitle+' '})).records,[projected(deals[3])],'significant whitespace is retained');
  if(onScreen)await onScreen({h,w:draft,run:complete,state:'complete'});
  for(const [patch,input,status,outcome,ids] of [
   [{multi_match:'first'},{title:dealTitle},'succeeded','found',['3']],
   [{multi_match:'first',sort:{field:'id',direction:'desc'}},{title:dealTitle},'succeeded','found',['10']],
   [{multi_match:'stop'},{title:dealTitle},'stopped_by_search','multiple matches',undefined],
   [{multi_match:'stop',on_multiple:'continue'},{title:dealTitle},'succeeded','multiple matches',['3','10']],
   [{multi_match:'all',limit:1},{title:dealTitle},'succeeded','truncated',['3']],
   [{no_match:'halt'},{title:'synthetic-crank-missing'},'stopped_by_search','not found',undefined],
   [{no_match:'continue'},{title:'synthetic-crank-missing'},'succeeded','not found',[]],
  ]) {
   const run=await startRun(h,await flow(h,c,patch),input);assert.equal(run.status,status,JSON.stringify(run.error));assert.equal(output(run).outcome,outcome);if(ids)assert.deepEqual(output(run).records.map(item=>item.id),ids);assert.equal(!!run.response,status==='succeeded','search halts never reach downstream response');
  }
  for(const mode of ['first','stop']) {
   const run=await startRun(h,await flow(h,c,{multi_match:mode,max_pages:1}),{title:dealTitle});assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/);assert.equal(stepOf(run,'route'),undefined);
  }
  const bounded=await startRun(h,await flow(h,c,{max_pages:1}),{title:dealTitle});assert.equal(output(bounded).outcome,'truncated');assert.equal(output(bounded).complete,false);assert.deepEqual(output(bounded).records,[],'an incomplete scan cannot report false absence');
  if(onScreen)await onScreen({h,w:draft,run:bounded,state:'incomplete'});
  const beforeInvalid=fake.requests.length;
  for(const patch of [{create_if_not_found:{}},{comparison:'contains'},{resource:'persons'},{subdomain:'{{trigger.input.tenant}}'},{filter_id:'{{trigger.input.filter}}'},{filter_id:0},{max_pages:0},{sort:{field:'title',direction:'asc'}},{input:{title:''}},{input:{title:42}},{input:{title:dealTitle,custom_fields:['x']}}])await h.post('workflows',{name:'Unsupported Pipedrive lookup',graph:graph({...pipedriveStep(c.id),...patch})},h.owner,422);
  for(const title of ['',null,42,'   ']){const run=await startRun(h,draft,{title});assert.equal(run.status,'failed');assert.equal(run.error.category,'validation')}
  assert.equal(fake.requests.length,beforeInvalid,'unsupported settings and invalid resolved keys send no requests');
  const bodies=[['bad JSON',()=>new Response('{')],['failed envelope',()=>jsonResponse({...page([]),success:false})],['missing cursor',()=>jsonResponse({success:true,data:[],additional_data:{}})],['wrong data',()=>jsonResponse({...page([]),data:{}})],['bad record',()=>jsonResponse(page([{...deals[0],stage_id:null}]))],['bad identity',()=>jsonResponse(page([{...deals[0],id:0}]))],['bad status',()=>jsonResponse(page([{...deals[0],status:'unknown'}]))],['bad cursor',()=>jsonResponse(page([],{}))],['too many records',()=>jsonResponse(page(Array(101).fill(deals[0])))],['loop',()=>jsonResponse(page([deals[0]],'synthetic-crank-loop'))],['conflicting duplicate',({url})=>jsonResponse(url.searchParams.has('cursor')?page([{...deals[2],status:'won'}]):page([deals[2]],'synthetic-crank-next'))],['permission',()=>jsonResponse({},403)],['provider failure',()=>jsonResponse({},500)]];
  for(const [label,response] of bodies) {
   fake.routes.set(host,request=>{requestIsRead(request);return response(request)});const run=await startRun(h,draft,{title:dealTitle});assert.notEqual(run.status,'succeeded',label);assert.equal(stepOf(run,'route'),undefined,label);assert.notEqual(output(run)?.outcome,'not found',label);if(['paused','waiting','queued'].includes(run.status))await h.post(`workflow-runs/${run.id}/cancel`);
  }
  // A second tenant is independent, and a general or foreign-tenant credential cannot authorize it.
  const otherHost='synthetic-crank-703.pipedrive.com',otherToken='synthetic-crank-704';
  const other=await connection(h,{app:'pipedrive',auth_kind:'bearer',domains:[otherHost],label:'Other deal tenant',secret:{token:otherToken}});
  const generic=await connection(h,{app:'http',auth_kind:'bearer',domains:[host],label:'No native Pipedrive consent',secret:{token:'synthetic-crank-705'}});
  const beforeDenied=fake.requests.length;
  for(const denied of [other,generic]){const run=await startRun(h,await flow(h,denied),{title:dealTitle});assert.notEqual(run.status,'succeeded');if(['paused','waiting','queued'].includes(run.status))await h.post(`workflow-runs/${run.id}/cancel`)}
  assert.equal(fake.requests.length,beforeDenied,'foreign tenant and generic bearer authority cause zero requests');
  fake.routes.set(otherHost,request=>{requestIsRead(request,otherHost,otherToken,null);return jsonResponse(page([{...deals[0],id:700}]))});
  const isolated=await startRun(h,await flow(h,other,{subdomain:'synthetic-crank-703',filter_id:undefined}),{title:dealTitle});assert.equal(output(isolated).record.id,'700');assert.deepEqual(output(complete).records.map(item=>item.id),['3','10']);
  // Every physical request carries an admission for its own connection.
  for(const run of [complete,isolated]) {
   const admissions=(await h.db.prepare('SELECT bucket,finished_at FROM crank_request_admissions WHERE run_id=?').bind(run.id).all()).results;assert.equal(admissions.length,run.attempts.length);assert.ok(admissions.every(row=>row.bucket==='connection:'+(run.id===complete.id?c.id:other.id)&&row.finished_at!==null));
  }
  // A later-page read parks, then reconstructs its completed page after restart.
  fake.routes.set(host,request=>{requestIsRead(request);return request.url.searchParams.has('cursor')?jsonResponse({},429,{'retry-after':'60'}):jsonResponse(page([deals[1]],'synthetic-crank-next'))});
  const parked=await startRun(h,draft,{title:dealTitle});assert.equal(parked.status,'waiting');const operation=stepOf(parked,'search').operation_key,beforeRestart=fake.requests.length;
  fake.routes.set(host,request=>{requestIsRead(request);assert.equal(request.url.searchParams.get('cursor'),'synthetic-crank-next','completed page must never be re-fetched');return jsonResponse(page([deals[0]]))});
  await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');const resumed=await h.get('workflow-runs/'+parked.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.deepEqual(output(resumed).records,[projected(deals[1]),projected(deals[0])]);assert.equal(stepOf(resumed,'search').operation_key,operation);assert.equal(fake.requests.length,beforeRestart+1);
  // A revoked credential and a tenant grant removed between pages stop continuation.
  fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse({},429,{'retry-after':'60'})});const revoked=await startRun(h,draft,{title:dealTitle});assert.equal(revoked.status,'waiting');let before=fake.requests.length;
  await h.post('connections/'+c.id+'/revoke');await h.restart({clock:'2026-11-10T15:02:02Z'});await h.tick('2026-11-10T15:02:02Z');assert.equal((await h.get('workflow-runs/'+revoked.id)).status,'paused');assert.equal(fake.requests.length,before);
  await h.post('connections/'+c.id+'/rotate',{secret:{token}});
  fake.routes.set(host,async request=>{requestIsRead(request);await h.post('connections/'+c.id+'/revoke');return jsonResponse(page([deals[1]],'synthetic-crank-next'))});
  const late=await startRun(h,draft,{title:dealTitle});assert.notEqual(late.status,'succeeded');assert.equal(fake.requests.length,before+1);assert.equal(stepOf(late,'route'),undefined);
  assert.deepEqual(await polling(),baseline,'lookup, draft tests, errors and restart leave every polling baseline and cursor unchanged');
  const disclosure=(await h.get('data/flows')).flows.find(row=>row.kind==='pipedrive.find_deal');assert.deepEqual(disclosure.recipients,['https://'+host]);assert.match(disclosure.purpose,/compare the exact title locally/);assert.ok(!disclosure.fields.includes('title'));for(const field of ['filter_id','cursor'])assert.ok(disclosure.fields.includes(field));assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(dealTitle));
  assert.ok(fake.requests.every(request=>request.method==='GET'),'all Pipedrive lookup paths perform zero provider writes');
 } finally {await h.close()}
}

/** Unfinished pages and final results inherit DATA custody without acquiring restore authority. */
export async function pipedriveSearchCustodyJourney() {
 const {fake,h,c}=await fixture();let restored,erased;
 try {
  const w=await flow(h,c);await h.post(`workflows/${w.id}/pause`);await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['id','title']});await h.post(`workflows/${w.id}/resume`);
  fake.routes.set(host,request=>{requestIsRead(request);return request.url.searchParams.has('cursor')?jsonResponse({},429,{'retry-after':'60'}):jsonResponse(page([{...deals[1],custom_fields:{private:'synthetic-crank-unselected'}}],'synthetic-crank-private-cursor'),200,{'set-cookie':'synthetic-crank-private-cookie'})});
  const parked=await startRun(h,w,{title:dealTitle});assert.equal(parked.status,'waiting');
  const chunks=async id=>(await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=? ORDER BY ordinal,chunk_index').bind(id).all()).results;
  const raw=await chunks(parked.id);assert.ok(raw.length>0);assert.ok(raw.every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'));
  const metadata=(await h.db.prepare('SELECT response_json FROM crank_request_checkpoints WHERE run_id=?').bind(parked.id).all()).results;assert.ok(metadata.every(row=>!row.response_json.includes(host)&&!row.response_json.includes('synthetic-crank-private-cursor')));
  const subject=await h.post('data/subject',{subject:dealTitle});assert.deepEqual(subject.workflow_runs.map(row=>row.id),[parked.id]);assert.equal(subject.blocked,true);
  const hold=await h.post('data/holds',{kind:'subject',subject:dealTitle,reason:'Deal lookup under review'},h.owner,201);assert.match((await h.post('data/subject',{subject:dealTitle})).workflow_runs[0].blocked,/legal hold/);
  const exported=await archive(h);for(const value of [token,dealTitle,'synthetic-crank-private-cursor','synthetic-crank-private-cookie','synthetic-crank-unselected'])assert.ok(!exported.includes(value),'private pages and credentials are absent from clear archive text');
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  for(const invalid of ['url','size','credential']) {
   const corrupt=await rewritten(exported,(table,row)=>{if(table==='crank_request_checkpoints'){const data=JSON.parse(row.response_json);if(invalid==='url')data.url='https://foreign.example/api/v2/deals';if(invalid==='size')data.body_bytes=1024*1024+1;if(invalid==='credential')data.headers=[['authorization','synthetic-crank-invalid']];row.response_json=JSON.stringify(data)}});
   await restored.post('data/restore',{archive:corrupt,confirm:'RESTORE'},restored.owner,400);assert.deepEqual(await restored.get('workflows'),[],'malformed archives are refused atomically');
  }
  await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});const original=inventory(exported),received=inventory(await archive(restored)),originalSet=new Set(original),added=received.filter(row=>!originalSet.has(row));assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==added[0]),original,'complete sealed unfinished custody survives inactive restore');
  assert.ok((await restored.get('connections')).every(row=>row.status==='needs_reconnect'));assert.ok((await restored.get('workflows')).every(row=>['paused','draft'].includes(row.status)));assert.equal((await restored.get('workflow-runs/'+parked.id)).steps[0].status,'waiting','interrupted GET remains a read, never an uncertain write');
  const unavailable=await restored.post('data/subject',{subject:dealTitle});assert.equal(unavailable.blocked,true);assert.match(unavailable.sealed_unmatched.join(' '),/key file/);
  let before=fake.requests.length;await restored.restart();await restored.tick('2026-11-10T15:02:01Z');assert.equal(fake.requests.length,before,'inactive restore never resumes provider requests');
  const rotation=await h.post('data/keys/rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick('2026-11-10T15:00:10Z');assert.ok((await chunks(parked.id)).every(row=>JSON.parse(row.content_base64).k===rotation.key_id));
  fake.routes.set(host,request=>{requestIsRead(request);assert.equal(request.url.searchParams.get('cursor'),'synthetic-crank-private-cursor');return jsonResponse(page([deals[0]]))});before=fake.requests.length;await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');const done=await h.get('workflow-runs/'+parked.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(output(done).records,[projected(deals[1]),projected(deals[0])]);assert.equal(fake.requests.length,before+1);
  const stored=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(done.id,'search').first();assert.equal(JSON.parse(stored.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(stored.output_json).sealed,'crank-payload-v1');
  // Finished results and rotated-key pages also survive complete inactive custody.
  await restored.close();restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  const finishedArchive=await archive(h);await restored.post('data/restore',{archive:finishedArchive,confirm:'RESTORE'});
  const finishedInventory=inventory(finishedArchive),finishedReceived=inventory(await archive(restored)),finishedSet=new Set(finishedInventory),finishedAdded=finishedReceived.filter(row=>!finishedSet.has(row));assert.equal(finishedAdded.length,1);assert.equal(JSON.parse(finishedAdded[0]).row.action,'data.restore');assert.deepEqual(finishedReceived.filter(row=>row!==finishedAdded[0]),finishedInventory,'complete final results, pages, holds and rotated key metadata remain portable');
  before=fake.requests.length;await restored.restart();await restored.tick('2026-11-10T15:02:02Z');assert.equal(fake.requests.length,before);
  // Status-only history access cannot expose customer deal titles or results.
  const displayName='Synthetic deal observer',email=['synthetic-crank-observer','example.test'].join('@');
  assert.equal((await h.send('/auth/invite',{email,displayName,role:'member'},h.owner)).status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const person=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.displayName===displayName);await h.post('team/'+person.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+done.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.equal(stepOf(restricted,'search').output,undefined);assert.ok(!JSON.stringify(restricted).includes(dealTitle));
  const policy={payload_days:1,attachment_days:1,history_days:30};assert.ok((await h.post('data/retention/preview',{...policy,at:'2026-11-12T15:01:01Z'})).payload.kept.some(row=>row.id===done.id&&row.reason==='legal hold'));
  await h.post(`workflows/${w.id}/pause`);const held=await h.post('data/subject',{subject:dealTitle});await h.post('data/erase',{subject:dealTitle,digest:held.digest,confirm:'ERASE'},h.owner,409);await h.post('data/holds/'+hold.id+'/release');const preview=await h.post('data/subject',{subject:dealTitle});assert.equal(preview.blocked,false);await h.post('data/erase',{subject:dealTitle,digest:preview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+done.id,h.owner,404);assert.deepEqual(await chunks(done.id),[]);
  const journal=await archive(h);erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await erased.post('data/restore',{archive:exported,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'erasure journal prevents resurrection from an older archive');
  await h.post(`workflows/${w.id}/resume`);fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse(page([deals[1]]))});const expiring=await startRun(h,w,{title:dealTitle});assert.equal(expiring.status,'succeeded');const retention=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:retention.digest});await h.restart({clock:'2026-11-12T15:02:02Z'});await h.tick('2026-11-12T15:02:02Z');assert.deepEqual(await chunks(expiring.id),[]);const expired=await h.get('workflow-runs/'+expiring.id);assert.ok(expired.payload_expired_at);assert.equal(output(expired),null);assert.match((await h.get(`workflow-runs/${expiring.id}/replay`)).blocked_reason,/expired/);assert.ok(fake.requests.every(row=>row.method==='GET'));
 } finally {await erased?.close();await restored?.close();await h.close()}
}

export async function pipedriveOwnership(h,fake) {
 const c=await connection(h,{app:'pipedrive',auth_kind:'bearer',domains:[host],label:'Owned Pipedrive read',secret:{token}});fake.routes.set(host,request=>{requestIsRead(request);return jsonResponse(page([deals[1]]))});const run=await startRun(h,await flow(h,c),{title:dealTitle});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(output(run).record,projected(deals[1]));return ['pipedrive.find_deal'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await pipedriveSearchJourney();await pipedriveSearchCustodyJourney();console.log('Pipedrive exact title, outcomes, authority, restart and sealed inactive custody PASS')}
