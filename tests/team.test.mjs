import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {publish,connection,fakeSecret} from './kit.mjs';

async function invite(h,name,baseRole='member') {
 const invited=await h.send('/auth/invite',{email:name.toLowerCase().replaceAll(' ','-')+'@example.test',displayName:name,role:baseRole},h.owner);
 assert.equal(invited.status,202,invited.text);
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const token=new URL(link,h.origin).searchParams.get('token');
 const signed=await h.send('/auth/confirm',{token});
 assert.equal(signed.status,303,signed.text);
 const people=await h.send('/auth/operators',undefined,h.owner);
 return {id:people.value.find(p=>p.displayName===name).id,cookie:signed.cookie};
}

test('TEAM-001: product scopes fence direct reads, lists, publication, review and next-request changes; transfer survives departure',async()=>{
 const h=await harness('http://127.0.0.1:9');
 try{
  const graph={trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{amount:'25.00'}},{id:'record',type:'map',input:{approved:true}}]};
  const restricted=await publish(h,'Harbour supplier settlement — restricted',graph),other=await publish(h,'Other department payroll facts',graph);
  const c=await connection(h,{app:'http',label:'Harbour finance account',auth_kind:'bearer',domains:['finance.example'],secret:{token:fakeSecret('private-finance')}});
  const hidden=await connection(h,{app:'http',label:'Other department account',auth_kind:'bearer',domains:['other.example'],secret:{token:fakeSecret('hidden-account')}});
  const builder=await invite(h,'Dana Reyes'),viewer=await invite(h,'Morgan Lee'),approver=await invite(h,'Alex Rivera'),operator=await invite(h,'Casey Nguyen');
  const scope=(person,role,workflow_ids=[restricted.id],connection_ids=[c.id])=>h.post('team/'+person.id,{role,workflow_ids,connection_ids});
  for(const [person,role] of [[builder,'builder'],[viewer,'viewer'],[approver,'approver'],[operator,'operator']]) await scope(person,role);
  for(const person of [builder,viewer,approver,operator]){
   assert.deepEqual((await h.get('workflows',person.cookie)).map(w=>w.id),[restricted.id]);
   assert.deepEqual((await h.get('connections',person.cookie)).map(c=>c.id),[c.id]);
   await h.get('workflows/'+other.id,person.cookie,403);
   assert.equal((await h.send('/api/crank/workflows/'+other.id+'/draft',{name:'Forbidden'},person.cookie)).status,403);
   await h.get('audit',person.cookie,403);await h.get('team',person.cookie,403);
   assert.deepEqual((await h.get('state',person.cookie)).runs,[]);
  }
  await h.post(`workflows/${restricted.id}/draft`,{name:'Harbour supplier settlement — reviewed draft'},builder.cookie);
  const published=await h.post(`workflows/${restricted.id}/publish`,{},builder.cookie,201);
  assert.equal(published.version.authority.publisher,builder.id);
  const bound={trigger:{type:'manual'},steps:[{id:'send',type:'http',connection_id:hidden.id,input:{url:'https://other.example/events',method:'POST',body:{}}}]};
  await h.post(`workflows/${restricted.id}/draft`,{graph:bound},builder.cookie);
  assert.equal((await h.send(`/api/crank/workflows/${restricted.id}/publish`,{},builder.cookie)).status,403,'binding an unshared connection refuses publication');
  await h.post(`workflows/${restricted.id}/draft`,{graph},builder.cookie);
  await h.post(`workflows/${restricted.id}/publish`,{},builder.cookie,201);
  const run=await h.post(`workflows/${restricted.id}/run`,{input:{tax_fact:'pending'}},operator.cookie,201);
  const detail=await h.get('workflow-runs/'+run.id,viewer.cookie);assert.equal(detail.trigger,undefined);assert.equal(detail.payload,'restricted');
  const decision={path:'review',digest:run.waits[0].proposal_digest};
  for(const person of [viewer,builder,operator]) assert.equal((await h.send(`/api/crank/workflow-runs/${run.id}/approve`,decision,person.cookie)).status,403);
  assert.equal((await h.post(`workflow-runs/${run.id}/approve`,decision,approver.cookie)).status,'succeeded');
  const own=await h.post(`workflows/${restricted.id}/run`,{input:{}},operator.cookie,201);
  await scope(operator,'approver');
  assert.equal((await h.send(`/api/crank/workflow-runs/${own.id}/approve`,{path:'review',digest:own.waits[0].proposal_digest},operator.cookie)).status,403,'run starter cannot gain self-approval by changing roles');
  await scope(approver,'approver',[]);assert.equal((await h.send(`/api/crank/workflow-runs/${own.id}/approve`,{path:'review',digest:own.waits[0].proposal_digest},approver.cookie)).status,403);
  assert.deepEqual((await h.get('workflow-runs',approver.cookie)).runs,[]);
  await h.post('team/transfer',{workflow_id:restricted.id,new_owner_id:viewer.id});
  assert.equal((await h.get('workflows/'+restricted.id)).owner.id,viewer.id);
  const deactivated=await h.send('/auth/operator/status',{operatorId:builder.id,status:'inactive'},h.owner);assert.equal(deactivated.status,200,deactivated.text);
  assert.equal((await h.send('/api/crank/workflows/'+restricted.id,undefined,builder.cookie)).status,401);
  assert.equal((await h.get('workflows/'+restricted.id)).status,'published');
  await h.restart();assert.equal((await h.get('workflows/'+restricted.id)).owner.id,viewer.id);
  assert.equal((await h.post(`workflow-runs/${own.id}/reject`,{path:'review',digest:own.waits[0].proposal_digest})).status,'rejected');
  const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='team.scope'));assert.ok(audit.some(a=>a.action==='workflow.transfer'));
  const archive=await h.post('data/export');assert.ok(!JSON.stringify(archive).includes('private-finance'));assert.ok(!JSON.stringify(archive).includes('hidden-account'));
  assert.ok(!archive.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>item.kind==='row'&&item.table==='crank_team_access'));
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});assert.equal(setup.status,303);
  const page=await h.send('/app/access',undefined,h.owner);assert.equal(page.status,200);assert.match(page.text,/Team workflow access/);
 }finally{await h.close()}
});
