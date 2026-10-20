import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, startRun, stepOf } from './kit.mjs';
import { archive } from './restore-journey.mjs';
import { correctionCases } from './skills-fixture.mjs';

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
    const rows = text => text.trim().split('\n').map(JSON.parse).flatMap(p => p.items ?? []).filter(i => i.kind === 'row').map(i => JSON.stringify(i)).sort();
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
