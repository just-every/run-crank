import assert from 'node:assert/strict';
import {archive, inventory} from '../restore-journey.mjs';

export const output = answer => {assert.ok(!answer.result?.isError,JSON.stringify(answer));assert.ok(answer.result?.structuredContent,JSON.stringify(answer));return answer.result.structuredContent};

/** Runs in the shared hosted CORE journey as well as the installed editor proof. */
export default async function attribution({request,origin,cookie,workflow,agent,sponsor,approvers=[]}) {
 const response=await request(origin+'/api/crank/workflows/'+workflow.id,{headers:{cookie}});
 assert.equal(response.status,200);
 const native=await response.json(),prepared=native.prepared_by;
 assert.deepEqual(prepared.agent,agent);
 assert.deepEqual(prepared.for,sponsor);
 assert.equal(prepared.label,agent.name+' for '+sponsor.name);
 assert.deepEqual(prepared.approvers,approvers);
 assert.deepEqual(native.preparations[0].prepared_by,prepared);
 return native;
}

/** Public native sessions, policy and MCP; no direct database writes or fabricated approvals. */
export async function nativeAttributionJourney(h,{inspect=async()=>{},restore}={}) {
 const request=(url,init)=>h.mf.dispatchFetch(url,{redirect:'manual',...init});
 const setup=await request(h.origin+'/setup',{method:'POST',headers:{origin:h.origin,cookie:h.owner,'content-type':'application'+'/'+'x-www-form-urlencoded'},body:'confirm=yes'});
 assert.equal(setup.status,303);
 const person=async(path,body,cookie=h.owner,headers={})=>h.send(path,body,cookie,headers);
 const state=await person('/auth/session');assert.equal(state.status,200);
 const sponsor={id:state.value.operator.id,name:state.value.operator.displayName};
 const name='Synthetic reviewer <historical & independent>';
 const email=['synthetic-crank-81','example.test'].join('@');
 const invited=await person('/auth/invite',{email,displayName:name,role:'member'});assert.equal(invited.status,202,invited.text);
 const token=new URL(h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
 const signed=await person('/auth/confirm',{token});assert.equal(signed.status,303,signed.text);
 const people=await person('/auth/operators');assert.equal(people.status,200);
 const reviewer={id:people.value.find(p=>p.displayName===name).id,name};
 assert.notEqual(reviewer.id,sponsor.id);
 const credential=await h.post('tokens',{label:'Synthetic assistant <preparer & retained>',scope:'agent'},h.owner,201);
 const agent={id:'crank-token:'+credential.id,name:credential.label};
 const call=async(method,params={},expectedStatus=200)=>{
  const response=await request(h.origin+'/mcp',{method:'POST',headers:{origin:h.origin,'content-type':'application'+'/'+'json','mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools'+'/'+'call'?{'mcp-name':params.name}:{}),authorization:'Bearer '+credential.token},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{url:{}}}}}})});
  const answer=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(answer));return answer;
 };
 const tool=(name,args,status=200)=>call('tools'+'/'+'call',{name:'crank.workflows.'+name,arguments:args},status);
 const policy=async disposition=>{
  const document={schema:'rer-agent-policy'+'/'+'1',catalogue:'rer-agent-classes'+'/'+'1',rules:[{id:'native-preparation',class:'*',do:disposition,...(disposition==='approval'?{approver:['person:'+reviewer.id],wait:'PT1H'}:{})}],spend:{none:true}};
  const response=await request(h.origin+'/agents/api/policy',{method:'PUT',headers:{origin:h.origin,cookie:h.owner,'content-type':'application'+'/'+'json'},body:JSON.stringify({document})});
  assert.equal(response.status,200,await response.text());
 };
 const graph={trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{supplier:'synthetic-crank-82'}}]};
 const args=label=>({name:label,graph,idempotency_key:crypto.randomUUID()});
 const snapshot=async()=>({workflows:await h.get('workflows'),audit:(await h.get('audit')).filter(row=>row.subject_kind==='workflow'),runs:(await h.get('workflow-runs')).runs});
 const check=async(workflow,approvers=[])=>attribution({request,origin:h.origin,cookie:h.owner,workflow,agent,sponsor,approvers});
 const pending=async(name,args)=>{
  const answer=await tool(name,args);assert.equal(answer.result?.resultType,'input_required',JSON.stringify(answer));
  const approval=answer.result._meta['com.runeditrun/approval'];assert.ok(approval.id);
  return {answer,approval};
 };
 const view=async id=>{const r=await person('/agents/api/approvals/'+id,undefined,signed.cookie);assert.equal(r.status,200,r.text);return r.value.approval};
 const decide=async held=>{const saved=await view(held.approval.id);return {revision:saved.revision,summary_sha256:saved.summary_sha256}};
 const approve=async held=>{
  const decision=await decide(held),response=await person('/agents/api/approvals/'+held.approval.id+'/approve',decision,signed.cookie);
  assert.equal(response.status,200,response.text);assert.equal(response.value.approval.state,'executed',response.text);
  return decision;
 };

 await policy('autonomous');
 const plain=await tool('create',args('Synthetic autonomous preparation'));
 const autonomous=output(plain),native=await check(autonomous);
 const spoofed=await tool('create',{...args('Synthetic untrusted confirmation'),confirmation:true,approved_by:reviewer.id,approvers:[reviewer],agent_door:{approvers:[reviewer]}});
 assert.deepEqual(spoofed.result._meta['com.runeditrun/decision'].classes,plain.result._meta['com.runeditrun/decision'].classes);
 await check(output(spoofed));
 await inspect({stage:'autonomous',h,workflow:autonomous,native,agent,sponsor,reviewer});

 await policy('approval');
 const createArgs={...args('Synthetic independently reviewed preparation'),confirmation:true,approved_by:reviewer.id,approvers:[reviewer]};
 const before=await snapshot(),held=await pending('create',createArgs),decision=await decide(held);
 assert.deepEqual(await snapshot(),before,'confirmation arguments supply no native approval or mutation');
 const endpoint='/agents/api/approvals/'+held.approval.id+'/approve';
 for(const bearer of [credential.token,'synthetic-crank-device-83']) {
  const refused=await person(endpoint,decision,signed.cookie,{authorization:'Bearer '+bearer});
  assert.equal(refused.status,403);assert.deepEqual(await snapshot(),before);
 }
 const acceptedForm=await call('elicitation'+'/'+'create',{mode:'form',action:'accept',approval_id:held.approval.id},404);
 assert.equal(acceptedForm.error?.code,-32601);assert.deepEqual(await snapshot(),before);
 const sponsorDecision=await person(endpoint,decision);assert.equal(sponsorDecision.status,403);assert.deepEqual(await snapshot(),before,'sponsorship is not independent approval authority');
 const wrong=await person(endpoint,{...decision,summary_sha256:'0'.repeat(64)},signed.cookie);
 assert.equal(wrong.status,409);assert.deepEqual(await snapshot(),before);
 await approve(held);
 const created=output(await tool('create',createArgs));
 let current=await check(created,[reviewer]);
 assert.equal(current.status,'draft');assert.equal(current.published_version_id,null);assert.deepEqual(current.versions,[]);
 const retained=await person('/agents/api/approvals/'+held.approval.id);assert.deepEqual(retained.value.approval.approvals.map(mark=>({id:mark.person,name:mark.name})),[reviewer]);
 await inspect({stage:'approved',h,workflow:created,native:current,agent,sponsor,reviewer});

 // Bind each human decision to the exact native revision, including metadata.
 const updateArgs={workflow_id:created.id,draft_digest:created.draft_digest,expected_revision:created.revision,description:'Independently reviewed exact revision',idempotency_key:crypto.randomUUID()};
 const stale=await pending('update',updateArgs);
 await h.post('workflows/'+created.id+'/draft',{description:'A newer native revision'});
 assert.equal((await h.get('workflows/'+created.id)).prepared_by,null,'a later person edit is not represented as an agent preparation');
 const newer=await snapshot(),staleDecision=await decide(stale);
 const refused=await person('/agents/api/approvals/'+stale.approval.id+'/approve',staleDecision,signed.cookie);
 assert.equal(refused.status,200);assert.equal(refused.value.approval.state,'refused');assert.equal(refused.value.approval.code,'revision_conflict');
 assert.deepEqual(await snapshot(),newer,'a stale human approval changes no native records');
 // Read metadata using the native person door while the agent read policy waits.
 await policy('autonomous');
 const fresh=output(await tool('get',{workflow_id:created.id}));await policy('approval');
 const freshArgs={...updateArgs,draft_digest:fresh.draft_digest,expected_revision:fresh.revision,idempotency_key:crypto.randomUUID()};
 const update=await pending('update',freshArgs);await approve(update);const updated=output(await tool('update',freshArgs));
 current=await check(updated,[reviewer]);assert.equal(current.description,freshArgs.description);
 assert.ok(current.drafts.some(row=>row.agent_door?.approvers?.[0]?.id===reviewer.id));
 const copyArgs={workflow_id:created.id,expected_revision:updated.revision,idempotency_key:crypto.randomUUID()};
 const duplicate=await pending('duplicate',copyArgs);await approve(duplicate);const copy=output(await tool('duplicate',copyArgs));
 await check(copy,[reviewer]);assert.notEqual(copy.id,created.id);assert.equal((await h.get('workflows/'+copy.id)).status,'draft');
 const unchanged=await snapshot();await person(endpoint,decision,signed.cookie);assert.deepEqual(await snapshot(),unchanged,'replayed approval makes no second preparation');

 const revokedArgs=args('Synthetic revoked reviewer preparation'),revoked=await pending('create',revokedArgs),revokedDecision=await decide(revoked);
 const renamed=await person('/auth/display-name',{displayName:'Synthetic current reviewer'},signed.cookie);assert.equal(renamed.status,200,renamed.text);
 await check(updated,[reviewer]);
 const revokedState=await snapshot();
 await h.post('data'+'/'+'erase',{operator_id:reviewer.id,confirm:'ERASE'},h.owner,409);
 assert.deepEqual(await snapshot(),revokedState,'an active reviewer cannot be erased or lose attribution');
 const deactivated=await person('/auth/operator/status',{operatorId:reviewer.id,status:'inactive'});assert.equal(deactivated.status,200,deactivated.text);
 const revokedResponse=await person('/agents/api/approvals/'+revoked.approval.id+'/approve',revokedDecision,signed.cookie);
 assert.equal(revokedResponse.status,401);assert.deepEqual(await snapshot(),revokedState,'a revoked reviewer cannot mutate a draft');
 await h.post('tokens/'+credential.id+'/revoke');
 const revokedCredentialState=await snapshot();
 assert.ok((await tool('create',args('Synthetic revoked preparer'),401)).error);
 assert.deepEqual(await snapshot(),revokedCredentialState,'revoked preparation credentials cannot create new work');
 await h.restart();current=await check(updated,[reviewer]);await check(copy,[reviewer]);
 const audit=await h.get('audit'),rows=audit.filter(row=>row.subject_id===created.id&&row.detail.agent_door);
 assert.equal(rows.length,2);assert.ok(rows.every(row=>row.actor_id===sponsor.id&&row.detail.agent_door.agent.id===agent.id&&row.detail.agent_door.approvers[0].id===reviewer.id));
 const exportedAudit=await person('/api/crank/audit/export');assert.equal(exportedAudit.status,200,exportedAudit.text);
 const exportedRows=exportedAudit.text.trim().split('\n').map(JSON.parse);assert.deepEqual(exportedRows.filter(row=>rows.some(saved=>saved.id===row.id)).sort((a,b)=>a.id.localeCompare(b.id)),rows.sort((a,b)=>a.id.localeCompare(b.id)));
 const exported=await archive(h);assert.ok(!exported.includes(credential.token));
 await inspect({stage:'retained',h,workflow:updated,native:current,agent,sponsor,reviewer});
 if(restore) {
  const receiving=await restore(exported);
  const received=await receiving.get('workflows/'+created.id);assert.deepEqual(received.prepared_by,current.prepared_by);assert.deepEqual(received.preparations,current.preparations);
  assert.deepEqual(received.drafts,current.drafts);assert.equal(received.status,'draft');assert.equal(received.published_version_id,null);
  const source=inventory(exported),receivedRows=inventory(await archive(receiving));
  assert.deepEqual(receivedRows.filter(row=>source.includes(row)),source);
  assert.deepEqual(receivedRows.filter(row=>!source.includes(row)).map(row=>JSON.parse(row).row.action),['data.restore']);
  await receiving.restart();await receiving.tick();
  assert.deepEqual((await receiving.get('workflow-runs')).runs,[]);
  const replay=await receiving.send(endpoint,decision,receiving.owner);assert.ok([403,404].includes(replay.status));
  assert.deepEqual((await receiving.get('workflows/'+created.id)).prepared_by,current.prepared_by);
  await inspect({stage:'restored',h:receiving,workflow:updated,native:received,agent,sponsor,reviewer});
 }
 // Erasure must reach the retained reviewer snapshots, not just audit actors.
 const beforeErasure=(await h.get('audit')).filter(row=>rows.some(saved=>saved.id===row.id));
 await assert.rejects(h.db.prepare("UPDATE crank_audit SET detail_json=json_set(detail_json,'$.agent_door.approvers[0].name',?) WHERE id=?").bind('Unverified replacement',beforeErasure[0].id).run(),/crank_audit_append_only/,'reviewer snapshots remain immutable outside guarded erasure');
 const erased=await h.post('data'+'/'+'erase',{operator_id:reviewer.id,confirm:'ERASE'});
 const removed={id:erased.label,name:'Removed person'};
 const checkErased=async receiving=>{
  for(const workflow of [updated,copy]) {
   const retained=await receiving.get('workflows/'+workflow.id);
   assert.deepEqual(retained.prepared_by.approvers,[removed],'operator erasure anonymizes the independently verified reviewer');
   assert.deepEqual(retained.prepared_by.agent,agent);
   assert.deepEqual(retained.prepared_by.for,sponsor);
   assert.ok(retained.preparations.filter(row=>row.prepared_by?.approvers?.length).every(row=>JSON.stringify(row.prepared_by.approvers)===JSON.stringify([removed])));
   assert.ok(retained.drafts.filter(row=>row.agent_door?.approvers?.length).every(row=>JSON.stringify(row.agent_door.approvers)===JSON.stringify([removed])));
  }
  const audit=await receiving.get('audit');
  const activity=await receiving.send('/agents/api/audit',undefined,receiving.owner);
  assert.equal(activity.status,200,activity.text);assert.equal(activity.value.differs_from_policy,0,'anonymizing reviewer references preserves historical policy decisions');
  assert.deepEqual(audit.filter(row=>beforeErasure.some(saved=>saved.id===row.id)).map(({detail,...row})=>row),beforeErasure.map(({detail,...row})=>row),'erasure preserves action chronology and unrelated attribution');
  const exported=await receiving.send('/api/crank/audit/export',undefined,receiving.owner);
  assert.equal(exported.status,200,exported.text);
  const portable=await archive(receiving);
  for(const text of [JSON.stringify(audit),activity.text,exported.text,portable])for(const value of [reviewer.id,reviewer.name,'Synthetic current reviewer',email])assert.ok(!text.includes(value),'erased reviewer identity is absent from history and exports');
  return portable;
 };
 await person('/auth/session',undefined,signed.cookie).then(response=>assert.equal(response.status,401));
 const erasedArchive=await checkErased(h);
 await h.restart();await checkErased(h);
 if(restore) {
  const receiving=await restore(erasedArchive,{older:exported});
  await receiving.restart();await receiving.tick();await checkErased(receiving);
  assert.deepEqual((await receiving.get('workflow-runs')).runs,[]);
  await inspect({stage:'erased',h:receiving,workflow:updated,native:await receiving.get('workflows/'+updated.id),agent,sponsor,reviewer:removed});
 }
 console.log('PROBE DATA-002 reviewer erasure: approve draft, deactivate and erase reviewer -> anonymized workflow history and exports across restart and inactive restore');
 assert.deepEqual((await h.get('workflow-runs')).runs,[],'preparation never publishes or executes a workflow');
 return {workflow:updated,copy,agent,sponsor,reviewer};
}
