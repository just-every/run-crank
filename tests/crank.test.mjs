import { graphExport } from './n8n-graph-fixture.mjs';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {harness,freePort} from './harness.mjs';
import {publish,door,doorPlan,doorImport,checkDoor,deliver,settled} from './kit.mjs';
import {restoreJourney} from './restore-journey.mjs';

// Fake only the external receiver/network edge. Workerd, D1, auth and imports
// run the application's real code, through HTTP requests.
let h, receiver, target, mode='ok'; const effects=new Map(),requests=[];
before(async()=>{
 const port=await freePort();target=`http://127.0.0.1:${port}`;
 receiver=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const key=req.headers['idempotency-key'];requests.push({key,text});
  if(req.url==='/graph-events'){res.writeHead(200,{'content-type':'application'+'/'+'json'});res.end(JSON.stringify({received:true}));return;}
  if(mode==='reject'){res.writeHead(503);res.end();return;}
  if(effects.has(key))assert.equal(effects.get(key),text);else effects.set(key,text);
  if(mode==='lost'){res.destroy();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:key,idempotencyKey:key}));
 });await new Promise(r=>receiver.listen(port,'127.0.0.1',r));h=await harness(target);
});
after(async()=>{await h?.close();if(receiver)await new Promise(r=>receiver.close(r));});

// The owner invites a person; they accept through the emailed link (the mail provider is the faked edge).
async function join(role,email=`${role}-${crypto.randomUUID().slice(0,8)}@example.test`){
 const invited=await h.send('/auth/invite',{email,displayName:role,role},h.owner);assert.equal(invited.status,202,invited.text);
 const message=h.mail.findLast(message=>message.to.includes(email));
 const token=new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
 assert.ok(token,'invitation delivered to mail provider');const joined=await h.send('/auth/confirm',{token});assert.equal(joined.status,303,joined.text);
 return {cookie:joined.cookie,id:(await h.get('state',joined.cookie)).actor.id};
}

test('native owner sign-in, admin preparation and member read-only roles apply at each HTTP door',async()=>{
 await h.get('state','',401);
 for(const role of ['admin','member']) {
  const {cookie}=await join(role,role+'@example.test');
  assert.equal((await h.get('state',cookie)).actor.role,role);
  const f=await h.flow('Role boundary '+role),r=await h.run(f);
  for(const path of [`flows/${f.id}/activate`,`flows/${f.id}/pause`,`runs/${r.id}/approve`,`runs/${r.id}/reject`,`runs/${r.id}/replay`,'tokens','data/export','data/restore','data/erase']) await h.post(path,{},cookie,403);
  for(const action of ['uploads','plan','apply','undo']) assert.equal((await door(h,action,{},cookie)).status,401,`${role} cannot use the import door`);
  await h.post('flows',{name:'Prepared by '+role,source_app:'Support desk',destination_app:'Inbox',target_url:target+'/events'},cookie,role==='admin'?201:403);
 }
 const csrf=await h.send('/api/crank/flows',{name:'CSRF'},h.owner,{origin:'https://foreign.example'});assert.equal(csrf.status,403);
 assert.equal((await h.send('/api/crank/data/export',{},h.owner,{origin:'https://foreign.example'})).status,403);assert.equal((await door(h,'plan',{},h.owner,{origin:'https://foreign.example'})).status,403);
});

