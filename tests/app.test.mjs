import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { publish, startRun } from './kit.mjs';

// The app's pages through their HTTP doors: the Flow editor reads a published
// workflow's steps and runs, and an approval decided from the Approvals form
// continues the run it holds.
let h;
before(async () => { h = await harness('http://127.0.0.1:9') });
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
