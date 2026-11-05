import assert from 'node:assert/strict';

export const period='from=2026-11-02&to=2026-11-09';
export const errorCode=answer=>answer._meta?.['com.runeditrun/error']?.code;
export async function setPolicy(h,disposition,reviewers=['role:owner']) {
 const document={schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[{id:'preparation',class:'standard',do:disposition,
  ...(disposition==='approval'?{approver:['role:owner'],wait:'P1D'}:{})}],reviewers,spend:{none:true}};
 const response=await h.mf.dispatchFetch(h.origin+'/agents/api/policy',{method:'PUT',headers:{cookie:h.owner,origin:h.origin,'content-type':'application'+'/'+'json'},body:JSON.stringify({document})});
 assert.equal(response.status,200,await response.text());
}
export function tools(h,credential) {
 return async(name,args={},trace='synthetic-crank-trace')=>{
  const response=await h.mf.dispatchFetch(h.origin+'/mcp',{method:'POST',headers:{origin:h.origin,authorization:'Bearer '+credential.token,accept:'application'+'/'+'json, text'+'/'+'event-stream','content-type':'application'+'/'+'json','mcp-protocol-version':'2025-11-25'},
   body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:['tools','call'].join('/'),params:{name,arguments:args,_meta:{traceparent:trace}}})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.ok(body.result,JSON.stringify(body));return body.result;
 };
}
export async function page(h,query=period,exported=false,cookie=h.owner,headers={}) {
 return h.send('/agents/api/activity'+(exported?'/export':'')+'?'+query,undefined,cookie,headers);
}
export async function allPages(h,query=period,exported=false) {
 const rows=[],pages=[];let cursor=null;
 do {
  const response=await page(h,query+(cursor?'&cursor='+encodeURIComponent(cursor):''),exported);
  assert.equal(response.status,200,response.text);
  const next=exported?response.headers.get('x-activity-next-cursor'):response.value.cursor;
  const items=exported?(response.text.trim()?response.text.trim().split('\n').map(JSON.parse):[]):response.value.rows;
  assert.ok(items.length<=100);rows.push(...items);pages.push(response);
  assert.notEqual(next,cursor || 'not-a-cursor');cursor=next;
 }while(cursor);
 assert.equal(new Set(rows.map(row=>row.id)).size,rows.length,'every call appears once across pages');
 return {rows,pages};
}
export async function seedActivity(h,{volume=205}={}) {
 const a=await h.post('tokens',{label:'Harbour preparation assistant',scope:'agent'},h.owner,201);
 const b=await h.post('tokens',{label:'Second preparation assistant',scope:'agent'},h.owner,201);
 const call=tools(h,a),other=tools(h,b);
 const input={name:'Harbour reviewed preparation',graph:{trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{private_value:'synthetic-crank-private-graph'}}]},idempotency_key:'synthetic-crank-original'};
 assert.equal((await h.send('/agents/api/pause',{paused:false},h.owner)).status,200);
 const unset=await call('crank.workflows.create',input);assert.equal(errorCode(unset),'policy_unset');
 await setPolicy(h,'autonomous');
 const created=await call('crank.workflows.create',input);assert.ok(created.structuredContent?.id,JSON.stringify(created));
 for(let i=0;i<volume;i++)assert.ok((await call('crank.workflows.get',{workflow_id:created.structuredContent.id})).structuredContent);
 await other('crank.catalog.list');
 await setPolicy(h,'blocked');
 assert.equal(errorCode(await call('crank.workflows.create',{...input,idempotency_key:'synthetic-crank-refused'})),'policy_blocked');
 await setPolicy(h,'review');
 const reviewed=await call('crank.workflows.create',{...input,idempotency_key:'synthetic-crank-review'});
 const reviews=await h.send('/agents/api/reviews',undefined,h.owner);assert.equal(reviews.status,200,reviews.text);
 const review=reviews.value.reviews.find(item=>item.tool==='crank.workflows.create');assert.ok(review);
 assert.equal((await h.send('/agents/api/reviews/'+review.id+'/reviewed',{},h.owner)).status,200);
 await setPolicy(h,'approval');
 const pending=await call('crank.workflows.create',{...input,idempotency_key:'synthetic-crank-pending'});assert.equal(errorCode(pending),'approval_required');
 const awaiting=(await h.send('/agents/api/approvals',undefined,h.owner)).value.approvals;
 const approvedPending=await call('crank.workflows.create',{...input,idempotency_key:'synthetic-crank-approved'});
 assert.equal(errorCode(approvedPending),'approval_required');
 const approval=(await h.send('/agents/api/approvals',undefined,h.owner)).value.approvals.find(item=>!awaiting.some(old=>old.id===item.id));
 assert.ok(approval);
 const approved=await h.send('/agents/api/approvals/'+approval.id+'/approve',{revision:approval.revision,summary_sha256:approval.summary_sha256},h.owner);
 assert.equal(approved.status,200,approved.text);assert.equal(approved.value.approval.state,'executed');
 await setPolicy(h,'autonomous');
 const replay=await call('crank.workflows.create',input);assert.equal(replay.structuredContent.id,created.structuredContent.id);
 return {a,b,call,input,created,review,pending,reviewed,approval};
}

