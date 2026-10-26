import assert from 'node:assert/strict';
import { publish, startRun, stepOf } from './kit.mjs';

export async function driftOwnership(h) {
  const workflow = await publish(h, 'Owned typed provider field mapping', { trigger: { type: 'manual' }, steps: [
    { id: 'mapping', type: 'drift.map', input: { record: '{{trigger.input}}' }, fields: { amount: { source: 'amount_total', type: 'number' } } },
  ] });
  const run = await startRun(h, workflow, { amount_total: 19.99 });
  assert.equal(run.status, 'succeeded');
  assert.equal(stepOf(run, 'mapping').output.amount, 19.99);
  return run.steps.filter(step => step.status === 'succeeded').map(step => step.type);
}
