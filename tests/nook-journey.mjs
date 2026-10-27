import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf,until} from './kit.mjs';

/** The real Worker and native owner doors; only Nook's documented token API is faked. */
export async function nookJourney({inspect}={}) {
 const fake=fakeEdge(),messages=new Map(),calls=[];let mode='ok',token='synthetic-crank-101',afterWrite;
 const families=new Map([[token,'synthetic-crank-family-1']]);
 const origin='https://nook.synthetic-crank.example',conversation='synthetic-crank-102';
 fake.routes.set(new URL(origin).host,async request=>{
  calls.push(request);
  assert.equal(request.method,'POST');assert.equal(request.url.pathname,`/api/conversations/${conversation}/messages`);
  assert.equal(request.headers.authorization,'Bearer '+token);
  const body=JSON.parse(request.body),key=request.headers['idempotency-key'];assert.match(key,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(body),['body']);
  if(mode==='refused-401')return jsonResponse({error:'synthetic-crank-provider-expired'},401);
  if(mode==='refused')return jsonResponse({error:'synthetic-crank-provider-refusal'},403);
  if(mode==='parked-once'){mode='ok';return jsonResponse({error:'synthetic-crank-quota'},429,{'retry-after':'31'})}
  if(mode==='limited')return jsonResponse({error:'synthetic-crank-quota'},429,{'retry-after':'1'});
  const familyKey=families.get(token)+':'+key;assert.ok(families.has(token));
  const message=messages.get(familyKey)??{id:'synthetic-crank-'+(messages.size+200),conversation,body:body.body};
  assert.equal(message.body,body.body);messages.set(familyKey,message);
  if(afterWrite){const hook=afterWrite;afterWrite=null;await hook()}
  if(mode==='lost-once'){mode='ok';await new Promise(resolve=>setTimeout(resolve,350))}
  if(mode==='malformed')return jsonResponse({id:message.id,body:'synthetic-crank-wrong-body'});
  return jsonResponse(message);
 });
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});let restored,releaseAdmission;const admittedRuns=[];
 try {
  const input={app:'nook',label:'Synthetic Nook operations',auth_kind:'bearer',scopes:['messages:write'],binding:{origin,conversation_id:conversation},secret:{token}};
  await h.post('connections',{...input,binding:{origin:'http://127.0.0.1',conversation_id:conversation}},h.owner,422);
  const account=await connection(h,input);assert.deepEqual(account.binding,input.binding);
  await h.post(`connections/${account.id}/rotate`,{secret:{token},binding:{origin,conversation_id:'synthetic-crank-foreign'}},h.owner,400);assert.deepEqual(account.domains,[new URL(origin).hostname]);
  assert.equal((await h.send('/api/crank/connections',{...input})).status,401);
  const agent=await h.post('tokens',{label:'Synthetic preparation',scope:'agent'},h.owner,201);
  await h.post('connections',input,'',403,{authorization:'Bearer '+agent.token});
  await h.post(`connections/${account.id}/test`,{url:origin+'/other'},h.owner,400);assert.equal(calls.length,0,'connection test cannot use a post-only token as a general credential');
  const graph={trigger:{type:'manual'},settings:{max_concurrency:8},steps:[{id:'post',type:'nook.send_message',connection_id:account.id,input:{body:'{{trigger.input.body}}'}}]};
  const workflow=await publish(h,'Nook authorized operations message',graph);
  const catalog=await h.get('catalog');assert.ok(JSON.stringify(catalog).includes('nook.send_message'));
  const done=await startRun(h,workflow,{body:'synthetic-crank-103 <script>inert</script>'});
  assert.equal(done.status,'succeeded',JSON.stringify(done.error));
  assert.deepEqual(stepOf(done,'post').output,{id:'synthetic-crank-200',conversation_id:conversation,body:'synthetic-crank-103 <script>inert</script>',origin,acknowledgement:'provider_response',independently_read_back:false});
  assert.equal(messages.size,1);assert.equal(calls.length,1);
  const inventory=await h.get('data'+'/flows'),disclosure=inventory.flows.find(f=>f.kind==='nook.send_message');
  assert.deepEqual(disclosure.recipients,[origin]);assert.deepEqual(disclosure.fields,['body']);
  for(const field of ['credentials','purpose','region','retention'])assert.ok(disclosure[field]);
  assert.match(disclosure.region,/not verified/);assert.ok(!JSON.stringify(inventory).includes(token));
  if(inspect)await inspect({h,account,workflow,run:done,state:'acknowledged'});
  const unsafe=await publish(h,'Nook foreign destination refused',{trigger:{type:'manual'},steps:[{...graph.steps[0],input:{body:'synthetic-crank-104',conversation_id:'synthetic-crank-foreign'}}]});
  const rejected=await startRun(h,unsafe,{});assert.equal(rejected.error.category,'validation');assert.equal(calls.length,1);
  for(const url of [origin+'/api/conversations/synthetic-crank-foreign/messages','https://foreign.'+new URL(origin).host+`/api/conversations/${conversation}/messages`,origin+`/api/conversations/${conversation}/messages?tenant=foreign`]) {
   const w=await publish(h,'Nook exact credential destination',{trigger:{type:'manual'},steps:[{id:'leak',type:'http',connection_id:account.id,input:{method:'POST',url,body:{body:'synthetic-crank-105'}}}]});
   assert.equal((await startRun(h,w,{})).error.category,'egress');
  }
  assert.equal(calls.length,1);assert.equal(fake.requests.length,1,'no foreign request even through generic HTTP');
  // Same-operation retry recovers the original provider receipt, with exactly one stored message.
  const retryWorkflow=await publish(h,'Nook same-operation retry',{...graph,steps:[{id:'prepared',type:'map',input:{body:'{{trigger.input.body}}'}},{...graph.steps[0],timeout_ms:100}]});
  mode='lost-once';const recovered=await startRun(h,retryWorkflow,{body:'synthetic-crank-106'});
  assert.equal(recovered.status,'succeeded',JSON.stringify(recovered.error));assert.equal(messages.size,2);assert.equal(calls.length,3);
  assert.equal(calls[1].headers['idempotency-key'],calls[2].headers['idempotency-key']);
  assert.equal(stepOf(recovered,'post').output.id,'synthetic-crank-201');
  await h.restart();assert.equal(stepOf(await h.get('workflow-runs/'+recovered.id),'post').output.id,'synthetic-crank-201');assert.equal(calls.length,3);
  mode='malformed';const uncertain=await startRun(h,workflow,{body:'synthetic-crank-107'});
  assert.equal(uncertain.status,'uncertain');assert.equal(calls.length,4);assert.equal(messages.size,3);
  const preview=await h.get(`workflow-runs/${uncertain.id}/replay`);assert.deepEqual(preview.eligible,[]);
  mode='refused';const refused=await startRun(h,workflow,{body:'synthetic-crank-108'});assert.equal(refused.status,'paused');assert.equal(messages.size,3);
  mode='limited';const limited=await startRun(h,workflow,{body:'synthetic-crank-109'});assert.equal(limited.error.category,'rate_limit');assert.equal(messages.size,3);assert.equal(calls.length,7);
  mode='parked-once';const parked=await startRun(h,workflow,{body:'synthetic-crank-parked'});
  assert.equal(parked.status,'waiting');assert.equal(calls.length,8);assert.ok(parked.attempts[0].retry_parked_at);
  const due=Date.parse(parked.attempts[0].retry_at);await h.restart();await h.tick();assert.equal(calls.length,8,'restart does not send before Retry-After');
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,due-Date.now())+100));await h.tick();
  const resumed=await h.get('workflow-runs/'+parked.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.error));assert.equal(calls.length,9);assert.equal(messages.size,4);
  assert.equal(stepOf(resumed,'post').operation_key,stepOf(parked,'post').operation_key);assert.equal(calls[7].headers['idempotency-key'],calls[8].headers['idempotency-key']);
  assert.equal(resumed.attempts[0].budget_started_at,resumed.attempts[1].budget_started_at);
  // Admission is occupied through the public work flow; a current-scope loss must fence the queued request.
  mode='ok';let release;const gate=new Promise(resolve=>{release=resolve;releaseAdmission=resolve});const old=fake.routes.get(new URL(origin).host);
  let holding=0;fake.routes.set(new URL(origin).host,async request=>{const response=await old(request);if(++holding<=4)await gate;return response});
  const held=Array.from({length:4},(_,n)=>startRun(h,workflow,{body:'synthetic-crank-held-'+n}));admittedRuns.push(...held);
  await until(()=>holding===4,'four Nook requests occupy admission');
  const pending=startRun(h,workflow,{body:'synthetic-crank-waiting'});admittedRuns.push(pending);
  await until(async()=>{const all=(await h.get('workflow-runs?workflow='+workflow.id)).runs;return all.filter(r=>r.status==='running').length===5},'fifth Nook request waits');
  token='synthetic-crank-110';families.set(token,'synthetic-crank-family-1');await h.post(`connections/${account.id}/rotate`,{secret:{token},scopes:[]});
  release();await Promise.all(held);const stopped=await pending;assert.equal(stopped.status,'paused');assert.equal(holding,4,'scope loss during admission refuses physical dispatch');
  fake.routes.set(new URL(origin).host,old);
  await h.post(`connections/${account.id}/rotate`,{secret:{token},scopes:['messages:write']});
  // A definite refusal can recover after owner reconnect and a process restart.
  mode='ok';token='synthetic-crank-112';families.set(token,'synthetic-crank-family-1');
  await h.post(`connections/${account.id}/rotate`,{secret:{token}});await h.restart();
  let before=calls.length,count=messages.size;
  const reconnected=await h.post(`workflow-runs/${refused.id}/resume`);
  assert.equal(reconnected.status,'succeeded',JSON.stringify(reconnected.error));
  assert.equal(calls.length,before+1);assert.equal(messages.size,count+1);
  assert.equal(stepOf(reconnected,'post').operation_key,stepOf(refused,'post').operation_key);
  if(inspect)await inspect({h,account,workflow,run:reconnected,state:'reconnected'});
  await h.post(`workflow-runs/${reconnected.id}/resume`,{},h.owner,409);assert.equal(calls.length,before+1,'completed success is never resent');
  mode='refused-401';const expired=await startRun(h,workflow,{body:'synthetic-crank-expired'});
  assert.equal(expired.status,'paused');before=calls.length;count=messages.size;
  token='synthetic-crank-117';families.set(token,'synthetic-crank-family-1');
  await h.post(`connections/${account.id}/rotate`,{secret:{token}});mode='ok';
  const renewed=await h.post(`workflow-runs/${expired.id}/resume`);
  assert.equal(renewed.status,'succeeded');assert.equal(calls.length,before+1);assert.equal(messages.size,count+1);
  // Resealing the same credential retains its known family and may safely retry.
  before=calls.length;count=messages.size;mode='lost-once';
  afterWrite=()=>h.post(`connections/${account.id}/rotate`,{secret:{token}});
  const resealed=await startRun(h,retryWorkflow,{body:'synthetic-crank-113'});
  assert.equal(resealed.status,'succeeded',JSON.stringify(resealed.error));
  assert.equal(calls.length,before+2);assert.equal(messages.size,count+1);
  assert.equal(calls[before].headers['idempotency-key'],calls[before+1].headers['idempotency-key']);
  // Changed bearer continuity cannot be verified by the post-only provider API.
  // Both a genuine family-preserving rotation and a different family stay safe.
  for(const [replacement,family] of [['synthetic-crank-115','synthetic-crank-family-2'],['synthetic-crank-114','synthetic-crank-family-1']]) {
   before=calls.length;count=messages.size;mode='lost-once';
   afterWrite=async()=>{token=replacement;families.set(token,family);await h.post(`connections/${account.id}/rotate`,{secret:{token}})};
   const fenced=await startRun(h,retryWorkflow,{body:'synthetic-crank-rotation-'+family});
   assert.equal(messages.size,count+1,'one provider message across a changed token family');
   assert.equal(fenced.status,'uncertain',JSON.stringify(fenced.error));
   assert.match(fenced.error.message,/earlier credential/);
   assert.equal(calls.length,before+1,'replacement cannot retry a possibly accepted write');
   assert.equal(stepOf(fenced,'prepared').status,'succeeded');
   assert.deepEqual(stepOf(fenced,'prepared').output,{body:'synthetic-crank-rotation-'+family});
   const identity=stepOf(fenced,'post').operation_key;await h.restart();
   assert.equal(stepOf(await h.get('workflow-runs/'+fenced.id),'post').operation_key,identity);
   assert.deepEqual((await h.get(`workflow-runs/${fenced.id}/replay`)).eligible,[]);
   await h.post(`workflow-runs/${fenced.id}/resume`,{},h.owner,409);
   assert.equal(calls.length,before+1);
   if(inspect && family==='synthetic-crank-family-2')await inspect({h,account,workflow,run:fenced,state:'replacement-uncertain'});
  }
  mode='ok';before=calls.length;count=messages.size;
  const fresh=await startRun(h,workflow,{body:'synthetic-crank-116'});
  assert.equal(fresh.status,'succeeded');assert.equal(calls.length,before+1);assert.equal(messages.size,count+1);
  const beforeRevoke=calls.length;await h.post(`connections/${account.id}/revoke`);
  const revoked=await startRun(h,workflow,{body:'synthetic-crank-111'});assert.equal(revoked.status,'paused');assert.equal(calls.length,beforeRevoke);
  if(inspect)await inspect({h,account,workflow,run:revoked,state:'revoked'});
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
  for(const secret of [token,input.secret.token,agent.token])assert.ok(!archive.text.includes(secret));
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge});await restored.post('data'+'/restore',{archive:archive.text,confirm:'RESTORE'});
  const received=(await restored.get('connections')).connections??await restored.get('connections');
  const restoredAccount=received.find(c=>c.id===account.id);assert.deepEqual(restoredAccount.binding,input.binding);assert.equal(restoredAccount.status,'revoked');
  assert.equal((await restored.get('workflows/'+workflow.id)).status,'paused');assert.equal(calls.length,beforeRevoke);
  await h.post(`workflows/${workflow.id}/pause`);
  const subject='synthetic-crank-103 <script>inert</script>',erase=await h.post('data'+'/subject',{subject});assert.ok(erase.workflow_runs.some(r=>r.id===done.id));
  await h.post('data'+'/erase',{subject,confirm:'ERASE',digest:erase.digest});await h.get('workflow-runs/'+done.id,h.owner,404);
  assert.equal(calls.length,beforeRevoke,'local erasure leaves the provider message untouched');
 } finally {releaseAdmission?.();await Promise.allSettled(admittedRuns);await restored?.close();await h.close()}
}
