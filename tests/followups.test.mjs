import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';
import {archive} from './restore-journey.mjs';

async function join(h,name) {
 const email=name.toLowerCase().replaceAll(' ','-')+'@example.test';
 assert.equal((await h.send('/auth/invite',{email,displayName:name,role:'member'},h.owner)).status,202);
 const mail=h.mail.findLast(m=>m.to.includes(email)),link=mail.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const result=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(result.status,303);
 return {cookie:result.cookie,id:(await h.get('state',result.cookie)).actor.id};
}
const scope=(h,p,role,w)=>h.post('team/'+p.id,{role,workflow_ids:[w.id],connection_ids:[]});
const calendar=(h,p,extra={})=>h.post('followups/people/'+p.id,{timezone:'Australia/Brisbane',weekdays:[1,2,3,4,5],start:'09:00',end:'17:00',...extra});
const follow=(h,r,people,due,extra={})=>h.post('followups',{run_id:r.id,path:'review',due_at:new Date(due).toISOString(),recipient_ids:people.map(p=>p.id),...extra},h.owner,201);
const decide=(h,r,p,extra={},status=200)=>h.post('workflow-runs/'+r.id+'/approve',{path:'review',digest:r.waits[0].proposal_digest,...extra},p.cookie,status);
const contacts=async(h,id)=> (await h.get('followups')).followups.find(f=>f.id===id).contacts;
const graph={trigger:{type:'manual'},steps:[{id:'review',type:'approval',editable:['tax_fact'],input:{tax_fact:''}},{id:'record',type:'map',input:{tax_fact:'{{steps.review.proposal.tax_fact}}'}}]};
function friday() {
 const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()+((5-d.getUTCDay()+7)%7||7));return d.getTime();
}
const portable=new Set(['crank_agent_followups','crank_agent_followup_recipients','crank_agent_followup_contacts']);
const local=new Set(['crank_agent_followup_people','crank_agent_followup_authorizations','crank_agent_followup_admissions']);
const records=text=>text.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row');
const portableRecords=text=>records(text).filter(item=>portable.has(item.table)).map(({table,row})=>JSON.stringify({table,row})).sort();

