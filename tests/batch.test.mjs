import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { deliver, fakeEdge, jsonResponse, publish, startRun, stepOf, until } from './kit.mjs';

let h;
const fake = fakeEdge();
before(async () => { h = await harness('http://127.0.0.1:9', { edge: fake.edge }) });
after(async () => { await h?.close() });

const joinStep = policy => ({ id: 'merge', type: 'join', policy, left_key: 'order.id', right_key: 'order_id', duplicate_keys: 'error', order: 'left_then_right', empty: 'allow', input: { left: '{{trigger.input.left}}', right: '{{trigger.input.right}}' } });
const graph = step => ({ trigger: { type: 'manual' }, steps: [step, { id: 'consume', type: 'map', input: { joined: '{{steps.merge.rows}}', exceptions: '{{steps.merge.unmatched_left}}' } }] });
const row = (key, left, right) => ({ key, left, right });
const loopStep = (id, steps, extra = {}) => ({ id, type: 'loop', input: { items: '{{trigger.input.items}}' }, max_items: 10, concurrency: 2, order: 'input', empty: 'allow', item_errors: 'stop', steps, result: '{{item}}', ...extra });

test('WORK-003: published keyed joins retain source order, unmatched records, typed keys and declared empty behavior', async () => {
  const left = [{ order: { id: 'b' }, total: 20 }, { order: { id: 'a' }, total: 10 }, { order: { id: 1 }, total: 30 }];
  const right = [{ order_id: 'a', invoice: 'inv-a' }, { order_id: '1', invoice: 'inv-string' }, { order_id: 'b', invoice: 'inv-b' }, { order_id: 'z', invoice: 'inv-z' }];
  const matched = [row('b', left[0], right[2]), row('a', left[1], right[0])];
  for (const policy of ['inner', 'left', 'full']) {
    const workflow = await publish(h, `Order join ${policy}`, graph(joinStep(policy)));
    const started = await startRun(h, workflow, { left, right });
    const detail = await h.get('workflow-runs/' + started.id);
    assert.equal(detail.status, 'succeeded', JSON.stringify(detail.error));
    const expected = [...matched, ...(policy === 'inner' ? [] : [row(1, left[2], null)]), ...(policy === 'full' ? [row('1', null, right[1]), row('z', null, right[3])] : [])];
    assert.deepEqual(stepOf(detail, 'merge').output, { rows: expected, unmatched_left: [left[2]], unmatched_right: [right[1], right[3]] });
    assert.deepEqual(stepOf(detail, 'consume').output, { joined: expected, exceptions: [left[2]] }, 'later steps can map joined rows and exceptions');
    for (const [a, b] of [[[], []], [left, []], [[], right]]) {
      const empty = await startRun(h, workflow, { left: a, right: b });
      assert.equal(empty.status, 'succeeded');
      assert.deepEqual(stepOf(empty, 'merge').output, {
        rows: a.length && policy !== 'inner' ? a.map(v => row(v.order.id, v, null)) : b.length && policy === 'full' ? b.map(v => row(v.order_id, null, v)) : [],
        unmatched_left: a, unmatched_right: b,
      });
    }
  }
});

test('WORK-003: ambiguous or invalid joins fail before downstream steps, and publish requires explicit policies', async () => {
  const step = joinStep('full'), workflow = await publish(h, 'Join exceptions', graph(step));
  const validLeft = [{ order: { id: 'a' } }], validRight = [{ order_id: 'a' }];
  const cases = [
    { left: [validLeft[0], validLeft[0]], right: validRight, outcome: 'duplicate join key', side: 'left' },
    { left: validLeft, right: [validRight[0], validRight[0]], outcome: 'duplicate join key', side: 'right' },
    ...[{}, { order: { id: null } }, { order: { id: '  ' } }, { order: { id: {} } }].map(value => ({ left: [value], right: validRight, outcome: 'invalid join key', side: 'left' })),
    { left: validLeft, right: [{}], outcome: 'invalid join key', side: 'right' },
    { left: {}, right: validRight, outcome: 'invalid join input' },
  ];
  for (const item of cases) {
    const started = await startRun(h, workflow, item), detail = await h.get('workflow-runs/' + started.id);
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.outcome, item.outcome);
    if (item.side) assert.equal(detail.error.side, item.side);
    assert.equal(stepOf(detail, 'merge').status, 'failed');
    assert.ok(!stepOf(detail, 'consume'), 'no downstream work follows an invalid join');
  }
  const strict = await publish(h, 'Empty join exception', graph({ ...step, empty: 'error' }));
  for (const input of [{ left: [], right: validRight }, { left: validLeft, right: [] }]) {
    const failed = await startRun(h, strict, input);
    assert.equal(failed.error.outcome, 'empty join input');
    assert.ok(!stepOf(failed, 'consume'));
  }
  for (const field of ['policy', 'left_key', 'right_key', 'duplicate_keys', 'order', 'empty']) {
    const incomplete = { ...step }; delete incomplete[field];
    await h.post('workflows', { name: 'Incomplete join', graph: graph(incomplete) }, h.owner, 422);
  }
  await h.post('workflows', { name: 'Many-to-many join refused', graph: graph({ ...step, duplicate_keys: 'all' }) }, h.owner, 422);
});

