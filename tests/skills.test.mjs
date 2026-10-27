import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, startRun, stepOf } from './kit.mjs';
import { archive, inventory } from './restore-journey.mjs';
import { correctionCases } from './skills-fixture.mjs';
import { authoringModelReply, setupAuthoring } from './authoring-fixture.mjs';
import { recurringSetup } from './recurring-fixture.mjs';

test('Recurring invoice objectives freeze version pins, serialize invoice ownership and retain blocked progress across due dates and restart', async () => {
 const fake=fakeEdge();let reads=0,paid=false;
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,url})=>{reads++;assert.equal(method,'GET');return jsonResponse({Invoice:{Id:url.pathname.split('/').at(-1),SyncToken:String(reads),Balance:paid?0:521,DueDate:'2020-01-01',BillEmail:{Address:'billing@harbour.example.test'}}})});
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try {
  const s=await recurringSetup(h),path='recurring-tasks/'+s.task.id;
  await h.post('recurring-skills',s.publication,'',401);
  const token=await h.post('tokens',{label:'Agent cannot adopt or approve a recurring skill',scope:'agent'},h.owner,201);
  await h.post('recurring-tasks',s.request,'',403,{authorization:'Bearer '+token.token});
  await h.post('recurring-tasks',{...s.request,recipients:['attacker@example.test']},h.owner,422);
  const starts=await Promise.all([h.post(path+'/dispatch'),h.post(path+'/dispatch')]);
  assert.equal(starts[0].run_id,starts[1].run_id);
  let task=await h.get(path),run=await h.get('workflow-runs/'+starts[0].run_id);
  assert.equal(task.runs.length,1);assert.equal(run.status,'paused');assert.equal(reads,2);
  const original=run.steps[0].output,firstAt=Date.parse(original.checked_at),key=run.steps[0].operation_key;
  assert.equal(original.contact_state,'not_sent');assert.equal(original.billing_contact,'billing@harbour.example.test');assert.equal(original.same_dispatch_read,true);
  assert.deepEqual(original.remaining_obligations.map(({kind,state})=>({kind,state})),[{kind:'customer_contact',state:'blocked'}]);
  assert.equal(task.runs[0].cost.owner_estimate_usd,'0');assert.equal(task.runs[0].cost.budget_accounted_usd,'0');
  await h.post(path+'/dispatch');assert.equal(reads,2,'Duplicate dispatch never bypasses configured cadence');
  const duplicate=await h.post('recurring-tasks',s.request,h.owner,201);
  await h.post('recurring-tasks/'+duplicate.id+'/dispatch',{},h.owner,409);assert.equal(reads,2);
  const alias=await recurringSetup(h);await h.post('recurring-tasks/'+alias.task.id+'/dispatch',{},h.owner,409);assert.equal(reads,2,'Another connection to the same company cannot bypass invoice ownership');
  const nextSource=await recurringSetup(h,{invoiceId:'synthetic-crank-303',create:false});
  const updated=await h.post('recurring-skills',{...nextSource.publication,name:s.skill.name,skill_id:s.skill.skill_id,instructions:'Second reviewed instructions. Continue to stop paid invoices and never send through an unavailable transport.'},h.owner,201);
  await h.post(path+'/adopt',{revision:task.revision,skill_version_id:updated.id,grant_id:s.grant.id,objective:{...s.objective,recipients:['attacker@example.test']}},h.owner,422);
  await h.post(path+'/adopt',{revision:task.revision,skill_version_id:updated.id,grant_id:s.grant.id,objective:nextSource.objective},h.owner,403);
  task=await h.post(path+'/adopt',{revision:task.revision,skill_version_id:updated.id,grant_id:nextSource.grant.id,objective:{...nextSource.objective,interval_minutes:60}});
  assert.equal(task.skill_version_id,updated.id);assert.notEqual(task.objective_version_id,s.task.objective_version_id);
  assert.equal(task.runs[0].skill_version_id,s.skill.id);assert.equal(task.runs[0].objective_version_id,s.task.objective_version_id);
  await h.restart();await h.tick(firstAt+86400000);run=await h.get('workflow-runs/'+run.id);assert.equal(reads,4);
  assert.equal(run.steps[0].operation_key,key);assert.equal(run.steps[0].output.objective_version_id,s.task.objective_version_id,'Open run keeps its original cadence and objective');
  await h.tick(firstAt+86400000+3600000);assert.equal(reads,4,'New objective cadence cannot shorten an open run');
  paid=true;await h.tick(firstAt+2*86400000);assert.equal(reads,5);assert.equal((await h.get(path)).status,'active','An explicitly adopted next objective remains separate from the finished frozen objective');
  await h.tick(firstAt+3*86400000);task=await h.get(path);assert.equal(task.runs.length,2);assert.equal(task.status,'satisfied');
  const newest=task.runs.find(r=>r.skill_version_id===updated.id);assert.ok(newest);assert.equal(newest.objective_version_id,task.objective_version_id);
  assert.equal((await h.get('workflow-runs/'+newest.run_id)).steps[0].output.invoice_state,'paid');
  const count=reads;await h.tick(firstAt+4*86400000);assert.equal(reads,count,'Satisfied objective schedules no further connected read or contact');
  const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='recurring.task.adopt'));assert.equal(fake.requests.filter(r=>r.method!=='GET').length,0);
 } finally {await h.close()}
});

