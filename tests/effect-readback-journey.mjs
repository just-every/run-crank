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

/** Native financial reconciliation, owner continuation and independent compensation. */
export async function quickbooksReconciliationJourney({ inspect } = {}) {
  const fake = fakeEdge(), pending = new Set(), seenVoidKeys = new Set();
  let mode = 'zero', creates = 0, voids = 0;
  const invoice = { Id: 'synthetic-crank-1', SyncToken: '0', DocNumber: 'synthetic-crank-1', CustomerRef: { value: 'synthetic-crank-2' }, TotalAmt: 19.99, CurrencyRef: { value: 'USD' } };
  fake.routes.set('sandbox-quickbooks.api.intuit.com', ({ method, url, body }) => {
    if (method === 'GET' && url.pathname.endsWith('/query')) {
      const entity = url.searchParams.get('query').includes('RefundReceipt') ? 'RefundReceipt' : 'Invoice';
      return jsonResponse({ QueryResponse: { [entity]: mode === 'zero' ? [] : [invoice, ...(mode === 'multiple' ? [{ ...invoice, Id: 'synthetic-crank-3' }] : [])] } });
    }
    if (method === 'POST' && url.searchParams.get('operation') === 'void') {
      const key = url.searchParams.get('requestid');
      if (!seenVoidKeys.has(key)) { voids++; seenVoidKeys.add(key); }
      assert.equal(JSON.parse(body).Id, invoice.Id);
      return jsonResponse({ Invoice: { ...invoice, TotalAmt: 0 } });
    }
    if (method === 'POST') {
      creates++; assert.ok(url.searchParams.get('requestid'));
      const promise = new Promise(resolve => setTimeout(() => resolve(jsonResponse({ Invoice: invoice })), 500));
      pending.add(promise); promise.finally(() => pending.delete(promise)); return promise;
    }
    return jsonResponse({ Invoice: { ...invoice, TotalAmt: 0 } });
  });
  fake.routes.set('downstream.example', () => jsonResponse({ refused: true }, 400));
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const c = await h.post('connections', { app: 'quickbooks', label: 'Harbour QuickBooks sandbox', account_name: '1234', scopes: ['com.intuit.quickbooks.accounting'], auth_kind: 'oauth2', secret: { access_token: 'synthetic-crank-4' } }, h.owner, 201);
    const step = { id: 'invoice', name: 'Create workshop invoice', type: 'quickbooks.create_invoice', connection_id: c.id, timeout_ms: 200, input: { realm_id: '1234', business_key: invoice.DocNumber, payload: { CustomerRef: invoice.CustomerRef, Line: [{ Amount: 19.99, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] } } };
    const flow = await publish(h, 'Harbour invoice with delivery failure', { trigger: { type: 'manual' }, steps: [step, { id: 'later', type: 'http', input: { method: 'GET', url: 'https://downstream.example/fail' } }] });
    let run = await startRun(h, flow, {});
    assert.equal(run.status, 'uncertain'); assert.equal(creates, 1);
    await h.restart();
    let preview = await h.get(`workflow-runs/${run.id}/reconcile?path=invoice`);
    assert.deepEqual(preview.matches, []);
    await h.post(`workflow-runs/${run.id}/reconcile`, { path: 'invoice', digest: preview.digest, remote_id: invoice.Id, reason: 'No matching record' }, h.owner, 422);
    assert.equal(creates, 1);
    mode = 'multiple'; preview = await h.get(`workflow-runs/${run.id}/reconcile?path=invoice`);
    assert.equal(preview.matches.length, 2);
    await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    const page = await h.send(`/app/workflow-runs/${run.id}?reconcile=invoice`, undefined, h.owner);
    assert.equal(page.status, 200); assert.ok(page.text.includes('Use record and continue'));
    if (inspect) await inspect({ h, run, preview, state: 'multiple' });
    mode = 'one';
    await h.post(`workflow-runs/${run.id}/reconcile`, { path: 'invoice', digest: preview.digest, remote_id: invoice.Id, reason: 'Stale choice' }, h.owner, 409);
    preview = await h.get(`workflow-runs/${run.id}/reconcile?path=invoice`);
    const decision = { path: 'invoice', digest: preview.digest, remote_id: invoice.Id, reason: 'Matched the customer and order in QuickBooks' };
    const fromUi = inspect && await inspect({ h, run, preview, decision, state: 'choose' });
    run = fromUi ?? await h.post(`workflow-runs/${run.id}/reconcile`, decision);
    assert.equal(run.status, 'failed'); assert.equal(stepOf(run, 'invoice').status, 'succeeded');
    assert.equal(stepOf(run, 'invoice').trace.reconciliation.provider_id, invoice.Id);
    assert.equal(stepOf(run, 'later').status, 'failed'); assert.equal(creates, 1);
    await h.post(`workflow-runs/${run.id}/reconcile`, { path: 'invoice', digest: preview.digest, remote_id: invoice.Id, reason: 'Repeated decision' }, h.owner, 409);
    if (inspect) await inspect({ h, run, state: 'continued' });
    const compensation = await publish(h, 'Harbour separately authorized invoice void', { trigger: { type: 'manual' }, steps: [{ id: 'void_invoice', type: 'quickbooks.void_invoice', connection_id: c.id, input: { source_run_id: run.id, source_path: 'invoice' } }] });
    let cancel = await startRun(h, compensation, {});
    assert.equal(cancel.status, 'awaiting_approval'); assert.equal(voids, 0);
    const decide = (r, choice) => h.post(`workflow-runs/${r.id}/${choice}`, { path: 'void_invoice', digest: r.waits[0].proposal_digest, reason: 'Compensate the failed downstream delivery' });
    assert.equal((await decide(cancel, 'reject')).status, 'rejected'); assert.equal(voids, 0);
    cancel = await startRun(h, compensation, {});
    if (inspect) await inspect({ h, run: cancel, state: 'compensation-review' });
    await h.restart(); cancel = await h.get(`workflow-runs/${cancel.id}`);
    cancel = await decide(cancel, 'approve');
    assert.equal(cancel.status, 'succeeded'); assert.equal(voids, 1); assert.equal(creates, 1);
    assert.equal(stepOf(cancel, 'void_invoice').output.compensation_of, run.id);
    if (inspect) await inspect({ h, run: cancel, state: 'compensated' });
    const refund = await publish(h, 'Harbour refund readback', { trigger: { type: 'manual' }, steps: [{ ...step, type: 'quickbooks.create_refund_receipt' }] });
    const recovered = await startRun(h, refund, {});
    assert.equal(recovered.status, 'succeeded'); assert.equal(stepOf(recovered, 'invoice').output.body.RefundReceipt.Id, invoice.Id); assert.equal(creates, 2);
    const archive = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(archive.status, 200); assert.ok(!archive.text.includes('synthetic-crank-4'));
    const restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    try {
      await restored.post('data/restore', { archive: archive.text, confirm: 'RESTORE' });
      assert.equal((await restored.get(`workflow-runs/${run.id}`)).steps[0].trace.reconciliation.provider_id, invoice.Id);
      assert.ok((await restored.get('connections')).every(c => c.status === 'needs_reconnect'));
    } finally { await restored.close(); }
  } finally { await Promise.allSettled([...pending]); await h.close(); }
}
