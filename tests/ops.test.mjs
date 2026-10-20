import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {harness} from './harness.mjs';
import {connection, door, doorImport, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf} from './kit.mjs';

const fake = fakeEdge();
let h;
before(async () => {
  fake.routes.set('business.example', ({url}) => url.pathname === '/failed' ? jsonResponse({error:'bad input'},400) : url.pathname === '/uncertain' ? new Promise(resolve=>setTimeout(()=>resolve(jsonResponse({id:'lost-response'})),1500)) : jsonResponse({id:'receipt-1'}));
  h = await harness('http://127.0.0.1:9', {edge:fake.edge});
});
after(async () => {if(h) await h.close()});

test('WORK-008: draft tests retain labelled history without production reports, notices or automatic pause counts', async () => {
  const settings = await h.get('settings');
  await h.post('settings',{auto_pause:{enabled:true,min_runs:3,failure_rate:0.5,window_hours:24}});
  try {
    const graph = {trigger:{type:'manual'},steps:[
      {id:'eligible',type:'filter',when:[[{field:'trigger.input.amount',op:'number.gt',value:0}]]},
      {id:'summary',type:'map',input:{customer:'{{trigger.input.customer}}'}},
    ]};
    const workflow = await h.post('workflows',{name:'Draft settlement checks',graph},h.owner,201);
    const before = await h.get('workflows/'+workflow.id), mails = h.mail.length;
    const testDraft = input => h.post(`workflows/${workflow.id}/test`,{input,bindings:{}},h.owner,201);
    const passed = await testDraft({amount:100,customer:'Harbor Workshop'});
    assert.equal(passed.mode,'test'); assert.equal(passed.status,'succeeded');
    assert.deepEqual(stepOf(passed,'summary').output,{customer:'Harbor Workshop'});
    const stopped = await testDraft({amount:0,customer:'Harbor Workshop'});
    assert.equal(stopped.status,'stopped_by_filter'); assert.equal(stepOf(stopped,'summary'),undefined);
    await h.post('reports/obligations',{run_id:passed.id,key:'test-only',description:'Sample settlement evidence'},h.owner,201);
    await h.post(`workflows/${workflow.id}/draft`,{graph:{trigger:{type:'manual'},steps:[
      {id:'divide',type:'transform',fn:'number.divide',input:{a:10,b:'{{trigger.input.divisor}}'}},
    ]}});
    const failures = [];
    for (let i=0;i<3;i++) {
      const failed = await testDraft({divisor:0});
      assert.equal(failed.mode,'test'); assert.equal(failed.status,'failed'); failures.push(failed);
    }
    const after = await h.get('workflows/'+workflow.id);
    assert.equal(after.status,before.status); assert.equal(after.published_version_id,before.published_version_id);
    assert.equal(h.mail.length,mails,'draft failures send no operational email');
    assert.deepEqual((await h.get('notices')).filter(n=>n.workflow_id===workflow.id),[]);
    const history = (await h.get('workflow-runs?workflow='+workflow.id)).runs;
    assert.equal(history.length,5); assert.ok(history.every(r=>r.mode==='test'));
    assert.equal((await h.get('workflow-runs/'+failures[0].id)).mode,'test');
    let report = await h.get('reports/operations?workflow='+workflow.id);
    assert.equal(report.summary.runs,0); assert.equal(report.today.runs,0);
    assert.equal(report.summary.run_latency.count,0); assert.equal(report.summary.trigger_to_start.count,0);
    assert.equal(report.summary.outstanding_obligations,0); assert.deepEqual(report.obligations,[]);
    assert.equal(report.execution_queue.depth,0); assert.deepEqual(report.execution_queue.runs,[]);
    const latency = (await h.get('reports/latency?workflow='+workflow.id)).workflows[0];
    assert.deepEqual(latency.outcomes,{}); assert.equal(latency.trigger_to_start.count,0);
    const csv = await h.send('/api/crank/reports/operations?workflow='+workflow.id+'&format=csv',undefined,h.owner);
    assert.equal(csv.status,200);
    const [columns,row] = csv.text.trim().split('\r\n').map(line=>line.split(',').map(cell=>JSON.parse(cell)));
    assert.equal(row[columns.indexOf('runs')],'0'); assert.equal(row[columns.indexOf('failed')],'0');
    await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
    const production = await startRun(h,workflow,{divisor:0});
    assert.equal(production.status,'failed');
    assert.equal((await h.get('workflows/'+workflow.id)).status,'published','test failures do not satisfy the production pause minimum');
    report = await h.get('reports/operations?workflow='+workflow.id);
    assert.equal(report.summary.runs,1); assert.equal(report.summary.failed,1);
    assert.deepEqual(report.execution_queue.runs.map(r=>r.id),[production.id]);
    for (let i=0;i<2;i++) assert.equal((await startRun(h,workflow,{divisor:0})).status,'failed');
    assert.equal((await h.get('workflows/'+workflow.id)).status,'paused','production failures still enforce the configured policy');
    const notices = (await h.get('notices')).filter(n=>n.workflow_id===workflow.id);
    assert.equal(notices.filter(n=>n.kind==='run_failed').length,1);
    assert.equal(notices.filter(n=>n.kind==='auto_paused').length,1);
  } finally {
    await h.post('settings',{auto_pause:settings.auto_pause});
  }
});

