import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, runs, stepOf } from './kit.mjs';

test('TRIG-002: preview real historical source pages, review cost and release 10 selected deals then the rest once each', async () => {
  const fake = fakeEdge(), token = fakeSecret('deals');
  let deals = Array.from({ length: 40 }, (_, i) => ({ id: 'deal-' + i, status: 'closed', customer: 'Harbor Workshop customer ' + i, closed_at: i === 0 ? '2026-07-01T00:00:00.000Z' : i === 39 ? '2026-09-30T23:59:59.999Z' : '2026-08-14T15:00:00Z', amount: '521.00' }));
  deals.push({ id: 'open', status: 'open', closed_at: '2026-08-14T15:00:00Z' }, { id: 'too_old', status: 'closed', closed_at: '2026-06-30T23:59:59.999Z' }, { id: 'too_new', status: 'closed', closed_at: '2026-10-01T00:00:00Z' });
  fake.routes.set('deals.example', ({ url, headers }) => {
    assert.equal(headers.authorization, 'Bearer ' + token);
    const offset = Number(url.searchParams.get('cursor') ?? 0), end = offset + 15;
    return jsonResponse({ results: deals.slice(offset, end), next: end < deals.length ? end : null });
  });
  fake.routes.set('ledger.example', ({ body }) => jsonResponse({ id: 'invoice-' + JSON.parse(body).deal }, 201));
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const source = await connection(h, { app: 'http', label: 'Harbor CRM export API', auth_kind: 'bearer', domains: ['deals.example'], secret: { token } });
    const workflow = await publish(h, 'Last quarter closed deals', { trigger: { type: 'manual' }, steps: [{ id: 'invoice', type: 'http', input: { method: 'POST', url: 'https://ledger.example/invoices', body: { deal: '{{trigger.id}}', customer: '{{trigger.customer}}', amount: '{{trigger.amount}}' } } }] });
    const cost = { components: [
      { kind: 'orchestration', usd_per_run: '0.000125', assumption: 'Owner estimate of infrastructure per execution' },
      { kind: 'connectors', usd_per_run: '0.025', assumption: 'Owner estimate for the invoice request' },
      { kind: 'models', usd_per_run: '0', assumption: 'This graph has no model step' },
      { kind: 'executors', usd_per_run: '0', assumption: 'This graph has no external executor' },
    ] };
    const input = { source: { url: 'https://deals.example/deals', connection_id: source.id, items_path: 'results', id_path: 'id', pagination: { kind: 'cursor', cursor_path: 'next' } }, filter: [[{ field: 'trigger.status', op: 'text.equals', value: 'closed' }]], date_range: { field: 'closed_at', from: '2026-07-01', to: '2026-09-30' }, cost };
    await h.post(`workflows/${workflow.id}/historical`, { ...input, cost: undefined }, h.owner, 422);
    assert.equal(fake.requests.length, 0, 'missing cost assumptions fail before a source read');
    const preview = await h.post(`workflows/${workflow.id}/historical`, input, h.owner, 201);
    assert.equal(preview.source_count, 43); assert.equal(preview.count, 40); assert.equal(preview.remaining, 40);
    assert.equal(preview.sample[0].record.customer, 'Harbor Workshop customer 0');
    assert.equal(preview.cost.total_usd, '1.01', 'sum exact per-run estimates, multiply by count, then round half-up to USD cents');
    assert.equal(preview.cost.source, 'owner estimate; not provider-verified');
    assert.equal(fake.to('ledger.example').length, 0); assert.equal((await runs(h, workflow)).length, 0, 'preview starts no workflow effects');
    await h.post(`historical/${preview.id}/run`, { all: true, fingerprint: 'not-the-preview' }, h.owner, 409);
    await h.post(`historical/${preview.id}/run`, { items: ['not-in-the-preview'], fingerprint: preview.fingerprint }, h.owner, 422);
    const selected = preview.items.slice(0, 10).map(item => item.id), release = { items: selected, fingerprint: preview.fingerprint };
    await h.db.exec(`CREATE TRIGGER interrupt_history BEFORE UPDATE OF run_id ON crank_historical_items WHEN OLD.batch_id='${preview.id}' BEGIN SELECT RAISE(ABORT,'test historical admission interruption'); END;`);
    try { await h.post(`historical/${preview.id}/run`, release, h.owner, 503); }
    finally { await h.db.exec('DROP TRIGGER interrupt_history'); }
    assert.equal((await h.get('historical/' + preview.id)).remaining, 40);
    assert.equal((await runs(h, workflow)).length, 0, 'an interrupted chunk rolls back both run and release marker');
    await Promise.all([h.post(`historical/${preview.id}/run`, release), h.post(`historical/${preview.id}/run`, release)]);
    assert.equal((await h.get('historical/' + preview.id)).remaining, 30);
    assert.equal(fake.to('ledger.example').length, 10);
    await h.restart();
    deals = deals.map(deal => ({ ...deal, customer: 'Changed after preview' }));
    const complete = await h.post(`historical/${preview.id}/run`, { all: true, fingerprint: preview.fingerprint });
    assert.equal(complete.remaining, 0); assert.ok(complete.items.every(item => item.status === 'succeeded'));
    const executed = await runs(h, workflow);
    assert.equal(executed.length, 40); assert.equal(new Set(executed.map(run => run.source_id)).size, 40);
    assert.equal(fake.to('ledger.example').length, 40);
    assert.ok(fake.to('ledger.example').every(request => JSON.parse(request.body).customer.startsWith('Harbor Workshop customer ')), 'released payloads come from the reviewed snapshot');
    const detail = await h.get('workflow-runs/' + executed[0].id);
    assert.equal(detail.trigger_kind, 'historical'); assert.equal(detail.version_id, preview.version_id);
    assert.ok(stepOf(detail, 'invoice').output.body.id.startsWith('invoice-deal-'));
    await h.post(`historical/${preview.id}/run`, { all: true, fingerprint: preview.fingerprint });
    assert.equal(fake.to('ledger.example').length, 40, 'releasing all twice does not repeat any source ID');
    assert.equal((await h.send('/api/crank/historical/' + preview.id, undefined, '')).status, 401);
    const agent = await h.post('tokens', { label: 'History reader', scope: 'agent' }, h.owner, 201);
    await h.get('historical/' + preview.id, '', 403, { authorization: 'Bearer ' + agent.token });
    const stale = await h.post(`workflows/${workflow.id}/historical`, input, h.owner, 201);
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    await h.post(`historical/${stale.id}/run`, { all: true, fingerprint: stale.fingerprint }, h.owner, 403);
    assert.equal((await h.get('historical/' + stale.id)).remaining, 40, 'a replaced version cannot use its old preview to start more work');
    const cutoff = { ...input, date_range: { field: 'closed_at', from: '2026-10-01', to: '2026-09-30' } };
    await h.post(`workflows/${workflow.id}/historical`, cutoff, h.owner, 422);
    fake.routes.set('deals.example', () => jsonResponse({ results: [{ id: 'same', value: 1 }, { id: 'same', value: 2 }] }));
    await h.post(`workflows/${workflow.id}/historical`, input, h.owner, 422);
    fake.routes.set('deals.example', () => jsonResponse({ results: [], next: 'forever' }));
    const limited = await h.post(`workflows/${workflow.id}/historical`, { ...input, source: { ...input.source, pagination: { ...input.source.pagination, max_pages: 1 } } }, h.owner, 422);
    assert.match(limited.error, /page limit/);
    assert.equal(fake.to('ledger.example').length, 40, 'failed or incomplete previews create no effects');
    fake.routes.set('deals.example', () => jsonResponse({ results: [deals[0]] }));
    fake.routes.set('ledger.example', () => jsonResponse({ error: 'invoice validation refused' }, 400));
    const failing = await h.post(`workflows/${workflow.id}/historical`, input, h.owner, 201);
    const failed = await h.post(`historical/${failing.id}/run`, { all: true, fingerprint: failing.fingerprint });
    assert.equal(failed.items[0].status, 'failed'); assert.equal(failed.items[0].error.category, 'provider');
    assert.equal((await h.get('workflow-runs/' + failed.items[0].run_id)).status, 'failed', 'per-item outcomes retain the actual failure');
  } finally { await h.close(); }
});
