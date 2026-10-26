import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, startRun, stepOf } from './kit.mjs';
import { archive, inventory } from './restore-journey.mjs';
import { correctionCases } from './skills-fixture.mjs';
import { authoringModelReply, setupAuthoring } from './authoring-fixture.mjs';

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
  const fake = fakeEdge(), invoices = [];
  let refuse = false;
  fake.routes.set('authoring-model.example', ({ body }) => jsonResponse(authoringModelReply(JSON.parse(body), { refusal: refuse ? 'Sending email exceeds the approved tools.' : null })));
  fake.routes.set('crm-authoring.example', ({ url }) => jsonResponse({ id: url.pathname.split('/').at(-1), country: 'US' }));
  fake.routes.set('sandbox-quickbooks.api.intuit.com', ({ body, method }) => {
    if (method === 'GET') return jsonResponse({ QueryResponse: { Invoice: invoices } });
    const invoice = { ...JSON.parse(body), Id: String(invoices.length + 1) }; invoices.push(invoice);
    return jsonResponse({ Invoice: invoice });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge, bindings: { AI_ENABLED: 'true', AI_MODEL: 'configured-authoring-model', AI_BASE_URL: 'https://authoring-model.example/v1', AI_API_KEY: 'synthetic-crank-30' } });
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
  } finally { await restored?.close(); await h.close(); }
});
