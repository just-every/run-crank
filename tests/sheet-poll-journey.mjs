import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';
const minute=60000;

/** Real workflow HTTP and Cron doors; only Google and the destination are faked. */
export async function sheetPollJourney({inspect=async()=>{},provider='google_sheets'}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 const headers=['Record ID','Status','Customer','Amount','Notes'];
 let rows=Array.from({length:50},(_,i)=>['synthetic-crank-'+i,'Approved','Buyer '+i,100,'seed']),effects=[],reads=0,blocked=false,release,arrived;
 const excel=provider==='microsoft_excel';
 edge.routes.set(excel?'graph.microsoft.com':'sheets.googleapis.com',async({url,headers:request})=>{
  reads++;assert.equal(request.authorization,'Bearer synthetic-crank-10');assert.equal(decodeURIComponent(url.pathname),excel?"/v1.0/me/drive/items/synthetic-crank-11/workbook/worksheets/Orders/range(address='A1:E1001')":'/v4/spreadsheets/synthetic-crank-11/values/Orders!A1:E1001');
  if(!excel)assert.equal(url.searchParams.get('valueRenderOption'),'UNFORMATTED_VALUE');
  if(blocked){blocked=false;arrived();await new Promise(done=>{release=done})}
  return jsonResponse({range:'Orders!A1:E'+(rows.length+1),majorDimension:'ROWS',values:[headers,...rows]});
 });
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 let restored;
 try {
  const c=await connection(h,excel?{app:'microsoft_graph',label:'Orders workbook',auth_kind:'bearer',secret:{token:'synthetic-crank-10'}}:{app:'google',label:'Orders spreadsheet',auth_kind:'oauth2',scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'],secret:{access_token:'synthetic-crank-10'}});
  const trigger={type:'app_poll',provider,resource:'rows',...(excel?{workbook_id:'synthetic-crank-11',worksheet_id:'Orders',range:'A1:E1001'}:{spreadsheet_id:'synthetic-crank-11',range:'Orders!A1:E1001'}),key_field:'Record ID',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['Status'],changed_to:[[{field:'Status',op:'text.equals',value:'Approved'}]]};
  for(const patch of [{key_field:''},{watched_fields:undefined},{settle_delay:0},{required_columns:[]}]) {
   const invalid=await h.send('/api/crank/workflows',{name:'Invalid row trigger',graph:{trigger:{...trigger,...patch},steps:[]}},h.owner);assert.equal(invalid.status,422,invalid.text);
  }
  const settingsDraft=await h.post('workflows',{name:'Choose watched order columns',graph:{trigger,steps:[]}},h.owner,201);
  const schema=await h.get(`workflows/${settingsDraft.id}/trigger/fields`);
  assert.deepEqual(schema.fields.map(field=>field.name),headers);assert.equal((await h.send(`/api/crank/workflows/${settingsDraft.id}/trigger/fields`,undefined)).status,401);
  const selection={draft_digest:schema.draft_digest,schema_digest:schema.schema_digest,watched_fields:['Status','Customer'],any_field:false};
  await h.post(`workflows/${settingsDraft.id}/trigger/fields`,selection);
  assert.deepEqual((await h.get('workflows/'+settingsDraft.id)).draft.trigger.watched_fields,['Status','Customer']);
  assert.equal((await h.send(`/api/crank/workflows/${settingsDraft.id}/trigger/fields`,selection,h.owner)).status,409,'a stale loaded draft cannot replace a later selection');
  const newer=await h.get(`workflows/${settingsDraft.id}/trigger/fields`);headers[4]='Changed notes';
  assert.equal((await h.send(`/api/crank/workflows/${settingsDraft.id}/trigger/fields`,{...selection,draft_digest:newer.draft_digest},h.owner)).status,409,'a renamed source column invalidates the loaded schema');headers[4]='Notes';
  await inspect({h,w:settingsDraft,state:'watch-picker'});
  assert.equal((await runs(h,settingsDraft)).length,0);assert.deepEqual(effects,[],'field discovery and draft choices never admit work');
  const workflows=[];
  for(const identity of ['change','first_value'])workflows.push(await publish(h,'Approved sheet rows '+identity,{trigger:{...trigger,identity},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/rows',body:{identity,id:'{{trigger.record_id}}',previous:'{{trigger.previous.Status}}',current:'{{trigger.current.Status}}',row:'{{trigger.properties}}',source:'{{trigger.change_time_source}}'}}}]}));
  let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
  const counts=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected);
  const poll=async()=>{time+=minute;await h.tick(time)};
  await h.tick(time);await counts([0,0]);assert.deepEqual(effects,[],'50 initially approved rows seed without running');
  rows[0][4]='unwatched notes';await poll();await counts([0,0]);
  rows[0][1]='Pending';await poll();await counts([0,0]);
  rows[0][1]='Approved';await h.restart();time+=minute;await Promise.all([h.tick(time),h.tick(time)]);await counts([1,0]);
  assert.deepEqual(effects,[{identity:'change',id:'synthetic-crank-0',previous:'Pending',current:'Approved',row:Object.fromEntries(headers.map((key,i)=>[key,rows[0][i]])),source:'poll'}]);
  // Stable keys survive a reorder. A newly observed row spends values separately.
  rows.reverse();rows.push(['synthetic-crank-50','Pending','New buyer',250,'new']);await poll();await counts([1,0]);
  rows.at(-1)[1]='Approved';await poll();await counts([2,1]);
  rows.at(-1)[1]='Pending';await poll();rows.at(-1)[1]='Approved';await poll();await counts([3,1]);
  const settled=await publish(h,'Complete settled orders',{trigger:{...trigger,settle_delay:2,required_columns:['Customer','Amount']},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/settled',body:{id:'{{trigger.record_id}}',row:'{{trigger.properties}}',previous:'{{trigger.previous}}',time:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]});
  await poll();assert.equal((await runs(h,settled)).length,0);
  const row=['synthetic-crank-51','Approved','','',''];rows.push(row);await poll();
  row[2]='Filled buyer';await poll();row[3]=450;await poll();
  const stable=time;await inspect({h,w:settled,state:'row-settling'});
  await h.restart();await poll();assert.equal((await runs(h,settled)).length,0,'restart preserves the last cell edit and remaining delay');
  const pending=(await h.db.prepare('SELECT * FROM crank_app_pending_rows WHERE workflow_id=?').bind(settled.id).all()).results;
  assert.equal(pending.length,1);assert.equal(pending[0].stable_since,new Date(stable).toISOString());assert.ok(!JSON.stringify(pending).includes('Filled buyer'));
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('./data/restore',{archive:archive.text,confirm:'RESTORE'});
  const copied=(await restored.db.prepare('SELECT * FROM crank_app_pending_rows WHERE workflow_id=?').bind(settled.id).all()).results;assert.deepEqual(copied,pending);
  const beforeRestoreEffects=effects.length;await restored.restart();await restored.tick(time+86400000);assert.equal(effects.length,beforeRestoreEffects);assert.equal((await restored.get('workflows/'+settled.id)).status,'paused');
  time+=minute;await Promise.all([h.tick(time),h.tick(time)]);assert.equal((await runs(h,settled)).length,1);
  const completed=(await runs(h,settled))[0];assert.deepEqual(effects.at(-1),{id:'synthetic-crank-51',row:Object.fromEntries(headers.map((key,i)=>[key,row[i]])),previous:null,time:new Date(stable).toISOString(),source:'poll'});
  await inspect({h,w:settled,state:'row-released',run:completed});
  await poll();assert.equal((await runs(h,settled)).length,1);
  // Required cells remain a hold even after the delay; an unwatched mapped edit resets it.
  rows.push(['synthetic-crank-52','Approved','Incomplete buyer','','']);await poll();time+=3*minute;await h.tick(time);assert.equal((await runs(h,settled)).length,1);
  rows.at(-1)[3]=500;await poll();await poll();rows.at(-1)[4]='finished notes';await poll();await poll();assert.equal((await runs(h,settled)).length,1);await poll();assert.equal((await runs(h,settled)).length,2);
  // A removed named column fails before changing any baseline.
  headers[1]='Renamed status';await poll();assert.equal((await h.get(`workflows/${settled.id}/trigger`)).poll.last_status,'error');headers[1]='Status';
  // Erasure drops the settling digest and permanently fences renewed input.
  row[1]='Pending';await poll();
  await h.post(`workflows/${settled.id}/pause`);await h.post('./data/erase',{workflow_run_id:completed.id,confirm:'ERASE'});
  const digest=(await h.db.prepare('SELECT record_id FROM crank_app_erased_records WHERE workflow_id=?').bind(settled.id).first()).record_id;
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_app_pending_rows WHERE workflow_id=? AND record_id=?').bind(settled.id,digest).first()).n,0);
  const journal=await h.send('/api/crank/data/export',{},h.owner),destination=await harness('http://127.0.0.1:9',{edge:edge.edge});try {assert.equal((await destination.send('/api/crank/data/restore',{archive:archive.text,journal:journal.text,confirm:'RESTORE'},destination.owner)).status,409)}finally{await destination.close()}
  await h.post(`workflows/${settled.id}/publish`,{},h.owner,201);row[1]='Approved';await poll();time+=3*minute;await h.tick(time);assert.equal((await runs(h,settled)).length,1,'only the other retained run survives erasure and replay');
  const reached=new Promise(done=>{arrived=done});blocked=true;time+=minute;const count=effects.length;rows.push(['synthetic-crank-53','Approved','Revoked buyer',600,'']);const inflight=h.tick(time);await reached;
  await h.post(`connections/${c.id}/revoke`);row[1]='Pending';blocked=false;release();await inflight;assert.equal(effects.length,count);await poll();assert.equal(effects.length,count);assert.ok(reads>10);
 } finally {await restored?.close();await h.close()}
}
