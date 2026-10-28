import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, startRun } from './kit.mjs';

// The app's pages through their HTTP doors: the Flow editor reads a published
// workflow's steps and runs, and an approval decided from the Approvals form
// continues the run it holds.
const edge = fakeEdge();
let h;
before(async () => { edge.routes.set('history.example', ({ body }) => { const input = JSON.parse(body); return jsonResponse(input.fail ? { customer: input.customer, private_note: 'restricted-provider-detail' } : { id: 'invoice-123', url: 'https://history.example/invoices/123' }, input.fail ? 400 : 201) }); h = await harness('http://127.0.0.1:9', { edge: edge.edge }) });
after(async () => { await h?.close() });

const page = async path => { const r = await h.send(path, undefined, h.owner); assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`); return r.text };
const form = async (fields, path = '/app/action') => h.mf.dispatchFetch(h.origin + path, { method: 'POST', redirect: 'manual', headers: { host: new URL(h.origin).host, origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('the flow editor shows the steps and runs; an approval decided from its form continues the run', async () => {
  assert.equal((await h.send('/app', undefined, h.owner)).headers.get('location'), '/setup', 'the owner finishes setup first');
  assert.equal((await form({ confirm: 'yes' }, '/setup')).headers.get('location'), '/app');
  const graph = { trigger: { type: 'manual', name: 'Started by hand' }, settings: { run_columns: [{ label: 'Customer', value: '{{trigger.input.customer}}' }] }, steps: [
    { id: 'paid', type: 'filter', name: 'Paid orders only', when: [[{ field: 'trigger.input.status', op: 'text.equals', value: 'paid' }]] },
    { id: 'check', type: 'approval', name: 'Ask an owner', instructions: 'Large orders wait for an owner.', input: { customer: '{{trigger.input.customer}}' } },
    { id: 'summary', type: 'map', name: 'Order summary', input: { customer: '{{trigger.input.customer}}' } },
  ] };
  const workflow = await publish(h, 'Paid orders to the team', graph);
  const run = await startRun(h, workflow, { customer: 'Harbor Workshop', status: 'paid' });
  assert.equal(run.status, 'awaiting_approval');

  const editor = await page(`/app/workflows/${workflow.id}`);
  for (const text of ['Paid orders to the team', 'Paid orders only', 'Ask an owner', 'Order summary', 'Runs today', 'Harbor Workshop', 'Waiting for approval']) assert.ok(editor.includes(text), `editor shows ${text}`);
  assert.ok((await page('/app/runs')).includes('Harbor Workshop'), 'the Runs page leads with the run’s own Customer column');
  const selected = await page(`/app/workflows/${workflow.id}?step=check`);
  assert.ok(selected.includes('Large orders wait for an owner.'), 'the inspector shows the selected step');

  const approvals = await page('/app/approvals');
  assert.ok(approvals.includes(run.id.slice(0, 8)), 'the waiting run is listed');
  const digest = approvals.match(/name="digest" value="([0-9a-f]{64})"/)[1];
  const decided = await form({ step_path: 'check', digest, return_to: '/app/approvals', reason: '', path: `/api/crank/workflow-runs/${run.id}/approve` });
  assert.equal(decided.status, 303); assert.equal(decided.headers.get('location'), '/app/approvals');
  assert.equal((await h.get('workflow-runs/' + run.id)).status, 'succeeded');
  assert.ok((await page('/app/approvals')).includes('Nothing needs you'), 'nothing waits after the decision');
  assert.ok((await page(`/app/workflow-runs/${run.id}`)).includes('Order summary'), 'the run page lists its steps');
});


test('EXEC-005: older business-key history, date/error filters, mapping decisions, comparison and restricted payloads through API and app', async () => {
  const w = await publish(h, 'Wholesale invoices · Harbor Workshop', { trigger: { type: 'manual' }, steps: [
    { id: 'eligible', type: 'filter', when: [[{ field: 'trigger.input.amount', op: 'number.gt', value: 0 }]] },
    { id: 'invoice', type: 'http', input: { method: 'POST', url: 'https://history.example/invoices', body: { customer: '{{trigger.input.customer}}', fail: '{{trigger.input.fail}}' } } },
  ] });
  const failed = await h.post(`workflows/${w.id}/run`, { input: { customer: 'Harbor Workshop', amount: 100, fail: true }, business_key: 'customer-harbor' }, h.owner, 201);
  const passed = await h.post(`workflows/${w.id}/run`, { input: { customer: 'Harbor Workshop', amount: 100, fail: false }, business_key: 'customer-harbor' }, h.owner, 201);
  const stopped = await startRun(h, w, { customer: 'Harbor Workshop', amount: 0, fail: false });
  assert.equal(failed.status, 'failed'); assert.equal(passed.status, 'succeeded'); assert.equal(stopped.status, 'stopped_by_filter');
  const prefix = `workflow-runs?workflow=${w.id}`;
  const first = await h.get(prefix + '&limit=1');
  assert.ok(first.next);
  const second = await h.get(prefix + '&limit=1&before=' + encodeURIComponent(first.next));
  assert.notEqual(first.runs[0].id, second.runs[0].id);
  const day = new Date().toISOString().slice(0, 10);
  const found = await h.get(prefix + '&business_key=customer-harbor&status=failed&error=provider&from=' + day + '&to=' + day);
  assert.deepEqual(found.runs.map(r => r.id), [failed.id]);
  const detail = await h.get('workflow-runs/' + failed.id);
  assert.equal(detail.steps.find(s => s.path === 'invoice').input.body.customer, 'Harbor Workshop');
  assert.equal(detail.attempts[0].http_status, 400); assert.ok(detail.attempts[0].started_at); assert.ok(detail.attempts[0].finished_at);
  assert.equal(detail.attempts[0].destination_origin, 'https://history.example');
  assert.equal(detail.steps.find(s => s.path === 'eligible').trace.groups[0].rules[0].result, true);
  const history = await page('/app/runs?workflow=' + w.id + '&business_key=customer-harbor&status=failed&error=provider&from=' + day + '&to=' + day);
  assert.ok(history.includes(failed.id.slice(0, 8))); assert.ok(!history.includes(passed.id.slice(0, 8)));
  const compared = await page(`/app/workflow-runs/${failed.id}?compare=${passed.id}`);
  for (const value of ['Harbor Workshop', 'invoice-123', 'https://history.example/invoices/123', 'provider', passed.id.slice(0, 8)]) assert.ok(compared.includes(value), value);
  assert.ok((await page('/app/workflow-runs/' + passed.id)).includes('href="https://history.example/invoices/123"'));
  const email = ['history-reader','example.test'].join('@');
  assert.equal((await h.send('/auth/invite', { email, displayName: 'History reader', role: 'member' }, h.owner)).status, 202);
  const message = h.mail.findLast(m => m.to.includes(email));
  const token = new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), h.origin).searchParams.get('token');
  const cookie = (await h.send('/auth/confirm', { token })).cookie;
  const reader=(await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.email===email);
  await h.post('team/'+reader.id,{role:'viewer',workflow_ids:[w.id],connection_ids:[]});
  const safe = await h.get('workflow-runs/' + failed.id, cookie);
  assert.equal(safe.status, 'failed'); assert.ok(safe.received_at); assert.equal(safe.payload, 'restricted');
  assert.equal(safe.steps.find(s => s.path === 'invoice').input, undefined);
  assert.ok(!JSON.stringify(safe).includes('restricted-provider-detail'));
  const restrictedPage = await h.send(`/app/workflow-runs/${failed.id}?compare=${passed.id}`, undefined, cookie);
  assert.equal(restrictedPage.status, 200); assert.ok(!restrictedPage.text.includes('restricted-provider-detail')); assert.ok(!restrictedPage.text.includes('invoice-123'));
  await h.get(prefix + '&limit=NaN', h.owner, 422);
});

test('Native visual drafting builds named branches, fences stale and unauthorized saves, and preserves published execution', async () => {
  const created=await form({name:'Native routing',description:'A bounded native draft',folder:'Operations'},'/app/workflows/create');
  assert.equal(created.status,303);
  const url=created.headers.get('location'), workflowId=/workflows\/([^?]+)/.exec(url)[1];
  const read=()=>h.get('workflows/'+workflowId);
  const edit=async(fields,status=303)=>{
    const current=await read();
    const response=await form({draft_digest:current.draft_digest,...fields},'/app/workflows/'+workflowId+'/edit');
    assert.equal(response.status,status,await response.clone().text());
    return {response,current:await read()};
  };
  const added=async(type,after)=>{
    const before=await read();
    const {current}=await edit({operation:'add',type,after});
    const flat=graph=>graph.steps.flatMap(step=>[step,...(step.branches??[]).flatMap(b=>flat({steps:b.steps})),...flat({steps:step.fallback?.steps??[]})]);
    const existing=new Set(flat(before.draft).map(step=>step.id));
    return flat(current.draft).find(step=>step.type===type&&!existing.has(step.id));
  };
  const startRequests=edge.requests.length;
  const values=await added('map','start');
  await edit({operation:'save-step',step:values.id,name:'Lead details'});
  const untouched=await read();
  const invalid=await edit({operation:'field',step:values.id,key:'',field_name:'',value_kind:'number',value:'1200'},422);
  const invalidText=await invalid.response.text();
  assert.match(invalidText,/aria-invalid="true" aria-describedby="[^"]+-error"/);
  assert.deepEqual((await read()).draft,untouched.draft);
  for(const [field_name,value_kind,value] of [['amount','number','1200'],['company','text','synthetic-crank-1'],['active','boolean','true'],['blank','text',''],['nothing','null','']])
    await edit({operation:'field',step:values.id,key:'',field_name,value_kind,value});
  const filter=await added('filter','after:'+values.id);
  await edit({operation:'rule',step:filter.id,group:'0',rule:'0',source:'steps.'+values.id+'.amount',operator:'number.gte',value_kind:'number',value:'1000'});
  const typedBefore=await read();
  const retyped=await edit({operation:'field',step:values.id,key:'amount',field_name:'amount',value_kind:'text',value:'1200'},422);
  assert.match(await retyped.response.text(),/invalidate a typed condition/);
  assert.deepEqual((await read()).draft,typedBefore.draft,'a field retype cannot silently break a downstream typed condition');
  const paths=await added('paths','after:'+filter.id);
  const branch=paths.branches[0].id;
  await edit({operation:'rename-branch',step:paths.id,branch,branch_name:'Qualified leads'});
  await edit({operation:'rule',step:paths.id,branch,group:'0',rule:'0',source:'steps.'+values.id+'.active',operator:'boolean.is_true'});
  const qualified=await added('respond','branch:'+paths.id+':'+branch);
  await edit({operation:'save-step',step:qualified.id,name:'Qualified response',status:'201',value_kind:'field',reference:'steps.'+values.id+'.company'});
  const fallback=await added('respond','branch:'+paths.id+':fallback');
  await edit({operation:'save-step',step:fallback.id,name:'Fallback response',status:'202',value_kind:'text',value:'not qualified'});
  const wait=await added('delay','after:'+filter.id);
  await edit({operation:'save-step',step:wait.id,name:'Wait briefly',amount:'0',unit:'seconds'});
  // Reordering keeps stable identifiers and refuses a forward field reference.
  await edit({operation:'up',step:wait.id});
  await edit({operation:'down',step:wait.id});
  await edit({operation:'move',step:filter.id,after:'start'},422);
  const scalar=await added('respond','after:'+wait.id);
  await edit({operation:'save-step',step:scalar.id,name:'Text response',status:'200',value_kind:'text',value:'approved'});
  const responseFilter=await added('filter','after:'+scalar.id);
  await edit({operation:'rule',step:responseFilter.id,group:'0',rule:'0',source:'steps.'+scalar.id+'.body',operator:'text.equals',value_kind:'text',value:'approved'});
  const scalarBefore=await read();
  await edit({operation:'save-step',step:scalar.id,name:'Text response',status:'200',value_kind:'number',value:'1'},422);
  assert.deepEqual((await read()).draft,scalarBefore.draft);
  await edit({operation:'remove',step:responseFilter.id});await edit({operation:'remove',step:scalar.id});
  const temporary=await added('map','after:'+wait.id);
  await edit({operation:'remove',step:temporary.id});
  const before=await read(), staleDigest=before.draft_digest;
  await edit({operation:'field',step:values.id,key:'company',field_name:'company',value_kind:'text',value:'synthetic-crank-2'});
  const stale=await form({operation:'remove',step:paths.id,draft_digest:staleDigest},'/app/workflows/'+workflowId+'/edit');
  assert.equal(stale.status,409);
  await h.post('workflows/'+workflowId+'/draft',{graph:before.draft,draft_digest:staleDigest},h.owner,409);
  const email=['synthetic-crank-editor-reader','example.test'].join('@');
  assert.equal((await h.send('/auth/invite',{email,displayName:'Read only editor',role:'member'},h.owner)).status,202);
  const message=h.mail.findLast(m=>m.to.includes(email)), token=new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
  const viewer=(await h.send('/auth/confirm',{token})).cookie;
  const person=(await h.send('/auth/operators',undefined,h.owner)).value.find(p=>p.email===email);
  await h.post('team/'+person.id,{role:'viewer',workflow_ids:[workflowId],connection_ids:[]});
  const frozen=await read();
  await h.post('workflows/'+workflowId+'/draft',{graph:before.draft,draft_digest:frozen.draft_digest},viewer,403);
  const refused=await h.mf.dispatchFetch(h.origin+'/app/workflows/'+workflowId+'/edit',{method:'POST',headers:{origin:h.origin,cookie:viewer,'content-type':['application','x-www-form-urlencoded'].join('/')},body:new URLSearchParams({operation:'remove',step:paths.id,draft_digest:frozen.draft_digest}).toString()});
  assert.equal(refused.status,403);
  assert.deepEqual((await read()).draft,frozen.draft);
  assert.equal((await h.get('workflow-runs?workflow='+workflowId)).runs.length,0);
  assert.equal(edge.requests.length,startRequests,'draft editing sends no provider request');
  const reopened=await page('/app/workflows/'+workflowId+'?step='+paths.id);
  assert.ok(reopened.includes('Qualified leads'));
  const copy=await h.post('workflows/'+workflowId+'/duplicate',{},h.owner,201);
  assert.deepEqual(copy.draft,frozen.draft);
  const saved=await h.get('workflows/'+workflowId+'/drafts/'+frozen.draft_versions[0].id);
  assert.deepEqual(saved.graph,frozen.draft);
  const published=await h.post('workflows/'+workflowId+'/publish',{},h.owner,201);
  const version=await h.get('workflows/'+workflowId+'/versions/1');
  assert.deepEqual(version.graph,frozen.draft);
  await edit({operation:'field',step:values.id,key:'active',field_name:'active',value_kind:'boolean',value:'false'});
  assert.deepEqual((await h.get('workflows/'+workflowId+'/versions/1')).graph,version.graph);
  let run=await h.post('workflows/'+workflowId+'/run',{input:{}},h.owner,201);
  assert.equal(run.status,'waiting');await h.tick(Date.now()+2000);
  let detail=await h.get('workflow-runs/'+run.id);
  assert.equal(detail.status,'succeeded');
  assert.deepEqual(detail.steps.find(s=>s.step_id===values.id).output,{amount:1200,company:'synthetic-crank-2',active:true,blank:'',nothing:null});
  assert.equal(detail.steps.find(s=>s.step_id===qualified.id).output.body,'synthetic-crank-2');
  assert.ok(!detail.steps.some(s=>s.step_id===fallback.id));
  await h.post('workflows/'+workflowId+'/publish',{},viewer,403);
  await h.post('workflows/'+workflowId+'/publish',{},h.owner,201);
  run=await h.post('workflows/'+workflowId+'/run',{input:{}},h.owner,201);
  await h.tick(Date.now()+2000);detail=await h.get('workflow-runs/'+run.id);
  assert.equal(detail.steps.find(s=>s.step_id===fallback.id).output.body,'not qualified');
  assert.ok(!detail.steps.some(s=>s.step_id===qualified.id));
  assert.equal(version.number,published.version.number);
});