test('SEC-001: private doors need a current session or scoped credential, access/data/import decisions stay the owner\'s, and revocation lands at commit',async()=>{
 for(const door of ['','state','flows','flows/x','flows/x/activate','flows/x/runs','flows/x/trigger','runs/x','runs/x/approve','runs/x/replay','tokens','tokens/x/revoke','imports','imports/x/undo','data/export','data/restore','data/erase',
  'historical','historical/x','workflows','workflows/x','workflows/x/publish','workflows/x/run','workflow-runs','workflow-runs/x','workflow-runs/x/resume','connections','connections/x','oauth/start','oauth/callback','oauth/apps/slack','hooks','holds/x','queues','catalog','coverage','settings','audit','notices','reports'])
  for(const input of [undefined,{}]) assert.equal((await h.send('/api/crank'+(door&&'/'+door),input)).status,401,`SEC-001 signed-out ${input?'POST':'GET'} /api/crank/${door}`);
 for(const action of ['uploads','plan','apply','status','reconcile','undo']) assert.equal((await h.send('/api/operator/import/'+action,{},'',{'X-Import-Source':'n8n'})).status,401,'SEC-001 signed-out import door '+action);
 assert.equal((await h.send('/api/rer/import/plan',{},h.owner)).status,404,'no grant mount without Business');
 for(const page of ['/app','/app/operations','/app/approvals','/app/runs','/app/runs/x','/app/connections','/app/access','/app/account','/app/data','/app/import','/app/workflows/x','/app/workflow-runs/x','/app/action']) {
  const r=await h.send(page,page==='/app/action'?{path:'/api/crank/data/erase'}:undefined);assert.equal(r.status,303,'SEC-001 signed-out '+page);assert.match(r.headers.get('location'),/^\/signin/);
 }
 assert.equal((await h.send('/auth/operators')).status,401);
 const people=async()=>JSON.stringify((await h.send('/auth/operators',undefined,h.owner)).value);
 const admin=await join('admin'),member=await join('member'),departing=await join('member');
 const agent=await h.post('tokens',{label:'SEC-001 agent',scope:'agent'},h.owner,201),f=await h.flow('SEC-001 trigger flow'),trigger=await h.post('tokens',{label:'SEC-001 trigger',scope:'trigger',flow_id:f.id},h.owner,201);
 const before=await people(),tokens=(await h.get()).tokens.length;
 for(const [who,cookie,headers] of [['admin',admin.cookie,{}],['member',member.cookie,{}],['agent','',{authorization:'Bearer '+agent.token}],['trigger','',{authorization:'Bearer '+trigger.token}]]) {
  for(const [path,input] of [['/auth/invite',{email:'uninvited@example.test',displayName:'Uninvited',role:'member'}],['/auth/operator/status',{operatorId:departing.id,status:'inactive'}],['/auth/operator/role',{operatorId:departing.id,role:'admin'}]]) {
   const r=await h.send(path,input,cookie,headers);assert.ok([401,403].includes(r.status),`SEC-001 ${who} ${path}: ${r.status} ${r.text}`);
  }
  for(const path of ['tokens','tokens/'+agent.id+'/revoke','data/export','data/restore','data/erase']) assert.equal((await h.send('/api/crank/'+path,{},cookie,headers)).status,403,`SEC-001 ${who} ${path}`);
  for(const action of ['uploads','plan','apply','undo']) assert.equal((await door(h,action,{},cookie,headers)).status,401,`SEC-001 ${who} import door ${action}`);
  assert.ok([401,403].includes((await h.send('/api/operator/import-settings',{enabled:true},cookie,headers)).status),`SEC-001 ${who} cannot open Business imports`);
 }
 assert.equal(await people(),before,'no lower role changed who may sign in');assert.equal((await h.get()).tokens.length,tokens);
 assert.ok(!h.mail.some(m=>m.to.includes('uninvited@example.test')),'no invitation was sent');
 const flows=(await h.get()).flows.length;
 for(const origin of ['https://foreign.example','null',h.origin.replace('127.0.0.1','localhost')]) for(const [path,input] of [['/api/crank/flows',{name:'SEC-001 cross-site',source_app:'Support desk',destination_app:'Inbox',target_url:target+'/events'}],['/api/crank/tokens',{label:'Cross-site',scope:'agent'}],['/api/crank/data/export',{}],['/api/operator/import/plan',{}]])
  assert.equal((await h.send(path,input,h.owner,{origin,'X-Import-Source':'n8n'})).status,403,`SEC-001 ${origin} ${path}`);
 assert.equal((await h.get()).flows.length,flows);assert.equal((await h.get()).tokens.length,tokens,'foreign-Origin owner mutations change nothing');
 await h.get('state',departing.cookie);
 const deactivated=await h.send('/auth/operator/status',{operatorId:departing.id,status:'inactive'},h.owner);assert.equal(deactivated.status,200,deactivated.text);
 await h.get('state',departing.cookie,401);
 // Admit a write, end its session or credential while the body is still arriving, then finish it:
 // the durable write predicate refuses at commit and nothing is created.
 const admitted=async(name,headers,revoke)=>{
  let release;const gate=new Promise(r=>release=r),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(c){c.enqueue(encoder.encode(`{"name":${JSON.stringify(name)},`));await gate;c.enqueue(encoder.encode(JSON.stringify({source_app:'Support desk',destination_app:'Inbox',target_url:target+'/events'}).slice(1)));c.close()}});
  const pending=h.mf.dispatchFetch(h.origin+'/api/crank/flows',{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{host:new URL(h.origin).host,origin:h.origin,'content-type':'application/json',...headers}});
  await new Promise(r=>setTimeout(r,500));await revoke();release();
  const response=await pending,text=await response.text();
  assert.equal(response.status,403,text);assert.match(text,/Authority changed/);
  assert.ok(!(await h.get()).flows.some(flow=>flow.name===name),name+' created nothing');
 };
 await admitted('SEC-001 admitted before sign-out',{cookie:admin.cookie},async()=>assert.equal((await h.send('/auth/signout',{},admin.cookie)).status,204));
 await admitted('SEC-001 admitted before token revocation',{authorization:'Bearer '+agent.token},()=>h.post('tokens/'+agent.id+'/revoke'));
});