test('Recurring connected-invoice contact boundary re-reads paid, closed and void state and uses only the current billing contact', async () => {
 const fake=fakeEdge();let requests=0,current,change;
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({method,url})=>{requests++;assert.equal(method,'GET');if(change && requests%2===0)current={...current,...change};return jsonResponse({Invoice:{...current,Id:url.pathname.split('/').at(-1)}})});
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try {
  for(const state of ['paid','closed','void','open']) {
   current={Balance:521,DueDate:'2020-01-01',SyncToken:'1',BillEmail:{Address:'old-billing@example.test'}};
   change=state==='open'?{SyncToken:'2',BillEmail:{Address:'current-billing@example.test'}}:{SyncToken:'2',TxnStatus:state,...(state==='paid'?{Balance:0}:{})};
   const s=await recurringSetup(h,{invoiceId:'synthetic-crank-'+(310+requests)}),start=await h.post('recurring-tasks/'+s.task.id+'/dispatch');
   const run=await h.get('workflow-runs/'+start.run_id),output=run.steps[0].output;
   assert.equal(output.same_dispatch_read,true);assert.equal(output.provider_version,'2');
   if(state==='open'){assert.equal(run.status,'paused');assert.equal(output.billing_contact,'current-billing@example.test');assert.equal(output.contact_state,'not_sent')}
   else {assert.equal(run.status,'succeeded');assert.equal(output.objective_state,'satisfied');assert.equal(output.invoice_state,state);assert.equal((await h.get('recurring-tasks/'+s.task.id)).status,'satisfied')}
  }
  assert.equal(requests,8);assert.equal(fake.requests.filter(r=>r.method!=='GET').length,0);
 } finally {await h.close()}
});