test('WORK-003: a paginated order batch branches, checkpoints invoices through restarts and joins unmatched orders by ID', async () => {
  const orders = [{ id: 'o-1', total: 25 }, { id: 'o-2', total: 50 }, { id: 'o-3', total: 75 }], invoices = new Map(), writes = [];
  fake.routes.set('orders.batch.example', ({ url }) => jsonResponse(url.searchParams.get('cursor') === 'second' ? { orders: orders.slice(2), next: null } : { orders: orders.slice(0, 2), next: 'second' }));
  fake.routes.set('invoices.batch.example', ({ headers, body }) => {
    const order = JSON.parse(body), key = headers['idempotency-key'];
    writes.push({ key, order: order.id });
    if (!invoices.has(key)) invoices.set(key, { id: 'inv-' + order.id, order_id: order.id });
    return jsonResponse(invoices.get(key), 201);
  });
  const source = { id: 'source', type: 'http', input: { url: 'https://orders.batch.example/orders' }, pagination: { kind: 'cursor', items_path: 'orders', cursor_path: 'next', max_pages: 3, max_items: 10 } };
  const invoiceLoop = loopStep('invoices', [
    { id: 'write_invoice', type: 'http', idempotency_header: 'Idempotency-Key', input: { method: 'POST', url: 'https://invoices.batch.example/invoices', body: '{{item}}' } },
    { id: 'review_invoice', type: 'approval', input: { order_id: '{{item.id}}', invoice_id: '{{steps.write_invoice.body.id}}' } },
  ], { concurrency: 1, input: { items: '{{steps.source.items}}' }, result: { order_id: '{{item.id}}', invoice_id: '{{steps.write_invoice.body.id}}' } });
  const packLoop = loopStep('packing', [
    { id: 'ready_to_pack', type: 'filter', when: [[{ field: 'item.id', op: 'text.not_equals', value: 'o-3' }]] },
    { id: 'pack_order', type: 'map', input: { order_id: '{{item.id}}', packed: true } },
  ], { input: { items: '{{steps.source.items}}' }, result: '{{steps.pack_order}}' });
  const workflow = await publish(h, 'Orders to invoices and packing', { trigger: { type: 'manual' }, steps: [source,
    { id: 'streams', type: 'paths', mode: 'parallel', branches: [
      { id: 'billing', when: [[{ field: 'steps.source.items', op: 'exists' }]], steps: [invoiceLoop] },
      { id: 'fulfilment', when: [[{ field: 'steps.source.items', op: 'exists' }]], steps: [packLoop] },
    ] },
    { ...joinStep('full'), left_key: 'order_id', right_key: 'order_id', input: { left: '{{steps.invoices.results}}', right: '{{steps.packing.results}}' } },
  ] });
  let current = await startRun(h, workflow, {});
  assert.equal(current.status, 'awaiting_approval');
  assert.equal(writes.length, 1, 'only the first order has an invoice before interruption');
  const firstKey = current.steps.find(s => s.path === 'streams/billing/invoices/items/0/write_invoice').operation_key;
  for (let i = 0; i < orders.length; i++) {
    await h.restart();
    current = await h.get('workflow-runs/' + current.id);
    const waiting = current.waits.find(w => !w.resolved_at && w.kind === 'approval');
    assert.equal(waiting.path, `streams/billing/invoices/items/${i}/review_invoice`);
    current = await h.post(`workflow-runs/${current.id}/approve`, { path: waiting.path, digest: waiting.proposal_digest });
  }
  assert.equal(current.status, 'succeeded', JSON.stringify(current.error));
  assert.equal(writes.length, orders.length, 'each completed invoice effect is sent once across restarts');
  assert.equal(invoices.size, orders.length);
  assert.equal(new Set(writes.map(w => w.key)).size, orders.length, 'each item has its own operation key');
  assert.equal(current.steps.find(s => s.path === 'streams/billing/invoices/items/0/write_invoice').operation_key, firstKey);
  assert.equal(fake.to('orders.batch.example').length, 2, 'source pages are retained rather than fetched again on resume');
  const billing = current.steps.find(s => s.path === 'streams/billing/invoices').output;
  assert.deepEqual(billing.items.map(item => item.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(billing.results.map(item => item.order_id), orders.map(order => order.id));
  const packing = current.steps.find(s => s.path === 'streams/fulfilment/packing').output;
  assert.deepEqual(packing.items.map(item => item.status), ['succeeded', 'succeeded', 'stopped']);
  const joined = stepOf(current, 'merge').output;
  assert.deepEqual(joined.rows.map(item => item.key), orders.map(order => order.id));
  assert.deepEqual(joined.unmatched_left, [billing.results[2]]);
  assert.deepEqual(joined.unmatched_right, []);
});

test('WORK-003: bounded concurrent iterations isolate mappings, retain input ordering and expose each failure', async () => {
  let active = 0, peak = 0, pending = [];
  fake.routes.set('concurrent.batch.example', ({ body }) => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    pending.push({ resolve, value: JSON.parse(body) });
    if (pending.length === 2) {
      const pair = pending.splice(0).reverse();
      for (const item of pair) { active--; item.resolve(jsonResponse(item.value)) }
    }
  }));
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const batch = loopStep('batch', [
    { id: 'local', type: 'map', input: { id: '{{item.id}}', ordinal: '{{item_index}}' } },
    { id: 'send', type: 'http', input: { method: 'POST', url: 'https://concurrent.batch.example/items', body: '{{steps.local}}' } },
  ], { result: '{{steps.send.body}}' });
  const workflow = await publish(h, 'Concurrent items', { trigger: { type: 'manual' }, steps: [batch] });
  const completed = await startRun(h, workflow, { items });
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  assert.equal(peak, batch.concurrency, 'two requests overlap and no more than the declared workers run');
  assert.deepEqual(stepOf(completed, 'batch').output.results, items.map((item, ordinal) => ({ ...item, ordinal })), 'responses can finish in reverse order without leaking item scope');

  const attempted = [];
  fake.routes.set('errors.batch.example', ({ url }) => { const id = url.searchParams.get('id'); attempted.push(id); return jsonResponse({ id }, id === 'bad' ? 400 : 200) });
  const read = { id: 'read', type: 'http', input: { url: 'https://errors.batch.example/items', query: { id: '{{item.id}}' } } };
  const source = [{ id: 'ok' }, { id: 'bad' }, { id: 'later' }];
  for (const policy of ['continue', 'stop']) {
    attempted.length = 0;
    const flow = await publish(h, `Item errors ${policy}`, { trigger: { type: 'manual' }, steps: [loopStep('batch', [read], { concurrency: 1, item_errors: policy, result: '{{steps.read.body}}' })] });
    const run = await startRun(h, flow, { items: source }), output = stepOf(run, 'batch').output;
    assert.equal(run.status, policy === 'continue' ? 'succeeded' : 'failed');
    assert.deepEqual(output.items.map(item => item.status), policy === 'continue' ? ['succeeded', 'failed', 'succeeded'] : ['succeeded', 'failed']);
    assert.equal(output.items[1].error.category, 'provider');
    assert.deepEqual(attempted, policy === 'continue' ? ['ok', 'bad', 'later'] : ['ok', 'bad']);
    assert.equal(run.steps.find(s => s.path === 'batch/items/1/read').status, 'failed');
  }
  const empty = await startRun(h, workflow, { items: [] });
  assert.deepEqual(stepOf(empty, 'batch').output, { items: [], results: [], total: 0 });
  const strict = await publish(h, 'Declared loop limits', { trigger: { type: 'manual' }, steps: [loopStep('batch', [{ id: 'keep', type: 'map', input: {} }], { empty: 'error', max_items: 2 })] });
  for (const [input, outcome] of [[[], 'empty loop input'], [items, 'loop input limit'], [{}, 'invalid loop input']]) {
    const run = await startRun(h, strict, { items: input });
    assert.equal(run.status, 'failed'); assert.equal(run.error.outcome, outcome);
    assert.ok(!run.steps.some(s => s.path.startsWith('batch/items/')), 'invalid inputs begin no iteration');
  }
  for (const field of ['max_items', 'concurrency', 'order', 'empty', 'item_errors', 'result']) {
    const incomplete = { ...batch }; delete incomplete[field];
    await h.post('workflows', { name: 'Undeclared iteration policy', graph: { trigger: { type: 'manual' }, steps: [incomplete] } }, h.owner, 422);
  }
  const effects = [];
  fake.routes.set('uncertain.batch.example', ({ body }) => {
    const value = JSON.parse(body); effects.push(value.id);
    return value.id === 'lost' ? new Promise(resolve => setTimeout(() => resolve(jsonResponse(value)), 800)) : jsonResponse(value);
  });
  const interrupted = await publish(h, 'Lost item write response', { trigger: { type: 'manual' }, steps: [loopStep('batch', [
    { id: 'write', type: 'http', timeout_ms: 200, input: { method: 'POST', url: 'https://uncertain.batch.example/items', body: '{{item}}' } },
  ], { concurrency: 1, result: '{{steps.write.body}}' })] });
  const uncertain = await startRun(h, interrupted, { items: [{ id: 'committed' }, { id: 'lost' }] });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.steps.find(s => s.path === 'batch/items/1/write').status, 'uncertain');
  assert.deepEqual(stepOf(uncertain, 'batch').output.items.map(item => item.status), ['succeeded', 'failed']);
  await h.restart(); await h.tick();
  await h.post(`workflow-runs/${uncertain.id}/resume`, {}, h.owner, 409);
  assert.deepEqual(effects, ['committed', 'lost'], 'a completed effect and a lost-response effect are never blindly repeated');
});

