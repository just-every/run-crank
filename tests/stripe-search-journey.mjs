import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,publish,startRun,stepOf} from './kit.mjs';
const clock='2026-11-10T15:00:00.000Z';
const identifier=(prefix,n)=>prefix+'_'+('synthetic-crank-'+n).replaceAll('-','');
const customer=identifier('cus',1),otherCustomer=identifier('cus',2);
const testKey=n=>['sk','test',fakeSecret('synthetic-crank-'+n)].join('_');
export function subscription(n,{customer_id=customer,status='active',...extra}={}) {
 return {object:'subscription',id:identifier('sub',n),customer:customer_id,livemode:false,status,created:100+n,cancel_at_period_end:false,
  items:{object:'list',has_more:false,data:[{id:identifier('si',n),quantity:n,price:{object:'price',id:identifier('price',n),product:identifier('prod',n),livemode:false,currency:'usd',unit_amount:1250}}]},...extra};
}
const list=(data,has_more=false)=>({object:'list',url:'/v1/subscriptions',data,has_more});
const search=connection_id=>({id:'subscriptions',name:'Customer subscriptions',type:'stripe.find_subscriptions',connection_id,page_size:2,max_pages:5,multi_match:'all',input:{customer_id:'{{trigger.input.customer_id}}',status:'all'}});

