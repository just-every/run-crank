import assert from 'node:assert/strict';

const errorCode=answer=>answer.result?._meta?.['com.runeditrun/error']?.code??answer.error?.data?.code;
const content=answer=>{assert.ok(!answer.error,JSON.stringify(answer));assert.ok(!answer.result?.isError,JSON.stringify(answer));return answer.result.structuredContent};
const graph={trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{supplier:'synthetic-crank-1'}}]};

/** Real native person, MCP and legacy preparation doors; no direct SQL. */
export default async function narrowingJourney({request,origin,cookie,restart,restore,commitBarrier,configurePolicy=false}) {
 const person=async(path,body,method=body===undefined?'GET':'POST')=>{
  const response=await request(origin+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,value}));return value;
 };
 const policy=async held=>person('/agents/api/policy',{document:{schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:held?[{id:'held',class:'access',do:'approval',approver:['sponsor'],wait:'PT1H'},{id:'rest',class:'*',do:'autonomous'}]:[{id:'all',class:'*',do:'autonomous'}],spend:{none:true}}},'PUT');
 if(configurePolicy)await policy(false);
 const mint=async scopes=>person('/api/crank/tokens',{label:'Scope removal acceptance',scope:'agent',...(scopes?{tool_scopes:scopes}:{})});
 const rpc=(token)=>async(name,args={})=>{
  const response=await request(origin+'/mcp',{method:'POST',headers:{origin,authorization:'Bearer '+token,accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{url:{}}}}}})});
  return response.json();
 };
 const grant=async token=>person('/api/crank/agent-access/'+encodeURIComponent(token.agent_access.agent_id));
 const approve=async answer=>{
  const handle=answer.result?._meta?.['com.runeditrun/approval'];assert.ok(handle?.id,JSON.stringify(answer));
  const path='/agents/api/approvals/'+encodeURIComponent(handle.id),view=(await person(path)).approval;
  await person(path+'/approve',{revision:view.revision,summary_sha256:view.summary_sha256});
 };
 const finish=async(call,name,args)=>{
  let answer=await call(name,args);
  if(answer.result?.resultType==='input_required') {await approve(answer);answer=await call(name,args)}
  return content(answer);
 };
 const old=await mint(),oldCall=rpc(old.token),original=old.agent_access.scopes;
 assert.ok(!original.includes('agents:narrow'),'Existing default permission sets must not gain access-family authority');
 assert.equal(errorCode(await oldCall('crank.agents.narrow',{scopes:[],revision:0,idempotency_key:crypto.randomUUID()})),'insufficient_scope');
 const full=[...original,'agents:narrow'];
 const forbiddenUpgrade=await request(origin+'/api/crank/agent-access',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({agent_id:old.agent_access.agent_id,scopes:full})});
 assert.equal(forbiddenUpgrade.status,400);await forbiddenUpgrade.body?.cancel();assert.deepEqual((await grant(old)).scopes,original,'The owner must issue a fresh credential for the new permission');
 const issued=await mint(full),call=rpc(issued.token),foreign=await mint(full);
 const created=await finish(call,'crank.workflows.create',{name:'Scope removal supported draft',graph,idempotency_key:crypto.randomUUID()});
 assert.ok(created.id);
 const before=await grant(issued),foreignBefore=await grant(foreign),policyBefore=await person('/agents/api/state'),peopleBefore=await person('/auth/operators');
 const escalation=await call('crank.agents.narrow',{scopes:[...full,'workflows:publish'],revision:before.revision,agent_id:foreign.agent_access.agent_id,direction:'narrows',idempotency_key:crypto.randomUUID()});
 assert.equal(errorCode(escalation),'self_escalation');assert.deepEqual(await grant(issued),before);assert.deepEqual(await grant(foreign),foreignBefore);
 const retained=full.filter(scope=>scope!=='workflows:prepare');
 const args={scopes:retained,revision:before.revision,agent_id:foreign.agent_access.agent_id,sponsor_id:'synthetic-crank-foreign',direction:'widens',role:'owner',policy:{rules:[]},paused:false,idempotency_key:crypto.randomUUID()};
 const narrowed=await finish(call,'crank.agents.narrow',args);
 assert.equal(narrowed.agent_id,issued.agent_access.agent_id);assert.deepEqual(new Set(narrowed.scopes),new Set(retained));assert.equal(narrowed.revision,before.revision+1);
 assert.deepEqual(await grant(foreign),foreignBefore,'Forged targets cannot modify another agent');
 assert.deepEqual(await person('/agents/api/state'),policyBefore,'Forged policy and Pause arguments change no company control');
 assert.deepEqual(await person('/auth/operators'),peopleBefore,'Forged role and sponsor arguments change no person');
 const audit=await person('/agents/api/audit');
 const own=audit.rows.findLast(row=>row.tool==='crank.agents.narrow'&&row.agent.id===issued.agent_access.agent_id&&row.outcome==='done');
 assert.ok(own);assert.deepEqual(own.classes.map(item=>({class:item.class,direction:item.facts.direction})),[{class:'access',direction:'narrows'}]);
 const witness=await person('/api/crank/workflows');
 const denied=()=>call('crank.workflows.create',{name:'Removed preparation must never commit',graph,idempotency_key:crypto.randomUUID()});
 assert.equal(errorCode(await denied()),'insufficient_scope');
 assert.equal(content(await call('crank.workflows.get',{workflow_id:created.id})).id,created.id);
 const raw=await request(origin+'/api/crank/workflows',{method:'POST',headers:{origin,authorization:'Bearer '+issued.token,'content-type':'application/json'},body:JSON.stringify({name:'Legacy bypass refused',graph})});
 assert.equal(raw.status,403);await raw.body?.cancel();assert.deepEqual(await person('/api/crank/workflows'),witness);
 assert.deepEqual(content(await call('crank.agents.narrow',args)),narrowed,'A completed retry keeps its first outcome without a second reduction');
 const stale=await call('crank.agents.narrow',{scopes:[],revision:before.revision,idempotency_key:crypto.randomUUID()});
 assert.equal(errorCode(stale),'revision_conflict');
 assert.equal(errorCode(await call('crank.agents.narrow',{scopes:full,revision:narrowed.revision,direction:'narrows',idempotency_key:crypto.randomUUID()})),'self_escalation');
 if(restart){await restart();assert.equal(errorCode(await denied()),'insufficient_scope');assert.equal(content(await call('crank.workflows.get',{workflow_id:created.id})).id,created.id)}

 // Two owner controls at the same revision cannot accidentally restore a scope
 // removed by the other transaction. A native owner shares the exact same action.
 const concurrent=await mint(full),current=await grant(concurrent),path='/api/crank/agent-access/'+encodeURIComponent(concurrent.agent_access.agent_id);
 const attempts=await Promise.all([full.filter(scope=>scope!=='workflows:prepare'),full.filter(scope=>scope!=='catalog:read')].map(scopes=>request(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({scopes,revision:current.revision})})));
 assert.deepEqual(attempts.map(response=>response.status).sort(),[200,409]);
 for(const response of attempts)await response.body?.cancel();
 const after=await grant(concurrent);assert.equal(after.revision,current.revision+1);assert.equal(after.scopes.length,full.length-1);
 const regrant=await request(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({scopes:full,revision:after.revision})});assert.equal(regrant.status,403);await regrant.body?.cancel();assert.deepEqual(await grant(concurrent),after);

 if(commitBarrier){
  const late=await mint(full),lateBefore=await person('/api/crank/workflows'),barrier=commitBarrier();
  const writing=request(origin+'/api/crank/workflows',{method:'POST',headers:{origin,authorization:'Bearer '+late.token,'content-type':'application/json'},body:JSON.stringify({name:'In-flight removed preparation',graph})});
  let timeout;
  try {
   await Promise.race([barrier.arrival,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Native mutation never reached the commit boundary')),10000)})]);
   await person('/api/crank/agent-access/'+encodeURIComponent(late.agent_access.agent_id),{scopes:retained,revision:0});
  } finally {clearTimeout(timeout);barrier.release()}
  const stopped=await writing;assert.equal(stopped.status,403);await stopped.body?.cancel();assert.deepEqual(await person('/api/crank/workflows'),lateBefore,'A prior admission cannot commit after its scope is removed');
 }
 if(configurePolicy){
  await policy(true);
  const held=await mint(full),heldCall=rpc(held.token),heldArgs={scopes:retained,revision:0,idempotency_key:crypto.randomUUID()};
  const pending=await heldCall('crank.agents.narrow',heldArgs);assert.equal(pending.result?.resultType,'input_required',JSON.stringify(pending));assert.equal((await grant(held)).revision,0);
  const handle=pending.result._meta['com.runeditrun/approval'];
  const forged=await request(origin+'/agents/api/approvals/'+handle.id+'/approve',{method:'POST',headers:{origin,authorization:'Bearer '+held.token,'content-type':'application/json'},body:JSON.stringify({revision:0})});
  assert.equal(forged.status,403);await forged.body?.cancel();assert.equal((await grant(held)).revision,0);
  await approve(pending);assert.deepEqual(new Set(content(await heldCall('crank.agents.narrow',heldArgs)).scopes),new Set(retained));
  assert.equal(errorCode(await heldCall('crank.workflows.create',{name:'Held scope was consumed',graph,idempotency_key:crypto.randomUUID()})),'insufficient_scope');
  // A person can withdraw authority while an approval is pending; approving
  // that saved action must not restore any scope or execute under the old grant.
  const withdrawn=await mint(full),withdrawnCall=rpc(withdrawn.token),withdrawnArgs={scopes:retained,revision:0,idempotency_key:crypto.randomUUID()};
  const waiting=await withdrawnCall('crank.agents.narrow',withdrawnArgs);assert.equal(waiting.result?.resultType,'input_required');
  const removed=await person('/api/crank/agent-access/'+encodeURIComponent(withdrawn.agent_access.agent_id),{scopes:['workflows:read'],revision:0});
  await approve(waiting);assert.deepEqual(await grant(withdrawn),removed,'A pending approval cannot restore withdrawn scopes');
  assert.equal(errorCode(await withdrawnCall('crank.agents.narrow',withdrawnArgs)),'insufficient_scope');
  const revoked=await mint(full),revokedCall=rpc(revoked.token),revokedArgs={scopes:retained,revision:0,idempotency_key:crypto.randomUUID()};
  const revokedPending=await revokedCall('crank.agents.narrow',revokedArgs);assert.equal(revokedPending.result?.resultType,'input_required');
  const revocationWitness=await grant(revoked);await person('/api/crank/tokens/'+revoked.id+'/revoke',{});await approve(revokedPending);
  assert.deepEqual(await grant(revoked),revocationWitness,'A revoked credential cannot execute its pending removal');
  assert.ok((await revokedCall('crank.workflows.get',{workflow_id:created.id})).error,'A revoked credential cannot read retained metadata');
  await policy(false);
 }
 const empty=await mint(full),emptyCall=rpc(empty.token);
 const emptied=await finish(emptyCall,'crank.agents.narrow',{scopes:[],revision:0,idempotency_key:crypto.randomUUID()});
 assert.deepEqual(emptied.scopes,[]);assert.equal(errorCode(await emptyCall('crank.workflows.get',{workflow_id:created.id})),'insufficient_scope');
 if(restore){
  const exported=await request(origin+'/api/crank/data/export',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'});assert.ok(exported.ok);const archive=await exported.text();
  const rows=archive.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).filter(item=>item.kind==='row');
  const saved=rows.find(item=>item.table==='crank_agent_scope_grants'&&item.row.agent_id===issued.agent_access.agent_id);
  assert.ok(saved);assert.equal(saved.row.active,0);assert.deepEqual(JSON.parse(saved.row.scopes),narrowed.scopes);assert.equal(saved.row.revision,narrowed.revision);
  assert.ok(!rows.some(item=>item.table==='crank_tokens'));
  await restore({archive,token:issued.token,grant:narrowed,full});
 }
 return {issued,created,narrowed};
}