test('Recurring authority stops fence task controls, in-flight tool revocation, expired grants and budget holds through native run doors', async () => {
 const fake=fakeEdge();let reads=0,entered,release,holdRead=false;
 fake.routes.set('sandbox-quickbooks.api.intuit.com',async({method,url})=>{reads++;assert.equal(method,'GET');if(holdRead){holdRead=false;entered();await new Promise(resolve=>{release=resolve})}return jsonResponse({Invoice:{Id:url.pathname.split('/').at(-1),Balance:19.99,DueDate:'2020-01-01',BillEmail:{Address:'billing-stop@example.test'}}})});
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
 try {
  for(const action of ['pause','takeover','cancel']) {
   const s=await recurringSetup(h,{invoiceId:'synthetic-crank-'+(350+reads)}),path='recurring-tasks/'+s.task.id,start=await h.post(path+'/dispatch');
   const stopped=await h.post(path+'/'+action,{revision:s.task.revision});
   assert.equal(stopped.status,action==='pause'?'paused':action==='cancel'?'cancelled':'takeover');
   const before=reads;if(action!=='cancel') {const resumed=await h.post('workflow-runs/'+start.run_id+'/resume');assert.equal(resumed.status,'paused');assert.equal(resumed.error.category,'authority')}
   await h.tick(Date.now()+3*86400000);assert.equal(reads,before,'Task control survives ordinary run resume and due scheduler');
   if(action!=='pause')await h.post(path+'/resume',{revision:stopped.revision},h.owner,409);
  }
  const revoked=await recurringSetup(h,{invoiceId:'synthetic-crank-370'}),path='recurring-tasks/'+revoked.task.id;
  const reached=new Promise(resolve=>{entered=resolve});holdRead=true;const pending=h.post(path+'/dispatch');await reached;
  const before=reads,stopped=await h.post(path+'/revoke-tool',{revision:revoked.task.revision});release();
  const start=await pending;assert.equal(stopped.status,'paused');assert.ok(stopped.tool_revoked_at);assert.equal(reads,before,'Revocation after the first live read blocks the same-dispatch contact read');
  await h.post('workflow-runs/'+start.run_id+'/resume');assert.equal(reads,before);
  await h.post(path+'/resume',{revision:stopped.revision},h.owner,409);
  const s=await recurringSetup(h,{invoiceId:'synthetic-crank-371'}),budgetPath='recurring-tasks/'+s.task.id;
  await h.post('usage/budgets',{scope:'workflow',workflow_id:s.workflow.id,monthly_usd:'0'});
  await h.post(budgetPath+'/dispatch',{},h.owner,409);assert.equal(reads,before);assert.equal((await h.get(budgetPath)).status,'blocked');
  await h.post('usage/budgets',{scope:'workflow',workflow_id:s.workflow.id,monthly_usd:'1'});
  let budgetTask=await h.get(budgetPath);budgetTask=await h.post(budgetPath+'/resume',{revision:budgetTask.revision});const funded=await h.post(budgetPath+'/dispatch');assert.equal(reads,before+2);
  await h.post('usage/budgets',{scope:'workflow',workflow_id:s.workflow.id,monthly_usd:'0'});
  await h.post('workflow-runs/'+funded.run_id+'/resume');assert.equal(reads,before+2,'An already admitted run also obeys a current budget hold');
  await h.post('grants/'+s.grant.id+'/revoke');await h.post('workflow-runs/'+funded.run_id+'/resume');assert.equal(reads,before+2);
  const expiring=await recurringSetup(h,{invoiceId:'synthetic-crank-372',create:false});
  const shortGrant=await h.post('grants',{label:'Owner short-lived invoice authority',workflow_id:expiring.workflow.id,version_id:expiring.published.version.id,policy:expiring.grant.policy,expires_at:new Date(Date.now()+1500).toISOString()},h.owner,201);
  const expiringTask=await h.post('recurring-tasks',{...expiring.request,grant_id:shortGrant.id},h.owner,201);
  await new Promise(resolve=>setTimeout(resolve,1600));await h.post('recurring-tasks/'+expiringTask.id+'/dispatch',{},h.owner,409);assert.equal(reads,before+2);
  assert.equal((await h.get('recurring-tasks/'+expiringTask.id)).status,'blocked');assert.equal(fake.requests.filter(r=>r.method!=='GET').length,0);
 } finally {release?.();await h.close()}
});

test('Recurring skill provenance restores inactive without grants or invoice ownership and erased run payloads leave no customer contact copy', async () => {
 const fake=fakeEdge();let reads=0;
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({url})=>{reads++;return jsonResponse({Invoice:{Id:url.pathname.split('/').at(-1),Balance:521,DueDate:'2020-01-01',BillEmail:{Address:'only-in-the-erasable-run@example.test'}}})});
 const h=await harness('http://127.0.0.1:9',{edge:fake.edge});let restored;
 try {
  const s=await recurringSetup(h),start=await h.post('recurring-tasks/'+s.task.id+'/dispatch'),saved=await archive(h);
  assert.ok(!saved.includes(s.grant.credential));assert.ok(!saved.includes(h.owner));
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge});await restored.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),received=inventory(await archive(restored)),added=received.filter(row=>!original.includes(row));
  assert.deepEqual(added.map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
  assert.deepEqual(received.filter(row=>!added.includes(row)),original,'All portable recurring versions, provenance and inactive history survive completely');
  const task=await restored.get('recurring-tasks/'+s.task.id);assert.equal(task.status,'inactive');assert.equal(task.runs[0].skill_version_id,s.skill.id);assert.equal(task.runs[0].objective_version_id,s.task.objective_version_id);
  assert.equal((await restored.get('grants')).length,0);const before=reads;
  await restored.post('recurring-tasks/'+s.task.id+'/dispatch',{},restored.owner,409);await restored.post('recurring-tasks/'+s.task.id+'/resume',{revision:task.revision},restored.owner,409);
  await restored.post('workflow-runs/'+start.run_id+'/resume',{},restored.owner,409);await restored.restart();await restored.tick(Date.now()+7*86400000);assert.equal(reads,before);
  await h.post('recurring-tasks/'+s.task.id+'/cancel',{revision:s.task.revision});await h.post('workflows/'+s.workflow.id+'/pause');await h.post('data/erase',{workflow_run_id:start.run_id,confirm:'ERASE'});
  assert.deepEqual((await h.get('recurring-tasks/'+s.task.id)).runs,[]);assert.ok(!(await archive(h)).includes('only-in-the-erasable-run@example.test'));
  const flows=await h.get('data/flows');const read=flows.flows.find(f=>f.kind==='quickbooks.followup_invoice');assert.ok(read);assert.deepEqual(read.recipients,['https://sandbox-quickbooks.api.intuit.com']);assert.match(read.region,/provider-controlled/i);
 } finally {await restored?.close();await h.close()}
});

