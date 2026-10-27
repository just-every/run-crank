import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

export async function airtablePollJourney() {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 let stage='Pending',amount=100,notes='seed',revision=0,mode='ok',effects=[];
 const at=()=>new Date(Date.parse('2026-10-27T12:00:00Z')+revision*60000).toISOString();
 edge.routes.set('api.airtable.com',({url,headers})=>{
  assert.equal(headers.authorization,'Bearer synthetic-crank-30');
  if(url.pathname.startsWith('/v0/meta/'))return jsonResponse({tables:[{id:'synthetic-crank-32',name:'Orders',fields:['Approval Status','Invoice Amount','Notes','Last Modified'].map(name=>({name}))}]});
  assert.equal(url.pathname,'/v0/synthetic-crank-31/synthetic-crank-32');assert.equal(url.searchParams.get('view'),'synthetic-crank-33');
  if(mode==='outage'&&url.searchParams.has('offset'))return jsonResponse({},503);
  const record={id:'synthetic-crank-34',createdTime:'2025-01-01T00:00:00Z',fields:{'Approval Status':stage,'Invoice Amount':amount,Notes:notes,'Last Modified':at()}};
  return url.searchParams.has('offset')?jsonResponse({records:[record]}):jsonResponse({records:[record],offset:'synthetic-crank-35'});
 });
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  const c=await connection(h,{app:'airtable',auth_kind:'bearer',label:'Account orders',secret:{token:'synthetic-crank-30'}}),workflows=[];
  const trigger={type:'app_poll',provider:'airtable',resource:'records',base_id:'synthetic-crank-31',table_id:'synthetic-crank-32',view_id:'synthetic-crank-33',modified_field:'Last Modified',connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Approval Status','Invoice Amount'],changed_to:[[{field:'Approval Status',op:'text.equals',value:'Approved'}]]};
  for(const identity of ['change','first_value'])workflows.push(await publish(h,'Airtable approval '+identity,{trigger:{...trigger,identity},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/airtable',body:{identity,previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',at:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]}));
  assert.deepEqual((await h.get(`workflows/${workflows[0].id}/trigger/fields`)).fields.map(f=>f.name),['Approval Status','Invoice Amount','Notes','Last Modified']);
  let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
  const poll=async()=>{time+=60000;await h.tick(time)},counts=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected);
  await h.tick(time);await counts([0,0]);revision++;notes='unwatched';await poll();await counts([0,0]);
  revision++;stage='Approved';amount=200;mode='outage';await poll();await counts([0,0]);
  await h.restart();mode='ok';await poll();await counts([1,1]);assert.equal(effects.length,2);
  for(const effect of effects){assert.deepEqual(effect.previous,{'Approval Status':'Pending','Invoice Amount':100});assert.deepEqual(effect.current,{'Approval Status':'Approved','Invoice Amount':200});assert.deepEqual(effect.changed,['Approval Status','Invoice Amount']);assert.equal(effect.at,at());assert.equal(effect.source,'provider')}
  revision=0;stage='Pending';amount=100;await poll();await counts([1,1]);
  revision=3;await poll();revision++;stage='Approved';amount=200;await poll();await counts([2,1]);
  await h.post(`connections/${c.id}/revoke`);revision++;amount=300;await poll();await counts([2,1]);
 }finally{await h.close()}
}