test('preparation does not send; approval binds input, records person and dispatches exactly once',async()=>{
 mode='ok';const f=await h.flow(),before=requests.length; const r=await h.run(f,'ticket-1042',{customer:'Harbour Workshop',task:'Book a callback'});
 assert.equal(r.state,'pending');assert.equal(requests.length,before);
 const same=await h.post(`flows/${f.id}/runs`,{event_id:r.event_id,input:r.input},h.owner,201);assert.equal(same.id,r.id);
 await h.post(`flows/${f.id}/runs`,{event_id:r.event_id,input:{different:true}},h.owner,409);
 const results=await Promise.all([h.send(`/api/crank/runs/${r.id}/approve`,{},h.owner),h.send(`/api/crank/runs/${r.id}/approve`,{},h.owner)]);
 assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(results.filter(x=>x.status===409).length,1);
 assert.equal(effects.get(r.id),r.input_json);assert.equal(requests.filter(x=>x.key===r.id).length,1);
 const state=await h.get();assert.equal(state.runs.find(x=>x.id===r.id).state,'succeeded');const decision=state.approvals.find(x=>x.run_id===r.id);assert.equal(decision.action_digest,r.action_digest);assert.equal(decision.actor_id,state.actor.id);
 await h.post(`runs/${r.id}/replay`,{},h.owner,409);
});

test('uncertain network delivery replays once with the same bytes/key and cannot repeat its effect',async()=>{
 mode='lost';const f=await h.flow('Lost acknowledgement'),r=await h.run(f);const failed=await h.post(`runs/${r.id}/approve`);assert.equal(failed.state,'failed');assert.ok(effects.has(r.id));
 mode='ok';const replayed=await h.post(`runs/${r.id}/replay`);assert.equal(replayed.state,'succeeded');assert.equal(replayed.replay_count,1);
 assert.equal(requests.filter(x=>x.key===r.id).length,2);assert.equal(effects.get(r.id),r.input_json);
 await h.post(`runs/${r.id}/replay`,{},h.owner,409);assert.equal((await h.get()).attempts.filter(x=>x.run_id===r.id).length,2);
});