function network() {
  const fake = fakeEdge(), records = [];
  fake.routes.set('addresses.example', ({ body }) => {
    const { address, preserve_whitespace } = JSON.parse(body);
    if (!preserve_whitespace && address !== address.trim()) return jsonResponse({ error: 'Address must have no leading or trailing whitespace' }, 400);
    const row = { id: 'address-' + records.length, address }; records.push(row);
    return jsonResponse(row, 201);
  });
  return { fake, records };
}

test('AGENT-003: retained exception clusters produce tested reusable transforms; owner stages, publishes, measures readback and rolls back without suppressing history', async () => {
  const { fake, records } = network(), h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const { workflow, cases, proposal } = await correctionCases(h, 'https://addresses.example/addresses');
    const requests = fake.requests.length;
    await h.post('skills', proposal, '', 401);
    const token = await h.post('tokens', { label: 'Assistant without owner deployment authority', scope: 'agent' }, h.owner, 201);
    await h.post('skills', proposal, '', 403, { authorization: 'Bearer ' + token.token });
    await h.post('skills', { ...proposal, run_ids: proposal.run_ids.slice(0, 2) }, h.owner, 422);
    const skill = await h.post('skills', proposal, h.owner, 201);
    assert.deepEqual(skill.cluster, { corrected: 2, passing: 1 });
    assert.ok(skill.cases.every(c => c.pass));
    assert.equal(skill.cases.find(c => !c.corrected).proposed, cases[2].steps[0].input.body.address, 'multi-line passing addresses are preserved');
    assert.equal(fake.requests.length, requests, 'proposing uses retained cases only, with no model, external recipient or fabricated application call');
    assert.equal((await h.get('workflows/' + workflow.id)).versions.length, 1);
    assert.ok((await h.get('skills')).some(s => s.id === skill.id));
    const setup = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes', redirect: 'manual' });
    assert.equal(setup.status, 303);
    assert.equal((await h.send('/app/skills', undefined, h.owner)).status, 200);
    assert.equal((await h.send('/app/skills/' + skill.id, undefined, h.owner)).status, 200);
    await h.post(`skills/${skill.id}/approve`, { digest: 'stale' }, h.owner, 409);
    const edited = structuredClone(workflow.draft); edited.steps[0].name = 'Owner’s unrelated draft edit';
    await h.post(`workflows/${workflow.id}/draft`, { graph: edited });
    await h.post(`skills/${skill.id}/approve`, { digest: skill.digest }, h.owner, 409);
    const currentProposal = await h.get('skills/' + skill.id);
    await h.post(`skills/${skill.id}/approve`, { digest: currentProposal.digest }, h.owner, 409);
    assert.equal((await h.get('workflows/' + workflow.id)).draft.steps[0].name, edited.steps[0].name);
    await h.post(`workflows/${workflow.id}/draft`, { graph: workflow.draft });
    skill.digest = (await h.get('skills/' + skill.id)).digest;
    // The owner sees the proposed semantic change, then stages it without authorizing a send.
    const staged = await h.post(`skills/${skill.id}/approve`, { digest: skill.digest });
    assert.ok(staged.staged_at); assert.equal(staged.active, false);
    assert.equal(fake.requests.length, requests);
    const draft = (await h.get('workflows/' + workflow.id)).draft;
    assert.notDeepEqual(draft.steps[0].input.body.address, workflow.draft.steps[0].input.body.address);
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    await h.restart();
    const later = await startRun(h, workflow, { address: '  81 Cedar Lane\nLoading dock  ' });
    assert.equal(later.status, 'succeeded');
    assert.equal(records.at(-1).address, '81 Cedar Lane\nLoading dock', 'independent network-edge record matches the intended address');
    let measured = await h.get('skills/' + skill.id);
    assert.equal(measured.active, true); assert.equal(measured.metrics.failed, 0); assert.equal(measured.metrics.runs, 1);
    assert.equal(measured.metrics.owner_verified, 0, 'a successful request cannot claim business correctness');
    const obligation = await h.post('reports/obligations', { run_id: later.id, key: 'normalized-address', description: 'Address independently read back from the destination' }, h.owner, 201);
    await h.post(`reports/obligations/${obligation.id}/verify`, { confirm_business_outcome: true, evidence: 'Read back destination record ' + records.at(-1).id + ': exact address and embedded newline match the intended business address' });
    assert.equal((await h.get('skills/' + skill.id)).metrics.owner_verified, 1);
    // A later valid address reveals a semantic regression: trimming was wrong for this buyer.
    const exact = '  Authorized indentation';
    const regressed = await startRun(h, workflow, { address: exact, preserve_whitespace: true });
    assert.notEqual(stepOf(regressed, 'deliver_address').output.body.address, exact);
    assert.equal((await h.get('skills/' + skill.id)).metrics.owner_verified, 1, 'unverified later work is never called correct');
    await h.post(`workflows/${workflow.id}/rollback`, { version: skill.base_version }, h.owner, 201);
    measured = await h.get('skills/' + skill.id);
    assert.equal(measured.active, false); assert.equal(measured.metrics.runs, 2, 'deployment measurements remain after rollback');
    const recovered = await startRun(h, workflow, { address: exact, preserve_whitespace: true });
    assert.equal(stepOf(recovered, 'deliver_address').output.body.address, exact, 'rollback preserves a newly valid verbatim address');
    const after = await startRun(h, workflow, { address: '  New exception is visible  ' });
    assert.equal(after.status, 'failed');
    for (const c of cases.filter(c => c.revisions.length)) {
      const retained = await h.get('workflow-runs/' + c.id);
      assert.deepEqual(retained.revisions, c.revisions, 'original failed inputs and errors remain unchanged beside corrections');
    }
    const audit = await h.get('audit');
    assert.ok(audit.some(a => a.action === 'skill.propose'));
    assert.ok(audit.some(a => a.action === 'skill.approve'));
    // Existing expiry applies to samples; skills contain references, never extra retained payloads.
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: cases[0].id, confirm: 'ERASE' });
    await h.get('skills/' + skill.id, h.owner, 409);
  } finally { await h.close(); }
});

