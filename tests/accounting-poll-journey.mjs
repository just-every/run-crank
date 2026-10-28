import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,runs,settled} from './kit.mjs';

const minute=60000,realm='123456789',tenant='00000000-0000-4000-8000-000000000201';
const sources=[
 {provider:'quickbooks',resource:'invoices',entity:'Invoice',key:'Id',status:'EmailStatus',pending:'NotSet',approved:'EmailSent',balance:'Balance',note:'PrivateNote',host:'sandbox-quickbooks.api.intuit.com',source:{realm_id:realm},token:'synthetic-crank-202'},
 {provider:'quickbooks',resource:'customers',entity:'Customer',key:'Id',status:'Active',pending:false,approved:true,balance:'Balance',note:'Notes',host:'sandbox-quickbooks.api.intuit.com',source:{realm_id:realm},token:'synthetic-crank-203'},
 {provider:'xero',resource:'invoices',entity:'Invoices',key:'InvoiceID',status:'Status',pending:'DRAFT',approved:'AUTHORISED',balance:'AmountDue',note:'Reference',host:'api.xero.com',source:{tenant_id:tenant},token:'synthetic-crank-204'},
 {provider:'xero',resource:'contacts',entity:'Contacts',key:'ContactID',status:'ContactStatus',pending:'ACTIVE',approved:'ARCHIVED',balance:'Balances',note:'Name',host:'api.xero.com',source:{tenant_id:tenant},token:'synthetic-crank-205'},
];

