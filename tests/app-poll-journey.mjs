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

/** Typed transitions and individual field-value identity through HTTP and Cron. */
export async function comparisonPollJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-27T21:00:00.000Z'});
 let revision=0,properties={Status:'Pending',amount:10,minimum_amount:100,ready:true,due:'2026-10-28T12:00:00Z',tags:['invoice'],notes:'initial'},effects=[];
 const at=()=>new Date(Date.parse('2026-10-26T12:00:00Z')+revision*minute).toISOString();
 edge.routes.set('api.hubapi.com',()=>jsonResponse({results:[{id:'synthetic-crank-record',updatedAt:at(),properties}]}));
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 let restored;
 try {
  const c=await connection(h,{app:'hubspot',label:'Transition records',auth_kind:'bearer',secret:{token:'synthetic-crank-8'}});
  const changed_to=[[{field:'Status',op:'text.in',value:['Approved']},{field:'amount',op:'number.gte',value:100,value_type:'number'},{field:'amount',op:'number.gte',value:{$ref:'trigger.minimum_amount'}},{field:'ready',op:'boolean.is_true'},{field:'due',op:'date.after',value:'2026-10-27T12:00:00Z'},{field:'tags',op:'list.any',inner:{field:'',op:'text.equals',value:'invoice'}}]];
  const trigger={type:'app_poll',provider:'hubspot',resource:'deals',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['Status','amount','minimum_amount','ready','due','tags'],changed_to,changed_from:[[{field:'Status',op:'text.equals',value:'Pending'}],[{field:'Status',op:'text.equals',value:'Approved'}]]};
  for(const bad of [{changed_from:[[{field:'notes',op:'exists'}]]},{changed_to:[[{field:'Status',op:'number.unknown',value:1}]]},{settle_delay:2}]) {
   const refused=await h.send('/api/crank/workflows',{name:'Invalid transition',graph:{trigger:{...trigger,...bad},steps:[]}},h.owner);assert.equal(refused.status,422,refused.text);
  }
  const workflows=[];
  for(const identity of ['change','first_value']) workflows.push(await publish(h,'Approved transition '+identity,{trigger:{...trigger,identity},steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/changes',body:{identity,record:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',time:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]}));
  let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
  const counts=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected);
  const poll=async({restart=false,concurrent=false}={})=>{time+=minute;if(restart)await h.restart();if(concurrent)await Promise.all([h.tick(time),h.tick(time)]);else await h.tick(time)};
  await h.tick(time);await counts([0,0]);assert.deepEqual(effects,[],'from-now seeds never dispatch');
  revision++;properties={...properties,Status:'Approved',amount:100};await poll({restart:true,concurrent:true});await counts([1,1]);
  assert.equal(effects.length,2,'one admission per edit, not one per changed field');
  for(const effect of effects){assert.deepEqual(effect.changed,['Status','amount']);assert.equal(effect.record,'synthetic-crank-record');assert.equal(effect.previous.Status,'Pending');assert.equal(effect.current.Status,'Approved');assert.equal(effect.previous.amount,10);assert.equal(effect.current.amount,100);assert.equal(effect.time,'2026-10-26T12:01:00.000Z');assert.equal(effect.source,'provider')}
  const first=(await runs(h,workflows[1]))[0];await inspect({h,w:workflows[1],state:'comparison-payload',run:first});
  revision++;properties={...properties,Status:'Pending',amount:10};await poll();await counts([1,1]);
  revision++;properties={...properties,Status:'Approved',amount:100};await poll({restart:true,concurrent:true});await counts([2,1]);
  revision++;properties={...properties,amount:150};await poll();await counts([3,2]);
  const novel=effects.find(e=>e.identity==='first_value'&&e.current.amount===150);assert.deepEqual(novel.changed,['amount'],'a new value on one field admits the entire edit even when another field is familiar');
  revision++;properties={...properties,notes:'unwatched edit'};await poll();await counts([3,2]);
  const currentRevision=revision;revision=1;properties={...properties,amount:100};await poll();await counts([3,2]);revision=currentRevision;
  // Typed mismatch refuses the complete poll and retains its baseline for a retry.
  revision++;properties={...properties,amount:'200'};await poll();await counts([3,2]);
  for(const w of workflows){const state=await h.get(`workflows/${w.id}/trigger`);assert.equal(state.poll.last_status,'error');assert.match(state.poll.last_error,/changed_to: type mismatch.*amount/)}
  properties={...properties,amount:200};await poll();await counts([4,3]);
  // Values observed on nonmatching changes also consume first-value identity.
  revision++;properties={...properties,Status:'Pending',amount:250};await poll();await counts([4,3]);
  revision++;properties={...properties,Status:'Approved'};await poll();await counts([5,3]);
  for(const invalid of [{amount:99},{minimum_amount:999},{ready:false},{due:'2026-10-26T12:00:00Z'},{tags:['unrelated']}]) {
   revision++;properties={...properties,Status:'Approved',amount:260,...invalid};await poll();await counts([5,3]);
   revision++;properties={...properties,Status:'Pending',minimum_amount:100,ready:true,due:'2026-10-28T12:00:00Z',tags:['invoice']};await poll();await counts([5,3]);
  }
  // A changed-from rule must refuse a valid destination reached from another origin.
  revision++;properties={...properties,Status:'Rejected',amount:300};await poll();
  revision++;properties={...properties,Status:'Approved',amount:350};await poll();await counts([5,3]);
  // Initial Approved values are spent even when no run was requested.
  const seeded=await publish(h,'Initially approved',{trigger:{...trigger,identity:'first_value',changed_from:undefined},steps:[]});
  await poll();assert.equal((await runs(h,seeded)).length,0);
  const backfill=await publish(h,'Explicit existing approval',{trigger:{...trigger,backfill:'existing',identity:'first_value',changed_from:undefined},steps:[]});
  await poll();assert.equal((await runs(h,backfill)).length,1,'an explicit existing-record choice admits its matching seed once');
  revision++;properties={...properties,Status:'Pending'};await poll();
  revision++;properties={...properties,Status:'Approved'};await poll({restart:true});assert.equal((await runs(h,seeded)).length,0);
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
  const portable=text=>text.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).filter(item=>item.kind==='row'&&['crank_app_field_values','crank_app_snapshots','crank_app_erased_records','crank_app_subjects','crank_app_pending_rows'].includes(item.table)).map(item=>JSON.stringify({table:item.table,row:item.row})).sort();
  assert.ok(portable(archive.text).length>10);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('./data/restore',{archive:archive.text,confirm:'RESTORE'});
  const copy=await restored.send('/api/crank/data/export',{},restored.owner);assert.equal(copy.status,200);assert.deepEqual(portable(copy.text),portable(archive.text),'all comparison records survive byte for byte');
  const effectCount=effects.length;await restored.restart();await restored.tick(time+86400000);assert.equal(effects.length,effectCount);
  for(const w of workflows)assert.equal((await restored.get(`workflows/${w.id}`)).status,'paused');
  // A changed watch seeds a new version and retains per-field history across versions.
  const w=workflows[1],before=(await runs(h,w)).length;
  await h.post(`workflows/${w.id}/draft`,{graph:{trigger:{...trigger,identity:'first_value',watched_fields:['amount'],changed_to:[[{field:'amount',op:'number.gt',value:0}]],changed_from:undefined},steps:[]}});
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);await poll();assert.equal((await runs(h,w)).length,before);
  revision++;properties={...properties,amount:150};await poll();assert.equal((await runs(h,w)).length,before,'reseed must not forget an earlier field value');
  await h.post(`workflows/${w.id}/pause`);await h.post('./data/erase',{workflow_run_id:first.id,confirm:'ERASE'});
  for(const table of ['crank_app_field_values','crank_app_snapshots'])assert.equal((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow_id=?`).bind(w.id).first()).n,0);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_app_erased_records WHERE workflow_id=?').bind(w.id).first()).n,1);
  const afterErase=await h.send('/api/crank/data/export',{},h.owner);assert.ok(portable(afterErase.text).some(row=>row.includes('crank_app_erased_records')));
  const destination=await harness('http://127.0.0.1:9',{edge:edge.edge});try {
   const refused=await destination.send('/api/crank/data/restore',{archive:archive.text,journal:afterErase.text,confirm:'RESTORE'},destination.owner);assert.equal(refused.status,409,refused.text);
  }finally{await destination.close()}
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);revision++;properties={...properties,amount:999};await poll({restart:true});assert.equal((await runs(h,w)).length,before-1,'erased records never reappear through a later poll');
  await h.post(`connections/${c.id}/revoke`);revision++;properties={...properties,amount:1000};const prior=await Promise.all(workflows.map(async w=>(await runs(h,w)).length));await poll();await counts(prior);
 }finally{await restored?.close();await h.close()}
}
