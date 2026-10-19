import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf, until } from './kit.mjs';

test('EXEC-002: the catalog default bounds 300 queued HTTP steps, their retries and concurrent requests per connection while another account progresses', async () => {
  const fake = fakeEdge(), arrivals = new Map(), attempts = new Map();
  const active = new Map(), peaks = new Map();
  let throttled = 0, policy;
  fake.routes.set('bounded-provider.example', async ({ headers, url }) => {
    const account = headers.authorization, time = Date.now(), history = arrivals.get(account) ?? [];
    const window = history.filter(at => time - at < policy.window_ms);
    history.push(time); arrivals.set(account, history);
    if (window.length >= policy.requests) { throttled++; return jsonResponse({ error: 'provider rate exceeded' }, 429, { 'retry-after': String(policy.window_ms / 1000) }); }
    active.set(account, (active.get(account) ?? 0) + 1); peaks.set(account, Math.max(peaks.get(account) ?? 0, active.get(account))); 
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      const item = url.searchParams.get('record'), key = account + ':' + item, seen = attempts.get(key) ?? 0;
      attempts.set(key, seen + 1);
      if (item === '42' && seen < 2) return jsonResponse({ error: 'temporary outage' }, 503);
      return jsonResponse({ id: item });
    } finally { active.set(account, active.get(account) - 1); }
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    policy = (await h.get('catalog')).apps.find(a => a.app === 'webhooks').actions.find(a => a.id === 'request').request_limit;
    const [bulkToken, otherToken] = [fakeSecret('bulk-provider'), fakeSecret('other-provider')];
    const accounts = await Promise.all([bulkToken, otherToken].map((token, i) => connection(h, { app: 'http', label: i ? 'Other supplier account' : 'Bulk supplier account', auth_kind: 'bearer', domains: ['bounded-provider.example'], secret: { token } })));
    const request = (id, connection_id, record) => ({ id, type: 'http', connection_id, input: { url: 'https://bounded-provider.example/inventory', query: { record } } });
    const workflow = await publish(h, 'Bulk supplier inventory', { trigger: { type: 'manual' }, steps: [
      { id: 'items', type: 'loop', max_items: 500, concurrency: 8, order: 'input', empty: 'error', item_errors: 'stop', input: { items: '{{trigger.input.items}}' }, result: '{{steps.read.body.id}}', steps: [request('read', accounts[0].id, '{{item}}')] },
    ] });
    let complete = false;
    const pending = startRun(h, workflow, { items: Array.from({ length: 300 }, (_, i) => i) }).then(run => { complete = true; return run; });
    await until(() => (arrivals.get('Bearer ' + bulkToken)?.length ?? 0) >= policy.requests, 'first provider window', 20000);
    const other = await publish(h, 'Other supplier lookup', { trigger: { type: 'manual' }, steps: [request('read', accounts[1].id, 'other')] });
    assert.equal((await startRun(h, other, {})).status, 'succeeded');
    assert.equal(complete, false, 'one account progresses while the bulk connection awaits capacity');
    const run = await pending;
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    assert.deepEqual(stepOf(run, 'items').output.results, Array.from({ length: 300 }, (_, i) => String(i)));
    assert.equal(throttled, 0, 'the provider never has to return 429');
    // Physical provider arrivals, rather than reservations, prove the window.
    const actual = arrivals.get('Bearer ' + bulkToken);
    assert.equal(actual.length, 302, 'the two transient retries consume provider capacity too');
    for (let i = policy.requests; i < actual.length; i++) assert.ok(actual[i] - actual[i - policy.requests] >= policy.window_ms, 'no provider window exceeds the catalog limit');
    assert.ok(peaks.get('Bearer ' + bulkToken) <= policy.concurrency, 'bulk connection requests obey the catalog concurrency bound');
    const retries = run.attempts.filter(a => a.path === 'items/items/42/read');
    assert.deepEqual(retries.map(a => a.http_status), [503, 503, 200]);
    assert.ok(Date.parse(retries[1].retry_at) - Date.parse(retries[1].finished_at) > Date.parse(retries[0].retry_at) - Date.parse(retries[0].finished_at));
    assert.ok((await h.send('/api/crank/data/export', {}, h.owner)).text.includes('crank_wf_attempts'), 'durable attempts remain portable');
  } finally { await h.close(); }
});
