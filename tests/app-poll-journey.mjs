import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs,settled} from './kit.mjs';
const minute=60000;
export async function crmPollJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 let mode='seed',effects=[];
 const record=(id,stage,version,amount='10')=>({id,updatedAt:`2026-10-26T12:${String(version).padStart(2,'0')}:00.000Z`,properties:{dealstage:stage,amount}});
 edge.routes.set('api.hubapi.com',({url,headers})=>{
  assert.equal(headers.authorization,'Bearer synthetic-crank-1');
  assert.equal(url.pathname,'/crm/v3/objects/deals');assert.ok(['dealstage','amount'].includes(url.searchParams.get('properties')));
  if(mode==='outage'&&url.searchParams.has('after'))return jsonResponse({},503);
  const first=record('deal-one',mode==='seed'?'open':'won',mode==='seed'?0:mode==='amount'?2:1,mode==='amount'?'999':'10');
  return url.searchParams.has('after')?jsonResponse({results:[first,record('deal-two','open',0)]}):jsonResponse({results:[first],paging:{next:{after:'page-two'}}});
 });
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  const c=await connection(h,{app:'hubspot',label:'Sales records',auth_kind:'bearer',secret:{token:'synthetic-crank-1'}});
  const trigger={type:'app_poll',provider:'hubspot',resource:'deals',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['dealstage'],changed_to:{dealstage:'won'}};
  const invalid=await h.send('/api/crank/workflows',{name:'Unbounded edits',graph:{trigger:{...trigger,watched_fields:undefined,changed_to:undefined},steps:[]}},h.owner);assert.equal(invalid.status,422);
  const w=await publish(h,'Won deals to fulfillment',{trigger,steps:[{id:'notify',type:'http',input:{method:'POST',url:'https://receiver.example/deals',body:{id:'{{trigger.record_id}}',previous:'{{trigger.previous.dealstage}}',current:'{{trigger.current.dealstage}}',at:'{{trigger.change_time}}'}}}]});
  let time=Date.now()+minute;await h.tick(time);assert.equal((await runs(h,w)).length,0);assert.deepEqual(effects,[]);
  await inspect({h,w,state:'seeded'});
  mode='outage';await h.tick(time+=minute);
  const failed=await h.get(`workflows/${w.id}/trigger`);assert.equal(failed.poll.last_status,'error');assert.match(failed.poll.last_error,/503/);assert.ok(h.mail.some(m=>/trigger poll failed/.test(m.subject)));assert.equal((await runs(h,w)).length,0);
  await h.restart();mode='changed';await Promise.all([h.tick(time+=minute),h.tick(time)]);
  assert.equal((await runs(h,w)).length,1);await settled(h,(await runs(h,w))[0].id);
  assert.deepEqual(effects,[{id:'deal-one',previous:'open',current:'won',at:'2026-10-26T12:01:00.000Z'}]);
  await inspect({h,w,state:'changed'});
  mode='amount';await h.tick(time+=minute);assert.equal((await runs(h,w)).length,1);assert.equal(effects.length,1,'an unwatched amount edit produces no business action');
  mode='seed';await h.tick(time+=minute);assert.equal((await runs(h,w)).length,1,'an older provider record cannot roll the watched snapshot backwards');
  const state=await h.get(`workflows/${w.id}/trigger`);assert.ok(state.last_successful_poll);assert.ok(Date.parse(state.poll.next_due_at)>time);
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);assert.ok(!archive.text.includes('synthetic-crank-1'));
  const restored=await harness('http://127.0.0.1:9',{edge:edge.edge});try{
   await restored.post('data/restore',{archive:archive.text,confirm:'RESTORE'});
   assert.equal((await restored.db.prepare('SELECT COUNT(*) AS n FROM crank_app_snapshots').first()).n,2);
   await restored.tick(time+86400000);assert.equal(effects.length,1);
   assert.equal((await restored.get(`workflows/${w.id}`)).status,'paused');
  }finally{await restored.close()}
  // A new watched-field definition seeds its own version without running existing records.
  await h.post(`workflows/${w.id}/draft`,{graph:{trigger:{...trigger,watched_fields:['amount'],changed_to:undefined},steps:[]}});await h.post(`workflows/${w.id}/publish`,{},h.owner,201);await h.tick(time+=minute);assert.equal((await runs(h,w)).length,1);
  const original=(await runs(h,w))[0];await h.post(`workflows/${w.id}/pause`);
  await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['record_id']});
  await h.tick(time+=minute);
  const sealed=(await h.db.prepare('SELECT fields_json FROM crank_app_snapshots WHERE workflow_id=?').bind(w.id).all()).results;
  assert.equal(sealed.length,4);assert.ok(sealed.every(row=>JSON.parse(row.fields_json).sealed==='crank-payload-v1'));
  const rotation=await h.post('data/keys/rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick(time+=minute);
  assert.ok((await h.db.prepare('SELECT fields_json FROM crank_app_snapshots WHERE workflow_id=?').bind(w.id).all()).results.every(row=>JSON.parse(row.fields_json).k===rotation.key_id));
  const detail=await h.get('workflow-runs/'+original.id);
  await h.post('data/erase',{workflow_run_id:original.id,confirm:'ERASE'});
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_app_snapshots WHERE workflow_id=? AND record_id=?').bind(w.id,detail.business_key).first()).n,0);
 }finally{await h.close()}
}
export async function subscriptionPollJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge});let renewal='ok',version=0,patches=0,effects=[];
 const time=Date.now()+minute,expiry=new Date(time+2*minute).toISOString();
 edge.routes.set('graph.microsoft.com',({method,url,body,headers})=>{
  assert.equal(headers.authorization,'Bearer synthetic-crank-2');
  if(method==='PATCH'){patches++;if(renewal==='fail')return jsonResponse({},404);assert.equal(url.pathname,'/v1.0/subscriptions/synthetic-crank-3');return jsonResponse({id:'synthetic-crank-3',expirationDateTime:JSON.parse(body).expirationDateTime})}
  return jsonResponse({value:[{id:'message-'+version,lastModifiedDateTime:'2026-10-26T12:00:00.000Z',subject:'Order received'}]});
 });
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try{
  const c=await connection(h,{app:'microsoft_graph',label:'Order mailbox',auth_kind:'bearer',secret:{token:'synthetic-crank-2'}});
  const w=await publish(h,'Order mail',{trigger:{type:'app_poll',provider:'microsoft_graph',resource:'messages',event:'new',connection_id:c.id,interval_minutes:1,backfill:'existing',subscription:{id:'synthetic-crank-3',expires_at:expiry}},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/messages',body:{id:'{{trigger.record_id}}'}}}]});
  await h.tick(time);assert.equal(patches,1);assert.deepEqual(effects,[{id:'message-0'}]);
  const active=await h.get(`workflows/${w.id}/trigger`);assert.equal(active.subscription.status,'active');assert.ok(Date.parse(active.subscription.expires_at)>time);await inspect({h,w,state:'renewed'});
  renewal='fail';version=1;await h.restart();const expired=Date.parse(active.subscription.expires_at)+minute;await h.tick(expired);
  const state=await h.get(`workflows/${w.id}/trigger`);assert.equal(state.subscription.status,'expired');assert.match(state.subscription.error,/Polling continues/);assert.ok(h.mail.some(m=>/subscription renewal failed/.test(m.subject)));assert.equal((await runs(h,w)).length,2);assert.deepEqual(effects,[{id:'message-0'},{id:'message-1'}]);await inspect({h,w,state:'expired'});
  await h.restart();await h.tick(expired+minute);assert.equal((await runs(h,w)).length,2);assert.equal(effects.length,2);
  renewal='ok';await h.tick(expired+2*minute);{const recovered=await h.get(`workflows/${w.id}/trigger`);assert.equal(recovered.subscription.status,'active',JSON.stringify(recovered));}assert.equal(effects.length,2);
  await h.post(`connections/${c.id}/revoke`);version=2;await h.tick(expired+3*minute);assert.equal((await runs(h,w)).length,2);assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
 }finally{await h.close()}
}