test('OPS-001: scoped report and CSV reconcile real run outcomes, obligations and connector health', async () => {
  const vendor = await connection(h,{app:'http',label:'Business system',auth_kind:'bearer',domains:['business.example'],secret:{token:fakeSecret('vendor')}});
  const flow = await publish(h,'=Revenue, "daily"',{trigger:{type:'manual'},steps:[{id:'send',type:'http',timeout_ms:400,connection_id:vendor.id,input:{method:'POST',url:'https://business.example/{{trigger.input.route}}',body:{email:'{{trigger.input.email}}'}}}]});
  const waiting = await publish(h,'Waiting for settlement',{trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'days'}}]});
  await h.post('reports/settings',{timezone:'Pacific/Auckland',assignments:[{workflow_id:flow.id,team:'Finance'},{workflow_id:waiting.id,team:'Finance'}]});
  const good = await startRun(h,flow,{route:'ok',email:'private@buyer.example'});
  const bad = await startRun(h,flow,{route:'failed'});
  const uncertain = await startRun(h,flow,{route:'uncertain'});
  await startRun(h,waiting,{});
  assert.equal(good.status,'succeeded'); assert.equal(bad.status,'failed'); assert.equal(uncertain.error.category,'uncertain');
  let report = await h.get('reports/operations?team=Finance');
  assert.equal(report.summary.runs,4); assert.equal(report.summary.succeeded,1); assert.equal(report.summary.failed,1); assert.equal(report.summary.waiting,1); assert.equal(report.summary.uncertain,1);
  assert.equal(report.summary.business_completed,0,'HTTP 200 is not verified business completion');
  assert.equal(report.summary.business_incomplete,4);
  const history = await h.get('workflow-runs?workflow='+flow.id);
  const scoped = await h.get('reports/operations?workflow='+flow.id);
  assert.equal(scoped.summary.runs,history.runs.length); assert.equal(scoped.summary.failed,history.runs.filter(r=>r.status==='failed').length);
  const obligation = await h.post('reports/obligations',{run_id:good.id,key:'settled',description:'Invoice is settled in the ledger',due_at:new Date(Date.now()-1000).toISOString()},h.owner,201);
  report = await h.get('reports/operations?team=Finance');
  assert.equal(report.summary.outstanding_obligations,1); assert.equal(report.obligations.find(o=>o.id===obligation.id).overdue,true);
  await h.post(`reports/obligations/${obligation.id}/verify`,{evidence:'HTTP 200'},h.owner,400);
  await h.post(`reports/obligations/${obligation.id}/verify`,{evidence:'Owner checked settled ledger entry INV-73 independently',confirm_business_outcome:true});
  report = await h.get('reports/operations?team=Finance');
  assert.equal(report.summary.business_completed,1); assert.equal(report.summary.outstanding_obligations,0);
  assert.equal(report.obligations[0].verification_source,'owner_attestation');
  assert.equal((await h.get('workflow-runs/'+good.id)).business_outcome,'owner_verified');
  assert.equal((await h.get('workflow-runs?workflow='+flow.id+'&status=business_complete')).runs.length,1);
  assert.equal(scoped.workflows[0].connectors[0].health,'connected');
  await h.post('connections/'+vendor.id+'/revoke');
  assert.equal((await h.get('reports/operations?workflow='+flow.id)).workflows[0].connectors[0].health,'revoked');
  const today = report.today, dayHistory = await h.get(`workflow-runs?from=${encodeURIComponent(today.from)}&to=${encodeURIComponent(new Date(Date.parse(today.to)-1).toISOString())}&limit=100`);
  assert.equal(today.runs,dayHistory.runs.filter(r=>[flow.id,waiting.id].includes(r.workflow_id)).length);
  assert.equal(today.failed,dayHistory.runs.filter(r=>[flow.id,waiting.id].includes(r.workflow_id)&&r.status==='failed').length);
  assert.equal(today.active_workflows_ran,2); assert.equal(today.active_workflows,2);
  const scheduled = await publish(h,'Scheduled settlement audit',{trigger:{type:'schedule',every_minutes:15,timezone:'Pacific/Auckland'},steps:[]});
  await h.post('reports/settings',{assignments:[{workflow_id:scheduled.id,team:'Finance'}]});
  const dueAt = new Date(Date.now()-60000).toISOString();
  // Leave the durable schedule due without a Cron pass, as during an executor outage.
  await h.db.prepare('UPDATE crank_schedules SET next_due_at=? WHERE workflow_id=?').bind(dueAt,scheduled.id).run();
  assert.equal((await h.get('workflow-runs?workflow='+scheduled.id)).runs.length,0);
  report = await h.get('reports/operations?team=Finance');
  assert.deepEqual(report.today.missed_schedules,[{workflow_id:scheduled.id,due_at:dueAt,reason:'due run not admitted',name:scheduled.name}]);
  assert.equal(report.today.active_workflows,3); assert.equal(report.today.active_workflows_ran,2);
  const setup = await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
  assert.equal(setup.status,303);
  const operations = await h.send('/app/operations?team=Finance',undefined,h.owner);
  assert.equal(operations.status,200,operations.text.slice(0,200));
  assert.ok(operations.text.includes(`<strong>${report.today.runs}</strong>`),'the operations page renders the report run count');
  assert.ok(operations.text.includes(`<strong>${report.today.active_workflows_ran} of ${report.today.active_workflows}</strong>`),'the operations page renders actual scheduled-workflow coverage');
  const missedRow = operations.text.match(new RegExp(`<li><a href="/app/workflows/${scheduled.id}">[^]*?</li>`))?.[0];
  assert.ok(missedRow?.includes(scheduled.name) && missedRow.includes(report.today.missed_schedules[0].reason) && missedRow.includes(`datetime="${dueAt}"`),'the operations page renders the missing schedule with its due time and reason');
  assert.ok(operations.text.includes(obligation.description),'the operations page renders the recorded business obligation');
  assert.ok(operations.text.includes(`${vendor.label} (${report.workflows.find(w=>w.workflow_id===flow.id).connectors[0].health})`),'the operations page renders current connector health');
  const csv=await h.send('/api/crank/reports/operations?workflow='+flow.id+'&format=csv',undefined,h.owner);
  assert.equal(csv.status,200); assert.match(csv.headers.get('content-type'),/text\/csv/);
  assert.ok(csv.text.includes('"\'=Revenue, ""daily"""'),'names are escaped for CSV and spreadsheets');
  assert.ok(csv.text.includes(flow.id)); assert.ok(!csv.text.includes('private@buyer.example'));
  assert.equal((await h.get('reports/operations?team=Other')).summary.runs,0);
  await h.get('reports/operations?from=invalid',h.owner,400);
});

