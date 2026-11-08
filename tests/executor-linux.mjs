/** WORK-005 real Linux service and published Worker journey. Run through heavy-slot. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {linuxExecutor} from './executor-fixture.mjs';
import {harness} from './harness.mjs';
import {connection,publish,startRun,stepOf,until,fakeSecret,doorImport,door} from './kit.mjs';
import {conversionExport,isolatedCodeChoice,originalCodeExport,originalCodeChoice} from './n8n-graph-fixture.mjs';

const executor=await linuxExecutor();let h,second,undelegated;
const taskId=()=>createHash('sha256').update(crypto.randomUUID()).digest('hex');
const payload=(source,extra={})=>({language:'python',source,input:{customer:'  Harbour Workshop & Supply  '},timeout_ms:2000,memory_mb:128,allowed_egress:[],...extra});
const terminal=async id=>until(async()=>{const r=await executor.call('/tasks/'+id);return ['succeeded','failed','cancelled','interrupted'].includes(r.value.status)?r.value:null},'remote terminal task',10000);
try{
 assert.equal((await executor.call('/tasks/'+taskId(),undefined,fakeSecret('wrong'))).status,401);
 const python=taskId(),job=payload('def main(input): return {"customer": input["customer"].strip()}');
 await executor.call('/tasks/'+python,job);const pythonResult=await terminal(python);assert.deepEqual(pythonResult.output,{customer:'Harbour Workshop & Supply'},JSON.stringify(pythonResult));
 assert.equal((await executor.call('/tasks/'+python,job)).value.task_id,python);assert.equal((await executor.call('/tasks/'+python,{...job,input:{customer:'different'}})).status,409);
 for(const language of ['javascript','typescript']){const id=taskId();await executor.call('/tasks/'+id,payload(language==='typescript'?'export default function(input: {customer: string}) {return {customer:input.customer.trim()}}':'export default function(input) {return {customer:input.customer.trim()}}',{language,memory_mb:1024}));const actual=await terminal(id);assert.deepEqual(actual.output,{customer:'Harbour Workshop & Supply'},language+JSON.stringify(actual))}
 for(const [name,source,extra] of [
  ['wall deadline','def main(input):\n while True: pass',{timeout_ms:300}],
  ['memory bound','def main(input): return bytearray(1024*1024*512)',{memory_mb:64}],
  ['host secret','def main(input):\n import os\n return open("/etc/passwd").read()',{}],
  ['other tasks','def main(input):\n import os\n return os.listdir("/data/tasks")',{}],
  ['network refusal','def main(input):\n import socket\n return socket.create_connection(("1.1.1.1",443),timeout=1).fileno()',{}],
 ]){const id=taskId();await executor.call('/tasks/'+id,payload(source,extra));const result=await terminal(id);assert.equal(result.status,'failed',name);assert.ok(!JSON.stringify(result).includes(executor.token),name)}
 const env=taskId();await executor.call('/tasks/'+env,payload('def main(input):\n import os\n return dict(os.environ)'));assert.ok(!JSON.stringify((await terminal(env)).output).includes(executor.token));
 const cancelled=taskId();await executor.call('/tasks/'+cancelled,payload('def main(input):\n import time\n time.sleep(30)\n return "too late"',{timeout_ms:60000}));assert.equal((await executor.call('/tasks/'+cancelled+'/cancel',{})).value.status,'cancelled');
 const tombstone=taskId();await executor.call('/tasks/'+tombstone+'/cancel',{});assert.equal((await executor.call('/tasks/'+tombstone,job)).value.status,'cancelled');
 const interrupted=taskId();await executor.call('/tasks/'+interrupted,payload('def main(input):\n import time\n time.sleep(30)\n return "too late"',{timeout_ms:60000}));await executor.restart(true);assert.equal((await executor.call('/tasks/'+interrupted)).value.status,'interrupted');assert.equal((await executor.call('/tasks/'+interrupted,payload('def main(input):\n import time\n time.sleep(30)\n return "too late"',{timeout_ms:60000}))).value.status,'interrupted');
 // Forked private allocations exceed the aggregate while every process remains
 // below its original address-space ceiling. Children sleep rather than burn CPU.
 const forked=`def main(input):
 import os, time
 children = []
 for n in range(4):
  pid = os.fork()
  if pid == 0:
   allocation = bytearray(24 * 1024 * 1024)
   time.sleep(3)
   os._exit(0)
  children.append(pid)
 for pid in children: os.waitpid(pid, 0)
 return {"children": len(children)}`;
 const quotaJob=payload(forked,{memory_mb:128,aggregate_memory_mb:64,timeout_ms:10000});
 const oom=taskId();await executor.call('/tasks/'+oom,quotaJob);
 const limited=await terminal(oom);assert.equal(limited.status,'failed',JSON.stringify(limited));assert.equal(limited.error.category,'memory_limit');assert.equal(limited.aggregate_memory_mb,64);
 assert.deepEqual(limited.error,{category:'memory_limit',message:'Task exceeded its aggregate memory limit.'});
 await until(async()=>!(await executor.groups()).length,'OOM cgroup removed',10000);
 await executor.restart(true);assert.deepEqual((await executor.call('/tasks/'+oom,quotaJob)).value,limited,'restart returns the recorded OOM outcome without a new launch');assert.deepEqual(await executor.groups(),[]);
 const lostOutcome=taskId(),lostJob={...quotaJob,source:forked.replace(' children = []',' time.sleep(2)\n children = []')};await executor.call('/tasks/'+lostOutcome,lostJob);await until(async()=>(await executor.groups()).length,'quota before suspended HTTP service',10000);executor.pause();
 const durable=await until(async()=>{try{const result=JSON.parse(await readFile(join(executor.data,'tasks',lostOutcome,'quota-result.json'),'utf8'));return result.error==='memory_limit'&&result}catch{return false}},'durable OOM receipt while HTTP service is stopped',10000);assert.equal(durable.error,'memory_limit');assert.equal(JSON.parse(await readFile(join(executor.data,'tasks',lostOutcome,'state.json'),'utf8')).status,'running','HTTP service has not committed the terminal result');
 await executor.gracefulRestartPaused();const recoveredOom=(await executor.call('/tasks/'+lostOutcome,lostJob)).value;assert.equal(recoveredOom.status,'failed');assert.equal(recoveredOom.error.category,'memory_limit');assert.deepEqual(await executor.groups(),[],'unacknowledged OOM survives graceful shutdown without a fresh sandbox');await executor.restart(true);assert.deepEqual((await executor.call('/tasks/'+lostOutcome,lostJob)).value,recoveredOom,'recorded OOM survives a subsequent crash too');
 const within=taskId();await executor.call('/tasks/'+within,payload(forked,{memory_mb:128,aggregate_memory_mb:192,timeout_ms:10000}));assert.deepEqual((await terminal(within)).output,{children:4});
 await until(async()=>!(await executor.groups()).length,'successful cgroup removed',10000);
 // Independent owner services run simultaneously under different delegated roots.
 second=await linuxExecutor();
 const held=taskId(),other=taskId(),sleeping=payload('def main(input):\n import time\n allocation = bytearray(8*1024*1024)\n time.sleep(3)\n return "within quota"',{aggregate_memory_mb:96,timeout_ms:10000});
 await Promise.all([executor.call('/tasks/'+held,sleeping),second.call('/tasks/'+other,{...sleeping,aggregate_memory_mb:48})]);
 await until(async()=>(await executor.groups()).length&&(await second.groups()).length,'concurrent independent cgroups',10000);
 for(const [service,id,mb]of [[executor,held,96],[second,other,48]]){
  const directory=join(service.cgroup,'task-'+id);
  assert.equal((await readFile(join(directory,'memory.max'),'utf8')).trim(),String(mb*1024*1024));assert.equal((await readFile(join(directory,'memory.swap.max'),'utf8')).trim(),'0');assert.equal((await readFile(join(directory,'pids.max'),'utf8')).trim(),'64');
  assert.ok((await readFile(join(directory,'cgroup.procs'),'utf8')).trim(),'sandbox entered quota before task code');
 }
 await executor.call('/tasks/'+held+'/cancel',{});assert.equal((await executor.call('/tasks/'+held)).value.status,'cancelled');assert.deepEqual(await executor.groups(),[]);
 assert.equal((await until(async()=>{const value=(await second.call('/tasks/'+other)).value;return value.status==='succeeded'&&value},'independent task success',10000)).output,'within quota');
 const crashed=taskId();await executor.call('/tasks/'+crashed,{...sleeping,timeout_ms:60000,source:'def main(input):\n import time\n time.sleep(30)\n return "never"'});await until(async()=>(await executor.groups()).length,'active quota before service crash',10000);
 await executor.restart(true);const recovered=(await executor.call('/tasks/'+crashed)).value;assert.equal(recovered.status,'interrupted');assert.deepEqual(await executor.groups(),[],'crash cleanup precedes restart readback');assert.deepEqual((await executor.call('/tasks/'+crashed,{...sleeping,timeout_ms:60000,source:'def main(input):\n import time\n time.sleep(30)\n return "never"'})).value,recovered);
 const supervisorCrash=taskId();await executor.call('/tasks/'+supervisorCrash,{...sleeping,timeout_ms:60000,source:'def main(input):\n import time\n time.sleep(30)\n return "never"'});await until(async()=>(await executor.groups()).length,'quota before supervisor crash',10000);executor.crashSupervisor();const supervisorOutcome=await terminal(supervisorCrash);assert.equal(supervisorOutcome.status,'interrupted');assert.deepEqual(await executor.groups(),[],'supervisor crash is cleaned before terminal readback');await executor.restart(true);assert.deepEqual((await executor.call('/tasks/'+supervisorCrash)).value,supervisorOutcome);
 undelegated=await linuxExecutor({quota:false});const refused=taskId();await undelegated.call('/tasks/'+refused,quotaJob);const refusal=await until(async()=>{const value=(await undelegated.call('/tasks/'+refused)).value;return value.status==='failed'&&value},'named delegation refusal',10000);assert.equal(refusal.error.category,'cgroup_setup_required');await undelegated.restart(true);assert.deepEqual((await undelegated.call('/tasks/'+refused,quotaJob)).value,refusal);
 assert.ok(!(await readdir(join(executor.data,'tasks',oom))).includes('job'),'source staging erased after limit');
 h=await harness('https://unused.example',{edge:async request=>{if(new URL(request.url).hostname!=='executor.example')return new Response('Unconfigured network edge',{status:503});const url=new URL(request.url);const response=await fetch(executor.origin+url.pathname,{method:request.method,headers:{authorization:request.headers.get('authorization'),'content-type':'application/json'},...(['GET','HEAD'].includes(request.method)?{}:{body:await request.text()})});return new Response(response.body,{status:response.status,headers:response.headers})}});
 const account=await connection(h,{app:'http',label:'Harbour owned Linux code service',auth_kind:'bearer',domains:['executor.example'],secret:{token:executor.token}});
 const w=await publish(h,'Harbour Workshop — real isolated Python normalization',{trigger:{type:'manual'},steps:[{id:'normalize',type:'code',connection_id:account.id,executor_url:'https://executor.example',...job,input:{customer:'{{trigger.input.customer}}'}},{id:'finish',type:'map',input:{customer:'{{steps.normalize.output.customer}}'}}]});
 const run=await startRun(h,w,{customer:'  Harbour Workshop & Supply  '});assert.ok(['waiting','succeeded'].includes(run.status),JSON.stringify(run.error));await h.restart();await h.tick(Date.now()+61000);const done=await h.get('workflow-runs/'+run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(stepOf(done,'finish').output,{customer:'Harbour Workshop & Supply'});
 const remote=await executor.call('/tasks/'+done.executor_tasks[0].id);assert.deepEqual(remote.value.output,stepOf(done,'normalize').output.output);assert.ok(!JSON.stringify(done).includes(executor.token));
 const migration={workflow:conversionExport('code','synthetic-crank-52'),conversions:{n1:isolatedCodeChoice(account.id)}};
 const originals=['runOnceForAllItems','runOnceForEachItem'].map((mode,index)=>({workflow:originalCodeExport(mode,'synthetic-crank-'+(730+index)),conversions:{n1:originalCodeChoice(account.id)}}));
 const imported=await doorImport(h,JSON.stringify([migration,...originals])),converted=(await h.get('workflows')).find(item=>item.name===migration.workflow.name);
 assert.equal((await h.get('workflows/'+converted.id)).draft.steps[0].source,migration.conversions.n1.source);
 await h.post(`workflows/${converted.id}/publish`,{},h.owner,201);
 const migratedRun=await startRun(h,converted,{address:' synthetic-crank-53 '});
 await until(async()=>{const task=(await executor.call('/tasks/'+migratedRun.executor_tasks[0].id)).value;return ['succeeded','failed'].includes(task.status)&&task},'converted JavaScript terminal task',10000);
 await h.restart();await h.tick(Date.now()+61000);
 const migratedDone=await h.get('workflow-runs/'+migratedRun.id);assert.equal(migratedDone.status,'succeeded',JSON.stringify(migratedDone.error));assert.deepEqual(stepOf(migratedDone,'n1').output.output,{normalized:'synthetic-crank-53'});
 for(const [index,source]of originals.entries()){
  const workflow=(await h.get('workflows')).find(item=>item.name===source.workflow.name);await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
  const run=await startRun(h,workflow,{address:' synthetic-crank-'+(740+index)+' '});
  await until(async()=>{const task=(await executor.call('/tasks/'+run.executor_tasks[0].id)).value;return ['succeeded','failed'].includes(task.status)&&task},'original n8n JavaScript terminal task',10000);
  await h.restart();await h.tick(Date.now()+61000);const done=await h.get('workflow-runs/'+run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(stepOf(done,'n1').output.output,{items:[{json:{normalized:'synthetic-crank-'+(740+index)}}]});assert.deepEqual(stepOf(done,'n1_items').output,[{normalized:'synthetic-crank-'+(740+index)}]);
  if(index===1){const empty=await startRun(h,workflow,{address:''});await until(async()=>{const task=(await executor.call('/tasks/'+empty.executor_tasks[0].id)).value;return ['succeeded','failed'].includes(task.status)&&task},'null-suppressed n8n terminal task',10000);await h.tick(Date.now()+61000);const suppressed=await h.get('workflow-runs/'+empty.id);assert.equal(suppressed.status,'succeeded',JSON.stringify(suppressed.error));assert.deepEqual(stepOf(suppressed,'n1_items').output,[])}
 }
 const migratedUndo=await door(h,'undo',{planId:imported.planId});assert.ok(migratedUndo.status>=400||migratedUndo.value.job?.state!=='undone');
 console.log('WORK-005 PASS: real Python, JavaScript and TypeScript; aggregate cgroup quota, OOM readback, independent quotas, cancellation and crash cleanup and delegation refusal; isolation, memory, time and network bounds; authenticated durable identities, conflicts, cancellation tombstones, crash reconciliation and published Worker and Cron continuation.');
}finally{await h?.close();await undelegated?.close();await second?.close();await executor.close()}