test('TEAM-003: scoped trigger and agent commands prepare only, revoked credentials stop working',async()=>{
 const f=await h.flow('Machine input'),other=await h.flow('Other destination');const agent=await h.post('tokens',{label:'Operations assistant',scope:'agent'},h.owner,201),trigger=await h.post('tokens',{label:'Support webhook',scope:'trigger',flow_id:f.id},h.owner,201);
 const a={authorization:'Bearer '+agent.token},t={authorization:'Bearer '+trigger.token};
 const run=await h.post(`flows/${f.id}/trigger`,{event_id:'webhook-1',input:{subject:'New customer'}},'',201,t);
 await h.post(`flows/${other.id}/trigger`,{event_id:'webhook-1',input:{}},'',403,t);await h.get('state','',403,t);
 await h.post(`flows/${f.id}/runs`,{event_id:'agent-1',input:{subject:'Prepared'}},'',201,a);
 for(const path of [`runs/${run.id}/approve`,`runs/${run.id}/reject`,`runs/${run.id}/replay`,`flows/${f.id}/activate`,'tokens','data/export','data/erase'])await h.post(path,{},'',403,a);
 assert.equal((await door(h,'plan',{},'',a)).status,401,'an agent credential cannot import');
 const workflow=await publish(h,'Preparation cannot execute',{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{customer:'Harbour Workshop'}}]});
 await h.post('workflows',{name:'Agent-prepared draft',graph:{trigger:{type:'manual'},steps:[{id:'prepare',type:'map',input:{}}]}},'',201,a);
 await h.get('workflows/'+workflow.id,'',200,a);
 const runCount=(await h.get('workflow-runs')).runs.length;
 for(const path of [`workflows/${workflow.id}/run`,`workflows/${workflow.id}/publish`,`workflows/${workflow.id}/pause`,`workflows/${workflow.id}/resume`,`workflows/${workflow.id}/hooks`,'connections','settings','oauth/start',`workflow-runs/${run.id}/resume`,`workflow-runs/${run.id}/cancel`]) await h.post(path,{},'',403,a);
 await h.post(`workflows/${workflow.id}/run`,{},'',403,t);
 assert.equal((await h.get('workflow-runs')).runs.length,runCount,'preparation and trigger credentials cannot execute a published graph');
 const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200,archive.text);
 assert.ok(!archive.text.includes(agent.token));assert.ok(!archive.text.includes(trigger.token));
 const stored=await h.db.prepare('SELECT token_hash FROM crank_tokens WHERE id=?').bind(agent.id).first();
 assert.equal(stored.token_hash,await crypto.subtle.digest('SHA-256',new TextEncoder().encode(agent.token)).then(b=>Buffer.from(b).toString('hex')));
 await h.post('tokens/'+agent.id+'/revoke');await h.get('state','',401,a);
 await h.post('flows',{name:'Revoked draft'},'',401,a);
 const changed=await h.post('tokens',{label:'Before owner identity change',scope:'agent'},h.owner,201);
 const ownerId=(await h.get()).actor.id;
 const owner=await h.db.prepare('SELECT id,version FROM oa_operators WHERE id=?').bind(ownerId).first();
 await h.db.prepare('UPDATE oa_operators SET version=version+1 WHERE id=?').bind(owner.id).run();
 await h.get('state','',401,{authorization:'Bearer '+changed.token});
 // Restore the fixture owner's version so subsequent independent HTTP journeys retain their session.
 await h.db.prepare('UPDATE oa_operators SET version=? WHERE id=?').bind(owner.version,owner.id).run();
 const state=await h.get();assert.ok(!JSON.stringify(state).includes(agent.token));assert.ok(!JSON.stringify(state).includes(trigger.token));
});

test('rejection has an audit decision and no delivery; destinations cannot escape deployment origin',async()=>{
 const f=await h.flow('Reject callback'),r=await h.run(f),before=requests.length;assert.equal((await h.post(`runs/${r.id}/reject`)).state,'rejected');assert.equal(requests.length,before);await h.post(`runs/${r.id}/approve`,{},h.owner,409);
 for(const url of ['https://different.example/events',target+'/events?token=example-secret',target.replace('127.0.0.1','user@127.0.0.1')+'/events']) await h.post('flows',{name:'Bad destination',source_app:'A',destination_app:'B',target_url:url},h.owner,400);
});