test('SEC-003: the append-only audit records each kind of action with actor, time and version, exports to the owner, survives erasure anonymized and reaches log sinks', async () => {
  fake.routes.set('audit-logs.example',()=>jsonResponse({accepted:true}));
  const sinkToken=fakeSecret('audit-logs'), privateValue=fakeSecret('private-input'), privateReason=fakeSecret('private-reason');
  const sink=await h.post('reports/log-sinks',{label:'Audit trail',kind:'http',endpoint:'https://audit-logs.example/events',secret:{token:sinkToken},fields:['at','event','actor_id','subject_kind','subject_id','action'],events:['audit']},h.owner,201);
  const owner=(await h.get()).actor.id;
  const credential=await h.post('tokens',{label:'Audit agent',scope:'agent'},h.owner,201);await h.post('tokens/'+credential.id+'/revoke');
  const workflow=await publish(h,'Audited refunds',{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{note:'{{trigger.input.note}}'}}]});
  await h.post(`workflows/${workflow.id}/draft`,{name:'Audited refunds (edited)'});
  let run=await startRun(h,workflow,{note:privateValue});const wait=run.waits.find(w=>!w.resolved_at);
  run=await h.post(`workflow-runs/${run.id}/approve`,{path:wait.path,digest:wait.proposal_digest,reason:privateReason});assert.equal(run.status,'succeeded');
  const version=(await h.get('workflows/'+workflow.id)).published_version_id;
  const flow=await h.flow('Audited delivery'),failed=await h.run(flow),rejected=await h.run(flow);
  assert.equal((await h.post(`runs/${failed.id}/approve`)).state,'failed');await h.post(`runs/${failed.id}/replay`);await h.post(`runs/${rejected.id}/reject`);
  const source=(await readFile('public/fixtures/n8n-workflow.json','utf8')).replace('http://127.0.0.1:9051','http://127.0.0.1:9'),job={id:(await doorImport(h,source)).planId};
  assert.equal((await door(h,'undo',{planId:job.id})).value.job.state,'undone');
  assert.equal((await h.send('/api/crank/data/export',{},h.owner)).status,200);
  let rows=await h.get('audit');
  const mine=(action,subject)=>rows.find(r=>r.action===action&&(subject===undefined||r.subject_id===subject));
  for(const [action,subject] of [['credential.create',credential.id],['credential.revoke',credential.id],['workflow.publish',workflow.id],['flow.create',flow.id],['flow.activate',flow.id],['flow_run.approve',failed.id],['flow_run.replay',failed.id],['flow_run.reject',rejected.id],['import.apply',job.id],['import.undo',job.id],['data.export','data']])
    assert.equal(mine(action,subject)?.actor_id,owner,`SEC-003 audit records ${action}`);
  const draft=mine('workflow.draft',workflow.id),started=mine('run.start',run.id),approved=mine('run.approve',run.id),replayed=mine('flow_run.replay',failed.id);
  for(const row of [draft,started,approved]){assert.equal(row.actor_id,owner);assert.ok(Date.parse(row.at));assert.equal(row.version_id,version,'SEC-003: draft edit, run and approval of one workflow name its version')}
  assert.match(draft.detail.draft_digest,/^[0-9a-f]{64}$/);assert.equal(started.detail.authority,'published workflow');assert.equal(approved.detail.reason,privateReason);
  const admin=await (async()=>{const email='auditor-'+fakeSecret('admin')+'@example.test';assert.equal((await h.send('/auth/invite',{email,displayName:'Builder',role:'admin'},h.owner)).status,202);
    const token=new URL(h.mail.findLast(m=>m.to.includes(email)).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');return (await h.send('/auth/confirm',{token})).cookie})();
  rows=await h.get('audit');const builder=rows.find(r=>r.action==='access.invite');
  assert.equal(builder?.actor_id,owner,'SEC-003 audit records access decisions');assert.deepEqual(builder.detail,{role:'admin'});assert.ok(!JSON.stringify(rows).includes('@example.test'),'value-free subject identity');
  const count=rows.length;
  for(const cookie of [admin,h.owner]) for(const path of ['/api/crank/audit','/api/crank/audit/export','/api/crank/audit/'+draft.id]) for(const method of ['POST','PUT','DELETE']) {
    const response=await h.mf.dispatchFetch(h.origin+path,{method,body:'{}',headers:{host:new URL(h.origin).host,origin:h.origin,'content-type':'application/json',cookie}});
    assert.equal(response.status,405,`SEC-003 ${method} ${path}`);await response.text();
  }
  for(const path of ['audit','audit/export']) await h.get(path,admin,403);
  assert.equal((await h.get('audit')).length,count,'no caller changed the audit');
  const delivered=async actions=>{
    assert.equal((await h.post('reports/log-streams/flush')).failed,0);
    const health=(await h.get('reports/log-sinks')).find(s=>s.id===sink.id);assert.equal(health.pending,0);assert.ok(health.last_delivered_at);
    const events=fake.to('audit-logs.example').flatMap(r=>JSON.parse(r.body).events);
    for(const action of actions) assert.ok(events.some(e=>e.event==='audit'&&e.action===action),'SEC-003 log sink receives '+action);
  };
  await delivered(['credential.create','workflow.publish','run.approve','flow_run.replay','import.apply','data.export']);
  await h.post(`workflows/${workflow.id}/pause`);await h.post('data/erase',{workflow_run_id:run.id,confirm:'ERASE'});
  await h.post(`flows/${flow.id}/pause`);await h.post('data/erase',{run_id:failed.id,confirm:'ERASE'});
  const exported=await h.send('/api/crank/audit/export',undefined,h.owner);assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/attachment/);
  rows=exported.text.trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.map(r=>r.at),rows.map(r=>r.at).sort(),'chronological');assert.equal(rows.at(-1).action,'audit.export');
  for(const [before,subject] of [[started,run.id],[approved,run.id],[replayed,failed.id]]) {
    const after=rows.find(r=>r.id===before.id);
    assert.deepEqual([after.at,after.actor_id,after.action,after.version_id],[before.at,before.actor_id,before.action,before.version_id],'SEC-003: erasure keeps chronology, actor and action');
    assert.notEqual(after.subject_id,subject,'erased subject link is anonymized');assert.deepEqual(after.detail,{});
  }
  assert.equal(rows.filter(r=>r.action==='data.erase').length,2);
  for(const value of [privateValue,privateReason,sinkToken]) assert.ok(!exported.text.includes(value),'no erased payload or secret in the audit');
  await delivered(['data.erase','audit.export']);
  await h.post('reports/log-sinks/'+sink.id+'/delete');
});

