import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

/** A failed comparison write cannot leave an admitted effect without its baseline. */
export async function interruptedAppAdmission() {
 const edge=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 let status='Pending';
 edge.routes.set('sheets.googleapis.com',()=>jsonResponse({values:[['Record ID','Status'],['synthetic-crank-91',status]]}));
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  const c=await connection(h,{app:'google',label:'Interrupted comparison source',auth_kind:'oauth2',secret:{access_token:'synthetic-crank-92'}}),workflows=[];
  for(const identity of ['change','first_value'])workflows.push(await publish(h,'Interrupted row '+identity,{trigger:{type:'app_poll',provider:'google_sheets',resource:'rows',connection_id:c.id,spreadsheet_id:'synthetic-crank-93',range:'Orders!A1:B10',key_field:'Record ID',event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Status'],changed_to:{Status:'Approved'},identity},steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/interrupted',body:{identity,previous:'{{trigger.previous.Status}}',current:'{{trigger.current.Status}}'}}}]}));
  let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);await h.tick(time);
  await h.db.exec("CREATE TRIGGER interrupt_app_baseline BEFORE INSERT ON crank_app_snapshots WHEN json_extract(NEW.fields_json,'$.Status')='Approved' BEGIN SELECT RAISE(ABORT,'interrupted comparison storage'); END;");
  status='Approved';
  try {
   time+=60000;await h.tick(time);
   for(const w of workflows)assert.equal((await runs(h,w)).length,0,'an interrupted baseline write rolls back its admission');
   assert.deepEqual(effects,[]);
  } finally {await h.db.exec('DROP TRIGGER interrupt_app_baseline')}
  await h.restart();time+=60000;await h.tick(time);
  for(const w of workflows)assert.equal((await runs(h,w)).length,1);
  assert.deepEqual(effects.map(effect=>effect.identity).sort(),['change','first_value']);
  for(const effect of effects){assert.equal(effect.previous,'Pending');assert.equal(effect.current,'Approved')}
  time+=60000;await h.tick(time);for(const w of workflows)assert.equal((await runs(h,w)).length,1);assert.equal(effects.length,2);
 } finally {await h.close()}
}
