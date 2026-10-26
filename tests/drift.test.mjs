import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { driftCost, driftFixture } from './drift-fixture.mjs';
import { driftRepairJourney } from './drift-journey.mjs';

test('Native drift repair tests twenty retained cases, refuses scopes and stale approval, preserves effects and resumes held runs once', driftRepairJourney);

test('Drift repairs restore inactive and erased retained evidence cannot authorize deployment', async () => {
  const { h, fake, proposal, bindings, workflow } = await driftFixture();
  try {
    const tested = await h.post(`drift/${proposal.proposal.id}/test`, { digest: proposal.digest, bindings });
    const backup = await archive(h), restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    try {
      await restored.post('data/restore', { archive: backup, confirm: 'RESTORE' });
      const inactive = await restored.get('drift/' + proposal.proposal.id);
      assert.equal(inactive.proposal.status, 'inactive');
      assert.equal(inactive.incident.state, 'inactive');
      assert.equal(inactive.cases.length, 20);
      await restored.post(`drift/${proposal.proposal.id}/approve`, { digest: inactive.digest, business_meaning_confirmed: true, cost: driftCost }, restored.owner, 409);
    } finally { await restored.close(); }
    let erasedSource;
    for (const sample of tested.cases) if ((await h.get('workflow-runs/' + sample.source_run_id)).status === 'succeeded') { erasedSource = sample.source_run_id; break; }
    assert.ok(erasedSource);
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: erasedSource, confirm: 'ERASE' });
    await h.post(`workflows/${workflow.id}/resume`);
    const erased = await h.get('drift/' + proposal.proposal.id);
    await h.post(`drift/${proposal.proposal.id}/approve`, { digest: erased.digest, business_meaning_confirmed: true, cost: driftCost }, h.owner, 409);
    assert.equal((await h.get('workflows/' + workflow.id)).published_version_id, proposal.proposal.version_id);
  } finally { await h.close(); }
});