export async function seedReversibleEdit(h,seeded,workflowId=seeded.created.structuredContent.id) {
 const before=await h.get('workflows/'+workflowId);
 await setPolicy(h,'review',['role:owner','role:editor']);
 const args={workflow_id:workflowId,draft_digest:before.draft_digest,name:'Harbour revised preparation',description:'Reviewed native edit',folder:'Review drafts',
  graph:{trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{private_value:'synthetic-crank-reversal-private'}}]},idempotency_key:crypto.randomUUID()};
 const result=await seeded.call('crank.workflows.update',args);assert.ok(result.structuredContent,JSON.stringify(result));
 const reviews=(await h.send('/agents/api/reviews',undefined,h.owner)).value.reviews;
 const review=reviews.find(item=>item.tool==='crank.workflows.update'&&item.summary.nativeTarget.id===workflowId&&item.state==='open');assert.ok(review);
 assert.equal(review.undo.available,true);
 return {before,args,review,after:await h.get('workflows/'+workflowId)};
}

async function reviewUndoJourney(h,seeded) {
 const edit=await seedReversibleEdit(h,seeded),path='/agents/api/reviews/'+edit.review.id;
 const owner=(await h.get()).actor.id,workflowId=edit.before.id;
 const unchanged=async expected=>{
  const current=await h.get('workflows/'+workflowId);
  for(const key of ['name','description','folder','draft','status','published_version_id'])assert.deepEqual(current[key],expected[key],'reversal field '+key);
 };
 assert.equal((await h.send(path+'/undo',{},'')).status,401);
 assert.equal((await h.send(path+'/undo',{},h.owner,{authorization:'Bearer '+seeded.a.token})).status,403);
 assert.equal((await h.send(path+'/undo',{},h.owner,{origin:'https://other.example'})).status,403);
 await unchanged(edit.after);
 // A named reviewer still needs a complete current native preparation grant.
 const email=['synthetic-crank-reviewer','example.test'].join('@');
 assert.equal((await h.send('/auth/invite',{email,displayName:'Preparation reviewer',role:'admin'},h.owner)).status,202);
 const mail=h.mail.findLast(item=>item.to.includes(email)),token=new URL(mail.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
 const reviewer=(await h.send('/auth/confirm',{token})).cookie;
 const reviewerId=(await h.send('/auth/operators',undefined,h.owner)).value.find(item=>item.email===email).id;
 assert.equal((await h.send(path+'/undo',{},reviewer)).status,409);
 await unchanged(edit.after);
 await h.post('team/'+reviewerId,{role:'builder',workflow_ids:[workflowId],connection_ids:[]});
 assert.equal((await h.send(path+'/flag',{},reviewer)).value.review.marked_by,reviewerId);
 assert.equal((await h.send(path+'/reviewed',{},reviewer)).value.review.marked_by,reviewerId);
 await h.restart();
 const attempts=await Promise.all([h.send(path+'/undo',{},reviewer),h.send(path+'/undo',{},reviewer)]);
 assert.ok(attempts.some(item=>item.status===200),JSON.stringify(attempts));
 assert.ok(attempts.every(item=>[200,409].includes(item.status)));
 await unchanged(edit.before);
 assert.equal((await h.get('workflows/'+workflowId)).prepared_by,null,'the human restoration is not shown as agent preparation');
 assert.equal((await h.send(path+'/undo',{},reviewer)).value.review.state,'undone');
 await h.restart();await unchanged(edit.before);
 const rows=(await allPages(h,period)).rows,action=rows.find(row=>row.idempotency_key===edit.args.idempotency_key);
 assert.equal(action.review.by,reviewerId);
 assert.deepEqual(action.native.map(effect=>effect.action),['workflow.draft','workflow.agent_undo']);
 const undo=action.native[1];assert.equal(undo.actor_id,reviewerId);assert.equal(undo.review_id,edit.review.id);assert.equal(undo.reviewed_by,'Preparation reviewer');
 assert.equal(undo.operation_id,action.operation_id);
 const native=(await h.get('audit')).find(row=>row.id===undo.id);
 assert.equal(native.detail.agent_review.decision_id,edit.review.decision_id);
 assert.equal(native.actor_id,reviewerId);
 assert.equal(native.detail.agent_door,undefined,'a human reversal is never attributed as the agent acting');
 assert.ok(!JSON.stringify(action).includes('synthetic-crank-reversal-private'));
 const replay=await seeded.call('crank.workflows.update',edit.args);assert.ok(replay.structuredContent);
 await unchanged(edit.before);
 assert.equal((await h.get('audit')).filter(row=>row.action==='workflow.agent_undo'&&row.subject_id===workflowId).length,1);
 // Later metadata-only saves must be preserved even with a frozen clock and unchanged graph.
 const stale=await seedReversibleEdit(h,seeded);
 await h.post('workflows/'+workflowId+'/draft',{description:'Later person edit'});
 const later=await h.get('workflows/'+workflowId);
 assert.equal((await h.send('/agents/api/reviews/'+stale.review.id+'/undo',{},h.owner)).status,409);
 await unchanged(later);
 const fresh=await seedReversibleEdit(h,seeded);
 await h.post('team/'+reviewerId,{role:'viewer',workflow_ids:[workflowId],connection_ids:[]});
 assert.equal((await h.send('/agents/api/reviews/'+fresh.review.id+'/undo',{},reviewer)).status,409);
 await unchanged(fresh.after);
 // Publication makes even an otherwise unchanged draft ineligible for reversal.
 await h.post('workflows/'+workflowId+'/publish',{},h.owner,201);
 const published=await h.get('workflows/'+workflowId);
 assert.equal((await h.send('/agents/api/reviews/'+fresh.review.id+'/undo',{},h.owner)).status,409);await unchanged(published);
 assert.equal((await h.send('/agents/api/reviews/'+seeded.review.id+'/undo',{},h.owner)).status,409,'creation has no destructive Undo');
 assert.equal((await h.send('/auth/operator/status',{operatorId:reviewerId,status:'inactive'},h.owner)).status,200);
 const erased=await h.post('data/erase',{operator_id:reviewerId,confirm:'ERASE'});
 const retained=(await allPages(h,period,true)).rows.find(row=>row.id===action.id);
 assert.equal(retained.review.by,erased.label);
 assert.equal(retained.native[1].actor_id,erased.label);assert.equal(retained.native[1].reviewed_by,'Removed person');
 assert.ok(!JSON.stringify(retained).includes(reviewerId));assert.ok(!JSON.stringify(retained).includes('Preparation reviewer'));
 assert.equal((await h.send(path+'/undo',{},reviewer)).status,401,'erased reviewer authority cannot return');
 const isolated=await h.post('tokens',{label:'Revoked preparation helper',scope:'agent'},h.owner,201);
 const scratch=await h.post('workflows',{name:'Independent reversal',graph:{trigger:{type:'manual'},steps:[]}},h.owner,201);
 const revoked=await seedReversibleEdit(h,{call:tools(h,isolated)},scratch.id);
 await h.post('tokens/'+isolated.id+'/revoke');
 await h.restart();
 assert.equal((await h.send('/agents/api/reviews/'+revoked.review.id+'/undo',{},h.owner)).status,200,'a person can reverse preparation after revoking its agent');
 assert.deepEqual((await h.get('workflows/'+scratch.id)).draft,revoked.before.draft);
 await setPolicy(h,'autonomous');
 console.log('PROBE BASE-AGENT-009 review Undo: real reviewed draft edit -> person restores exact prior graph and metadata once after restart; bearer, foreign origin, missing or revoked grant, later edit and published state refused without changes; replay cannot reapply');
}

/** One retained public-door journey: paging, effects, provenance and unsafe reads. */
export default async function activityJourney(h) {
 const seeded=await seedActivity(h),{a,b,call,input,created,review}=seeded;
 await reviewUndoJourney(h,seeded);
 const filtered=period+'&agent='+encodeURIComponent('crank-token:'+a.id)+'&class=standard&limit=37';
 const first=await page(h,filtered);assert.equal(first.status,200,first.text);
 assert.equal(first.value.rows.length,37);assert.ok(first.value.cursor);
 // Append after the snapshot: following its cursor must not absorb the new call.
 await tools(h,b)('crank.catalog.list');
 const rest=await page(h,filtered+'&cursor='+encodeURIComponent(first.value.cursor));assert.equal(rest.status,200,rest.text);
 assert.equal(rest.value.through,first.value.through);assert.equal(rest.value.total,first.value.total);
 const changed=await page(h,filtered.replace('class=standard','class=money')+'&cursor='+encodeURIComponent(first.value.cursor));assert.equal(changed.status,400);
 const listed=await allPages(h,filtered),exported=await allPages(h,filtered,true);
 assert.ok(listed.rows.length>200);assert.ok(listed.pages.length>5);
 assert.deepEqual(exported.rows,listed.rows,'NDJSON opens as the same complete filtered records');
 assert.equal(listed.pages[0].value.total,listed.rows.length);
 for(const row of listed.rows){assert.equal(row.agent.id,'crank-token:'+a.id);assert.ok(row.classes.some(item=>item.class==='standard'))}
 const grouped=new Map();
 for(const row of listed.rows)for(const item of row.classes){const key=item.class+':'+row.decision;grouped.set(key,(grouped.get(key)||0)+1)}
 assert.deepEqual(listed.pages[0].value.counts.map(row=>[row.class+':'+row.decision,row.count]),[...grouped].sort(([a],[b])=>a.localeCompare(b)));
 const original=listed.rows.find(row=>row.idempotency_key===input.idempotency_key&&row.outcome==='done');
 const replay=listed.rows.find(row=>row.replay_of===original.id);
 assert.ok(original);assert.ok(replay);assert.equal(replay.operation_id,original.operation_id);
 assert.equal(original.native.length,1);assert.deepEqual(replay.native,original.native,'replay correlates the original native effect');
 assert.equal(original.native[0].operation_id,original.operation_id);assert.equal(original.native[0].subject_id,created.structuredContent.id);
 assert.equal(original.native[0].action,'workflow.create');
 assert.equal(original.label,'Harbour preparation assistant for Harbour owner');assert.equal(original.trace,'synthetic-crank-trace');
 assert.ok(original.scopes.includes('workflows:prepare'));assert.equal(original.agent.specialist,null);assert.equal(original.client_id,null);assert.equal(original.consent,null);
 assert.deepEqual(original.classes,[{class:'standard',facts:{measure:1}}]);assert.equal(original.rules[0].rule,'preparation');assert.equal(original.rules[0].do,'autonomous');
 for(const row of listed.rows.filter(row=>['refused','pending'].includes(row.outcome)))assert.deepEqual(row.native,[],'no native effect for an unexecuted call');
 assert.ok(listed.rows.some(row=>row.decision==='unset'));assert.ok(listed.rows.some(row=>row.decision==='blocked'));assert.ok(listed.rows.some(row=>row.outcome==='pending'));
 const owner=(await h.get()).actor.id;
 const approvedRows=listed.rows.filter(row=>row.approval?.id===seeded.approval.id);
 assert.ok(approvedRows.length);assert.ok(approvedRows.some(row=>row.native.length===1));
 assert.ok(approvedRows.every(row=>row.approval.by.includes(owner)));
 assert.equal(listed.rows.find(row=>row.review?.id===review.id).review.by,owner);
 const raw=await h.send('/agents/api/audit',undefined,h.owner);assert.equal(raw.status,200);
 for(const row of raw.value.rows.filter(row=>row.agent.id==='crank-token:'+a.id)){
  const projected=listed.rows.find(item=>item.id===row.id);assert.ok(projected);
  for(const key of Object.keys(row))assert.deepEqual(projected[key],row[key],'original audit field '+key);
 }
 const serialized=JSON.stringify(exported.rows);
 for(const secret of [a.token,b.token,'synthetic-crank-private-graph'])assert.ok(!serialized.includes(secret));
 assert.equal((await page(h,period+'&class=money')).value.total,0);
 assert.equal((await page(h,'from=2026-11-03&to=2026-11-04')).value.total,0);
 for(const query of ['from=2026-02-30','from=2026-11-09&to=2026-11-02','limit=101','class=unknown','cursor=bad','agent='+encodeURIComponent("x' OR 1=1")]) {
  const response=await page(h,query);assert.ok([200,400].includes(response.status));if(response.status===200)assert.equal(response.value.total,0);
 }
 for(const exported of [false,true]){
  for(const query of [period,...(exported?[period+'&download=all']:[])]){
   assert.equal((await page(h,query,exported,'')).status,401);
   assert.equal((await page(h,query,exported,h.owner,{authorization:'Bearer '+a.token})).status,403);
  }
 }
 const emptyDownload=await page(h,period+'&class=money&download=all',true);
 assert.equal(emptyDownload.status,200);assert.equal(emptyDownload.text,'');
 assert.equal(emptyDownload.headers.get('x-activity-total'),'0');
 const href=original.native[0].href;assert.ok(href);
 assert.equal((await h.send(href,undefined,h.owner)).status,303);
 assert.equal((await h.send(href,undefined,'')).status,401);
 // Business editor access to audit metadata does not grant product payload access.
 const email=['synthetic-crank-audit-editor','example.test'].join('@');
 assert.equal((await h.send('/auth/invite',{email,displayName:'Audit editor',role:'admin'},h.owner)).status,202);
 const message=h.mail.findLast(item=>item.to.includes(email)),token=new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
 const editor=(await h.send('/auth/confirm',{token})).cookie;
 assert.equal((await h.send(href,undefined,editor)).status,404,'a target rechecks current product grants');
 const editorRows=await page(h,filtered,false,editor);assert.equal(editorRows.status,200);
 assert.ok(editorRows.value.rows.every(row=>row.native.every(effect=>effect.href===null)));
 const operators=(await h.send('/auth/operators',undefined,h.owner)).value,editorId=operators.find(person=>person.email===email).id;
 await h.post('team/'+editorId,{role:'builder',workflow_ids:[created.structuredContent.id],connection_ids:[]});
 assert.equal((await h.send(href,undefined,editor)).status,303,'a current complete product grant permits the target');
 await h.post('team/'+editorId,{role:'viewer',workflow_ids:[],connection_ids:[]});
 assert.equal((await h.send(href,undefined,editor)).status,404,'removing the grant refuses an already displayed target');
 assert.equal((await h.send('/auth/operator/status',{operatorId:editorId,status:'inactive'},h.owner)).status,200);
 assert.equal((await page(h,filtered,false,editor)).status,401,'a deactivated person cannot resume reading a retained page');
 await h.post('tokens/'+a.id+'/revoke');
 await h.send('/agents/api/agents/'+encodeURIComponent('crank-token:'+a.id)+'/revoke',{},h.owner);
 await h.restart();
 const retained=await allPages(h,filtered,true);assert.deepEqual(retained.rows,exported.rows,'revocation and restart retain historical names, policy, identities and effects');
 const refused=await h.mf.dispatchFetch(h.origin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+a.token,origin:h.origin,accept:'application'+'/'+'json, text'+'/'+'event-stream','content-type':'application'+'/'+'json','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:['tools','call'].join('/'),params:{name:'crank.workflows.create',arguments:input}})});
 assert.equal(refused.status,401,await refused.text());
 assert.equal((await h.get('workflows')).filter(item=>item.id===created.structuredContent.id).length,1);
 console.log('PROBE BASE-AGENT-009 native activity: more than 200 real MCP calls -> filtered pages, equal NDJSON, exact counts, one correlated native effect, restart and revocation retained, unauthorized reads refused');
 return seeded;
}
