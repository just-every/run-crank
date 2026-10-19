import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {harness,freePort} from './harness.mjs';
import {publish} from './kit.mjs';
import {restoreJourney} from './restore-journey.mjs';

// Fake only the external receiver/network edge. Workerd, D1, auth and imports
// run the application's real code, through HTTP requests.
let h, receiver, target, mode='ok'; const effects=new Map(),requests=[];
before(async()=>{
 const port=await freePort();target=`http://127.0.0.1:${port}`;
 receiver=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const key=req.headers['idempotency-key'];requests.push({key,text});
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
  for(const path of [`flows/${f.id}/activate`,`flows/${f.id}/pause`,`runs/${r.id}/approve`,`runs/${r.id}/reject`,`runs/${r.id}/replay`,'tokens','imports/plan','imports/apply','data/export','data/restore','data/erase']) await h.post(path,{},cookie,403);
  await h.post('flows',{name:'Prepared by '+role,source_app:'Support desk',destination_app:'Inbox',target_url:target+'/events'},cookie,role==='admin'?201:403);
 }
 const csrf=await h.send('/api/crank/flows',{name:'CSRF'},h.owner,{origin:'https://foreign.example'});assert.equal(csrf.status,403);
 for(const path of ['imports/plan','data/export']) assert.equal((await h.send('/api/crank/'+path,{},h.owner,{origin:'https://foreign.example'})).status,403);
});

test('SEC-001: private doors need a current session or scoped credential, access/data/import decisions stay the owner\'s, and revocation lands at commit',async()=>{
 for(const door of ['','state','flows','flows/x','flows/x/activate','flows/x/runs','flows/x/trigger','runs/x','runs/x/approve','runs/x/replay','tokens','tokens/x/revoke','imports','imports/plan','imports/apply','data/export','data/restore','data/erase',
  'historical','historical/x','workflows','workflows/x','workflows/x/publish','workflows/x/run','workflow-runs','workflow-runs/x','workflow-runs/x/resume','connections','connections/x','oauth/start','oauth/callback','oauth/apps/slack','hooks','holds/x','queues','catalog','coverage','settings','audit','notices','reports'])
  for(const input of [undefined,{}]) assert.equal((await h.send('/api/crank'+(door&&'/'+door),input)).status,401,`SEC-001 signed-out ${input?'POST':'GET'} /api/crank/${door}`);
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
  for(const path of ['tokens','tokens/'+agent.id+'/revoke','imports/plan','imports/apply','data/export','data/restore','data/erase']) assert.equal((await h.send('/api/crank/'+path,{},cookie,headers)).status,403,`SEC-001 ${who} ${path}`);
 }
 assert.equal(await people(),before,'no lower role changed who may sign in');assert.equal((await h.get()).tokens.length,tokens);
 assert.ok(!h.mail.some(m=>m.to.includes('uninvited@example.test')),'no invitation was sent');
 const flows=(await h.get()).flows.length;
 for(const origin of ['https://foreign.example','null',h.origin.replace('127.0.0.1','localhost')]) for(const [path,input] of [['/api/crank/flows',{name:'SEC-001 cross-site',source_app:'Support desk',destination_app:'Inbox',target_url:target+'/events'}],['/api/crank/tokens',{label:'Cross-site',scope:'agent'}],['/api/crank/data/export',{}],['/api/crank/imports/plan',{}]])
  assert.equal((await h.send(path,input,h.owner,{origin})).status,403,`SEC-001 ${origin} ${path}`);
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
 for(const path of [`runs/${run.id}/approve`,`runs/${run.id}/reject`,`runs/${run.id}/replay`,`flows/${f.id}/activate`,'tokens','imports/plan','data/export','data/erase'])await h.post(path,{},'',403,a);
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
test('n8n dry run changes nothing; human-approved import has a durable journal and undo removes unused drafts',async()=>{
 const input={namespace:'move-in',source:await source()},before=(await h.get()).flows.length;
 const plan=await h.post('imports/plan',input);assert.equal((await h.get()).flows.length,before);
 const job=await h.post('imports/apply',{...input,fingerprint:plan.fingerprint});assert.equal(job.state,'completed');assert.equal((await h.get()).flows.length,before+1);
 const journal=await h.get('imports');assert.equal(journal.find(x=>x.id===job.id).approvedBy,(await h.get()).actor.id);
 assert.equal((await h.post(`imports/${job.id}/undo`)).state,'undone');assert.equal((await h.get()).flows.length,before);
});

test('n8n refuses unreviewed input, credential exports and changed or used targets on undo',async()=>{
 const input={namespace:'guarded-import',source:await source()},plan=await h.post('imports/plan',input);
 await h.post('imports/apply',{...input,source:input.source.replace('Receive an event','Changed event'),fingerprint:plan.fingerprint},h.owner,400);
 const credential=JSON.parse(input.source);credential.nodes[1].credentials={httpHeaderAuth:{id:'example-reference'}};await h.post('imports/plan',{...input,source:JSON.stringify(credential)},h.owner,400);
 const expression=JSON.parse(input.source);expression.nodes[1].parameters.jsonBody='={{ $json.body.customer }}';await h.post('imports/plan',{...input,source:JSON.stringify(expression)},h.owner,400);
 const job=await h.post('imports/apply',{...input,fingerprint:plan.fingerprint});const flow=(await h.get()).flows.find(x=>x.name==='Receive an event and forward its JSON body');assert.ok(flow);await h.post(`flows/${flow.id}/activate`);await h.run(flow,'imported-event');
 const undone=await h.send(`/api/crank/imports/${job.id}/undo`,{},h.owner);assert.ok(undone.status>=400 || undone.value.state!=='undone');assert.ok((await h.get()).flows.some(x=>x.id===flow.id));
});

test('DATA-001: complete portable inventory, inactive restore, explicit per-run adoption and atomic refusal',async()=>{
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