test('WORK-003: nested callback waits resume the correct item and preserve wakeups received during concurrent execution', async () => {
  const asks = [];
  fake.routes.set('callbacks.batch.example', async ({ body }) => {
    const input = JSON.parse(body);
    if (input.kind === 'ask') { asks.push(input); return jsonResponse({ asked: true }) }
    const wait = await until(async () => {
      const run = await h.get('workflow-runs/' + input.run_id);
      return run.waits.find(w => w.kind === 'callback' && !w.resolved_at);
    }, 'concurrent callback wait');
    assert.equal(wait.path, 'outer/items/0/inner/items/0/route/supplier/reply');
    const callback = await deliver(h, asks.at(-1).reply_to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'received' }) });
    assert.equal(callback.value.accepted, true);
    return jsonResponse({ released: true });
  });
  const route = { id: 'route', type: 'paths', mode: 'exclusive', branches: [
    { id: 'supplier', when: [[{ field: 'item.kind', op: 'text.equals', value: 'ask' }]], steps: [
      { id: 'ask', type: 'http', input: { method: 'POST', url: 'https://callbacks.batch.example/ask', body: { kind: 'ask', reply_to: '{{run.resume_urls.reply}}' } } },
      { id: 'reply', type: 'wait_for_callback', timeout: { amount: 1, unit: 'days' } },
    ] },
    { id: 'releaser', when: [[{ field: 'item.kind', op: 'text.equals', value: 'release' }]], steps: [
      { id: 'release', type: 'http', input: { method: 'POST', url: 'https://callbacks.batch.example/release', body: { kind: 'release', run_id: '{{run.id}}' } } },
    ] },
  ] };
  const inner = loopStep('inner', [route], { input: { items: '{{item.children}}' }, result: { kind: '{{item.kind}}', answer: '{{steps.reply.body.answer}}' } });
  const outer = loopStep('outer', [inner], { concurrency: 1, result: '{{steps.inner.results}}' });
  const flow = await publish(h, 'Nested callbacks', { trigger: { type: 'manual' }, steps: [outer] });
  const started = await startRun(h, flow, { items: [{ children: [{ kind: 'ask' }, { kind: 'release' }] }] });
  assert.equal(started.status, 'queued', 'a wait resolved during execution queues one continuation');
  await h.restart(); await h.tick();
  const finished = await h.get('workflow-runs/' + started.id);
  assert.equal(finished.status, 'succeeded', JSON.stringify(finished.error));
  assert.deepEqual(stepOf(finished, 'outer').output.results, [[{ kind: 'ask', answer: 'received' }, { kind: 'release' }]]);
  assert.equal(asks.length, 1, 'nested completed sends are not repeated');
  assert.equal(fake.to('callbacks.batch.example').length, 2);
  const duplicate = await deliver(h, asks[0].reply_to, { method: 'POST', body: 'duplicate' });
  assert.equal(duplicate.value.accepted, false);
  await h.tick();
  assert.equal((await h.get('workflow-runs/' + started.id)).status, 'succeeded', 'completed resolved waits do not spin');
});