test('AGENT-004: weekend silence, durable Monday notice, concurrent aggregate daily admission, unanswered escalation and native employee answer continue exactly once',async()=>{
 const edge=fakeEdge();edge.routes.set('tax-registration.example',()=>jsonResponse({accepted:true}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});
 try {
  const employee=await join(h,'Followup employee'),manager=await join(h,'Followup manager'),outsider=await join(h,'Followup outsider');
  const w=await publish(h,'Customer tax choice',{...graph,steps:[...graph.steps,{id:'register',type:'http',input:{method:'POST',url:'https://tax-registration.example/record',body:{tax_fact:'{{steps.review.proposal.tax_fact}}'}}}]});
  await scope(h,employee,'approver',w);await h.post('team/'+manager.id,{role:'viewer',workflow_ids:[],connection_ids:[]});await scope(h,outsider,'viewer',w);
  await calendar(h,employee);await calendar(h,manager);
  const r=await startRun(h,w,{}),other=await startRun(h,w,{}),fri=friday(),mon=fri+3*86400000-3600000,tue=mon+86400000;
  const f=await follow(h,r,[employee],fri+6*3600000,{escalate_at:new Date(tue).toISOString(),escalation_ids:[manager.id]});
  await follow(h,other,[employee],fri+7*3600000);
  const inviteMail=h.mail.length;
  await h.tick(fri+8*3600000);await h.tick(fri+86400000);await h.tick(mon-60000);
  assert.deepEqual(await h.get('inbox',employee.cookie),[]);assert.deepEqual(await h.get('inbox'),[],'owner never sees another person’s inbox');
  // This is a real storage abort inside the transaction, after admission but
  // before its durable notice. No application behavior is mocked.
  await h.db.exec(`CREATE TRIGGER interrupt_followup_contact BEFORE INSERT ON crank_agent_followup_contacts BEGIN SELECT RAISE(ABORT,'test followup storage interruption'); END;`);
  try {
   const knownOperations=new Set((await h.get('audit')).filter(a=>a.subject_kind==='operation').map(a=>a.subject_id));
   // workerd scheduled() resolves with {outcome:'exception'} on a Worker
   // failure; harness.tick intentionally discards that result. Observe the
   // actual Cron result and its durable failed operation through public doors.
   const cron=await (await h.mf.getWorker()).scheduled({scheduledTime:new Date(mon),cron:'* * * * *'});
   assert.equal(cron.outcome,'exception','storage abort must be reported as a failed Cron');
   const audit=await h.get('audit'),started=audit.filter(a=>a.action==='operation.started' && a.detail.kind==='scheduler' && !knownOperations.has(a.subject_id));
   assert.equal(started.length,1);
   assert.ok(audit.some(a=>a.action==='operation.failed' && a.subject_id===started[0].subject_id),'failed Cron must retain a durable failed outcome');
   assert.ok(!audit.some(a=>a.action==='operation.finished' && a.subject_id===started[0].subject_id),'failed Cron must never report successful completion');
   assert.deepEqual(await h.get('inbox',employee.cookie),[]);
   assert.deepEqual(await contacts(h,f.id),[]);
   assert.ok((await h.get('audit')).every(a=>a.action!=='followup.contact'),'failed contact transaction leaves no fabricated communication audit');
  } finally {await h.db.exec('DROP TRIGGER interrupt_followup_contact')}
  await h.restart();await Promise.all([h.tick(mon),h.tick(mon)]);
  const notices=await h.get('inbox',employee.cookie);assert.equal(notices.length,1);assert.equal(notices[0].followup_id,f.id);assert.equal(notices[0].kind,'initial');
  assert.equal(notices[0].link,new URL(notices[0].link,h.origin).pathname+'#step-review');
  await h.tick(mon+3600000);assert.equal((await h.get('inbox',employee.cookie)).length,1,'default aggregate cap covers two obligations');
  assert.equal((await h.get('followups',outsider.cookie)).followups.length,0);
  await h.get('workflow-runs/'+r.id,employee.cookie);
  await decide(h,r,outsider,{},403);await h.post('followups/'+f.id+'/revoke',{},employee.cookie,403);
  await h.tick(tue);await h.tick(tue+1);
  const escalation=await h.get('inbox',manager.cookie);assert.equal(escalation.length,1);assert.equal(escalation[0].kind,'escalation');
  await h.get('workflow-runs/'+r.id,manager.cookie,403);await decide(h,r,manager,{},403);
  assert.equal(edge.requests.length,0,'agent contacts never execute the waiting business action');
  const finished=await decide(h,r,employee,{edits:{tax_fact:'registration-on-file'}});assert.equal(finished.status,'succeeded');assert.equal(stepOf(await h.get('workflow-runs/'+r.id),'record').output.tax_fact,'registration-on-file');
  assert.equal(edge.requests.length,1);assert.equal(JSON.parse(edge.requests[0].body).tax_fact,'registration-on-file');
  await decide(h,r,employee,{edits:{tax_fact:'late-change'}},409);
  const count=(await contacts(h,f.id)).length;
  await h.tick(tue+86400000);await h.restart();await h.tick(tue+2*86400000);
  assert.equal(edge.requests.length,1,'late duplicate and later Cron passes never repeat the approved business effect');
  assert.equal((await contacts(h,f.id)).length,count);assert.equal((await h.get('followups')).followups.find(x=>x.id===f.id).status,'completed');
  const audit=(await h.get('audit')).filter(a=>a.action==='followup.contact');
  const total=(await h.get('followups')).followups.flatMap(f=>f.contacts).length;assert.equal(audit.length,total);assert.ok(audit.every(a=>a.actor_id==='system:agent-followup' && a.detail.owner_id));
  assert.equal(h.mail.length,inviteMail,'follow-up never invokes external email');
  assert.ok(!JSON.stringify((await h.get('followups')).followups).includes('registration-on-file'),'references/history carry no answer values');
 } finally {await h.close()}
});

