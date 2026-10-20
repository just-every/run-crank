import assert from 'node:assert/strict';
import { publish, startRun, stepOf } from './kit.mjs';

export const workflowName = 'Harbor Workshop — address normalization for multi-line delivery instructions';
export async function correctionCases(h, url) {
  const workflow = await publish(h, workflowName, { trigger: { type: 'manual' }, steps: [
    { id: 'deliver_address', type: 'http', input: { method: 'POST', url, body: { address: '{{trigger.input.address}}', preserve_whitespace: '{{trigger.input.preserve_whitespace}}' } } },
  ] });
  const cases = [];
  for (const address of ['  114 Maple Avenue, Suite 200  ', '\n48 Harbor Street, Floor 3\n']) {
    const failed = await startRun(h, workflow, { address });
    assert.equal(failed.status, 'failed');
    const preview = await h.get(`workflow-runs/${failed.id}/replay`);
    const input = structuredClone(stepOf(failed, 'deliver_address').input);
    input.body.address = address.trim();
    const corrected = await h.post(`workflow-runs/${failed.id}/replay`, { digest: preview.digest, paths: ['deliver_address'], corrections: { deliver_address: input } });
    assert.equal(corrected.status, 'succeeded');
    assert.equal(corrected.revisions[0].prior_input.body.address, address);
    cases.push(corrected);
  }
  const good = await startRun(h, workflow, { address: '29 Oak Street\nRear entrance  —  keep spacing' });
  assert.equal(good.status, 'succeeded');
  cases.push(good);
  return { workflow, cases, proposal: { workflow_id: workflow.id, step_id: 'deliver_address', field: 'body.address', run_ids: cases.map(r => r.id) } };
}