/** Real HTTP workflow publication, field discovery, Cron and actions; provider edges only are faked. */
export async function accountingPollJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),effects=[],h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 try {
  for(const spec of sources) {
   const {provider,resource,entity,key,status,pending,approved,balance,note,host,source,token}=spec,invoice=resource==='invoices',xero=provider==='xero';
   let revision=0,state=pending,amount=100,due='2026-11-01',notes='synthetic-crank-206',mode='ok';
   const at=(v=revision)=>new Date(Date.parse('2026-10-27T12:00:00Z')+v*minute).toISOString();
   const dotnet=value=>`/Date(${Date.parse(value)}+0000)/`;
   const balanceValue=n=>resource==='contacts'?{AccountsReceivable:{Outstanding:n,Overdue:0}}:n;
   const dueValue=value=>xero?dotnet(value+'T00:00:00Z'):value;
   const expected=(s,n,date)=>({[status]:s,[balance]:balanceValue(n),...(invoice?{DueDate:dueValue(date)}:{})});
   const raw=(old=false)=>({[key]:'synthetic-crank-207',
    ...(xero?{UpdatedDateUTC:dotnet(at(old?Math.max(0,revision-1):revision))}:{MetaData:{CreateTime:at(0),LastUpdatedTime:at(old?Math.max(0,revision-1):revision)}}),
    ...expected(old?pending:state,old?100:amount,old?'2026-11-01':due),[note]:notes,
    // These arbitrary provider properties stay inside provider_record, never appTimeline.
    propertiesWithHistory:{[status]:[{value:approved,timestamp:'2099-01-01T00:00:00Z'}]},
   });
   edge.routes.set(host,({method,url,headers})=>{
    assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer '+token);assert.equal(headers.accept,'application/json');
    let second;
    if(xero) {
     assert.equal(url.pathname,'/api.xro/2.0/'+entity);assert.equal(headers['xero-tenant-id'],tenant);
     assert.equal(url.searchParams.get('pageSize'),'100');assert.equal(url.searchParams.get('order'),key+' ASC');
     if(resource==='contacts')assert.equal(url.searchParams.get('includeArchived'),'true');
     second=url.searchParams.get('page')==='2';
    }else {
     assert.equal(url.pathname,`/v3/company/${realm}/query`);
     const query=url.searchParams.get('query');assert.match(query,new RegExp(`^SELECT \\* FROM ${entity}`));assert.match(query,/ORDERBY Id ASC STARTPOSITION (1|101) MAXRESULTS 100$/);
     if(resource==='customers')assert.match(query,/WHERE Active IN \(true, false\)/);
     second=query.includes('STARTPOSITION 101 ');
    }
    if(second&&mode==='outage')return jsonResponse({},503);
    const record=raw(mode==='newest-second'&&!second||mode==='older-second'&&second);
    if(mode==='conflict'&&second)record[balance]=balanceValue(999);
    if(mode==='invalid-time'&&second){if(xero)record.UpdatedDateUTC='/Date(1+0130)/';else record.MetaData.LastUpdatedTime='2026-02-30T12:00:00Z'}
    // A bounded duplicate-heavy provider page exercises paging without seeding 100 unrelated records.
    const items=second?[record]:Array.from({length:100},()=>record);
    if(xero)return jsonResponse({Status:mode==='provider-error'&&second?'ERROR':'OK',[entity]:items,...(mode==='incomplete'&&second?{}:{pagination:{page:second?2:1,pageSize:100,pageCount:2,itemCount:101}})});
    if(mode==='provider-error'&&second)return jsonResponse({Fault:{type:'synthetic-crank-208'},QueryResponse:{}});
    return jsonResponse({QueryResponse:{[entity]:items,startPosition:mode==='incomplete'&&second?1:second?101:1,maxResults:items.length}});
   });
   const c=await connection(h,{app:provider,label:'Synthetic accounting '+resource,account_name:xero?tenant:realm,...(xero?{}:{environment:'sandbox',purpose:'test',scopes:['com.intuit.quickbooks.accounting']}),auth_kind:xero?'bearer':'oauth2',secret:xero?{token}:{access_token:token}});
   const publishSource=async(name,graph)=>{const w=await h.post('workflows',{name,graph,environment:xero?'production':'sandbox'},h.owner,201);return {...w,published:await h.post(`workflows/${w.id}/publish`,{},h.owner,201)}};
   const watched=[status,balance,...(invoice?['DueDate']:[])];
   const trigger={type:'app_poll',provider,resource,...source,connection_id:c.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:watched,changed_to:{[status]:approved}};
   for(const bad of [{resource:'accounts'},{query:'synthetic-crank-209'},{url:'https://receiver.example/accounting'},{...(xero?{realm_id:realm}:{tenant_id:tenant})}]) {
    const refused=await h.send('/api/crank/workflows',{name:'Unsupported accounting source',graph:{trigger:{...trigger,...bad},steps:[]}},h.owner);assert.equal(refused.status,422,refused.text);
   }
   const workflows=[];
   for(const identity of ['change','first_value'])workflows.push(await publishSource('Accounting snapshot '+provider+' '+resource+' '+identity,{trigger:{...trigger,identity},steps:[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/accounting',body:{provider,resource,identity,id:'{{trigger.record_id}}',previous:'{{trigger.previous}}',current:'{{trigger.current}}',changed:'{{trigger.changed_fields}}',time:'{{trigger.change_time}}',time_source:'{{trigger.change_time_source}}',source_kind:'{{trigger.source_kind}}',history:'{{trigger.history_available}}',provider_at:'{{trigger.provider_updated_at}}'}}}]}));
   const fields=(await h.get(`workflows/${workflows[0].id}/trigger/fields`)).fields.map(f=>f.name);
   for(const field of watched)assert.ok(fields.includes(field));
   let time=Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
   const counts=async expected=>assert.deepEqual(await Promise.all(workflows.map(async w=>(await runs(h,w)).length)),expected,provider+' '+resource);
   const poll=async()=>{time+=minute;await h.tick(time)};
   const own=identity=>effects.filter(effect=>effect.provider===provider&&effect.resource===resource&&effect.identity===identity);
   const complete=async expected=>{await counts(expected);for(const w of workflows)for(const run of await runs(h,w)){const done=await settled(h,run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error))}};
   await h.tick(time);await counts([0,0]);
   revision++;notes='synthetic-crank-210';await poll();await counts([0,0]);
   revision++;state=approved;amount=0;due='2026-12-01';mode='outage';await poll();await counts([0,0]);
   for(const w of workflows)assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   mode='newest-second';await h.restart();time+=minute;await Promise.all([h.tick(time),h.tick(time)]);await complete([1,1]);
   for(const identity of ['change','first_value'])assert.deepEqual(own(identity),[{provider,resource,identity,id:'synthetic-crank-207',previous:expected(pending,100,'2026-11-01'),current:expected(approved,0,'2026-12-01'),changed:watched,time:xero?new Date(time).toISOString():at(),time_source:xero?'poll':'provider',source_kind:'current_snapshot',history:false,provider_at:at()}]);
   await inspect({h,w:workflows[0],state:'accounting-change',provider,resource});
   mode='older-second';await poll();await counts([1,1]);
   revision=0;state=pending;amount=100;due='2026-11-01';mode='ok';await poll();await counts([1,1]);
   revision=3;state=approved;amount=50;due='2026-12-02';
   for(const failure of ['conflict','invalid-time','incomplete','provider-error']) {
    mode=failure;await poll();await counts([1,1]);
    for(const w of workflows)assert.equal((await h.get(`workflows/${w.id}/trigger`)).poll.last_status,'error');
   }
   mode='ok';await h.restart();await poll();await complete([2,2]);
   for(const identity of ['change','first_value'])assert.deepEqual(own(identity)[1].previous,expected(approved,0,'2026-12-01'));
   let extra=0;
   if(xero) {
    // Xero documents fields that change without advancing UpdatedDateUTC.
    if(invoice)due='2026-12-03';else amount=75;
    await poll();await complete([3,3]);extra=1;
    for(const identity of ['change','first_value'])assert.equal(own(identity)[2].provider_at,at());
    await poll();await counts([3,3]);
   }
   revision++;state=pending;amount=100;due='2026-11-01';await poll();await counts([2+extra,2+extra]);
   revision++;state=approved;amount=0;due='2026-12-01';await poll();await complete([3+extra,2+extra]);
   // Realm and tenant mismatches refuse before any provider read.
   const requests=edge.to(host).length;
   const wrong=await publishSource('Wrong accounting account',{trigger:{...trigger,...(xero?{tenant_id:'00000000-0000-4000-8000-000000000211'}:{realm_id:'999999999'})},steps:[]});
   await poll();assert.equal(edge.to(host).length,requests+4,'only the two valid workflows read their two pages');
   assert.equal((await h.get(`workflows/${wrong.id}/trigger`)).poll.last_status,'error');await h.post(`workflows/${wrong.id}/pause`);
   await h.post(`connections/${c.id}/revoke`);const before=edge.to(host).length;revision++;amount=999;await poll();
   await counts([3+extra,2+extra]);assert.equal(edge.to(host).length,before);
   for(const w of workflows)await h.post(`workflows/${w.id}/pause`);
  }
 }finally{await h.close()}
}
