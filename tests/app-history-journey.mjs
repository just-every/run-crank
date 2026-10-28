import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

/** Provider history recovers transitions that happened between polling observations. */
export async function appHistoryJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 const base=Date.parse('2026-10-27T12:00:00Z'),at=n=>new Date(base+n*60000).toISOString();
 let revision=0,effects=[],invalid=false;
 const values=[['Pending','10'],['Approved','20'],['Pending','10'],['Approved','20'],['Pending','10'],['Approved','30']];
 edge.routes.set('api.hubapi.com',({url})=>{
  assert.equal(url.searchParams.get('propertiesWithHistory'),'Status,amount');
  const history=field=>values.slice(0,revision+1).map((value,i)=>({value:value[field],timestamp:at(i)})).reverse();
  const status=history(0);if(invalid)status.push({value:'Rejected',timestamp:at(revision)});
  return jsonResponse({results:[{id:'synthetic-crank-history',updatedAt:at(revision),properties:{Status:values[revision][0],amount:values[revision][1]},propertiesWithHistory:{Status:status,amount:history(1)}}]});
 });
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  const c=await connection(h,{app:'hubspot',auth_kind:'bearer',label:'Historical transitions',secret:{token:'synthetic-crank-20'}}),workflows=[];
  const trigger={type:'app_poll',provider:'hubspot',resource:'deals',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['Status','amount'],changed_to:{Status:'Approved'}};
  for(const identity of ['change','first_value'])workflows.push(await publish(h,'Property history '+identity,{trigger:{...trigger,identity},steps:[{id:'send',type:'http',input:{method:'POST',url:'https://receiver.example/history',body:{identity,previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',at:'{{trigger.change_time}}',source:'{{trigger.change_time_source}}'}}}]}));
  let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
  const counts=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected);
  await h.tick(time);await counts([0,0]);
  revision=3;time+=60000;await Promise.all([h.tick(time),h.tick(time)]);await counts([2,1]);
  assert.deepEqual(effects.filter(e=>e.identity==='change').map(e=>e.at),[at(1),at(3)]);
  for(const effect of effects){assert.deepEqual(effect.previous,{Status:'Pending',amount:'10'});assert.deepEqual(effect.current,{Status:'Approved',amount:'20'});assert.deepEqual(effect.changed,['Status','amount']);assert.equal(effect.source,'provider')}
  await inspect({h,w:workflows[0],state:'history-payload',run:(await runs(h,workflows[0]))[0]});
  await h.restart();time+=60000;await h.tick(time);await counts([2,1]);
  revision=5;invalid=true;time+=60000;await h.tick(time);await counts([2,1]);
  for(const workflow of workflows){const state=await h.get(`workflows/${workflow.id}/trigger`);assert.equal(state.poll.last_status,'error');assert.match(state.poll.last_error,/history conflicts/)}
  invalid=false;time+=60000;await h.tick(time);await counts([3,2]);
  assert.deepEqual(effects.at(-1).current,{Status:'Approved',amount:'30'});assert.equal(effects.at(-1).at,at(5));
 } finally {await h.close()}
}