test('BASE-003 OPS-001: durable redacted stream survives outage and restart, preserves lag, then catches up', async () => {
  let available=false;
  fake.routes.set('logs.example',()=>jsonResponse(available?{accepted:true}:{error:'down'},available?200:503));
  const token=fakeSecret('logs'), secretValue=fakeSecret('payload');
  const sink=await h.post('reports/log-sinks',{label:'Buyer operations',kind:'http',endpoint:'https://logs.example/events',secret:{token},fields:['at','event','workflow_id','run_id','status'],events:['run.received','run.status','step.status']},h.owner,201);
  const workflow=await publish(h,'Stream example',{trigger:{type:'manual'},steps:[{id:'done',type:'map',input:{private:'{{trigger.input.private}}'}}]});
  const run=await startRun(h,workflow,{private:secretValue});
  assert.equal((await h.post('reports/log-streams/flush')).failed,1);
  let health=(await h.get('reports/log-sinks')).find(s=>s.id===sink.id);
  assert.ok(health.pending>0); assert.equal(health.failures,1); assert.match(health.last_failure,/HTTP 503/); assert.ok(health.next_attempt_at);
  const cursor=health.cursor;
  await h.restart(); available=true;
  await h.tick(Date.parse(health.next_attempt_at)+1000);
  health=(await h.get('reports/log-sinks')).find(s=>s.id===sink.id);
  assert.equal(health.pending,0); assert.equal(health.last_failure,null); assert.ok(health.cursor>cursor); assert.ok(health.last_delivered_at);
  const delivered=fake.to('logs.example');
  assert.ok(delivered.some(r=>JSON.parse(r.body).events.some(e=>e.run_id===run.id)));
  for(const request of delivered){
    assert.equal(request.headers.authorization,'Bearer '+token);
    assert.ok(!request.body.includes(secretValue)); assert.ok(!request.body.includes('input_json')); assert.ok(!request.body.includes('actor_id'));
  }
  assert.ok(!JSON.stringify(await h.get('reports/log-sinks')).includes(token));
  const archive=await h.send('/api/crank/data/export',{},h.owner);
  assert.equal(archive.status,200); assert.ok(!archive.text.includes(token)); assert.ok(!archive.text.includes('logs.example/events'));
  await h.post('reports/log-sinks/'+sink.id+'/delete');
});

