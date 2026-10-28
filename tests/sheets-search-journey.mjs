import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {connection,deliver,fakeEdge,hookUrl,jsonResponse,publish,runs,settled,startRun,stepOf} from './kit.mjs';
import {archive,inventory} from './restore-journey.mjs';

const clock='2026-11-10T15:00:00Z',scope='https://www.googleapis.com/auth/spreadsheets.readonly';
const resource='synthetic-crank-500',subject='synthetic-crank-501',secret='synthetic-crank-502';
export const sheetsStep=connectionId=>({id:'lookup',type:'google_sheets.find_row',connection_id:connectionId,multi_match:'all',input:{spreadsheet_id:resource,range:"'Sales Q4'!B7:F212",column:'Key',value:'{{trigger.input.key}}'}});
const tableRows=()=>{
  const rows=Array.from({length:205},()=>['unmatched']);
  for(const index of [0,109,204])rows[index]=[1,subject,true,'',0];
  rows[1]=['1','synthetic-crank-503',false,null];rows[2]=[false];rows[3]=[0];rows[4]=[''];rows[5]=[null];
  return rows;
};
export function sheetsProvider(fake,{token=secret}={}) {
  const state={mode:'normal',park:false,retryAfter:'60',reads:[],rows:tableRows(),tokens:new Set(['Bearer '+token]),rowsByToken:new Map()};
  fake.routes.set('sheets.googleapis.com',async({url,method,headers})=>{
    assert.equal(method,'GET','row lookup never writes');assert.ok(state.tokens.has(headers.authorization),'only a selected fixture account can read');
    const range=decodeURIComponent(url.pathname.split('/values/')[1]??'');
    if(range==='Polling!A1:B3')return jsonResponse({range,majorDimension:'ROWS',values:[['Key','Status'],['synthetic-crank-550','Pending']]});
    assert.equal(url.searchParams.get('valueRenderOption'),'UNFORMATTED_VALUE');assert.equal(url.searchParams.get('dateTimeRenderOption'),'SERIAL_NUMBER');assert.equal(url.searchParams.get('majorDimension'),'ROWS');
    state.reads.push(range);
    if(!url.pathname.includes('/'+resource+'/'))return jsonResponse({error:'resource refused'},403);
    if(state.mode==='forbidden')return jsonResponse({error:'permission'},403);
    if(state.mode==='missing resource')return jsonResponse({error:'not found'},404);
    if(state.mode==='provider failure')return jsonResponse({error:'unavailable'},500);
    if(state.mode==='malformed')return new Response('not JSON');
    const match=/!B(\d+):F(\d+)$/.exec(range);assert.ok(match,range);
    const from=Number(match[1]),to=Number(match[2]);
    if(state.park&&headers.authorization==='Bearer '+token&&from===108)return jsonResponse({error:'quota'},429,{'retry-after':state.retryAfter});
    const source=state.rowsByToken.get(headers.authorization)??state.rows;
    let values=from===7?[['Key','Person','Active','Note','Amount']]:source.slice(from-8,to-7);
    if(state.beforeResponse)await state.beforeResponse({from,to,headers});
    if(state.mode==='duplicate headers'&&from===7)values=[['Key','Person','Active','Note','Key']];
    if(state.mode==='missing headers'&&from===7)values=[['Key','Person']];
    if(state.mode==='malformed cells'&&from!==7)values=[[1,{unsafe:'nested'}]];
    if(state.mode==='oversized window'&&from!==7)values=Array.from({length:101},()=>[1]);
    return jsonResponse({range,majorDimension:'ROWS',values},200,{'x-provider-person':subject,'set-cookie':'synthetic-crank-504'});
  });
  return state;
}
async function fixture() {
  const fake=fakeEdge(),state=sheetsProvider(fake),h=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});
  const account=await connection(h,{app:'google',label:'Owned Sheets reader',auth_kind:'oauth2',scopes:[scope],secret:{access_token:secret}});
  return {h,fake,state,account};
}
export async function sheetsSearchJourney({onScreen}={}) {
  const {h,fake,state,account}=await fixture();
  try {
    const graph=(settings={},tail=[])=>({trigger:{type:'manual'},steps:[{...sheetsStep(account.id),...settings},...tail]});
    const w=await publish(h,'Exact typed worksheet lookup',graph({},[{id:'result',type:'map',input:{outcome:'{{steps.lookup.outcome}}',rows:'{{steps.lookup.records}}'}}]));
    const poll=await publish(h,'Existing watched worksheet baseline',{trigger:{type:'app_poll',provider:'google_sheets',resource:'rows',event:'updated',connection_id:account.id,spreadsheet_id:resource,range:'Polling!A1:B3',key_field:'Key',watched_fields:['Status'],interval_minutes:1,backfill:'from_now'},steps:[]});
    await h.tick('2026-11-10T15:01:00Z');await h.post(`workflows/${poll.id}/pause`);
    const beforePoll=(await h.db.prepare('SELECT * FROM crank_polls').all()).results,beforeSnapshots=(await h.db.prepare('SELECT * FROM crank_app_snapshots').all()).results;
    assert.equal(beforeSnapshots.length,1,'the existing poll has a real retained baseline');assert.equal(beforePoll.length,1);
    const good=await startRun(h,w,{key:1}),output=stepOf(good,'lookup').output;
    assert.equal(good.status,'succeeded',JSON.stringify(good.error));assert.equal(output.outcome,'found');assert.equal(output.truncated,false);
    assert.deepEqual(output.records.map(row=>row.row_number),[8,117,212]);assert.equal(output.count,3);
    assert.deepEqual(output.records[0].fields,{Key:1,Person:subject,Active:true,Note:'',Amount:0});
    assert.deepEqual(output.records[0].cells.Note,{state:'empty',value:''});assert.equal(output.records[0].row_range,"'Sales Q4'!B8:F8");
    assert.deepEqual(output.records[0].fields,output.records[2].fields,'equal rows retain distinct coordinates');
    assert.deepEqual(state.reads,["'Sales Q4'!B7:F7","'Sales Q4'!B8:F107","'Sales Q4'!B108:F207","'Sales Q4'!B208:F212"]);
    if(onScreen)await onScreen({h,w,run:good,state:'found'});
    for(const [key,coordinate] of [['1',9],[false,10],[0,11],['',12]]) {
      const typed=await startRun(h,w,{key}),found=stepOf(typed,'lookup').output;
      assert.equal(typed.status,'succeeded',JSON.stringify(typed.error));assert.deepEqual(found.records.map(row=>row.row_number),[coordinate]);
      assert.equal(found.record.fields.Key,key);
      if(key==='1') {assert.equal(Object.hasOwn(found.record.fields,'Note'),false);assert.equal(Object.hasOwn(found.record.fields,'Amount'),false);assert.deepEqual(found.record.cells.Note,{state:'missing'});assert.deepEqual(found.record.cells.Amount,{state:'missing'});assert.equal(found.record.fields.Active,false)}
    }
    const route={id:'route',type:'paths',mode:'exclusive',branches:[{id:'absent',when:[[{field:'steps.lookup.outcome',op:'text.equals',value:'not found'}]],steps:[]}],fallback:{steps:[]}};
    for(const no_match of ['halt','continue']) {
      const flow=await publish(h,'No match '+no_match,graph({no_match},[route]));
      const run=await startRun(h,flow,{key:'no matching key'});assert.equal(run.status,no_match==='halt'?'stopped_by_search':'succeeded');assert.equal(stepOf(run,'lookup').output.outcome,'not found');
      if(no_match==='halt')assert.equal(stepOf(run,'route'),undefined);else {assert.equal(stepOf(run,'lookup').output.record,null);assert.deepEqual(stepOf(run,'route').output.matched,['absent'])}
    }
    for(const [settings,status,outcome,coordinates] of [
      [{multi_match:'first',sort:{field:'row_number',direction:'desc'}},'succeeded','found',[212]],
      [{multi_match:'stop',on_multiple:'halt'},'stopped_by_search','multiple matches',null],
      [{multi_match:'stop',on_multiple:'continue'},'succeeded','multiple matches',[8,117,212]],
      [{multi_match:'all',limit:1,sort:{field:'row_number',direction:'desc'}},'succeeded','truncated',[212]],
    ]) {
      const flow=await publish(h,'Declared row outcomes',graph(settings));state.reads=[];
      const run=await startRun(h,flow,{key:1}),result=stepOf(run,'lookup').output;
      assert.equal(run.status,status);assert.equal(result.outcome,outcome);assert.equal(state.reads.length,4,'every declared window is scanned before selecting or truncating');
      if(coordinates)assert.deepEqual(result.records.map(row=>row.row_number),coordinates);
      if(outcome==='multiple matches'&&status==='succeeded')assert.equal(result.record,null);
    }
    assert.deepEqual((await h.db.prepare('SELECT * FROM crank_polls').all()).results,beforePoll);assert.deepEqual((await h.db.prepare('SELECT * FROM crank_app_snapshots').all()).results,beforeSnapshots);
    await h.post(`workflows/${poll.id}/unpublish`);
    const lookupCalls=fake.requests.length;
    const base=sheetsStep(account.id);
    for(const settings of [
      {input:{...base.input,range:'A1:F10'}},{input:{...base.input,range:"'Sales Q4'!B7:F1009"}},
      {input:{...base.input,range:"'Sales Q4'!B7:ZZ10"}},{input:{...base.input,range:"'Sales Q4'!F10:B7"}},
      {input:{...base.input,comparison:'contains'}},{comparison:'contains'},{operator:'equals'},{create_if_not_found:{}},
      {input:{...base.input,value:null}},{sort:{field:'fields.Key',direction:'asc'}},
    ])await h.post('workflows',{name:'Unsupported worksheet declaration',graph:graph(settings)},h.owner,422);
    assert.equal(fake.requests.length,lookupCalls,'unsupported settings never dispatch');
    for(state.mode of ['duplicate headers','missing headers','malformed cells','oversized window','malformed','provider failure','forbidden','missing resource']) {
      const run=await startRun(h,w,{key:1});assert.equal(run.status,'failed',state.mode);assert.notEqual(run.error.outcome,'not found');assert.equal(stepOf(run,'result'),undefined);
      assert.equal(run.error.category,['forbidden','missing resource'].includes(state.mode)?'auth':'provider');
    }
    state.mode='normal';
    const wrong=await publish(h,'Refused worksheet resource',graph({input:{...base.input,spreadsheet_id:'synthetic-crank-foreign'}}));
    assert.equal((await startRun(h,wrong,{key:1})).error.category,'auth');
    const arbitrary=await connection(h,{app:'http',label:'Arbitrary HTTP credential',auth_kind:'bearer',domains:['sheets.googleapis.com'],scopes:[scope],secret:{token:'synthetic-crank-505'}});
    const wrongAccount=await publish(h,'Managed account required',graph({connection_id:arbitrary.id}));
    let calls=fake.requests.length;assert.equal((await startRun(h,wrongAccount,{key:1})).error.category,'authority');assert.equal(fake.requests.length,calls);
    await h.post(`connections/${account.id}/rotate`,{scopes:[],secret:{access_token:secret}});
    assert.equal((await startRun(h,w,{key:1})).error.category,'authority');assert.equal(fake.requests.length,calls);
    await h.post(`connections/${account.id}/rotate`,{scopes:[scope],secret:{access_token:secret}});
    const secondSecret='synthetic-crank-506';state.tokens.add('Bearer '+secondSecret);
    const secondRows=tableRows();for(const index of [0,109,204])secondRows[index][1]='synthetic-crank-507';state.rowsByToken.set('Bearer '+secondSecret,secondRows);
    const second=await connection(h,{app:'google',label:'Separate worksheet account',auth_kind:'oauth2',scopes:[scope],secret:{access_token:secondSecret}});
    const secondFlow=await publish(h,'Independent selected worksheet account',graph({connection_id:second.id}));
    state.park=true;state.retryAfter='120';state.reads=[];let waiting=await startRun(h,w,{key:1});assert.equal(waiting.status,'waiting');assert.equal(waiting.attempts.length,3);
    const firstReads=state.reads.length,independent=await startRun(h,secondFlow,{key:1});assert.equal(independent.status,'succeeded');
    assert.equal(stepOf(independent,'lookup').output.record.fields.Person,'synthetic-crank-507');assert.equal(state.reads.length,firstReads+4,'a separate account progresses while the first is parked');
    assert.ok(!JSON.stringify(independent).includes(secondSecret));

    const parkedCalls=fake.requests.length;await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');
    assert.equal((await h.get('workflow-runs/'+waiting.id)).status,'waiting');assert.equal(fake.requests.length,parkedCalls,'provider Retry-After is a lower bound even after Cron and restart');
    state.park=false;state.retryAfter='60';await h.restart({clock:'2026-11-10T15:02:02Z'});await h.tick('2026-11-10T15:02:02Z');
    const resumed=await h.get('workflow-runs/'+waiting.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.deepEqual(stepOf(resumed,'lookup').output,output);
    const firstAccountReads=fake.to('sheets.googleapis.com').filter(request=>request.headers.authorization==='Bearer '+secret).slice(-5);
    assert.equal(firstAccountReads.filter(request=>decodeURIComponent(request.url.pathname).endsWith("'Sales Q4'!B7:F7")).length,1);assert.equal(firstAccountReads.filter(request=>decodeURIComponent(request.url.pathname).endsWith("'Sales Q4'!B8:F107")).length,1,'completed windows are retained across restart');
    state.park=true;const rotatedScan=await startRun(h,w,{key:1});assert.equal(rotatedScan.status,'waiting');
    await h.post(`connections/${account.id}/rotate`,{scopes:[scope],secret:{access_token:'synthetic-crank-509'}});const beforeRotation=fake.requests.length;
    await h.restart({clock:'2026-11-10T15:03:03Z'});await h.tick('2026-11-10T15:03:03Z');
    const mixed=await h.get('workflow-runs/'+rotatedScan.id);assert.equal(mixed.status,'paused');assert.match(mixed.error.message,/credential changed/);assert.equal(fake.requests.length,beforeRotation,'credential rotation cannot mix old and new windows');
    await h.post(`connections/${account.id}/rotate`,{scopes:[scope],secret:{access_token:secret}});
    state.park=true;waiting=await startRun(h,w,{key:1});assert.equal(waiting.status,'waiting');calls=fake.requests.length;
    await h.post(`connections/${account.id}/rotate`,{scopes:[],secret:{access_token:secret}});
    await h.restart({clock:'2026-11-10T15:04:04Z'});await h.tick('2026-11-10T15:04:04Z');
    const refused=await h.get('workflow-runs/'+waiting.id);assert.equal(refused.status,'paused',JSON.stringify(refused.error));assert.equal(refused.error.category,'authority',JSON.stringify(refused.error));assert.equal(fake.requests.length,calls,'completed checkpoints supply no stale scope authority');
    await h.post(`connections/${account.id}/rotate`,{scopes:[scope],secret:{access_token:secret}});
    const revoked=await startRun(h,w,{key:1});assert.equal(revoked.status,'waiting');calls=fake.requests.length;
    await h.post(`connections/${account.id}/revoke`);await h.restart({clock:'2026-11-10T15:05:05Z'});await h.tick('2026-11-10T15:05:05Z');
    assert.equal((await h.get('workflow-runs/'+revoked.id)).status,'paused');assert.equal(fake.requests.length,calls);
    state.park=false;let revokedDuringRead=false;state.beforeResponse=async({from})=>{if(from===208&&!revokedDuringRead){revokedDuringRead=true;await h.post(`connections/${second.id}/revoke`)}};
    const late=await startRun(h,secondFlow,{key:1});assert.equal(revokedDuringRead,true);assert.equal(late.status,'paused');assert.equal(stepOf(late,'lookup').output,null,'in-flight data is not exposed after authority is revoked');state.beforeResponse=null;
    const flow=(await h.get('data/flows')).flows.find(flow=>flow.kind==='google_sheets.find_row');
    assert.deepEqual(flow.recipients,['https://sheets.googleapis.com']);assert.ok(flow.fields.includes('spreadsheet_id'));assert.ok(!JSON.stringify(flow).includes(resource));
    assert.ok(!JSON.stringify(await h.get('workflow-runs/'+good.id)).includes(secret));
  } finally {await h.close()}
}

export async function sheetsCustodyJourney() {
  const {h,fake,state,account}=await fixture();let other,erased;
  try {
    const step=sheetsStep(account.id);step.input.value=1;const w=await h.post('workflows',{name:'Private row search',graph:{trigger:{type:'webhook'},steps:[step]}},h.owner,201);
    await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['Person']});
    await h.post(`workflows/${w.id}/publish`,{},h.owner,201);const hook=await hookUrl(h,w);
    state.park=true;
    const receipt=await deliver(h,hook,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({key:1})});assert.equal(receipt.status,200,receipt.text);
    const admitted=await runs(h,w);assert.equal(admitted.length,1);const waiting=await settled(h,admitted[0].id);assert.equal(waiting.status,'waiting',JSON.stringify(waiting.error));
    let exported=await archive(h),chunks=inventory(exported).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks');
    assert.ok(chunks.length>=2);for(const chunk of chunks)assert.ok(chunk.row.content_base64.startsWith('{"sealed":"crank-payload-v1"'));
    assert.ok(!exported.includes(subject));assert.ok(!exported.includes(secret));
    for(const chunk of chunks)assert.ok(!chunk.row.content_base64.includes(Buffer.from(subject).toString('base64')));
    const preview=await h.post('data/subject',{subject});assert.deepEqual(preview.workflow_runs.map(row=>row.id),[waiting.id],'a person appearing only in unfinished provider rows is indexed');
    const hold=await h.post('data/holds',{kind:'subject',subject,reason:'Synthetic row custody review'},h.owner,201);
    await h.post(`workflows/${w.id}/pause`);await h.post('data/erase',{workflow_run_id:waiting.id,confirm:'ERASE'},h.owner,409);
    assert.match((await h.post('data/subject',{subject})).workflow_runs[0].blocked,/legal hold/);
    const rotated=await h.post('data/keys/rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick('2026-11-10T15:00:01Z');
    exported=await archive(h);chunks=inventory(exported).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks');
    for(const chunk of chunks)assert.equal(JSON.parse(chunk.row.content_base64).k,rotated.key_id);
    assert.deepEqual((await h.post('data/subject',{subject})).workflow_runs.map(row=>row.id),[waiting.id],'rotation retains identifiers from completed windows');
    other=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});await other.post('data/restore',{archive:exported,confirm:'RESTORE'});
    const expected=inventory(exported),received=inventory(await archive(other)),expectedSet=new Set(expected),added=received.filter(row=>!expectedSet.has(row));
    assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==added[0]),expected,'complete portable records round-trip with sealed unfinished windows');
    assert.ok((await other.get('workflows')).every(row=>row.status==='paused'));assert.ok((await other.get('connections')).every(row=>row.status==='needs_reconnect'));
    let calls=fake.requests.length;await other.restart();await other.tick('2026-11-10T15:02:00Z');assert.equal(fake.requests.length,calls);
    await h.post(`data/holds/${hold.id}/release`);await h.post(`workflow-runs/${waiting.id}/cancel`);await h.post('data/erase',{workflow_run_id:waiting.id,confirm:'ERASE'});await h.get('workflow-runs/'+waiting.id,h.owner,404);
    await h.post(`workflow-runs/${waiting.id}/replay`,{paths:['lookup'],digest:'synthetic-crank-508'},h.owner,404);
    const replayed=await deliver(h,hook,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({key:1})});assert.equal(replayed.status,409,replayed.text);assert.match(replayed.text,/eras/i);assert.deepEqual(await runs(h,w),[],'replaying the erased capture cannot recreate a run');
    const journal=await archive(h);assert.equal(inventory(journal).map(JSON.parse).filter(row=>['crank_request_checkpoints','crank_request_checkpoint_chunks'].includes(row.table)).length,0);
    erased=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});await erased.post('data/restore',{archive:exported,journal,confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[]);
    await h.post(`connections/${account.id}/rotate`,{scopes:[scope],secret:{access_token:secret}});state.park=false;await h.post(`workflows/${w.id}/resume`);
    const done=await startRun(h,w,{key:1});assert.equal(done.status,'succeeded',JSON.stringify(done.error));
    await h.post(`workflows/${w.id}/pause`);
    const retention={payload_days:1,attachment_days:null,history_days:30};
    const expiring=await h.post('data/retention/preview',retention);assert.ok(expiring);
    await h.post('data/retention',{...retention,digest:expiring.digest});
    await h.restart({clock:'2026-11-12T15:00:00Z'});await h.tick('2026-11-12T15:00:00Z');
    const expired=await h.get('workflow-runs/'+done.id);assert.ok(expired.payload_expired_at);assert.equal(stepOf(expired,'lookup').output,null);
  } finally {await erased?.close();await other?.close();await h.close()}
}

export async function sheetsOwnership(h,fake) {
  sheetsProvider(fake);const c=await connection(h,{app:'google',label:'Owned worksheet reader',auth_kind:'oauth2',scopes:[scope],secret:{access_token:secret}});
  const w=await publish(h,'Owned worksheet lookup',{trigger:{type:'manual'},steps:[sheetsStep(c.id)]});
  const run=await startRun(h,w,{key:1});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(stepOf(run,'lookup').output.records.map(row=>row.row_number),[8,117,212]);return ['google_sheets.find_row'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {await sheetsSearchJourney();await sheetsCustodyJourney();console.log('Sheets typed lookup, outcomes, authority, retry and sealed custody PASS')}