/** Public workflow and Cron doors; only the Stripe network edge is synthetic. */
export async function stripeSearchJourney({inspect}={}) {
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});
 const east=testKey(10),west=testKey(11),readCalls=[];
 let shape='pages',parked=false,changed=false,hook,retries=0,quantity;
 fake.routes.set('api.stripe.com',async request=>{
  const {url,method,headers,body}=request;
  assert.equal(method,'GET','the native operation never writes');assert.equal(body,'');
  assert.equal(url.pathname,'/v1/subscriptions');assert.equal(headers['stripe-version'],'2024-06-20');
  assert.equal(headers['stripe-account'],undefined,'no account impersonation');
  assert.equal(headers['stripe-context'],undefined);
  assert.ok([east,west].some(key=>headers.authorization==='Bearer '+key));
  assert.equal(url.searchParams.get('customer'),customer);assert.ok(['all','active'].includes(url.searchParams.get('status')));
  assert.ok(Number(url.searchParams.get('limit'))<=100);
  assert.deepEqual([...url.searchParams.keys()].sort(),url.searchParams.has('starting_after')?['customer','limit','starting_after','status']:['customer','limit','status']);
  readCalls.push({shape,cursor:url.searchParams.get('starting_after'),auth:headers.authorization});
  if(hook){const once=hook;hook=null;await once()}
  if(shape==='empty')return jsonResponse(list([]));
  if(shape==='tie')return jsonResponse(list([subscription(2,{created:100}),subscription(1,{created:100})]));
  if(shape==='one')return jsonResponse(list([subscription(1)]));
  if(shape==='quantity'){const row=subscription(1);row.items.data[0].quantity=quantity;return jsonResponse(list([row]))}
  if(shape==='wrong customer')return jsonResponse(list([subscription(1,{customer_id:otherCustomer})]));
  if(shape==='live')return jsonResponse(list([subscription(1,{livemode:true})]));
  if(shape==='bad price')return jsonResponse(list([subscription(1,{items:{object:'list',has_more:false,data:[{id:identifier('si',1),quantity:'1',price:{}}]}})]));
  if(shape==='incomplete items')return jsonResponse(list([subscription(1,{items:{object:'list',has_more:true,data:[]}})]));
  if(shape==='wrong status')return jsonResponse(list([subscription(1,{status:'canceled'})]));
  if(shape==='malformed')return jsonResponse({object:'list',has_more:'false',data:[]});
  if(shape==='bad JSON')return new Response('{',{headers:{'content-type':'application'+'/'+'json'}});
  if(shape==='oversize')return new Response('x'.repeat(1024*1024+1));
  if(shape==='retry'&&retries++===0)return jsonResponse({},503);
  if(shape==='live price'){const row=subscription(1);row.items.data[0].price.livemode=true;return jsonResponse(list([row]))}
  if(shape==='500')return jsonResponse({error:{message:'Synthetic failure'}},500);
  if(shape==='403')return jsonResponse({error:{message:'Synthetic permission refusal'}},403);
  if(shape==='cycle')return jsonResponse(list([subscription(1)],true));
  if(shape==='empty cursor')return jsonResponse(list([],true));
  if(shape==='too many')return jsonResponse(list([subscription(1),subscription(2),subscription(3)]));
  if(shape==='park' && url.searchParams.has('starting_after') && !parked){parked=true;return jsonResponse({},429,{'retry-after':'31'})}
  if(headers.authorization==='Bearer '+west)return jsonResponse(list([subscription(9)]));
  if(!url.searchParams.has('starting_after'))return jsonResponse(list(changed?[subscription(8)]:[subscription(1),subscription(2)],true));
  assert.equal(url.searchParams.get('starting_after'),identifier('sub',2));
  return jsonResponse(list([subscription(3)]));
 });
 let restored,erasedRestore;
 try {
  const eastConnection=await connection(h,{app:'stripe',auth_kind:'bearer',label:'Synthetic east test account',secret:{token:east}});
  const westConnection=await connection(h,{app:'stripe',auth_kind:'bearer',label:'Synthetic west test account',secret:{token:west}});
  const after=[{id:'done',type:'respond',input:{body:'{{steps.subscriptions}}'}}];
  const workflow=await publish(h,'Look up customer subscriptions',{trigger:{type:'manual'},steps:[search(eastConnection.id),...after]});
  const run=()=>startRun(h,workflow,{customer_id:customer});
  let good=await run();assert.equal(good.status,'succeeded',JSON.stringify(good.error));
  const output=stepOf(good,'subscriptions').output;
  assert.equal(output.outcome,'found');assert.equal(output.count,3);assert.equal(output.truncated,false);
  assert.deepEqual(output.records.map(row=>row.id),[3,2,1].map(n=>identifier('sub',n)));
  assert.deepEqual(output.records[0],{id:identifier('sub',3),customer_id:customer,status:'active',created:103,cancel_at_period_end:false,items:[{id:identifier('si',3),quantity:3,price:{id:identifier('price',3),product_id:identifier('prod',3),currency:'usd',unit_amount:1250}}]});
  assert.deepEqual(good.response.body,output,'typed stable values reach downstream work');
  if(inspect)await inspect({h,workflow,run:good,state:'subscriptions'});
  const flows=(await h.get('data/flows')).flows.filter(row=>row.kind==='stripe.find_subscriptions');
  assert.ok(flows.length);assert.deepEqual(flows[0].recipients,['https://api.stripe.com']);assert.ok(flows[0].fields.includes('customer_id'));
  assert.match(flows[0].retention,/unverified|provider/i);assert.ok(!JSON.stringify(flows).includes(east));
  const both=await publish(h,'Isolated Stripe accounts',{trigger:{type:'manual'},steps:[search(westConnection.id)]});
  const isolated=await startRun(h,both,{customer_id:customer});assert.equal(isolated.status,'succeeded');assert.equal(stepOf(isolated,'subscriptions').output.record.id,identifier('sub',9));
  const settings=async(name,extra)=>publish(h,name,{trigger:{type:'manual'},steps:[{...search(eastConnection.id),...extra},...after]});
  for(const [name,extra,expected,ids] of [
   ['First by ascending identity',{multi_match:'first',sort:{field:'id',direction:'asc'}},'found',[1]],
   ['Stop at several matches',{multi_match:'stop'},'multiple matches',[]],
   ['Route several matches',{multi_match:'stop',on_multiple:'continue'},'multiple matches',[1,2,3]],
   ['Explicit truncation',{multi_match:'all',limit:2},'truncated',[3,2]],
  ]) {
   const w=await settings(name,extra),r=await startRun(h,w,{customer_id:customer}),s=stepOf(r,'subscriptions');
   assert.equal(s.output.outcome,expected);
   if(name==='Stop at several matches'){assert.equal(r.status,'stopped_by_search');assert.equal(stepOf(r,'done'),undefined)}
   else {assert.equal(r.status,'succeeded',JSON.stringify(r.error));assert.deepEqual(s.output.records.map(row=>row.id).sort(),ids.map(n=>identifier('sub',n)).sort())}
  }
  shape='tie';const tied=await settings('Stable first with equal timestamps',{multi_match:'first'});
  assert.equal(stepOf(await startRun(h,tied,{customer_id:customer}),'subscriptions').output.record.id,identifier('sub',1));
  shape='retry';retries=0;
  const retrying=await settings('Shared safe-read retry',{retry_policy:{read_attempts:2,base_delay_ms:1}}),retried=await startRun(h,retrying,{customer_id:customer});
  assert.equal(retried.status,'succeeded',JSON.stringify(retried.error));assert.equal(retried.attempts[0].http_status,503);assert.equal(retried.attempts[1].retry_number,2);assert.equal(stepOf(retried,'subscriptions').output.count,3);
  shape='empty';const mailBefore=h.mail.length;
  for(const no_match of ['halt','continue']) {
   const w=await settings('Empty search '+no_match,{no_match}),r=await startRun(h,w,{customer_id:customer});
   assert.equal(r.status,no_match==='halt'?'stopped_by_search':'succeeded');assert.equal(stepOf(r,'subscriptions').output.outcome,'not found');
   if(no_match==='continue')assert.deepEqual(stepOf(r,'subscriptions').output.records,[]);else assert.equal(stepOf(r,'done'),undefined);
  }
  assert.equal(h.mail.length,mailBefore,'search halts are not failure notices');
  shape='one';assert.equal(stepOf(await run(),'subscriptions').output.count,1);
  shape='quantity';
  for(quantity of [null,0]) {
   const r=await run();assert.equal(r.status,'succeeded',JSON.stringify(r.error));
   const result=stepOf(r,'subscriptions').output;assert.equal(result.outcome,'found');assert.equal(result.count,1);
   assert.deepEqual(result.record.items,[{id:identifier('si',1),quantity,price:{id:identifier('price',1),product_id:identifier('prod',1),currency:'usd',unit_amount:1250}}]);
   assert.deepEqual(r.response.body,result,'nullable and zero quantities reach downstream work unchanged');
  }
  for(quantity of [undefined,'1',-1,1.5]) {
   const r=await run();assert.equal(r.status,'failed');assert.equal(r.error.category,'provider');
   assert.equal(stepOf(r,'done'),undefined,'malformed quantities cannot reach downstream work');
  }
  shape='pages';
  for(const multi_match of ['all','first','stop']) {
   const w=await settings('Bounded scan '+multi_match,{max_pages:1,multi_match}),r=await startRun(h,w,{customer_id:customer});
   if(multi_match==='all'){assert.equal(r.status,'succeeded');assert.equal(stepOf(r,'subscriptions').output.outcome,'truncated');assert.equal(stepOf(r,'subscriptions').output.count,2)}
   else {assert.equal(r.status,'failed');assert.equal(r.error.outcome,'search incomplete');assert.equal(stepOf(r,'done'),undefined)}
  }
  for(shape of ['wrong customer','live','live price','bad price','incomplete items','malformed','bad JSON','500','403','cycle','empty cursor','too many','oversize']) {
   const r=await run();assert.notEqual(r.status,'succeeded',shape);assert.equal(stepOf(r,'done'),undefined,shape);
   assert.notEqual(stepOf(r,'subscriptions')?.output?.outcome,'not found',shape);
  }
  shape='wrong status';const active=await settings('Active subscriptions only',{input:{customer_id:customer,status:'active'}});
  assert.equal((await startRun(h,active,{})).status,'failed');
  const beforeInvalid=fake.requests.length;
  for(const input of [{customer_id:''},{customer_id:7},{customer_id:'all'},{customer_id:customer,status:'pending'},{customer_id:customer,account:otherCustomer}]) {
   await h.post('workflows',{name:'Invalid filter',graph:{trigger:{type:'manual'},steps:[{...search(eastConnection.id),input}]}},h.owner,422);
  }
  for(const extra of [{create_if_not_found:{}},{max_pages:11},{page_size:101},{max_pages:0},{page_size:1.5},{sort:{field:'items',direction:'asc'}}]) {
   await h.post('workflows',{name:'Invalid settings',graph:{trigger:{type:'manual'},steps:[{...search(eastConnection.id),...extra}]}},h.owner,422);
  }
  assert.equal((await runWithEmpty()).error.category,'validation');
  assert.equal(fake.requests.length,beforeInvalid,'invalid keys and settings never dispatch');
  async function runWithEmpty(){return startRun(h,workflow,{customer_id:''})}
  shape='one';
  for(const token of [fakeSecret('synthetic-crank-12'),['sk','live',fakeSecret('synthetic-crank-13')].join('_')]) {
   const c=await connection(h,{app:'stripe',auth_kind:'bearer',label:'Restricted credential',secret:{token}}),w=await settings('Refuse non-test credential',{connection_id:c.id});
   const before=fake.requests.length,r=await startRun(h,w,{customer_id:customer});assert.notEqual(r.status,'succeeded');assert.equal(fake.requests.length,before);
  }
  const wrongApp=await connection(h,{app:'http',auth_kind:'bearer',domains:['api.stripe.com'],label:'Generic credential',secret:{token:east}});
  const wrongFlow=await settings('Require native Stripe connection',{connection_id:wrongApp.id}),beforeWrong=fake.requests.length;
  assert.notEqual((await startRun(h,wrongFlow,{customer_id:customer})).status,'succeeded');assert.equal(fake.requests.length,beforeWrong);

  // A completed page survives a parked 429 and a Worker restart, even if the provider's first page changes.
  shape='park';parked=false;const pending=await run();assert.equal(pending.status,'waiting',JSON.stringify(pending.error));
  const operation=stepOf(pending,'subscriptions').operation_key,callsBefore=readCalls.length;
  await h.restart();await h.tick(clock);assert.equal(readCalls.length,callsBefore,'restart cannot retry before the provider or shared delay');
  const capture=await archive(h);assert.ok(!capture.includes(east)&&!capture.includes(west));
  restored=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});await restored.post('data/restore',{archive:capture,confirm:'RESTORE'});
  const sourceRows=inventory(capture),received=inventory(await archive(restored)),sourceSet=new Set(sourceRows),additions=received.filter(row=>!sourceSet.has(row));
  assert.equal(additions.length,1);assert.equal(JSON.parse(additions[0]).row.action,'data.restore');
  assert.deepEqual(received.filter(row=>!additions.includes(row)),sourceRows,'every portable record survives inactive restoration');
  assert.ok((await restored.get('connections')).every(c=>c.status!=='active'));
  const beforeRestore=fake.requests.length;await restored.restart({clock:'2026-11-10T15:02:00Z'});await restored.tick('2026-11-10T15:02:00Z');assert.equal(fake.requests.length,beforeRestore);
  changed=true;await h.restart({clock:'2026-11-10T15:02:00Z'});await h.tick('2026-11-10T15:02:00Z');
  good=await h.get('workflow-runs/'+pending.id);assert.equal(good.status,'succeeded',JSON.stringify({error:good.error,steps:good.steps,attempts:good.attempts}));
  assert.equal(stepOf(good,'subscriptions').operation_key,operation);assert.equal(readCalls.length,callsBefore+1);
  assert.deepEqual(stepOf(good,'subscriptions').output.records.map(row=>row.id),[3,2,1].map(n=>identifier('sub',n)));
  assert.equal(readCalls.at(-1).cursor,identifier('sub',2),'completed first page is not re-fetched');
  changed=false;
  // A replacement credential never mixes another account's data into retained pages.
  shape='pages';hook=()=>h.post('connections/'+eastConnection.id+'/rotate',{secret:{token:west}});
  const rotating=await run();assert.equal(rotating.status,'paused');assert.match(rotating.error.message,/credential changed/);
  const rotationCalls=fake.requests.length;
  await h.post('workflow-runs/'+rotating.id+'/resume');assert.equal(fake.requests.length,rotationCalls,'retained pages refuse replacement credential even after explicit resume');
  await h.post('connections/'+eastConnection.id+'/rotate',{secret:{token:east}});
  // A revoked account cannot release any next page or downstream result.
  shape='pages';hook=()=>h.post('connections/'+westConnection.id+'/revoke');
  const revoked=await startRun(h,both,{customer_id:customer});assert.notEqual(revoked.status,'succeeded');
  const beforeRevoke=fake.requests.length;await startRun(h,both,{customer_id:customer});assert.equal(fake.requests.length,beforeRevoke);
  assert.ok(fake.requests.every(r=>r.method==='GET'),'zero provider writes across every branch');
 } finally {await erasedRestore?.close();await restored?.close();await h.close()}
}