const source=async()=> (await readFile('public/fixtures/n8n-workflow.json','utf8')).replace('http://127.0.0.1:9051',target);
test('MIG-001 move-in door: owner upload, plan without writes, reviewed apply, reconcile, undo and history',async()=>{
 const nativeSnapshot=async()=>(await h.get()).flows.map(f=>({id:f.id,name:f.name,status:f.status,target_url:f.target_url})).sort((x,y)=>x.id.localeCompare(y.id));
 await checkDoor({request:async(action,body)=>{const r=await door(h,action,body);return new Response(r.text,{status:r.status})},bytes:Buffer.from(await source()),name:'n8n-workflows.json',nativeSnapshot,
  assertApplied:async(before,after,report)=>{assert.deepEqual(after.filter(f=>!before.some(x=>x.id===f.id)).map(f=>[f.name,f.status,f.target_url]),[['Receive an event and forward its JSON body','draft',target+'/events']]);assert.equal(report.counts.present,1)},
  assertUndone:async(before,after)=>assert.deepEqual(after,before)});
 const [entry]=await h.get('imports');assert.equal(entry.authority,'door');assert.equal(entry.state,'undone');assert.match(entry.caption,/approved by/i);
 const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='import.apply'&&a.subject_id===entry.planId)&&audit.some(a=>a.action==='import.undo'&&a.subject_id===entry.planId),'apply and undo are audited');
 // The signed-in move-in screen drives the same door: review, approve the exact plan, reconcile, undo.
 const screen=async(path,fields)=>{const r=await h.mf.dispatchFetch(h.origin+path,{method:'POST',redirect:'manual',headers:{host:new URL(h.origin).host,origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()});return {status:r.status,location:r.headers.get('location'),text:await r.text()}};
 await screen('/setup',{confirm:'yes'});
 const before=(await h.get()).flows.length,review=await screen('/app/import/preview',{source:await source()});
 assert.equal(review.status,200,review.text.slice(0,300));assert.match(review.text,/1 workflows in the upload: 1 new/);assert.equal((await h.get()).flows.length,before,'review writes nothing');
 const field=name=>review.text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
 const applied=await screen('/app/import/apply',{planId:field('planId'),reviewedFingerprint:field('reviewedFingerprint')});
 assert.match(applied.text,/Reconciled: 1 of 1 source workflows are present as drafts/);assert.equal((await h.get()).flows.length,before+1);
 assert.match((await h.send('/app/import',undefined,h.owner)).text,/Undo unused import/);
 assert.equal((await screen('/app/import/undo',{planId:field('planId')})).location,'/app/import');assert.equal((await h.get()).flows.length,before);
 const bad=JSON.parse(await source());bad.nodes[1].parameters.jsonBody='={{ $json.body.customer }}';
 const settings=async body=>{const r=await h.send('/api/operator/import-settings',body,h.owner);assert.equal(r.status,200,r.text);return r.value};
 assert.deepEqual(await settings(),{enabled:false,revokedKids:[],businessKeys:false},'Business grants start off; the owner door works regardless');
 assert.equal((await settings({enabled:true,revokedKids:['retired-test-key']})).enabled,true);await settings({enabled:false});
 assert.deepEqual((await settings({enabled:true})).revokedKids,['retired-test-key'],'turning Business on again never unrevokes a signing key');
 assert.equal((await screen('/app/import/settings',{enabled:'false'})).location,'/app/import');assert.match((await h.send('/app/import',undefined,h.owner)).text,/Turn on Business imports/);
 assert.equal((await h.send('/api/rer/import/plan',{},h.owner)).status,404,'no grant reaches the door without RER\'s key ring');
 assert.equal((await h.send('/api/operator/import-settings',{enabled:true},h.owner,{origin:'https://foreign.example'})).status,403);
 const refusal=await screen('/app/import/preview',{source:JSON.stringify(bad)});assert.equal(refusal.status,422);assert.match(refusal.text,/parser refused a source value\. \(record 1\)/);
});

test('MIG-001 door refuses expressions and credential exports without echoing them, and keeps used drafts on undo',async()=>{
 const text=await source(),flows=(await h.get()).flows.length;
 const expression=JSON.parse(text);expression.nodes[1].parameters.jsonBody='={{ $json.body.customer }}';
 const refused=await doorPlan(h,JSON.stringify(expression));assert.equal(refused.status,422,refused.text);assert.equal(refused.value.error,'source_parser_failed');assert.ok(refused.value.details.reason);
 const credential=JSON.parse(text);credential.nodes[1].credentials={httpHeaderAuth:{id:'example-reference'}};
 const withheld=await doorPlan(h,JSON.stringify(credential));assert.equal(withheld.status,422,withheld.text);assert.equal(withheld.value.error,'source_parser_failed');assert.ok(!withheld.text.includes('example-reference'),'a credential export is refused and never echoed');
 assert.equal((await h.get()).flows.length,flows,'planning writes no flow');
 await doorImport(h,text);const renamed=JSON.parse(text);renamed.name='Receive an event and forward it (renamed)';
 assert.equal((await doorPlan(h,JSON.stringify(renamed))).value.error,'catchup_required');const catchup=await doorPlan(h,JSON.stringify(renamed),true);assert.equal(catchup.status,200,catchup.text);assert.equal(catchup.value.summary.updated,1,'a changed source workflow is a reviewed replacement');
 assert.equal((await door(h,'apply',{planId:catchup.value.planId,reviewedFingerprint:catchup.value.fingerprint})).value.job.state,'completed');
 const plan=catchup.value,flow=(await h.get()).flows.find(x=>x.name==='Receive an event and forward it (renamed)');assert.ok(flow,'catch-up replaced the unused draft in place');assert.equal(flow.status,'draft');
 await h.post(`flows/${flow.id}/activate`);await h.run(flow,'imported-event');
 const undone=await door(h,'undo',{planId:plan.planId});assert.ok(undone.status>=400 || undone.value.job?.state!=='undone',undone.text);assert.ok((await h.get()).flows.some(x=>x.id===flow.id),'a used import is never removed');
});

