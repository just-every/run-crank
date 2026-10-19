import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {connection, fakeEdge, fakeSecret, jsonResponse, publish, runs, settled, startRun, stepOf, until} from './kit.mjs';

const action = (id, connection_id) => ({id,type:'http',...(connection_id ? {connection_id} : {}),input:{method:'POST',url:'https://authority-receiver.example/'+id,body:{job:'{{trigger.input.job}}'}}});

test('EXEC-001 / TEAM-004: pause and replacement stop queued and running next-step dispatch; only recorded waits retain frozen authority', async()=>{
 const fake=fakeEdge();let unblock;
 fake.routes.set('authority-receiver.example',({url,body})=> url.pathname==='/first' && JSON.parse(body).job==='blocked'
  ? new Promise(resolve=>{unblock=()=>resolve(jsonResponse({id:'first'}))}) : jsonResponse({id:url.pathname}));
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try{
  for(const transition of ['pause','replace']){
   const graph={trigger:{type:'manual'},steps:[action('first'),action('second')]};
   const w=await publish(h,'Harbour invoice '+transition,graph), before=fake.requests.length;
   const running=startRun(h,w,{job:'blocked'});
   await until(()=>unblock && fake.requests.length===before+1,'first action starts');
   const queued=await startRun(h,w,{job:'queued'});assert.equal(queued.status,'queued');
   if(transition==='pause') await h.post(`workflows/${w.id}/pause`);
   else {await h.post(`workflows/${w.id}/draft`,{graph:{...graph,steps:[...graph.steps,action('new_step')]}});await h.post(`workflows/${w.id}/publish`,{},h.owner,201)}
   unblock();unblock=null;
   const stopped=await running;assert.equal(stopped.status,'paused');assert.equal(stopped.error.category,'authority');assert.equal(stopped.error.reconnect,false);
   assert.equal(stepOf(stopped,'first').status,'succeeded');assert.equal(stepOf(stopped,'second'),undefined,'already-started effect stays recorded but no next effect begins');
   await h.tick();const held=await h.get('workflow-runs/'+queued.id);assert.equal(held.status,'paused');assert.deepEqual(held.steps,[]);
   assert.equal(fake.requests.length,before+1,'pause/retirement stops both running next steps and queued dispatch');
   const notices=await h.get('notices');assert.ok(notices.some(n=>n.kind==='run_paused' && n.subject.includes('Workflow authority needed')));
   if(transition==='pause'){
    assert.match(stopped.error.message,/Resume the workflow/);
    await h.post(`workflows/${w.id}/resume`);
    assert.equal((await h.post(`workflow-runs/${stopped.id}/resume`)).status,'succeeded');
    assert.equal(fake.requests.filter(r=>r.url.pathname==='/first' && JSON.parse(r.body).job==='blocked').length,1,'resume preserves the completed checkpoint');
   }else{
    assert.equal((await h.post(`workflow-runs/${stopped.id}/resume`)).status,'paused','manual resume cannot revive replaced authority');
    const fresh=await startRun(h,w,{job:'current'});assert.equal(fresh.status,'succeeded');assert.ok(stepOf(fresh,'new_step'));
   }
  }
  const c=await connection(h,{app:'http',label:'Harbour ledger',auth_kind:'bearer',domains:['authority-receiver.example'],secret:{token:fakeSecret('ledger')}});
  const graph={settings:{waiting_runs:'continue'},trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},action('frozen',c.id)]};
  const w=await publish(h,'Frozen approved continuation',graph), parked=await startRun(h,w,{job:'waiting'});
  await h.post(`workflows/${w.id}/draft`,{graph:{...graph,steps:[...graph.steps,action('later_draft')]}});await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  await h.post(`connections/${c.id}/revoke`);await h.restart();await h.tick(Date.parse(parked.waits[0].due_at)+1);
  const blocked=await h.get('workflow-runs/'+parked.id);assert.equal(blocked.status,'paused');assert.equal(blocked.error.reconnect,true,'retained wait authority still checks live connections');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:fakeSecret('reconnected')}});
  const finished=await h.post(`workflow-runs/${parked.id}/resume`);assert.equal(finished.status,'succeeded');assert.equal(finished.version.number,1);assert.ok(stepOf(finished,'frozen'));assert.equal(stepOf(finished,'later_draft'),undefined);

  const notContinuing=await publish(h,'Cancel-on-pause is not retirement permission',{...graph,settings:{waiting_runs:'cancel_on_pause'}});
  const old=await startRun(h,notContinuing,{job:'no-retirement-authority'});await h.post(`workflows/${notContinuing.id}/publish`,{},h.owner,201);await h.tick(Date.parse(old.waits[0].due_at)+1);
  assert.equal((await h.get('workflow-runs/'+old.id)).error.category,'authority');
  await h.post(`workflows/${notContinuing.id}/pause`);assert.equal((await h.get('workflow-runs/'+old.id)).status,'cancelled');
 }finally{unblock?.();await h.close()}
});

