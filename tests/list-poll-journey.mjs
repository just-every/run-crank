import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs,settled} from './kit.mjs';

/** Native lists use real workflow HTTP doors and Cron; only providers are faked. */
export async function listPollJourney({inspect=async()=>{}}={}) {
 const minute=60000,edge=fakeEdge(),effects=[];
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  for(const provider of ['sharepoint','http_json']) {
   const token=provider==='sharepoint'?'synthetic-crank-40':'synthetic-crank-41';
   const host=provider==='sharepoint'?'graph.microsoft.com':'list.example';
   let revision=0,status='Pending',amount=100,notes='seed',mode='ok';
   const at=()=>new Date(Date.parse('2026-10-27T12:00:00Z')+revision*minute).toISOString();
   const path=provider==='sharepoint'?'/v1.0/sites/synthetic-crank-42/lists/synthetic-crank-43/items':'/records';
   edge.routes.set(host,({method,url,headers})=>{
    assert.equal(method,'GET');assert.equal(url.pathname,path);assert.equal(headers.authorization,'Bearer '+token);
    const second=url.searchParams.has(provider==='sharepoint'?'$skiptoken':'cursor');
    if(second&&mode==='outage')return jsonResponse({},503);
    const fields={Status:status,Amount:amount,Notes:notes};
    const item=provider==='sharepoint'?{id:'synthetic-crank-44',lastModifiedDateTime:at(),fields}:{key:'synthetic-crank-44',modified:at(),data:fields};
    if(mode==='newest'&&!second||mode==='older-second'&&second) {
     const older=new Date(Date.parse(at())-minute).toISOString(),oldFields={...fields,Status:'Pending',Amount:100};
     if(provider==='sharepoint'){item.lastModifiedDateTime=older;item.fields=oldFields}else{item.modified=older;item.data=oldFields}
    }
    if(mode==='conflict'&&second) {if(provider==='sharepoint')item.fields={...fields,Amount:999};else item.data={...fields,Amount:999}}
    if(provider==='sharepoint') {
     if(!second)assert.equal(url.searchParams.get('$expand'),'fields');
     const next=new URL(url);next.searchParams.set('$skiptoken','synthetic-crank-45');
     return jsonResponse({value:[item],...(!second?{'@odata.nextLink':next.href}:{})});
    }
    return jsonResponse({page:{items:[item]},...(!second?{next:'synthetic-crank-45'}:{})});
   });
   const c=await connection(h,{app:provider==='sharepoint'?'microsoft_graph':'http',auth_kind:'bearer',label:'Synthetic list '+provider,...(provider==='http_json'?{domains:[host]}:{}),secret:{token}});
   const source=provider==='sharepoint'?{resource:'list_items',site_id:'synthetic-crank-42',list_id:'synthetic-crank-43'}:{resource:'records',url:'https://list.example/records',items_path:'page.items',id_path:'key',fields_path:'data',modified_path:'modified',pagination:{cursor_path:'next',param:'cursor',max_pages:3}};
   const trigger={type:'app_poll',provider,...source,connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Status','Amount']};
   const w=await publish(h,'Native list '+provider,{trigger,steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/list',body:{provider,id:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',at:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]});
   assert.deepEqual((await h.get(`workflows/${w.id}/trigger/fields`)).fields.map(f=>f.name).sort(),['Amount','Notes','Status']);
   let time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);
   const count=async n=>assert.equal((await runs(h,w)).length,n);
   const poll=async()=>{time+=minute;await h.tick(time)};
   const ownEffects=()=>effects.filter(e=>e.provider===provider);
   await h.tick(time);await count(0);
   revision++;notes='unwatched edit';await poll();await count(0);
   revision++;status='Approved';amount=200;mode='outage';await poll();await count(0);
   assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   await h.restart();mode='newest';time+=minute;await Promise.all([h.tick(time),h.tick(time)]);await count(1);
   await settled(h,(await runs(h,w))[0].id);
   assert.deepEqual(ownEffects(),[{provider,id:'synthetic-crank-44',previous:{Status:'Pending',Amount:100},current:{Status:'Approved',Amount:200},changed:['Status','Amount'],at:at(),source:'provider'}]);
   await inspect({h,w,state:'list-change'});
   // Repeated observations and older provider versions cannot roll back the baseline.
   mode='older-second';await poll();await count(1);mode='ok';revision=0;status='Pending';amount=100;await poll();await count(1);
   revision=3;status='Approved';amount=250;mode='conflict';await poll();await count(1);
   assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   mode='ok';await poll();await count(2);await settled(h,(await runs(h,w))[0].id);
   assert.deepEqual(ownEffects()[1].previous,{Status:'Approved',Amount:200});
   assert.deepEqual(ownEffects()[1].current,{Status:'Approved',Amount:250});
   // Revocation is checked before sending any source request.
   await h.post(`connections/${c.id}/revoke`);const requests=edge.to(host).length;
   revision++;amount=300;await poll();await count(2);
   assert.equal(edge.to(host).length,requests);assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   await h.post(`workflows/${w.id}/pause`);
  }
  // Sources without a timestamp use the exact, explicitly labelled poll time.
  let value='Pending';
  edge.routes.set('list.example',({method,headers})=>{
   assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer synthetic-crank-46');
   return jsonResponse([{key:0,Status:value,propertiesWithHistory:{Status:[{value:'injected',timestamp:'2099-01-01T00:00:00Z'}]}}]);
  });
  const c=await connection(h,{app:'http',auth_kind:'bearer',label:'Synthetic untimed list',domains:['list.example'],secret:{token:'synthetic-crank-46'}});
  const w=await publish(h,'Observed list time',{trigger:{type:'app_poll',provider:'http_json',resource:'records',connection_id:c.id,url:'https://list.example/records',items_path:'',id_path:'key',event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Status']},steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/list',body:{provider:'untimed',id:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',at:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]});
  let time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);await h.tick(time);
  value='Approved';await h.restart();time+=minute;await Promise.all([h.tick(time),h.tick(time)]);
  assert.equal((await runs(h,w)).length,1);await settled(h,(await runs(h,w))[0].id);
  assert.deepEqual(effects.filter(e=>e.provider==='untimed'),[{provider:'untimed',id:'0',previous:{Status:'Pending'},current:{Status:'Approved'},at:new Date(time).toISOString(),source:'poll'}]);
  await h.tick(time+=minute);assert.equal((await runs(h,w)).length,1);
 }finally{await h.close()}
}