test('MIG-001 native graph review, exact apply, restart, branch outcomes and protected undo',async()=>{
 const local=await harness(target);try{
  const input=graphExport(target),unsupported=structuredClone(input);
  unsupported.nodes.push({id:'child',name:'child',type:'n8n-nodes-base.executeWorkflow',typeVersion:1,position:[100,200],parameters:{workflowId:'synthetic-crank-child'}});
  unsupported.nodes.push({id:'custom',name:'custom',type:'synthetic-crank-custom',typeVersion:1,position:[100,300],parameters:{code:'={{ globalThis.crankInjected = 1 }}'}});
  unsupported.nodes[1].parameters.unhandledSetting=true;
  const rejected=await doorPlan(local,JSON.stringify(unsupported));assert.equal(rejected.status,200,rejected.text);assert.equal(rejected.value.rejected.length,1);
  assert.ok(rejected.value.diagnostics.some(d=>d.field==='nodes.1.parameters.unhandledSetting'));
  assert.ok(rejected.value.diagnostics.some(d=>d.field==='nodes.6'));assert.ok(rejected.value.diagnostics.some(d=>d.field==='nodes.7'));
  assert.equal((await local.get('workflows')).length,0);
  assert.equal((await door(local,'undo',{planId:rejected.value.planId})).value.state,'cancelled');
  const plan=await doorPlan(local,JSON.stringify(input));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0);
  assert.equal((await local.get('workflows')).length,0,'review creates no draft');
  assert.ok((await door(local,'apply',{planId:plan.value.planId,reviewedFingerprint:'0'.repeat(64)})).status>=400);
  const body={planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint};
  for(let i=0;i<2;i++)assert.equal((await door(local,'apply',body)).value.job.state,'completed');
  const [listed]=await local.get('workflows'),workflow=await local.get('workflows/'+listed.id);
  assert.equal(workflow.status,'draft');assert.equal(workflow.published_version_id,null);assert.equal(workflow.versions.length,0);assert.equal(workflow.hooks.length,0);
  assert.deepEqual(workflow.draft.settings.n8n_layout.map(n=>n.position),input.nodes.map(n=>n.position));assert.deepEqual(workflow.draft.settings.n8n_connections,input.connections);
  await local.restart();assert.deepEqual((await local.get('workflows/'+listed.id)).draft,workflow.draft);
  assert.ok((await local.get('imports')).some(e=>e.planId===plan.value.planId));const report=await door(local,'reconcile',{planId:plan.value.planId});assert.equal(report.value.ok,true,report.text);
  assert.equal((await door(local,'undo',{planId:plan.value.planId})).value.job.state,'undone');assert.equal((await local.get('workflows')).length,0);
  const driftPlan=await doorImport(local,JSON.stringify(input));const [drift]=await local.get('workflows');await local.post('workflows/'+drift.id+'/draft',{name:'Owner changed draft'});
  const driftUndo=await door(local,'undo',{planId:driftPlan.planId});assert.ok(driftUndo.status>=400||driftUndo.value.job?.state!=='undone');assert.equal((await local.get('workflows/'+drift.id)).name,'Owner changed draft');
 }finally{await local.close()}
 const declared='https://receiver.example';
 const execution=await harness(declared,{edge:async request=>{if(new URL(request.url).origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(target+new URL(request.url).pathname,{method:request.method,headers,body:await request.arrayBuffer()})}});try{
  const p=await doorImport(execution,JSON.stringify(graphExport(declared,'synthetic-crank-5'))),[w]=await execution.get('workflows');
  await execution.post('workflows/'+w.id+'/publish',{},execution.owner,201);const hook=await execution.post('workflows/'+w.id+'/hooks',{},execution.owner,201);
  for(const amount of [8,2]){
   const before=requests.length,message='synthetic-crank-'+amount;
   const sent=await deliver(execution,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json','x-event-id':message},body:JSON.stringify({amount,message})});assert.equal(sent.status,200,sent.text);
   const list=(await execution.get('workflow-runs?workflow='+w.id)).runs;let run=await execution.get('workflow-runs/'+list[0].id);
   run=await settled(execution,run.id);if(run.status==='waiting'){await execution.tick();run=await settled(execution,run.id)}
   assert.equal(run.status,'succeeded',JSON.stringify(run));assert.equal(requests.length,before+1);assert.deepEqual(JSON.parse(requests.at(-1).text),{amount,message});
   assert.ok(run.steps.some(s=>s.step_id===(amount>5?'n4':'n5')));
  }
  const undo=await door(execution,'undo',{planId:p.planId});assert.ok(undo.status>=400||undo.value.job?.state!=='undone');assert.ok(await execution.get('workflows/'+w.id));
 }finally{await execution.close()}
});

test('BASE-003 DATA-001: complete portable inventory, inactive restore, explicit per-run adoption and atomic refusal',async()=>{
 await restoreJourney();
 const archiveFlow=await h.flow('Archive fixture independent of test order');await h.run(archiveFlow);
 const exported=await h.send('/api/crank/data/export',{},h.owner);assert.equal(exported.status,200,exported.text);
 const lines=exported.text.trim().split('\n').map(JSON.parse),manifest=lines[0];assert.ok(!manifest.tables.some(x=>x.name==='crank_tokens'));assert.ok(!manifest.tables.some(x=>x.name==='oa_sessions'));
 const other=await harness(target);try{
  await other.post('data/restore',{archive:exported.text,confirm:'RESTORE'});
  const restored=await other.get(),original=await h.get();assert.equal(restored.runs.length,original.runs.length);assert.equal(restored.flows.length,original.flows.length);assert.ok(restored.flows.every(f=>f.status==='draft'));assert.equal(restored.tokens.length,0);assert.equal((await other.get('imports')).length,(await h.get('imports')).length);
  await other.post('data/restore',{archive:exported.text,confirm:'RESTORE'},other.owner,409);
 }finally{await other.close()}
 const empty=await harness(target);try {await empty.post('data/restore',{archive:exported.text.replace('Harbour Workshop','Tampered Workshop'),confirm:'RESTORE'},empty.owner,400);assert.equal((await empty.get()).runs.length,0)}finally{await empty.close()}
});

test('erasure deletes input and decisions, blocks redelivery, and fences an older archive',async()=>{
 const isolated=await harness(target);try{
  const f=await isolated.flow('Erase customer callback'),r=await isolated.run(f,'erase-event',{customer:'Erase me'});await isolated.post(`runs/${r.id}/reject`);
  const exported=await isolated.send('/api/crank/data/export',{},isolated.owner);assert.equal(exported.status,200,exported.text);
  await isolated.post('data/erase',{run_id:r.id,confirm:'ERASE'},isolated.owner,409);await isolated.post(`flows/${f.id}/pause`);
  const erased=await isolated.post('data/erase',{run_id:r.id,confirm:'ERASE'});assert.equal(erased.phase,'complete');const state=await isolated.get();assert.equal(state.runs.length,0);assert.equal(state.approvals.length,0);assert.ok(!JSON.stringify(erased).includes('Erase me'));
  await isolated.post(`flows/${f.id}/activate`);await isolated.post(`flows/${f.id}/runs`,{event_id:'erase-event',input:{}},isolated.owner,409);
  const later=await isolated.send('/api/crank/data/export',{},isolated.owner);assert.equal(later.status,200,later.text);assert.ok(!later.text.includes('Erase me'));assert.ok(JSON.parse(later.text.split('\n')[0]).journal.length>0);
  const empty=await harness(target);try {
   const restored=await empty.send('/api/crank/data/restore',{archive:exported.text,journal:later.text,confirm:'RESTORE'},empty.owner);assert.equal(restored.status,409);assert.match(restored.text,/erasure_epoch|erased_row/);assert.equal((await empty.get()).runs.length,0);
  }finally{await empty.close()}
 }finally{await isolated.close()}
});