test('AGENT-004 DATA-001: revoke and deactivation permanently fence contact authority; full portable history restores inactive without calendars, authorizations or daily admission authority',async()=>{
 const h=await harness('http://127.0.0.1:9');let restored;
 try {
  const person=await join(h,'Revoked followup employee'),w=await publish(h,'Restorable waiting tax fact',graph);await scope(h,person,'approver',w);await calendar(h,person);
  const fri=friday(),mon=fri+3*86400000-3600000,r=await startRun(h,w,{}),f=await follow(h,r,[person],mon);
  await h.tick(mon);assert.equal((await contacts(h,f.id)).length,1);
  await h.post('followups/'+f.id+'/revoke');await h.tick(mon+86400000);assert.equal((await contacts(h,f.id)).length,1);assert.equal((await h.get('workflow-runs/'+r.id)).status,'awaiting_approval','revoking contacts leaves the human decision pending');
  const pending=await startRun(h,w,{}),active=await follow(h,pending,[person],mon+86400000);
  assert.equal((await h.send('/auth/operator/status',{operatorId:person.id,status:'inactive'},h.owner)).status,200);
  // Reactivation before the scheduler observes deactivation still changes the
  // native operator version, permanently fencing the original authorization.
  assert.equal((await h.send('/auth/operator/status',{operatorId:person.id,status:'active'},h.owner)).status,200);
  await h.tick(mon+86400000);await h.restart();await h.tick(mon+2*86400000);
  assert.deepEqual(await contacts(h,active.id),[]);assert.equal((await h.get('followups')).followups.find(x=>x.id===active.id).status,'inactive');
  const live=await follow(h,pending,[person],mon+2*86400000);await h.tick(mon+2*86400000);assert.equal((await contacts(h,live.id)).length,1,'only a new explicit owner authorization restores contact authority');
  const text=await archive(h),rows=records(text);assert.ok(rows.every(item=>!local.has(item.table)));
  const obligations=rows.filter(item=>item.table==='crank_agent_followups');assert.equal(obligations.length,3);assert.ok(obligations.every(item=>item.row.status==='inactive'));
  for(const item of obligations) {
   const expected=(await h.get('followups')).followups.find(f=>f.id===item.row.id);
   assert.deepEqual(item.row,{id:expected.id,run_id:expected.run_id,path:expected.path,due_at:expected.due_at,escalate_at:expected.escalate_at,status:'inactive',created_by:expected.created_by,created_at:expected.created_at});
  }
  assert.ok(rows.some(item=>item.table==='crank_agent_followup_contacts' && item.row.followup_id===live.id));
  restored=await harness('http://127.0.0.1:9');await restored.post('data/restore',{confirm:'RESTORE',archive:text});
  assert.deepEqual(portableRecords(await archive(restored)),portableRecords(text),'all portable reference/history fields survive inactive restore');
  assert.deepEqual((await restored.get('followups')).people,[]);assert.deepEqual(await restored.get('inbox'),[]);
  await restored.restart();await restored.tick(mon+3*86400000);assert.deepEqual(portableRecords(await archive(restored)),portableRecords(text));
  const adopted=await restored.get('workflows/'+w.id);
  await restored.post(`workflows/${w.id}/publish`,{restore_snapshot:adopted.restore.snapshot,restore_decisions:{[r.id]:'resume',[pending.id]:'resume'}},restored.owner,201);
  await restored.tick(mon+4*86400000);assert.deepEqual(portableRecords(await archive(restored)),portableRecords(text),'run adoption does not silently reauthorize follow-ups');
  await h.post('workflow-runs/'+pending.id+'/cancel');await h.post('workflows/'+w.id+'/pause');
  const erased=await h.post('data/erase',{workflow_run_id:pending.id,confirm:'ERASE'});assert.equal(erased.phase,'complete');
  const retained=(await h.get('followups')).followups;
  assert.ok(retained.every(row=>row.run_id!==pending.id),'run erasure traverses follow-up references and all contact history');
  await h.get('workflow-runs/'+pending.id,h.owner,404);
  await h.post('workflows/'+w.id+'/resume');await calendar(h,person,{interval_minutes:1});
  const replacement=await startRun(h,w,{}),replacementFollowup=await follow(h,replacement,[person],mon+2*86400000+3600000);
  await h.tick(mon+2*86400000+3600000);
  assert.deepEqual(await contacts(h,replacementFollowup.id),[],'erasing the admitted run never replenishes the aggregate local-day cap');
  const takeover=await decide(h,replacement,{cookie:h.owner},{edits:{tax_fact:'owner-reviewed-registration'}});
  assert.equal(takeover.status,'succeeded','owner takes over through the original human decision, never an agent approval');
  await h.tick(mon+3*86400000);
  assert.equal((await h.get('followups')).followups.find(x=>x.id===replacementFollowup.id).status,'completed');
  assert.equal((await h.send('/auth/operator/status',{operatorId:person.id,status:'inactive'},h.owner)).status,200);
  const removal=await h.post('data/erase',{operator_id:person.id,confirm:'ERASE'});assert.ok(removal.label);
  const remaining=(await archive(h));
  assert.ok(!remaining.includes(person.id),'operator erasure removes portable recipient and audit references');
  await h.get('inbox',person.cookie,401);

 } finally {await restored?.close();await h.close()}
});