/** Sensitive pages and results follow the shared DATA custody doors. */
export async function stripeCustodyJourney() {
 const fake=fakeEdge();let park=true;
 fake.routes.set('api.stripe.com',({url})=>url.searchParams.has('starting_after')&&park?jsonResponse({},429,{'retry-after':'31'}):jsonResponse(list([subscription(url.searchParams.has('starting_after')?2:1)],!url.searchParams.has('starting_after'))));
 const h=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});let restored,stale;
 try {
  const key=testKey(21),c=await connection(h,{app:'stripe',auth_kind:'bearer',label:'Sensitive test account',secret:{token:key}});
  const workflow=await publish(h,'Sealed subscription lookup',{trigger:{type:'manual'},steps:[search(c.id)]});
  await h.post(`workflows/${workflow.id}/pause`);
  await h.post('data/classes',{workflow_id:workflow.id,data_class:'financial',identifier_fields:['customer_id','customer','id']});
  await h.post('data/attestations',{data_class:'financial',agreements:['Synthetic agreement'],data_location:'Synthetic local fixture',confirm:'ATTEST'},h.owner,201);
  await h.post(`workflows/${workflow.id}/resume`);
  const pending=await startRun(h,workflow,{customer_id:customer});assert.equal(pending.status,'waiting');
  const chunks=await h.db.prepare('SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(pending.id).all();
  assert.ok(chunks.results.length);assert.ok(chunks.results.every(row=>JSON.parse(row.content_base64).sealed==='crank-payload-v1'));
  const raw=JSON.stringify(chunks);assert.ok(!raw.includes(customer));assert.ok(!raw.includes(Buffer.from(customer).toString('base64')));
  let preview=await h.post('data/subject',{subject:identifier('sub',1)});assert.deepEqual(preview.workflow_runs.map(r=>r.id),[pending.id]);assert.ok(preview.blocked,'unfinished page-only subjects are indexed');
  const hold=await h.post('data/holds',{kind:'subject',subject:identifier('sub',1),reason:'Synthetic dispute'},h.owner,201);
  const heldArchive=await archive(h);assert.ok(!heldArchive.includes(key));
  restored=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});await restored.post('data/restore',{archive:heldArchive,confirm:'RESTORE'});
  const rows=inventory(heldArchive),restoredRows=inventory(await archive(restored)),known=new Set(rows),additions=restoredRows.filter(row=>!known.has(row));
  assert.equal(additions.length,1);assert.equal(JSON.parse(additions[0]).row.action,'data.restore');assert.deepEqual(restoredRows.filter(row=>!additions.includes(row)),rows);
  assert.match((await restored.post('data/subject',{subject:customer})).sealed_unmatched.join(' '),/key file/);
  const calls=fake.requests.length;await restored.restart();await restored.tick('2026-11-10T15:02:00Z');assert.equal(fake.requests.length,calls,'sealed restore never grants execution');
  park=false;await h.restart({clock:'2026-11-10T15:02:00Z'});await h.tick('2026-11-10T15:02:00Z');
  let done=await h.get('workflow-runs/'+pending.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(stepOf(done,'subscriptions').output.count,2);
  const sealed=await h.db.prepare('SELECT output_json FROM crank_wf_steps WHERE run_id=?').bind(done.id).first();assert.equal(JSON.parse(sealed.output_json).sealed,'crank-payload-v1');
  // Rotation must preserve both unfinished-page indexing and complete result readability.
  await h.post('data/keys/rotate',{data_class:'financial',confirm:'ROTATE'});await h.tick('2026-11-10T15:02:00Z');
  done=await h.get('workflow-runs/'+pending.id);assert.equal(stepOf(done,'subscriptions').output.count,2);
  preview=await h.post('data/subject',{subject:identifier('sub',1)});assert.deepEqual(preview.workflow_runs.map(r=>r.id),[done.id]);assert.match(preview.workflow_runs[0].blocked,/legal hold/);
  await h.post(`workflows/${workflow.id}/pause`);await h.post('data/erase',{workflow_run_id:done.id,confirm:'ERASE'},h.owner,409);
  await h.post(`data/holds/${hold.id}/release`);
  const beforeErasure=await archive(h);preview=await h.post('data/subject',{subject:identifier('sub',1)});assert.equal(preview.blocked,false);
  await h.post('data/erase',{subject:identifier('sub',1),digest:preview.digest,confirm:'ERASE'});await h.get('workflow-runs/'+done.id,h.owner,404);
  for(const table of ['crank_request_checkpoint_chunks','crank_request_checkpoints','crank_blind_index'])assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE run_id=?').bind(done.id).first()).n,0);
  const journal=await archive(h);stale=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});await stale.post('data/restore',{archive:beforeErasure,journal,confirm:'RESTORE'},stale.owner,409);
  assert.deepEqual(await stale.get('workflows'),[],'erasure journal fences an older capture');
  await h.post(`workflows/${workflow.id}/resume`);const expiring=await startRun(h,workflow,{customer_id:customer});assert.equal(expiring.status,'succeeded');
  const policy={payload_days:1,attachment_days:null,history_days:30},retention=await h.post('data/retention/preview',policy);
  await h.post('data/retention',{...policy,digest:retention.digest});await h.tick('2026-11-12T15:02:00Z');
  assert.equal(stepOf(await h.get('workflow-runs/'+expiring.id),'subscriptions').output,null);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(expiring.id).first()).n,0,'retention drops sealed pages with the expired result');
  assert.match((await h.get('workflow-runs/'+expiring.id+'/replay')).blocked_reason,/expired/);
 } finally {await stale?.close();await restored?.close();await h.close()}
}
export async function stripeOwnership(h,fake) {
 fake.routes.set('api.stripe.com',()=>jsonResponse(list([subscription(1)])));
 const c=await connection(h,{app:'stripe',auth_kind:'bearer',label:'Owned test-mode Stripe',secret:{token:testKey(30)}});
 const workflow=await publish(h,'Owned subscription lookup',{trigger:{type:'manual'},steps:[search(c.id)]});
 const run=await startRun(h,workflow,{customer_id:customer});assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(stepOf(run,'subscriptions').output.record.customer_id,customer);
 return ['stripe.find_subscriptions'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await stripeSearchJourney();await stripeCustodyJourney();console.log('Stripe subscription search, restart and sealed custody PASS')}
