import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

/** EXEC-006: structured business-key readback must preserve uncertain effects;
 * an unavailable or ambiguous read is never a license to repeat the write. */
export async function effectReadbackJourney() {
  const fake = fakeEdge();
  let mode = 'one', writes = 0;
  const pending = new Set();
  fake.routes.set('financial.example', ({ method }) => {
    if (method === 'POST') {
      writes++;
      const response = new Promise(resolve => setTimeout(() => resolve(jsonResponse({ id: 'synthetic-crank-invoice' }, 201)), 500));
      pending.add(response); response.finally(() => pending.delete(response)); return response;
    }
    if (mode === 'unavailable') return jsonResponse({}, 503);
    if (mode === 'invalid') return jsonResponse({ unexpected: [] });
    if (mode === 'malformed') return new Response('not JSON', { headers: { 'content-type': 'application/json' } });
    return jsonResponse({ items: mode === 'zero' ? [] : [
      { id: 'synthetic-crank-invoice', business_key: 'synthetic-crank-order', amount_usd: '19.99' },
      ...(mode === 'multiple' ? [{ id: 'synthetic-crank-duplicate', business_key: 'synthetic-crank-order', amount_usd: '19.99' }] : []),
      { id: 'synthetic-crank-unrelated', business_key: 'different-order', amount_usd: '19.99' },
    ] });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const workflow = await publish(h, 'Invoice readback by order', { trigger: { type: 'manual' }, steps: [
      { id: 'invoice', type: 'http', on_error: 'continue', timeout_ms: 200, retry_policy: { read_attempts: 1 }, input: { method: 'POST', url: 'https://financial.example/invoices', body: { order: '{{trigger.input.order}}', amount_usd: '19.99' } }, readback: { url: 'https://financial.example/invoices', records_path: 'items', path: 'business_key', equals: '{{trigger.input.order}}' } },
      { id: 'result', type: 'map', input: { id: '{{steps.invoice.body.id}}' } },
    ] });
    const found = await startRun(h, workflow, { order: 'synthetic-crank-order' });
    assert.equal(found.status, 'succeeded'); assert.equal(stepOf(found, 'invoice').output.reconciled, true);
    assert.equal(stepOf(found, 'result').output.id, 'synthetic-crank-invoice'); assert.equal(writes, 1);
    for (mode of ['zero', 'multiple', 'unavailable', 'invalid', 'malformed']) {
      const before = writes, run = await startRun(h, workflow, { order: 'synthetic-crank-order' });
      assert.equal(run.status, 'uncertain', mode + ': continue-on-error cannot hide uncertainty; a readback failure cannot turn the original unknown write into a replayable failure');
      assert.equal(stepOf(run, 'invoice').status, 'uncertain'); assert.equal(stepOf(run, 'result'), undefined);
      assert.equal(writes, before + 1, 'the original write is never retried');
      if (mode === 'zero') assert.equal(run.error.match_count, 0);
      if (mode === 'multiple') { assert.equal(run.error.match_count, 2); assert.equal(run.error.decision_required, true); }
      await h.restart();
      assert.deepEqual((await h.get(`workflow-runs/${run.id}/replay`)).eligible, [], 'unknown effects remain ineligible for blind replay after restart');
      assert.equal(writes, before + 1);
    }
  } finally { await Promise.allSettled([...pending]); await h.close(); }
}