test('AGENT-004: explicit calendar, overnight start/end boundaries, holiday silence and local-date daily cap across a DST repeated hour',async()=>{
 const h=await harness('http://127.0.0.1:9');
 try {
  const p=await join(h,'Night shift employee'),w=await publish(h,'Night review',graph);await scope(h,p,'approver',w);
  const r=await startRun(h,w,{});
  await h.post('followups/people/'+p.id,{weekdays:[5],start:'22:00',end:'06:00'},h.owner,422);
  await h.post('followups',{run_id:r.id,path:'review',due_at:new Date().toISOString(),recipient_ids:[p.id]},h.owner,422);
  let year=new Date().getUTCFullYear(),sunday;
  for(;;year++) {
   const nov=new Date(Date.UTC(year,10,1));nov.setUTCDate(1+(7-nov.getUTCDay())%7);
   if(nov.getTime()>Date.now()){sunday=nov;break}
  }
  const day=sunday.toISOString().slice(0,10),base=sunday.getTime();
  const policy={timezone:'America/New_York',weekdays:[6],start:'22:00',end:'06:00',interval_minutes:1,daily_limit:1};
  await calendar(h,p,policy);
  const f=await follow(h,r,[p],base+3600000);
  await h.tick(base+2*3600000-60000);assert.deepEqual(await contacts(h,f.id),[]);
  await h.tick(base+2*3600000);assert.equal((await contacts(h,f.id)).length,1,'overnight start is inclusive on Saturday local date');
  await h.tick(base+5.5*3600000);assert.equal((await contacts(h,f.id)).length,2,'new local date has its own aggregate admission');
  await h.tick(base+6.5*3600000);assert.equal((await contacts(h,f.id)).length,2,'repeated 1:30am cannot replenish the local-day cap');
  await calendar(h,p,{...policy,daily_limit:10,holiday_dates:[day]});
  await h.tick(base+11*3600000-60000);assert.equal((await contacts(h,f.id)).length,2,'holiday suppresses an otherwise open shift');
  await calendar(h,p,{...policy,daily_limit:10});
  await h.tick(base+11*3600000-60000);assert.equal((await contacts(h,f.id)).length,3,'Sunday early morning belongs to Saturday overnight shift');
  await h.tick(base+11*3600000);assert.equal((await contacts(h,f.id)).length,3,'overnight end is exclusive');
  await h.tick(base+27*3600000);assert.equal((await contacts(h,f.id)).length,3,'Sunday overnight start is outside the chosen starting weekdays');
 } finally {await h.close()}
});
