import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { connection, fakeEdge, jsonResponse, publish, settled, startRun, stepOf } from './kit.mjs';

/** Native create doors preserve every line and reject unsafe nested mappings. */
export async function quickbooksInputJourney({ inspect } = {}) {
  const fake = fakeEdge(), payloads = [];
  fake.routes.set('sandbox-quickbooks.api.intuit.com', ({ method, url, body }) => {
    assert.equal(method, 'POST');
    const payload = JSON.parse(body); payloads.push(payload);
    const entity = url.pathname.endsWith('/invoice') ? 'Invoice' : 'RefundReceipt';
    return jsonResponse({ [entity]: { ...payload, Id: 'synthetic-crank-1' } });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const account = await connection(h, { app: 'quickbooks', label: 'Synthetic accounting company', account_name: '1234', auth_kind: 'oauth2', secret: { access_token: 'synthetic-crank-1' }, scopes: ['com.intuit.quickbooks.accounting'] });
    const sale = (amount, detail = {}) => ({ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, ...detail } });
    const payload = { CustomerRef: { value: 'synthetic-crank-2' }, PrivateNote: '', CustomerMemo: { value: '' },
      DepartmentRef: { value: 'synthetic-crank-3' }, DueDate: '2026-11-30', SalesTermRef: { value: '1' },
      Line: [sale('10.00', { Qty: 2, UnitPrice: '5.00', TaxCodeRef: { value: 'TAX' }, ClassRef: { value: '1' } }),
        sale('5.00', { TaxCodeRef: { value: 'NON' } }),
        { Amount: '5.00', DetailType: 'DiscountLineDetail', DiscountLineDetail: { PercentBased: false, DiscountAccountRef: { value: '1' } } }],
      TxnTaxDetail: { TotalTax: '1.00', TaxLine: [{ Amount: '1.00', DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' }, PercentBased: true, TaxPercent: 10, NetAmountTaxable: '10.00' } }] } };
    const create = (type = 'quickbooks.create_invoice', input = {}) => ({ id: 'invoice', name: 'Create mapped invoice', type, connection_id: account.id,
      input: { realm_id: '1234', business_key: '{{trigger.input.key}}', payload: '{{trigger.input.payload}}', amount_usd: '{{trigger.input.total}}', ...input } });
    const workflow = await publish(h, 'Mapped accounting lines', { trigger: { type: 'manual' }, steps: [create()] });
    const runInput = { key: 'synthetic-crank-1', payload, total: '11.00' };
    let run = await startRun(h, workflow, runInput);
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(payloads.at(-1), { ...payload, DocNumber: runInput.key, CurrencyRef: { value: 'USD' } });
    assert.equal(stepOf(run, 'invoice').output.body.Invoice.Line.length, 3);
    if (inspect) await inspect({ h, workflow, run, state: 'three-lines' });
    const four = { ...payload, Line: [...payload.Line, sale('0.99', { Qty: '3', UnitPrice: '0.33' })] };
    const refund = await publish(h, 'Mapped refund lines', { trigger: { type: 'manual' }, steps: [create('quickbooks.create_refund_receipt')] });
    run = await startRun(h, refund, { ...runInput, payload: four, total: '11.99' });
    assert.equal(run.status, 'succeeded'); assert.deepEqual(payloads.at(-1).Line, four.Line);
    assert.deepEqual(stepOf(run, 'invoice').output.body.RefundReceipt.TxnTaxDetail, payload.TxnTaxDetail);
    // Optional declared totals remain optional; no defaults are fabricated for quantities or prices.
    assert.equal((await startRun(h, workflow, { ...runInput, total: undefined })).status, 'succeeded');
    const defaults = { ...payload, Line: [sale('0.30')], TxnTaxDetail: undefined };
    assert.equal((await startRun(h, workflow, { ...runInput, payload: defaults, total: '0.30' })).status, 'succeeded');
    assert.deepEqual(payloads.at(-1).Line, defaults.Line);
    const providerDefaults = { ...defaults, Line: [{ Amount: '0.30', DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }] };
    assert.equal((await startRun(h, workflow, { ...runInput, payload: providerDefaults, total: '0.30' })).status, 'succeeded');
    assert.deepEqual(payloads.at(-1).Line, providerDefaults.Line, 'optional item, quantity and price defaults stay with the provider');
    const exact = { ...payload, Line: [sale('9007199254740993.01')], TxnTaxDetail: undefined };
    assert.equal((await startRun(h, workflow, { ...runInput, payload: exact, total: '9007199254740993.01' })).status, 'succeeded');
    assert.equal(payloads.at(-1).Line[0].Amount, '9007199254740993.01');
    // Unit prices may be finer than cents when the resulting amount is exact cents.
    const fractionalPrice = { ...defaults, Line: [sale('0.250', { Qty: 2, UnitPrice: '0.125' })] };
    assert.equal((await startRun(h, workflow, { ...runInput, payload: fractionalPrice, total: undefined })).status, 'succeeded');
    assert.deepEqual(payloads.at(-1).Line, fractionalPrice.Line);
    const noTotalWrites = payloads.length;
    for (const target of [workflow, refund]) {
      const conflict = { ...defaults, Line: [sale('0.25', { Qty: 2, UnitPrice: '0.20' })] };
      const failed = await startRun(h, target, { ...runInput, payload: conflict, total: undefined });
      assert.equal(failed.status, 'failed', 'omitting an optional total must not admit contradictory line amounts');
      assert.equal(failed.error.field, 'input.payload.Line[0].Amount');
      assert.match(failed.error.message, /quantity and unit price/);
      const badLiteral = await h.send('/api/crank/workflows', { name: 'Conflicting line amount', graph: { trigger: { type: 'manual' }, steps: [create(target === refund ? 'quickbooks.create_refund_receipt' : undefined, { payload: conflict, amount_usd: undefined })] } }, h.owner);
      assert.equal(badLiteral.status, 422); assert.match(badLiteral.value.error, /Line\[0\].Amount/);
      const mixed = structuredClone(conflict); mixed.CustomerRef.value = { $ref: 'trigger.input.customer' };
      const mixedLiteral = await h.send('/api/crank/workflows', { name: 'Partly mapped conflicting line', graph: { trigger: { type: 'manual' }, steps: [create(undefined, { payload: mixed, amount_usd: undefined })] } }, h.owner);
      assert.equal(mixedLiteral.status, 422, 'a dynamic customer does not hide definite line arithmetic');
    }
    assert.equal(payloads.length, noTotalWrites);
    const mapped = await publish(h, 'Individual mapped accounting lines', { trigger: { type: 'manual' }, steps: [create(undefined, {
      payload: { CustomerRef: { value: { $ref: 'trigger.input.customer' } },
        Line: ['{{trigger.input.first}}', '{{trigger.input.middle}}', '{{trigger.input.last}}'],
        PrivateNote: '{{trigger.input.note}}' },
    })] });
    const mappedInput = { key: 'synthetic-crank-4', customer: payload.CustomerRef.value, first: payload.Line[0], middle: payload.Line[1], last: payload.Line[2], note: '' };
    assert.equal((await startRun(h, mapped, mappedInput)).status, 'succeeded');
    assert.deepEqual(payloads.at(-1).Line, payload.Line); assert.equal(payloads.at(-1).PrivateNote, '');
    const mappedWrites = payloads.length;
    const missingLine = await startRun(h, mapped, { ...mappedInput, middle: undefined, note: undefined });
    assert.equal(missingLine.status, 'failed', 'a missing mapped line cannot silently shorten an invoice');
    assert.equal(missingLine.error.field, 'input.payload.Line[1]'); assert.equal(missingLine.error.kind, 'missing');
    assert.equal(payloads.length, mappedWrites);
    const invalid = [
      [{ ...payload, CustomerRef: {} }, 'input.payload.CustomerRef.value', 'missing'],
      [{ ...payload, CustomerRef: { value: null } }, 'input.payload.CustomerRef.value', 'null'],
      [{ ...payload, CustomerRef: { value: '' } }, 'input.payload.CustomerRef.value', 'empty'],
      [{ ...payload, CustomerRef: { value: 5 } }, 'input.payload.CustomerRef.value', 'text'],
      [{ ...payload, Line: [] }, 'input.payload.Line', 'empty'],
      [{ ...payload, Line: 'not lines' }, 'input.payload.Line', 'array'],
      [{ ...payload, Line: [null] }, 'input.payload.Line[0]', 'null'],
      [{ ...payload, Line: [sale('10.00'), { DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] }, 'input.payload.Line[1].Amount', 'missing'],
      [{ ...payload, Line: [sale('10.00'), { Amount: '1.00', DetailType: 'SalesItemLineDetail' }] }, 'input.payload.Line[1].SalesItemLineDetail', 'missing'],
      [{ ...payload, Line: [sale('1.00', { ItemRef: { value: '' } })] }, 'input.payload.Line[0].SalesItemLineDetail.ItemRef.value', 'empty'],
      [{ ...payload, Line: [sale('10.00'), sale('1.00', { Qty: 'several' })] }, 'input.payload.Line[1].SalesItemLineDetail.Qty', 'decimal'],
      [{ ...payload, Line: [sale('10.00'), sale('1.00', { UnitPrice: {} })] }, 'input.payload.Line[1].SalesItemLineDetail.UnitPrice', 'decimal'],
      [{ ...payload, Line: [sale('10.00'), { ...payload.Line[2], DiscountLineDetail: { PercentBased: 'false' } }] }, 'input.payload.Line[1].DiscountLineDetail.PercentBased', 'boolean'],
      [{ ...payload, TxnTaxDetail: { TotalTax: 'unknown' } }, 'input.payload.TxnTaxDetail.TotalTax', 'decimal'],
      [{ ...payload, Line: [sale('10.00', { TaxCodeRef: 'TAX' })] }, 'input.payload.Line[0].SalesItemLineDetail.TaxCodeRef', 'object'],
      [{ ...payload, CurrencyRef: { value: 'EUR' } }, 'input.payload.CurrencyRef.value', 'USD'],
      [null, 'input.payload', 'null'],
      [undefined, 'input.payload', 'missing'],
      [{ ...payload, Line: [sale('0.001')] }, 'input.payload.Line[0].Amount', 'cents'],
      [{ ...payload, TxnTaxDetail: { TotalTax: '0.001' } }, 'input.payload.TxnTaxDetail.TotalTax', 'cents'],
      [{ ...payload, TxnTaxDetail: { TaxLine: [{ Amount: '0.001', DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '1' } } }] } }, 'input.payload.TxnTaxDetail.TaxLine[0].Amount', 'cents'],
      [{ ...payload, Line: [sale('not money')] }, 'input.payload.Line[0].Amount', 'decimal'],
      [{ ...payload, Line: [sale('1.00', { ItemRef: null })] }, 'input.payload.Line[0].SalesItemLineDetail.ItemRef', 'null'],
    ];
    for (const [bad, field, error] of invalid) {
      const before = payloads.length;
      for (const target of [workflow, refund]) {
        const failed = await startRun(h, target, { ...runInput, payload: bad });
        assert.equal(failed.status, 'failed'); assert.equal(failed.error.category, 'validation');
        assert.equal(failed.error.field, field); assert.ok(failed.error.message.includes(error), failed.error.message);
        assert.equal(stepOf(failed, 'invoice').status, 'failed');
      }
      assert.equal(payloads.length, before, 'invalid resolved inputs never reach the provider');
      const graph = { trigger: { type: 'manual' }, steps: [create(undefined, { payload: bad })] };
      for (const path of ['/api/crank/workflows', `/api/crank/workflows/${workflow.id}/draft`, `/api/crank/workflows/${workflow.id}/validate`]) {
        const refused = await h.send(path, { name: 'Invalid literal invoice', graph }, h.owner);
        assert.equal(refused.status, 422, refused.text); assert.ok(refused.value.error.includes(field), refused.text);
      }
      for (const target of [workflow, refund]) assert.equal((await startRun(h, target, runInput)).status, 'succeeded', 'a valid mapping remains usable after refusal');
    }
    const before = payloads.length;
    for (const total of ['10.99', '11.01']) {
      const mismatch = await startRun(h, workflow, { ...runInput, total });
      assert.equal(mismatch.status, 'failed'); assert.match(mismatch.error.message, /exact line, discount and tax total/);
      const literalMismatch = await h.send('/api/crank/workflows', { name: 'Incorrect literal total', graph: { trigger: { type: 'manual' }, steps: [create(undefined, { payload, amount_usd: total })] } }, h.owner);
      assert.equal(literalMismatch.status, 422); assert.match(literalMismatch.value.error, /input.amount_usd/);
    }
    const mismatch = await startRun(h, workflow, { ...runInput, payload: { ...payload, Line: [sale('10.00', { Qty: 3, UnitPrice: '3.33' })] }, total: '11.00' });
    assert.equal(mismatch.status, 'failed'); assert.equal(payloads.length, before);
    const fractionalTotal = await startRun(h, workflow, { ...runInput, total: '11.001' });
    assert.equal(fractionalTotal.status, 'failed'); assert.equal(fractionalTotal.error.field, 'input.amount_usd');
    assert.match(fractionalTotal.error.message, /cents/); assert.equal(payloads.length, before);
    // Publication revalidates a retained draft from before the schema was installed.
    const legacy = { trigger: { type: 'manual' }, steps: [create(undefined, { payload: { ...payload, Line: [] } })] };
    await h.db.prepare('UPDATE crank_workflows SET draft_json=? WHERE id=?').bind(JSON.stringify(legacy), refund.id).run();
    const refused = await h.send(`/api/crank/workflows/${refund.id}/publish`, {}, h.owner);
    assert.equal(refused.status, 422); assert.match(refused.value.error, /input.payload.Line/); assert.equal(payloads.length, before);
    const legacyConflict = { trigger: { type: 'manual' }, steps: [create(undefined, { payload: { ...defaults, Line: [sale('0.25', { Qty: 2, UnitPrice: '0.20' })] }, amount_usd: undefined })] };
    await h.db.prepare('UPDATE crank_workflows SET draft_json=? WHERE id=?').bind(JSON.stringify(legacyConflict), refund.id).run();
    const conflictPublish = await h.send(`/api/crank/workflows/${refund.id}/publish`, {}, h.owner);
    assert.equal(conflictPublish.status, 422); assert.match(conflictPublish.value.error, /Line\[0\].Amount/);
    assert.equal(payloads.length, before);
    // Dynamic leaves defer without hiding a definite error beside them; literals remain literal.
    const mixed = structuredClone(payload); mixed.CustomerRef.value = { $ref: 'trigger.input.customer' }; mixed.Line[0].SalesItemLineDetail.Qty = 'many';
    const mixedSave = await h.send('/api/crank/workflows', { name: 'Mixed mappings', graph: { trigger: { type: 'manual' }, steps: [create(undefined, { payload: mixed })] } }, h.owner);
    assert.equal(mixedSave.status, 422); assert.match(mixedSave.value.error, /Line\[0\].SalesItemLineDetail.Qty/);
    const literal = await publish(h, 'Literal accounting fields', { trigger: { type: 'manual' }, steps: [create(undefined, { payload: { $literal: { ...defaults, PrivateNote: '{{not_a_mapping}}' } }, amount_usd: '0.30' })] });
    assert.equal((await startRun(h, literal, runInput)).status, 'succeeded'); assert.equal(payloads.at(-1).PrivateNote, '{{not_a_mapping}}');
    // A wait and a worker restart cannot bypass validation of resolved mapping values.
    const delayed = await publish(h, 'Delayed mapped invoice', { trigger: { type: 'manual' }, steps: [
      { id: 'wait', type: 'delay', mode: 'for', input: { amount: 1, unit: 'minutes' } }, create(),
      { id: 'later', type: 'map', input: { delivered: true } },
    ] });
    const good = await startRun(h, delayed, runInput), bad = await startRun(h, delayed, { ...runInput, payload: invalid[10][0] });
    assert.equal(good.status, 'waiting'); assert.equal(bad.status, 'waiting'); const prior = payloads.length;
    await h.restart(); await h.tick(Date.now() + 120000);
    const complete = await settled(h, good.id), failed = await settled(h, bad.id);
    assert.equal(complete.status, 'succeeded'); assert.equal(stepOf(complete, 'later').output.delivered, true);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.field, invalid[10][1]); assert.equal(stepOf(failed, 'later'), undefined);
    assert.equal(payloads.length, prior + 1); assert.deepEqual(payloads.at(-1).Line, payload.Line);
    if (inspect) await inspect({ h, workflow: delayed, run: failed, state: 'nested-validation' });
    const delayedConflict = await startRun(h, delayed, { ...runInput, payload: { ...defaults, Line: [sale('0.25', { Qty: 2, UnitPrice: '0.20' })] }, total: undefined });
    const delayedCents = await startRun(h, delayed, { ...runInput, payload: { ...defaults, Line: [sale('0.001')] }, total: undefined });
    assert.equal(delayedConflict.status, 'waiting'); assert.equal(delayedCents.status, 'waiting');
    await h.restart(); await h.tick(Date.now() + 120000);
    const conflictAfterRestart = await settled(h, delayedConflict.id), centsAfterRestart = await settled(h, delayedCents.id);
    for (const refused of [conflictAfterRestart, centsAfterRestart]) {
      assert.equal(refused.status, 'failed'); assert.equal(refused.error.field, 'input.payload.Line[0].Amount');
      assert.equal(stepOf(refused, 'later'), undefined);
    }
    assert.equal(payloads.length, prior + 1, 'restart cannot dispatch conflicting or fractional-cent lines');
    if (inspect) await inspect({ h, workflow: delayed, run: centsAfterRestart, state: 'cent-validation' });
    assert.deepEqual((await h.get(`workflow-runs/${failed.id}/replay`)).eligible.map(step => step.path), ['invoice'], 'a validation refusal is distinct from an uncertain write');
  } finally { await h.close(); }
}

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
  let mode = 'zero', creates = 0, voids = 0, loseCompensation = false;
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
      if (loseCompensation) {
        const response = new Promise(resolve => setTimeout(() => resolve(jsonResponse({ Invoice: { ...invoice, TotalAmt: 0 } })), 500));
        pending.add(response); response.finally(() => pending.delete(response)); return response;
      }
      return jsonResponse({ Invoice: { ...invoice, TotalAmt: 0 } });
    }
    if (method === 'POST') {
      creates++; assert.ok(url.searchParams.get('requestid'));
      const promise = new Promise(resolve => setTimeout(() => resolve(jsonResponse({ Invoice: invoice })), 500));
      pending.add(promise); promise.finally(() => pending.delete(promise)); return promise;
    }
    if (loseCompensation) throw new Error('synthetic-crank-network-unavailable');
    return jsonResponse({ Invoice: { ...invoice, TotalAmt: 0 } });
  });
  fake.routes.set('downstream.example', () => jsonResponse({ refused: true }, 400));
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    fake.routes.set('oauth.platform.intuit.com', ({ headers, body }) => {
      assert.equal(headers.authorization, 'Basic ' + Buffer.from('synthetic-crank-5:synthetic-crank-6').toString('base64'));
      assert.equal(new URLSearchParams(body).has('client_secret'), false);
      return jsonResponse({ access_token: 'synthetic-crank-4', refresh_token: 'synthetic-crank-7', expires_in: 3600 });
    });
    await h.post('oauth/apps/quickbooks', { client_id: 'synthetic-crank-5', client_secret: 'synthetic-crank-6' });
    const oauth = await h.post('oauth/start', { app: 'quickbooks', label: 'Harbour QuickBooks sandbox', scopes: ['com.intuit.quickbooks.accounting'] }, h.owner, 201);
    const state = new URL(oauth.authorize_url).searchParams.get('state');
    const callback = 'oauth/callback?' + new URLSearchParams({ state, code: 'synthetic-crank-8', realmId: '1234' });
    const c = await h.get(callback, h.owner, 201);
    assert.equal(c.account_name, '1234');
    await h.get(callback, h.owner, 400);
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
    const compensation = await publish(h, 'Harbour separately authorized invoice void', { trigger: { type: 'manual' }, steps: [{ id: 'void_invoice', type: 'quickbooks.void_invoice', connection_id: c.id, timeout_ms: 200, input: { source_run_id: run.id, source_path: 'invoice' } }] });
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
    loseCompensation = true;
    let unknownCompensation = await startRun(h, compensation, {});
    unknownCompensation = await decide(unknownCompensation, 'approve');
    assert.equal(unknownCompensation.status, 'uncertain', 'unavailable compensation readback cannot license another void');
    await h.restart();
    assert.deepEqual((await h.get(`workflow-runs/${unknownCompensation.id}/replay`)).eligible, []);
    assert.equal(voids, 1, 'every compensation run retains the original effect’s stable compensation identity');
    loseCompensation = false;
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
