import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {after, before, test} from 'node:test';
import {harness} from './harness.mjs';
import {connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun} from './kit.mjs';

const fake = fakeEdge();
let h;
before(async () => {
  fake.routes.set('business.example', ({url}) => url.pathname === '/failed' ? jsonResponse({error:'bad input'},400) : url.pathname === '/uncertain' ? new Promise(resolve=>setTimeout(()=>resolve(jsonResponse({id:'lost-response'})),1500)) : jsonResponse({id:'receipt-1'}));
  h = await harness('http://127.0.0.1:9', {edge:fake.edge});
});
after(async () => {if(h) await h.close()});

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
  const csv=await h.send('/api/crank/reports/operations?workflow='+flow.id+'&format=csv',undefined,h.owner);
  assert.equal(csv.status,200); assert.match(csv.headers.get('content-type'),/text\/csv/);
  assert.ok(csv.text.includes('"\'=Revenue, ""daily"""'),'names are escaped for CSV and spreadsheets');
  assert.ok(csv.text.includes(flow.id)); assert.ok(!csv.text.includes('private@buyer.example'));
  assert.equal((await h.get('reports/operations?team=Other')).summary.runs,0);
  await h.get('reports/operations?from=invalid',h.owner,400);
});

test('OPS-001: durable redacted stream survives outage and restart, preserves lag, then catches up', async () => {
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
