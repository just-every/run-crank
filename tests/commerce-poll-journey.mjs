import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs,settled} from './kit.mjs';

const minute=60000;
const providers=[
 {provider:'pipedrive',resource:'deals',host:'synthetic-crank-101.pipedrive.com',source:{subdomain:'synthetic-crank-101'},status:'status',amount:'value',notes:'title',pending:'open',approved:'won',path:'/api/v2/deals',token:'synthetic-crank-102'},
 {provider:'shopify',resource:'orders',host:'synthetic-crank-103.myshopify.com',source:{shop_domain:'synthetic-crank-103.myshopify.com'},status:'displayFulfillmentStatus',amount:'totalPriceSet',notes:'note',pending:'UNFULFILLED',approved:'FULFILLED',path:'/admin/api/2026-10/graphql.json',token:'synthetic-crank-104'},
 {provider:'zendesk',resource:'tickets',host:'synthetic-crank-105.zendesk.com',source:{subdomain:'synthetic-crank-105'},status:'status',amount:'priority',notes:'subject',pending:'open',approved:'solved',path:'/api/v2/tickets.json',token:'synthetic-crank-106'},
];

/** Public workflow doors and Cron exercise snapshots, not provider event replay. */
export async function commercePollJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  for(const spec of providers) {
   const {provider,resource,host,source,status,amount,notes,pending,approved,path,token}=spec;
   let revision=0,state=pending,value=100,note='synthetic-crank-107',mode='ok';
   const at=(v=revision)=>new Date(Date.parse('2026-10-27T12:00:00Z')+v*minute).toISOString();
   const amountValue=n=>provider==='shopify'?{shopMoney:{amount:String(n),currencyCode:'USD'}}:provider==='zendesk'?(n===100?'normal':n===200?'high':n===250?'urgent':'low'):n;
   const expected=(s,n)=>({[status]:s,[amount]:amountValue(n)});
   const item=(old=false)=>({id:'synthetic-crank-108',
    [provider==='pipedrive'?'update_time':provider==='shopify'?'updatedAt':'updated_at']:at(old?Math.max(0,revision-1):revision),
    [status]:old?pending:state,[amount]:amountValue(old?100:value),[notes]:note,
    // The reader must not promote a provider property into appTimeline history.
    ...(provider==='shopify'?{}:{propertiesWithHistory:{[status]:[{value:approved,timestamp:'2099-01-01T00:00:00Z'}]}}),
   });
   edge.routes.set(host,({method,url,headers,body})=>{
    assert.equal(url.pathname,path);assert.equal(method,provider==='shopify'?'POST':'GET');
    if(provider==='shopify')assert.equal(headers['x-shopify-access-token'],token);else assert.equal(headers.authorization,'Bearer '+token);
    const query=provider==='shopify'?JSON.parse(body):null;
    const second=provider==='shopify'?query.variables.after!==null:url.searchParams.has(provider==='pipedrive'?'cursor':'page[after]');
    if(provider==='shopify') {assert.match(query.query,/orders\(first: 100/);assert.match(query.query,/pageInfo/)}
    if(provider==='pipedrive')assert.equal(url.searchParams.get('limit'),'100');
    if(provider==='zendesk')assert.equal(url.searchParams.get('page[size]'),'100');
    if(mode==='outage'&&second)return jsonResponse({},503);
    if(mode==='graphql-error'&&second)return jsonResponse({data:{orders:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}},errors:[{message:'synthetic-crank-109'}]});
    const raw=item(mode==='newest-second'&&!second||mode==='older-second'&&second);
    if(mode==='conflict'&&second)raw[amount]=amountValue(300);
    if(mode==='invalid-time'&&second)raw[provider==='pipedrive'?'update_time':provider==='shopify'?'updatedAt':'updated_at']='2026-02-30T12:00:00Z';
    const more=!second||mode==='loop';
    if(provider==='pipedrive')return jsonResponse({success:true,data:[raw],additional_data:mode==='incomplete'&&second?{}:{next_cursor:more?'synthetic-crank-110':null}});
    if(provider==='shopify')return jsonResponse({data:{orders:{nodes:[raw],pageInfo:{hasNextPage:mode==='incomplete'&&second?true:more,endCursor:mode==='incomplete'&&second?null:more?'synthetic-crank-110':null}}}});
    const next=new URL(url);next.searchParams.set('page[after]','synthetic-crank-110');
    if(mode==='cross-account')next.hostname='synthetic-crank-111.zendesk.com';
    return jsonResponse({tickets:[raw],meta:{has_more:mode==='incomplete'&&second?true:more},links:{next:mode==='incomplete'&&second?null:more?next.href:null}});
   });
   const c=await connection(h,{app:provider,label:'Synthetic '+provider,auth_kind:provider==='shopify'?'api_key':'bearer',domains:[host],secret:provider==='shopify'?{key:token,header:'X-Shopify-Access-Token'}:{token}});
   const trigger={type:'app_poll',provider,resource,...source,connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:[status,amount],changed_to:{[status]:approved}};
   const workflows=[];
   for(const identity of ['change','first_value'])workflows.push(await publish(h,'Snapshot '+provider+' '+identity,{trigger:{...trigger,identity},steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/commerce',body:{provider,identity,id:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',at:'{{trigger.change_time}}',time_source:'{{trigger.change_time_source}}',source_kind:'{{trigger.source_kind}}',history:'{{trigger.history_available}}'}}}]}));
   const fields=(await h.get(`workflows/${workflows[0].id}/trigger/fields`)).fields.map(f=>f.name);
   assert.ok(fields.includes(status));assert.ok(fields.includes(amount));
   let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
   const count=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected,provider);
   const poll=async()=>{time+=minute;await h.tick(time)};
   const own=identity=>effects.filter(effect=>effect.provider===provider&&effect.identity===identity);
   const success=async expected=>{await count(expected);for(const w of workflows){for(const run of await runs(h,w))await settled(h,run.id)}};
   await h.tick(time);await count([0,0]);
   revision++;note='synthetic-crank-112';await poll();await count([0,0]);
   revision++;state=approved;value=200;mode='outage';await poll();await count([0,0]);
   for(const w of workflows)assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   mode='newest-second';await h.restart();time+=minute;await Promise.all([h.tick(time),h.tick(time)]);await success([1,1]);
   for(const identity of ['change','first_value'])assert.deepEqual(own(identity),[{provider,identity,id:'synthetic-crank-108',previous:expected(pending,100),current:expected(approved,200),changed:[status,amount],at:at(),time_source:'provider',source_kind:'current_snapshot',history:false}]);
   await inspect({h,w:workflows[0],state:'commerce-change',provider});
   mode='older-second';await poll();await count([1,1]);
   const latest=revision;revision=0;state=pending;value=100;mode='ok';await poll();await count([1,1]);
   revision=latest+1;state=approved;value=250;
   for(const failure of ['conflict','invalid-time','incomplete','loop',...(provider==='shopify'?['graphql-error']:provider==='zendesk'?['cross-account']:[])]) {
    mode=failure;const before=edge.requests.length;await poll();await count([1,1]);
    for(const w of workflows)assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error',provider+' '+failure);
    if(failure==='cross-account')assert.ok(edge.requests.slice(before).every(request=>request.url.hostname!=='synthetic-crank-111.zendesk.com'));
   }
   mode='ok';await h.restart();await poll();await success([2,2]);
   for(const identity of ['change','first_value']) {
    assert.deepEqual(own(identity)[1].previous,expected(approved,200));assert.deepEqual(own(identity)[1].current,expected(approved,250));
   }
   revision++;state=pending;value=100;await poll();await count([2,2]);
   revision++;state=approved;value=200;await poll();await success([3,2]);
   revision++;value=300;await poll();await success([4,3]);
   await h.post(`connections/${c.id}/revoke`);const before=edge.to(host).length;
   revision++;value=400;await poll();await count([4,3]);assert.equal(edge.to(host).length,before);
   for(const w of workflows)assert.equal((await h.send(`/api/crank/workflows/${w.id}/publish`,{},h.owner)).status,422,'a revoked account cannot authorize a replacement version');
   for(const w of workflows)await h.post(`workflows/${w.id}/pause`);
  }
 }finally{await h.close()}
}
