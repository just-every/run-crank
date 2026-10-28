import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

/** Published searches distinguish a bounded result from proven absence. */
export async function searchOutcomesJourney() {
  const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge});
  let shape='complete',channelShape='complete',creates=0;
  fake.routes.set('slack.com',({url,body})=>{
    const method=url.pathname.replace('/api/',''),params=new URLSearchParams(body),page=Number(params.get('cursor')||0);
    if(method==='conversations.history') {
      if(shape==='invalid records')return jsonResponse({ok:true,messages:{}});
      const messages=shape==='empty bounded'?[]:[{ts:String(page+1),text:'synthetic-crank-1001',user:'synthetic-crank-1002'}];
      const cursor=shape==='invalid cursor'?42:shape==='repeated cursor'?'1':shape==='complete'?(page===0?'1':''):String(page+1);
      return jsonResponse({ok:true,messages,response_metadata:{next_cursor:cursor}});
    }
    if(method==='conversations.list')return jsonResponse({ok:true,channels:[],response_metadata:{next_cursor:channelShape==='complete'?'':String(page+1)}});
    if(method==='conversations.create'){creates++;return jsonResponse({ok:true,channel:{id:'C123456',name:params.get('name')}})}
    return jsonResponse({ok:false,error:'unknown_method'});
  });
  try {
    const account=await connection(h,{app:'slack',label:'Synthetic bounded search',auth_kind:'bearer',scopes:['channels:read','channels:manage'],secret:{token:'synthetic-crank-1003'}});
    const step={id:'search',type:'slack.find_message',connection_id:account.id,input:{channel:'C123456',text:'synthetic-crank-1001'},sort:{field:'ts',direction:'desc'}};
    const route={id:'route',type:'paths',mode:'exclusive',branches:[
      {id:'bounded',when:[[{field:'steps.search.outcome',op:'text.equals',value:'truncated'}]],steps:[]},
      {id:'missing',when:[[{field:'steps.search.outcome',op:'text.equals',value:'not found'}]],steps:[]},
    ],fallback:{steps:[]}};
    const flow=(name,settings,tail=[route])=>publish(h,name,{trigger:{type:'manual'},steps:[{...step,...settings},...tail]});
    const all=await flow('Bounded search routes visibly',{multi_match:'all'}),first=await flow('Complete search selects the sorted first',{multi_match:'first'});
    const limited=await flow('Declared result bound',{multi_match:'all',limit:1});
    const complete=await startRun(h,first,{});assert.equal(complete.status,'succeeded');assert.equal(stepOf(complete,'search').output.record.ts,'2');
    const bounded=await startRun(h,limited,{});assert.equal(bounded.status,'succeeded');
    assert.equal(stepOf(bounded,'search').output.outcome,'truncated');assert.equal(stepOf(bounded,'search').output.truncated,true);
    assert.deepEqual(stepOf(bounded,'search').output.records.map(row=>row.ts),['2']);assert.equal(stepOf(bounded,'search').output.count,1);
    assert.deepEqual(stepOf(bounded,'route').output.matched,['bounded']);
    const completeAll=await startRun(h,all,{});assert.equal(stepOf(completeAll,'search').output.outcome,'found');assert.equal(stepOf(completeAll,'search').output.truncated,false);
    assert.deepEqual(stepOf(completeAll,'search').output.records.map(row=>row.ts),['2','1']);

    shape='bounded';
    const partial=await startRun(h,all,{});assert.equal(partial.status,'succeeded');assert.equal(stepOf(partial,'search').output.outcome,'truncated');
    assert.equal(stepOf(partial,'search').output.count,5);assert.equal(stepOf(partial,'search').output.truncated,true);
    assert.deepEqual(stepOf(partial,'route').output.matched,['bounded']);
    const unsafeFirst=await startRun(h,first,{});assert.equal(unsafeFirst.status,'failed');assert.equal(unsafeFirst.error.outcome,'search incomplete');assert.equal(stepOf(unsafeFirst,'route'),undefined);
    shape='empty bounded';
    for(const no_match of ['halt','continue']) {
      const empty=await flow('Incomplete absence '+no_match,{no_match});
      const run=await startRun(h,empty,{});assert.equal(run.status,'failed');assert.equal(run.error.category,'provider');assert.equal(run.error.outcome,'search incomplete');assert.equal(stepOf(run,'route'),undefined);
    }
    const emptyAll=await startRun(h,all,{});assert.equal(emptyAll.status,'succeeded');assert.equal(stepOf(emptyAll,'search').output.outcome,'truncated');
    assert.equal(stepOf(emptyAll,'search').output.record,null);assert.equal(stepOf(emptyAll,'search').output.count,0);assert.deepEqual(stepOf(emptyAll,'route').output.matched,['bounded']);

    for(shape of ['invalid records','invalid cursor','repeated cursor']) {
      const malformed=await startRun(h,all,{});assert.equal(malformed.status,'failed');assert.equal(malformed.error.category,'provider');assert.equal(stepOf(malformed,'route'),undefined);
    }
    const calls=fake.requests.length;
    for(const settings of [{limit:0},{limit:-1},{limit:1.5},{limit:'1'},{limit:501},{sort:{field:'ts',direction:'up'}},{sort:{field:'',direction:'asc'}}]) {
      await h.post('workflows',{name:'Invalid bounded search',graph:{trigger:{type:'manual'},steps:[{...step,...settings}]}},h.owner,422);
    }
    assert.equal(fake.requests.length,calls,'Invalid search settings are refused before a provider request');

    // The native create door may run only after a complete no-match read.
    channelShape='bounded';
    const create=await publish(h,'Complete read before channel creation',{trigger:{type:'manual'},steps:[{id:'room',type:'slack.find_channel_by_name',connection_id:account.id,create_if_not_found:{},input:{name:'synthetic-crank-1004'}}]});
    const incomplete=await startRun(h,create,{});assert.equal(incomplete.status,'failed');assert.match(incomplete.error.message,/incomplete/);assert.equal(creates,0);
    channelShape='complete';const created=await startRun(h,create,{});assert.equal(created.status,'succeeded');assert.equal(stepOf(created,'room').output.outcome,'created');assert.equal(creates,1);
  } finally {await h.close()}
}