test('AGENT-003 BASE-001 DATA-001: proposals and evidence restore portably with no authority, and missing retained cases cannot train a skill', async () => {
  const { fake } = network(), h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  let restored;
  try {
    const { workflow, cases, proposal } = await correctionCases(h, 'https://addresses.example/addresses');
    const skill = await h.post('skills', proposal, h.owner, 201);
    await h.post(`skills/${skill.id}/approve`, { digest: skill.digest });
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    assert.equal((await h.get('skills/' + skill.id)).active, true);
    const exported = await archive(h);
    const archivedTables = exported.trim().split('\n').map(JSON.parse).flatMap(p => p.items ?? []).filter(i => i.kind === 'row').map(i => i.table);
    assert.ok(!archivedTables.some(table => table.startsWith('oa_') || table === 'crank_tokens'), 'source sign-in identities, sessions and bearer authority are excluded');
    assert.ok(!exported.includes(h.owner), 'the source session credential never travels');
    const rows = text => text.trim().split('\n').map(JSON.parse).flatMap(p => p.items ?? []).filter(i => i.kind === 'row').map(({table,row}) => JSON.stringify({table,row})).sort();
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    const requests = fake.requests.length;
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    const original = rows(exported), received = rows(await archive(restored));
    const additions = received.filter(row => !original.includes(row));
    assert.deepEqual(additions.map(row => [JSON.parse(row).table, JSON.parse(row).row.action]), [['crank_audit', 'data.restore']]);
    assert.deepEqual(received.filter(row => !additions.includes(row)), original, 'every portable record survives the inactive restore');
    assert.equal((await restored.get('skills/' + skill.id)).active, false, 'a restored published graph has no active authority');
    assert.equal((await restored.get('skills/' + skill.id)).cases.length, 3);
    await restored.post(`skills/${skill.id}/approve`, { digest: (await restored.get('skills/' + skill.id)).digest }, restored.owner, 409);
    assert.equal((await restored.get('workflows/' + workflow.id)).status, 'paused');
    await restored.restart(); await restored.tick(Date.now() + 86400000);
    assert.equal(fake.requests.length, requests, 'restore never receives or sends on source authority');
    // The original owner controls retention, and no copied case survives its deletion.
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: cases[0].id, confirm: 'ERASE' });
    await h.get('skills/' + skill.id, h.owner, 409);
  } finally { await restored?.close(); await h.close(); }
});


