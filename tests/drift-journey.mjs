import assert from 'node:assert/strict';
import { startRun, stepOf } from './kit.mjs';
import { driftCost, driftFixture } from './drift-fixture.mjs';

export async function driftRepairJourney({ inspect } = {}) {
  const fixture = await driftFixture(), { h, counts, workflow, held, incident, bindings } = fixture;
  try {
    const before = structuredClone(counts.production);
    await h.get('drift', '', 401);
    const agent = await h.post('tokens', { label: 'Preparation agent cannot approve mapping meaning', scope: 'agent' }, h.owner, 201);
    await h.post('drift', { incident_id: incident.id, source_after: 'amount_total' }, '', 403, { authorization: 'Bearer ' + agent.token });
    const scope = await h.post('drift', { incident_id: incident.id, kind: 'scope', scopes: ['records.private.read'] }, h.owner, 201);
    await h.post(`drift/${scope.proposal.id}/approve`, { digest: scope.digest, business_meaning_confirmed: true }, h.owner, 403);
    const refused = await h.post(`drift/${scope.proposal.id}/reject`, { digest: scope.digest });
    assert.equal(refused.proposal.status, 'rejected');
    assert.deepEqual((await h.get('connections')).find(connection => connection.id === fixture.production.http.id).scopes, []);
    let proposal = fixture.proposal;
    await inspect?.({ h, workflow, proposal, state: 'proposal' });
    await h.post(`drift/${proposal.proposal.id}/test`, { digest: proposal.digest, bindings: { ...bindings, [fixture.production.http.id]: fixture.production.http.id } }, h.owner, 422);
    proposal = await h.post(`drift/${proposal.proposal.id}/test`, { digest: proposal.digest, bindings });
    assert.equal(proposal.cases.length, 20);
    assert.ok(proposal.cases.every(sample => sample.result === 'succeeded' && sample.source_run_id && sample.test_run_id));
    assert.deepEqual(counts.production, before, 'real sandbox tests cannot dispatch a production-bound effect');
    assert.equal(counts.test.invoice, 20);
    await inspect?.({ h, workflow, proposal, state: 'tested' });
    for (const sample of proposal.cases) {
      const source = await h.get('workflow-runs/' + sample.source_run_id), tested = await h.get('workflow-runs/' + sample.test_run_id);
      assert.deepEqual(tested.trigger, source.trigger, 'each original trigger envelope is preserved');
      assert.equal(tested.mode, 'test');
      assert.equal(stepOf(tested, 'mapping').output.amount, 19.99);
    }
    await h.post(`drift/${proposal.proposal.id}/approve`, { digest: fixture.proposal.digest, business_meaning_confirmed: true, cost: driftCost }, h.owner, 409);
    await h.restart();
    proposal = await h.get('drift/' + proposal.proposal.id);
    const approved = await h.post(`drift/${proposal.proposal.id}/approve`, { digest: proposal.digest, business_meaning_confirmed: true, cost: driftCost });
    assert.equal(approved.proposal.status, 'approved');
    await inspect?.({ h, workflow, proposal: approved, state: 'approved' });
    assert.equal(approved.continuations.length, 3);
    assert.equal((await h.get('workflows/' + workflow.id)).status, 'published');
    for (const original of held) {
      const resumed = await h.get('workflow-runs/' + original.id);
      assert.equal(resumed.status, 'succeeded');
      assert.equal(resumed.version_id, approved.proposal.approved_version_id);
      for (const completed of original.steps.filter(step => step.status === 'succeeded')) {
        const retained = resumed.steps.find(step => step.path === completed.path);
        assert.deepEqual(retained.output, completed.output);
        assert.equal(retained.operation_key, completed.operation_key);
      }
    }
    assert.equal(counts.production.accept, 23);
    assert.equal(counts.production.invoice, 23);
    assert.equal(counts.production.notify, 23);
    await h.post(`drift/${proposal.proposal.id}/approve`, { digest: approved.digest, business_meaning_confirmed: true, cost: driftCost }, h.owner, 409);
    assert.equal(counts.production.invoice, 23);
    const rolled = await h.post(`drift/${proposal.proposal.id}/rollback`, { digest: approved.digest });
    assert.equal(rolled.proposal.status, 'rolled_back');
    await inspect?.({ h, workflow, proposal: rolled, state: 'rolled_back' });
    assert.equal((await startRun(h, workflow, { key: 'synthetic-crank-24' })).status, 'paused');
    assert.equal(counts.production.invoice, 23);
  } finally { await h.close(); }
}
