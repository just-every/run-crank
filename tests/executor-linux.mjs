/** WORK-005 real Linux service and published Worker journey. Run through heavy-slot. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {linuxExecutor} from './executor-fixture.mjs';
import {harness} from './harness.mjs';
import {connection,publish,startRun,stepOf,until,fakeSecret,doorImport,door} from './kit.mjs';
import {conversionExport,isolatedCodeChoice,originalCodeExport,originalCodeChoice} from './n8n-graph-fixture.mjs';

const executor=await linuxExecutor();let h;
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
 console.log('WORK-005 PASS: real Python/JavaScript/TypeScript; isolation, memory/time/network bounds; authenticated durable identities, conflicts, cancellation tombstones, crash reconciliation and published Worker/Cron continuation.');
}finally{await h?.close();await executor.close()}