test('AI-002: native model proposals stay within scope, sandbox tests fence exact human promotion and portable drafts retain provenance', async () => {
  const fake = fakeEdge(), invoices = [], modelUrl = 'https://authoring-model.example/v1';
  let refuse = false;
  fake.routes.set('authoring-model.example', ({ body }) => {
    for (const secret of ['synthetic-crank-10', 'synthetic-crank-11', 'synthetic-crank-30']) assert.ok(!body.includes(secret), 'No model or app credential enters the model prompt');
    return jsonResponse(authoringModelReply(JSON.parse(body), { refusal: refuse ? 'Sending email exceeds the approved tools.' : null }));
  });
  fake.routes.set('crm-authoring.example', ({ url }) => jsonResponse({ id: url.pathname.split('/').at(-1), country: 'US' }));
  fake.routes.set('sandbox-quickbooks.api.intuit.com', ({ body, method }) => {
    if (method === 'GET') return jsonResponse({ QueryResponse: { Invoice: invoices } });
    const invoice = { ...JSON.parse(body), Id: String(invoices.length + 1) }; invoices.push(invoice);
    return jsonResponse({ Invoice: invoice });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge, bindings: { AI_ENABLED: 'true', AI_MODEL: 'configured-authoring-model', AI_BASE_URL: modelUrl, AI_API_KEY: 'synthetic-crank-30' } });
  let restored;
  try {
    const { request, crm, qbo } = await setupAuthoring(h);
    await h.post('authoring', request, '', 401);
    const token = await h.post('tokens', { label: 'Assistant without promotion authority', scope: 'agent' }, h.owner, 201);
    await h.post('authoring', request, '', 403, { authorization: 'Bearer ' + token.token });
    refuse = true;
    await h.post('authoring', { ...request, prompt: request.prompt + ' Also email the customer.' }, h.owner, 422);
    assert.equal((await h.get('workflows')).length, 0);
    refuse = false;
    let proposal = await h.post('authoring', request, h.owner, 201);
    const base = 'authoring/' + proposal.workflow_id, bindings = { [crm.id]: crm.id, [qbo.id]: qbo.id };
    assert.equal(invoices.length, 0);
    assert.equal(fake.requests.filter(r => r.url.hostname === 'crm-authoring.example').length, 0);
    assert.equal(proposal.model.model, 'configured-authoring-model');
    assert.ok(proposal.questions.length > 0);
    assert.ok(proposal.disclosures.every(d => d.recipient && d.fields && d.retention));
    assert.ok(proposal.schemas.authorized.operations.some(operation => operation.type === 'quickbooks.create_invoice'));
    assert.equal(proposal.grant_proposal.rules.find(rule => rule.type === 'quickbooks.create_invoice').max_usd, request.amount_usd);
    assert.equal((await h.get('grants')).length, 0);
    const inventoryView = await h.get('data/flows');
    assert.deepEqual(inventoryView.flows.find(flow => flow.kind === 'authoring').recipients, [new URL(modelUrl).origin]);
    assert.ok(!JSON.stringify(inventoryView).includes('synthetic-crank-30'));
    const widened = structuredClone(proposal.graph); widened.steps[0].input.method = 'POST';
    await h.post(base + '/revise', { graph: widened }, h.owner, 422);
    await h.post('workflows/' + proposal.workflow_id + '/draft', { graph: widened }, h.owner, 422);
    assert.deepEqual((await h.get(base)).graph, proposal.graph);
    await h.post(base + '/promote', { digest: proposal.digest, confirm: true }, h.owner, 409);
    proposal = await h.post(base + '/revise', { answers: Object.fromEntries(proposal.questions.map(q => [q.id, ''])) });
    assert.ok(proposal.questions.some(q => !q.answer));
    proposal = await h.post(base + '/revise', { answers: Object.fromEntries(proposal.questions.map(q => [q.id, 'Confirmed against the owned CRM sample.'])) });
    await h.post('connections/' + crm.id + '/purpose', { purpose: 'production' });
    await h.post(base + '/test', { bindings }, h.owner, 422);
    await h.post('workflows/' + proposal.workflow_id + '/test', { bindings, input: request.samples[0] }, h.owner, 422);
    assert.equal(invoices.length, 0);
    await h.post('connections/' + crm.id + '/purpose', { purpose: 'test' });
    proposal = await h.post(base + '/test', { bindings });
    assert.equal(proposal.tested.passed, true);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].CustomerRef.value, request.customer_id);
    assert.equal(invoices[0].Line[0].Amount, Number(request.amount_usd));
    const testedDigest = proposal.digest;
    proposal = await h.post(base + '/revise', { samples: [{ id: 'lead-2' }] });
    assert.equal(proposal.tested.passed, false);
    await h.post(base + '/promote', { digest: testedDigest, confirm: true }, h.owner, 409);
    proposal = await h.post(base + '/test', { bindings });
    await h.post('workflows/' + proposal.workflow_id + '/publish', {}, h.owner, 409);
    await h.post('workflows/' + proposal.workflow_id + '/estimate', { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner acceptance journey uses nonbilling network edges' })) } });
    await h.post(base + '/promote', { digest: proposal.digest, confirm: true }, '', 403, { authorization: 'Bearer ' + token.token });
    proposal = await h.post(base + '/promote', { digest: proposal.digest, confirm: true });
    assert.equal(proposal.promoted, true);
    const workflow = await h.get('workflows/' + proposal.workflow_id);
    assert.equal(workflow.status, 'published');
    const beforePurposeChange = invoices.length;
    await h.post('connections/' + qbo.id + '/purpose', { purpose: 'production' });
    const blocked = await startRun(h, workflow, { id: 'lead-3' });
    assert.equal(blocked.status, 'paused');
    assert.equal(invoices.length, beforePurposeChange, 'The authoring executor fence still refuses production effects after promotion');
    await h.post('connections/' + qbo.id + '/purpose', { purpose: 'test' });
    const audit = await h.get('audit');
    assert.ok(audit.some(a => a.action === 'authoring.promote' && a.version_id === workflow.published_version_id));
    proposal = await h.post(base + '/revise', { samples: [{ id: 'lead-4' }] });
    assert.equal(proposal.promoted, false);
    assert.equal(proposal.tested.passed, false);
    assert.equal((await h.get('workflows/' + proposal.workflow_id)).published_version_id, workflow.published_version_id);
    await h.restart();
    assert.equal((await h.get(base)).digest, proposal.digest);
    const archiveText = await archive(h);
    assert.ok(archiveText.includes('authoring.generate'));
    assert.ok(!archiveText.includes('synthetic-crank-30'));
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    const beforeRestore = fake.requests.length;
    await restored.post('data/restore', { archive: archiveText, confirm: 'RESTORE' });
    const original = inventory(archiveText), received = inventory(await archive(restored));
    const additions = received.filter(row => !original.includes(row));
    assert.deepEqual(additions.map(row => [JSON.parse(row).table, JSON.parse(row).row.action]), [['crank_audit', 'data.restore']]);
    assert.deepEqual(received.filter(row => !additions.includes(row)), original);
    assert.deepEqual((await restored.get(base)).samples, proposal.samples);
    assert.equal((await restored.get('workflows/' + proposal.workflow_id)).status, 'paused');
    assert.ok((await restored.get('connections')).every(c => c.status === 'needs_reconnect'));
    assert.equal((await restored.get('grants')).length, 0);
    await restored.restart(); await restored.tick(Date.now() + 86400000);
    await restored.post(base + '/test', { bindings }, restored.owner, 409);
    await restored.post(base + '/promote', { digest: proposal.digest, confirm: true }, restored.owner, 422);
    assert.equal(fake.requests.length, beforeRestore);
    assert.ok(fake.requests.every(request => ['authoring-model.example', 'crm-authoring.example', 'sandbox-quickbooks.api.intuit.com'].includes(request.url.hostname)), 'The owner-selected model, CRM and accounting endpoints need no author network');
  } finally { await restored?.close(); await h.close(); }
});