test('OPS-001: Datadog, Splunk HEC and signed S3 deliver selected metadata through their network protocols', async () => {
  fake.routes.set('intake.example',()=>jsonResponse({accepted:true}));
  let hecCode=1;
  fake.routes.set('splunk.example',()=>jsonResponse({code:hecCode}));
  const access=fakeSecret('access'), signingSecret=fakeSecret('secret'), sessionToken=fakeSecret('session');
  fake.routes.set('storage.example',({url,headers,body,method})=>{
    const hash=s=>createHash('sha256').update(s).digest('hex'), mac=(key,s)=>createHmac('sha256',key).update(s).digest();
    const authorization=headers.authorization, signed=/SignedHeaders=([^,]+)/.exec(authorization)[1], scope=/Credential=([^,]+)/.exec(authorization)[1];
    const [key,day,region,service,terminator]=scope.split('/');
    assert.equal(key,access); assert.equal(headers['x-amz-security-token'],sessionToken);
    assert.equal(headers['x-amz-content-sha256'],hash(body));
    const canonical=[method,url.pathname,'',signed.split(';').map(name=>name+':'+(name==='host'?url.host:headers[name]).trim()+'\n').join(''),signed,hash(body)].join('\n');
    let signing=mac('AWS4'+signingSecret,day); for(const part of [region,service,terminator]) signing=mac(signing,part);
    const expected=mac(signing,['AWS4-HMAC-SHA256',headers['x-amz-date'],[day,region,service,terminator].join('/'),hash(canonical)].join('\n')).toString('hex');
    assert.equal(/Signature=([a-f0-9]+)$/.exec(authorization)[1],expected,'storage accepts only a valid signature for the exact bytes and headers');
    return new Response(null,{status:200});
  });
  const dd=await h.post('reports/log-sinks',{label:'Datadog',kind:'datadog',endpoint:'https://intake.example/api/v2/logs',secret:{token:fakeSecret('dd')},events:['run.received'],fields:['event','status']},h.owner,201);
  const splunk=await h.post('reports/log-sinks',{label:'Splunk',kind:'splunk',endpoint:'https://splunk.example/services/collector/event',secret:{token:fakeSecret('splunk')},events:['run.received'],fields:['event','status']},h.owner,201);
  const s3=await h.post('reports/log-sinks',{label:'Archive',kind:'s3',endpoint:'https://storage.example',region:'us-east-1',bucket:'buyer-audit',prefix:'operations/',secret:{access_key:access,secret_key:signingSecret,session_token:sessionToken},events:['run.received'],fields:['event','status']},h.owner,201);
  const workflow=await publish(h,'Protocol example',{trigger:{type:'manual'},steps:[{id:'done',type:'map',input:{}}]});
  await startRun(h,workflow,{});
  assert.equal((await h.post('reports/log-streams/flush')).failed,1,'HTTP 200 without HEC code zero is a failed delivery');
  const ddRequest=fake.to('intake.example').at(-1), splunkRequest=fake.to('splunk.example').at(-1), s3Request=fake.to('storage.example').at(-1);
  assert.ok(ddRequest.headers['dd-api-key']); assert.equal(JSON.parse(ddRequest.body)[0].service,'crank');
  assert.match(splunkRequest.headers.authorization,/^Splunk /); assert.equal(JSON.parse(splunkRequest.body.split('\n')[0]).sourcetype,'_json');
  assert.equal(s3Request.method,'PUT'); assert.match(s3Request.url.pathname,/^\/buyer-audit\/operations\/.*\.ndjson$/); assert.match(s3Request.headers.authorization,/^AWS4-HMAC-SHA256 Credential=/); assert.ok(s3Request.headers['x-amz-content-sha256']);
  let sinks=await h.get('reports/log-sinks'); assert.equal(sinks.find(s=>s.id===splunk.id).failures,1);
  hecCode=0; await h.tick(Date.parse(sinks.find(s=>s.id===splunk.id).next_attempt_at)+1000);
  sinks=await h.get('reports/log-sinks'); assert.equal(sinks.find(s=>s.id===splunk.id).pending,0);
  for(const sink of [dd,splunk,s3]) await h.post('reports/log-sinks/'+sink.id+'/delete');
});

