import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,stepOf} from './kit.mjs';
import {archive} from './restore-journey.mjs';

export async function outcomeObjective(h,{realm,customer,item,receiver,businessKey='synthetic-crank-51',lead='synthetic-crank-50',amount='19.99',token='synthetic-crank-52'}) {
 const account=await connection(h,{app:'quickbooks',label:'Harbour outcome sandbox',account_name:realm,environment:'sandbox',purpose:'test',auth_kind:'oauth2',scopes:['com.intuit.quickbooks.accounting'],secret:{access_token:token}});
 const steps=[
  {id:'lead',type:'http',input:{method:'GET',url:receiver+'/lead'}},
  {id:'invoice',type:'quickbooks.create_invoice',connection_id:account.id,input:{realm_id:realm,business_key:businessKey,amount_usd:amount,payload:{CustomerRef:{value:customer},Line:[{Amount:Number(amount),DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:item}}}]}}},
  {id:'verify_invoice',type:'quickbooks.invoice_outcome',connection_id:account.id,input:{realm_id:realm,business_key:businessKey,source_path:'invoice',lead_path:'lead',lead_id:lead,customer_id:customer,amount_usd:amount,due_at:'2026-10-30T12:00:00Z',remaining_cost_usd:'0.01'}},
  {id:'notify',type:'http',input:{method:'POST',url:receiver+'/notify',body:{to:'finance@example.test',lead_id:lead,business_key:businessKey,amount_usd:amount}}},
 ];
 const workflow=await h.post('workflows',{name:'Harbour recurring lead to invoice and notify',environment:'sandbox',graph:{trigger:{type:'manual'},steps}},h.owner,201);
 const published=await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
 const policy={rules:steps.map(s=>({step_id:s.id,type:s.type,connection_id:s.connection_id??null,app:s.connection_id?'quickbooks':'none',fields:Object.keys(s.input),recipients:s.id==='invoice'||s.id==='verify_invoice'?[customer]:s.id==='notify'?['finance@example.test']:[],...(s.id==='invoice'?{recipient_field:'payload.CustomerRef.value',amount_field:'amount_usd',max_usd:amount}:s.id==='verify_invoice'?{recipient_field:'customer_id',amount_field:'amount_usd',max_usd:amount}:s.id==='notify'?{recipient_field:'body.to'}:{}),max_per_minute:100})),approval:{timeout_seconds:3600,delegate_ids:[],escalate_to:[]}};
 const grant=await h.post('grants',{label:'Bounded Harbour invoice outcome',workflow_id:workflow.id,version_id:published.version.id,expires_at:new Date(Date.now()+3600000).toISOString(),policy},h.owner,201);
 const actions=steps.map(s=>({step_id:s.id,input:s.input}));
 const start=(change={},status=201)=>h.post('agent-tasks',{task_id:crypto.randomUUID(),actions:actions.map(a=>({...a,input:{...a.input,...(change[a.step_id]??{})}}))},'',status,{authorization:'Bearer '+grant.credential});
 return {workflow,account,steps,grant,start};
}
export async function invoiceOutcomeJourney({inspect,modeOnly}={}) {
 const notices=[],facts={id:'synthetic-crank-50',customer_id:'synthetic-crank-53',amount_usd:'19.99'};
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/lead'){res.end(JSON.stringify(facts));return}const chunks=[];for await(const c of req)chunks.push(c);notices.push(JSON.parse(Buffer.concat(chunks)));res.end(JSON.stringify({id:'synthetic-crank-'+(70+notices.length),accepted:true}))});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const receiver='http://127.0.0.1:'+server.address().port;
 const declared='https://synthetic-crank-owned.example',fake=fakeEdge();
 fake.routes.set('synthetic-crank-owned.example',({method,url,headers,body})=>{const {'content-length':_,...forwarded}=headers;return fetch(receiver+url.pathname+url.search,{method,headers:forwarded,...(!['GET','HEAD'].includes(method)?{body}:{})})});
 let mode='missing',record=null,posts=0,effects=0,repair=false;const seenKeys=new Map();
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,url,body})=>{
  if(method==='GET')return jsonResponse({QueryResponse:{Invoice:record?[record]:[]}});
  posts++;const input=JSON.parse(body),key=url.searchParams.get('requestid');assert.ok(key);
  if(input.sparse){assert.equal(input.Id,record.Id);assert.equal(input.SyncToken,record.SyncToken);record={...record,...input,SyncToken:'1',TotalAmt:19.99};effects++;return jsonResponse({Invoice:record})}
  if(repair){if(!seenKeys.has(key)){record={...input,Id:'synthetic-crank-54',SyncToken:'0',TotalAmt:19.99};seenKeys.set(key,record);effects++}return jsonResponse({Invoice:seenKeys.get(key)})}
  const acknowledgement={...input,Id:'synthetic-crank-54',SyncToken:'0',TotalAmt:19.99};
  if(mode==='wrong'){record={...acknowledgement,CustomerRef:{value:'synthetic-crank-55'}};seenKeys.set(key,record);effects++}
  return jsonResponse({Invoice:acknowledgement});
 });
 const h=await harness(receiver,{edge:fake.edge});let restored;
 try {
  const objective=await outcomeObjective(h,{realm:'1234',customer:facts.customer_id,item:'synthetic-crank-56',receiver:declared});
  for(mode of modeOnly?[modeOnly]:['missing','wrong']) {
   record=null;repair=false;seenKeys.clear();const before=posts,noticeCount=notices.length;
   let run=await objective.start();assert.equal(run.status,'awaiting_approval',JSON.stringify(run.error));
   assert.equal(stepOf(run,'invoice').status,'succeeded');assert.equal(run.waits[0].proposal.outcome_repair,true);
   assert.equal(run.waits[0].proposal.records.length,mode==='missing'?0:1);assert.equal(notices.length,noticeCount);
   await inspect?.({h,run,state:mode+'-open',objective});
   await h.restart();run=await h.get('workflow-runs/'+run.id);assert.equal(run.status,'awaiting_approval');assert.equal(posts,before+1);
   await h.post(`workflow-runs/${run.id}/approve`,{path:'verify_invoice',digest:'synthetic-crank-stale'},h.owner,409);
   const permission=await h.post('tokens',{label:'Outcome preparation',scope:'agent'},h.owner,201);
   await h.post(`workflow-runs/${run.id}/approve`,{path:'verify_invoice',digest:run.waits[0].proposal_digest},'',403,{authorization:'Bearer '+permission.token});
   repair=true;
   const changed=await inspect?.({h,run,state:'approve-'+mode,objective});
   run=changed??await h.post(`workflow-runs/${run.id}/approve`,{path:'verify_invoice',digest:run.waits[0].proposal_digest,reason:'Repair the exact granted invoice and require fresh provider evidence'});
   assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(stepOf(run,'verify_invoice').output.obligation.state,'satisfied');
   assert.equal(stepOf(run,'verify_invoice').output.obligation.verification_source,'provider_readback');assert.equal(record.CustomerRef.value,facts.customer_id);
   assert.equal(posts,before+2);assert.equal(notices.length,noticeCount+1);assert.equal(stepOf(run,'invoice').operation_key,run.id+':invoice');
   const count=posts;await h.post(`workflow-runs/${run.id}/approve`,{path:'verify_invoice',digest:run.waits[0].proposal_digest},h.owner,409);await h.tick();assert.equal(posts,count);assert.equal(notices.length,noticeCount+1);
   await inspect?.({h,run,state:mode+'-satisfied',objective});
  }
  // A deliberate scope violation remains reviewable and never repairs under that grant.
  const denied=await objective.start({verify_invoice:{customer_id:'synthetic-crank-99'}});assert.equal(denied.status,'awaiting_approval');
  const postsBefore=posts;const refused=await h.post(`workflow-runs/${denied.id}/approve`,{path:'verify_invoice',digest:denied.waits[0].proposal_digest});
  assert.equal(refused.status,'paused');assert.equal(posts,postsBefore);assert.equal(stepOf(refused,'notify'),undefined);
  await inspect?.({h,run:refused,state:'outside-grant',objective});
  repair=false;record=null;seenKeys.clear();
  const waiting=await objective.start();assert.equal(waiting.status,'awaiting_approval');await h.post(`grants/${objective.grant.id}/revoke`);const frozen=await h.get('workflow-runs/'+waiting.id);
  const saved=await archive(h);restored=await harness(receiver,{edge:fake.edge});await restored.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const entries=text=>text.trim().split('\n').map(JSON.parse).flatMap(p=>p.items??[]).filter(i=>i.kind==='row'&&['crank_wf_steps','crank_waits','crank_wf_step_revisions'].includes(i.table)).map(i=>JSON.stringify(i)).sort();
  assert.deepEqual(entries(await archive(restored)),entries(saved),'Every reconciliation input, output, proposal and decision survives inactive restoration');
  const imported=await restored.get('workflow-runs/'+frozen.id);assert.equal(imported.status,'paused');const count=posts,noticeCount=notices.length;
  await restored.restart();await restored.tick(Date.now()+86400000);await restored.post(`workflow-runs/${imported.id}/resume`,{},restored.owner,409);
  assert.equal(posts,count);assert.equal(notices.length,noticeCount);assert.ok((await restored.get('connections')).every(c=>c.status==='needs_reconnect'));
  assert.equal((await restored.get('grants')).length,0);assert.ok(!saved.includes(objective.grant.credential));
  await inspect?.({h:restored,run:await restored.get('workflow-runs/'+imported.id),state:'restored-inactive',objective});
  const inventory=await h.get('data/flows');assert.ok(inventory.flows.some(f=>f.kind==='quickbooks.invoice_outcome'&&f.recipients.includes('https://sandbox-quickbooks.api.intuit.com')&&f.region.toLowerCase().includes('provider-controlled')));
  return {types:['quickbooks.invoice_outcome'],effects};
 }finally{await restored?.close();await h.close();server.closeAllConnections();await new Promise(done=>server.close(done))}
}
