import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {archive} from './restore-journey.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

export const codeGraph=(connection_id,extra={})=>({trigger:{type:'manual'},steps:[{id:'normalize',type:'code',connection_id,executor_url:'https://executor.example',language:'python',source:'def main(input): return {"customer": input["customer"].strip()}',timeout_ms:10000,memory_mb:128,allowed_egress:[],input:{customer:'{{trigger.input.customer}}'},...extra},{id:'retain',type:'map',input:{result:'{{steps.normalize.output}}'}}]});

test('WORK-005 EXEC-002 BASE-001: published executor work keeps one durable identity across lost responses/restart, checks live connection authority and discloses values without secrets',async()=>{
 const edge=fakeEdge(),tasks=new Map(),token=fakeSecret('executor'),submitted=[];let lose=true;
 edge.routes.set('executor.example',({url,method,body,headers})=>{
  assert.equal(headers.authorization,'Bearer '+token);
  const task_id=url.pathname.split('/')[2];
  if(method==='POST'){
   const job=JSON.parse(body);submitted.push(task_id);
   if(!tasks.has(task_id))tasks.set(task_id,{task_id,status:'running',input:job.input});
   if(lose){lose=false;return new Response('Response lost after durable task creation',{status:500})}
  }
  const task=tasks.get(task_id);return task?jsonResponse({task_id,status:task.status,...(task.status==='succeeded'?{output:{customer:task.input.customer.trim()}}:{})}):jsonResponse({error:'not_found'},404);
 });
 const h=await harness('https://unused.example',{edge:edge.edge});
 try{
  const account=await connection(h,{app:'http',label:'Harbour isolated code host',auth_kind:'bearer',domains:['executor.example'],secret:{token}});
  const w=await publish(h,'Harbour Workshop — customer normalization',codeGraph(account.id));
  const run=await startRun(h,w,{customer:'  Harbour Workshop & Supply  '});assert.equal(run.status,'waiting',JSON.stringify(run));
  const task=run.executor_tasks[0];assert.equal(task.status,'running');assert.equal(stepOf(run,'normalize').trace.executor_task_id,task.id);
  assert.equal(new Set(submitted).size,1);assert.ok(submitted.length>=1);
  const requestCount=edge.requests.length;await h.tick(Date.now());assert.equal(edge.requests.length,requestCount,'no early task poll');
  await h.restart();tasks.get(task.id).status='succeeded';await h.tick(Date.now()+61000);
  const done=await h.get('workflow-runs/'+run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(stepOf(done,'retain').output.result,{customer:'Harbour Workshop & Supply'});
  assert.equal(new Set(submitted).size,1,'reconciliation never launches a new remote task');assert.ok(!JSON.stringify(done).includes(token));
  const inventory=await h.get('data/flows');assert.ok(inventory.flows.some(flow=>flow.kind==='code'&&flow.recipients.includes('https://executor.example')&&flow.fields.includes('source')));assert.ok(!JSON.stringify(inventory).includes('def main'));
  const pending=await startRun(h,w,{customer:'Revoked while waiting'});await h.post(`connections/${account.id}/revoke`);const before=edge.requests.length;await h.tick(Date.now()+120000);
  assert.equal((await h.get('workflow-runs/'+pending.id)).status,'paused');assert.equal(edge.requests.length,before,'live revocation refuses the next physical request');
  const bad=await h.send('/api/crank/workflows',{name:'No implicit egress',graph:codeGraph(account.id,{allowed_egress:['https://unapproved.example']})},h.owner);assert.equal(bad.status,422);
 }finally{await h.close()}
});

test('WORK-005 DATA-001 DATA-002: cancellation reports remote confirmation, task references restore inactive and erase with their run',async()=>{
 const edge=fakeEdge(),tasks=new Map();let cancelled=0,refuseCancellation=false;
 edge.routes.set('executor.example',({url,method})=>{
  const task_id=url.pathname.split('/')[2];
  if(url.pathname.endsWith('/cancel')){cancelled++;if(refuseCancellation)return jsonResponse({error:'service unavailable'},503);tasks.set(task_id,{task_id,status:'cancelled'})}
  else if(method==='POST')tasks.set(task_id,{task_id,status:'running'});
  return tasks.has(task_id)?jsonResponse(tasks.get(task_id)):jsonResponse({error:'not_found'},404);
 });
 const h=await harness('https://unused.example',{edge:edge.edge});let receiving;
 try{
  const c=await connection(h,{app:'http',label:'Owner Linux executor',auth_kind:'bearer',domains:['executor.example'],secret:{token:fakeSecret('executor')}}),w=await publish(h,'Long-running customer normalization',codeGraph(c.id));
  const run=await startRun(h,w,{customer:'Harbour Workshop'}),pending=await startRun(h,w,{customer:'Restore remains inactive'});
  const stopped=await h.post(`workflow-runs/${run.id}/cancel`);assert.equal(stopped.status,'cancelled');assert.equal(stopped.executor_tasks[0].status,'cancelled');assert.equal(cancelled,1);
  const after=edge.requests.length;await h.tick(Date.now());assert.equal(edge.requests.length,after,'cancelled work never resumes');
  const uncertain=await startRun(h,w,{customer:'Cancellation needs remote inspection'});refuseCancellation=true;
  const unconfirmed=await h.post(`workflow-runs/${uncertain.id}/cancel`);assert.equal(unconfirmed.executor_tasks[0].status,'cancel_unconfirmed');const attempts=cancelled;await h.tick(Date.now());assert.equal(cancelled,attempts,'no early cancellation retry');await Promise.all([h.tick(Date.now()+61000),h.tick(Date.now()+61000)]);const exhausted=cancelled;await h.tick(Date.now()+180000);assert.equal(cancelled,exhausted,'cancellation attempts remain bounded across concurrent Cron passes');assert.equal((await h.get('workflow-runs/'+uncertain.id)).executor_tasks[0].status,'cancel_unconfirmed');refuseCancellation=false;
  const exported=await archive(h);const items=exported.trim().split('\n').map(JSON.parse).flatMap(p=>p.items??[]),refs=items.filter(i=>i.kind==='row'&&i.table==='crank_executor_tasks');assert.equal(refs.length,3);assert.ok(refs.every(i=>i.row.active===0));
  const archivedRequests=edge.requests.length;
  receiving=await harness('https://unused.example',{edge:edge.edge});await receiving.post('data/restore',{archive:exported,confirm:'RESTORE'});
  assert.equal(edge.requests.length,archivedRequests,'restored task references never contact the source executor');assert.equal((await receiving.get('workflow-runs/'+pending.id)).status,'paused');
  const portableRows=text=>text.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row').map(({table,row})=>JSON.stringify({table,row})).sort();
  const original=portableRows(exported),received=portableRows(await archive(receiving)),added=received.filter(row=>!original.includes(row));
  assert.deepEqual(added.map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
  assert.deepEqual(received.filter(row=>!added.includes(row)),original,'every portable record, including complete task references and counters, survives inactive restore');
  await receiving.restart();await receiving.tick(Date.now()+86400000);assert.equal(edge.requests.length,archivedRequests,'restart and Cron cannot activate restored executor tasks');
  await h.post(`workflow-runs/${pending.id}/cancel`);await h.post(`workflows/${w.id}/pause`);await h.post('data/erase',{workflow_run_id:run.id,confirm:'ERASE'});
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_executor_tasks WHERE run_id=?').bind(run.id).first()).n,0,'erasure removes local remote-task references');
 }finally{await receiving?.close();await h.close()}
});