test('EXEC-001 / TEAM-004: pause preserves only existing permitted waits; unpublish ends every continuation and retains the draft and audit',async()=>{
 const fake=fakeEdge();fake.routes.set('authority-receiver.example',()=>jsonResponse({id:'recorded'}));
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try{
  for(const policy of ['continue','cancel_on_new_version']){
   const graph={settings:{waiting_runs:policy},trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},action('permitted')]};
   const w=await publish(h,'Paused wait '+policy,graph), run=await startRun(h,w,{job:policy});
   await h.post(`workflows/${w.id}/pause`);await h.restart();await h.tick(Date.parse(run.waits[0].due_at)+1);
   assert.equal((await h.get('workflow-runs/'+run.id)).status,'succeeded','the chosen existing wait continues on its frozen graph');
  }
  const graph={trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},action('never')]};
  const w=await publish(h,'Unpublish a waiting follow-up',graph), old=await startRun(h,w,{job:'withdrawn'}), count=fake.requests.length;
  const preparer=await h.post('tokens',{label:'Workflow preparation agent',scope:'agent'},h.owner,201);
  const denied=await h.send(`/api/crank/workflows/${w.id}/unpublish`,{},'',{authorization:'Bearer '+preparer.token});
  assert.equal(denied.status,403);assert.equal((await h.get('workflows/'+w.id)).status,'published','preparation authority cannot withdraw production authority');
  const unpublished=await h.post(`workflows/${w.id}/unpublish`);assert.equal(unpublished.status,'draft');assert.equal(unpublished.published_version_id,null);assert.deepEqual(unpublished.draft,graph);assert.ok(unpublished.versions[0].retired_at);
  assert.equal((await h.get('workflow-runs/'+old.id)).status,'cancelled');
  const refused=await h.send(`/api/crank/workflows/${w.id}/run`,{input:{}},h.owner);assert.equal(refused.status,409);
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);await h.restart();await h.tick(Date.parse(old.waits[0].due_at)+1);
  assert.equal((await h.get('workflow-runs/'+old.id)).status,'cancelled');assert.equal(fake.requests.length,count,'republishing cannot revive withdrawn waits');
  assert.ok((await h.get(`audit?kind=workflow&id=${w.id}`)).some(a=>a.action==='workflow.unpublish' && a.version_id===old.version_id));
 }finally{await h.close()}
});

test('TEAM-004: stricter workspace and step USD/recipient caps pause only excess exact actions, counting duplicates without delimiter parsing',async()=>{
 const fake=fakeEdge();fake.routes.set('authority-receiver.example',({body})=>jsonResponse({id:'send-'+fake.requests.length,received:JSON.parse(body)}));
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try{
  await h.post('settings',{caps:[{category:'mail',max_recipients:2},{category:'refund',max_usd:'200.00'}]});
  const mail=limit=>({trigger:{type:'manual'},steps:[{id:'send',type:'http',category:'mail',cap:{max_recipients:limit,recipients:'{{trigger.input.to}}'},input:{method:'POST',url:'https://authority-receiver.example/mail',body:{to:'{{trigger.input.to}}',text:'Harbour quote is ready'}}}]});
  const w=await publish(h,'Quoted supplier mail',mail(5));
  assert.equal((await startRun(h,w,{to:'one@example.test'})).status,'succeeded');
  assert.equal((await startRun(h,w,{to:['one@example.test','two@example.test']})).status,'succeeded','inclusive workspace recipient bound');
  const count=fake.requests.length, duplicates=['one@example.test','one@example.test','one@example.test'];
  const waiting=await startRun(h,w,{to:duplicates});assert.equal(waiting.status,'awaiting_approval');assert.equal(fake.requests.length,count);assert.equal(waiting.waits[0].proposal.recipient_count,3);
  const approved=await h.post(`workflow-runs/${waiting.id}/approve`,{path:'send',digest:waiting.waits[0].proposal_digest});assert.equal(approved.status,'succeeded');assert.deepEqual(JSON.parse(fake.requests.at(-1).body).to,duplicates);
  const own=await publish(h,'One reviewer recipient',mail(1));const pending=await startRun(h,own,{to:['one@example.test','two@example.test']});assert.equal(pending.status,'awaiting_approval','stricter per-step recipient bound');
  const before=fake.requests.length;assert.equal((await h.post(`workflow-runs/${pending.id}/reject`,{path:'send',digest:pending.waits[0].proposal_digest})).status,'rejected');assert.equal(fake.requests.length,before);
  const malformed=await startRun(h,w,{to:'one@example.test,two@example.test'});assert.equal(malformed.status,'failed');assert.equal(malformed.error.category,'validation');assert.equal(fake.requests.length,before);
  for(const [stepCap,amount,expected] of [['500.00','150.00','succeeded'],['500.00','350.00','awaiting_approval'],['100.00','150.00','awaiting_approval']]){
   const refund=await publish(h,'Bounded refund '+stepCap+amount,{trigger:{type:'manual'},steps:[{...action('refund'),category:'refund',cap:{max_usd:stepCap,amount:'{{trigger.input.amount}}'}}]});
   const result=await startRun(h,refund,{job:'refund',amount});assert.equal(result.status,expected,'workspace and per-step USD caps both apply');
  }
  const bad=await h.send('/api/crank/workflows',{name:'Invalid cap',graph:mail(-1)},h.owner);assert.equal(bad.status,422);
 }finally{await h.close()}
});