test('OPS-001: external sink configuration refuses unsafe targets and unredacted fields through authenticated HTTP', async () => {
  const input={label:'Unsafe',kind:'http',endpoint:'https://127.0.0.1/events',secret:{token:fakeSecret('sink')}};
  await h.post('reports/log-sinks',input,h.owner,422);
  await h.post('reports/log-sinks',{...input,endpoint:'https://public.example/events?token=private'},h.owner,400);
  await h.post('reports/log-sinks',{...input,endpoint:'https://public.example/events',fields:['input_json']},h.owner,400);
  assert.equal((await h.send('/api/crank/reports/operations')).status,401);
  assert.equal((await h.send('/api/crank/reports/log-sinks',input,'')).status,401);
  const response=await h.mf.dispatchFetch(h.origin+'/api/crank/reports/log-sinks',{method:'POST',headers:{cookie:h.owner,origin:'https://other.example','content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,403);
});

test('OPS-001: durable delay-queue ages appear in the report and cancellation removes their backlog', async () => {
  const workflow=await publish(h,'Queued release',{trigger:{type:'manual'},steps:[{id:'queue',type:'delay',mode:'queue',input:{queue:'Operations releases',spacing_seconds:60}},{id:'done',type:'map',input:{}}]});
  const run=await startRun(h,workflow,{});
  assert.equal(run.status,'waiting');
  const report=await h.get('reports/operations?workflow='+workflow.id);
  assert.equal(report.summary.waiting,1); assert.equal(report.summary.queue_age.count,1); assert.ok(report.summary.queue_age.max_ms>=0);
  await h.post('workflow-runs/'+run.id+'/cancel');
  assert.equal((await h.get('reports/operations?workflow='+workflow.id)).summary.queue_age.count,0);
});


test('BASE-003: dependency failure, maintenance interruption and archive custody stay observable after restart', async () => {
  const edge = fakeEdge(); edge.routes.set('unavailable-provider.example',()=>jsonResponse({error:'provider down'},503));
  const r = await harness('http://127.0.0.1:9',{edge:edge.edge});
  try {
    assert.equal((await r.send('/health')).status,200);
    await r.db.exec('ALTER TABLE crank_wf_runs RENAME TO unavailable_runs');
    const started = Date.now(), unavailable = await r.send('/health');
    assert.equal(unavailable.status,503); assert.equal(unavailable.value.status,'unavailable');
    assert.ok(Date.now()-started < 5000); assert.ok(!unavailable.text.includes('unavailable_runs'));
    await r.db.exec('ALTER TABLE unavailable_runs RENAME TO crank_wf_runs');
    assert.equal((await r.send('/health')).status,200);
    let report = await r.get('reports/operations');
    assert.equal(report.recovery.executor.status,'unobserved');
    assert.equal(report.recovery.storage.capacity_bytes,null);
    assert.ok(report.recovery.storage.allocated_bytes>0);
    assert.equal(report.recovery.backup.verified_external_copy,false);
    assert.equal(report.recovery.backup.last_generated_at,null);
    await r.db.exec('ALTER TABLE crank_waits RENAME TO unavailable_waits');
    try { await r.tick(); } catch { /* The real scheduled handler rejects its failed pass. */ }
    await r.db.exec('ALTER TABLE unavailable_waits RENAME TO crank_waits');
    await r.restart();
    report = await r.get('reports/operations');
    assert.equal(report.recovery.operations.find(j=>j.kind==='scheduler').status,'failed');
    assert.equal(report.recovery.executor.status,'unobserved','failed maintenance is not a completed Cron pass');
    await r.tick();
    report = await r.get('reports/operations');
    assert.equal(report.recovery.executor.status,'observed');
    assert.ok(report.recovery.operations.some(j=>j.status==='finished'));
    const poll = await publish(r,'Harbor Workshop supplier outage',{trigger:{type:'url_poll',url:'https://unavailable-provider.example/invoices',items_path:'',interval_minutes:1,backfill:'existing'},steps:[]});
    await r.tick(Date.now()+60000);
    report = await r.get('reports/operations');
    assert.equal(report.recovery.provider_outages.find(p=>p.workflow_id===poll.id).last_cause,'outage');
    assert.equal((await r.send('/health')).status,200,'an optional provider outage is not healthy-provider evidence or a required storage outage');
    const archive = await r.send('/api/crank/data/export',{},r.owner);
    assert.equal(archive.status,200);
    report = await r.get('reports/operations');
    assert.ok(report.recovery.backup.last_generated_at);
    assert.equal(report.recovery.backup.verified_external_copy,false,'generation never claims receipt');
    assert.ok((await r.get('data/transfers')).some(t=>t.kind==='export' && t.phase==='aborted'));
    await r.mf.dispatchFetch(r.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:r.origin,cookie:r.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
    const page = await r.send('/app/operations',undefined,r.owner);
    assert.equal(page.status,200); assert.ok(page.text.includes('Service recovery')); assert.ok(page.text.includes('not verified'));
    const retained = await r.post('data/transfers',{kind:'export'},r.owner,201);
    const resumePage=await r.send('/app/operations',undefined,r.owner);
    assert.ok(resumePage.text.includes('Resume export'));
    const resumed=await r.mf.dispatchFetch(r.origin+'/app/action',{method:'POST',redirect:'manual',headers:{origin:r.origin,cookie:r.owner,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({path:`/api/crank/data/transfers/${retained.id}/advance`,maxParts:'10',return_to:'/app/operations'}).toString()});
    assert.equal(resumed.status,303); assert.equal(resumed.headers.get('location'),'/app/operations');
    assert.equal((await r.get('data/transfers')).find(t=>t.id===retained.id).phase,'complete');
    assert.ok((await r.send('/app/operations',undefined,r.owner)).text.includes(`/data/transfers/${retained.id}/download`));
    assert.equal((await r.send(`/api/crank/data/transfers/${retained.id}/download`,undefined,r.owner)).status,200);

    assert.equal((await r.send('/api/crank/reports/operations')).status,401);
  } finally { await r.close(); }
});
