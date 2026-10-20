import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf, until } from './kit.mjs';
import { retryArchive } from './retry-archive.mjs';

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
    const request = (id, connection_id, record) => ({ id, type: 'http', retry_policy: { base_delay_ms: 500 }, connection_id, input: { url: 'https://bounded-provider.example/inventory', query: { record } } });
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

test('EXEC-002: parked pagination and lost-write readback resume their exact request phase without changing earlier records or repeating an effect', async () => {
  const fake = fakeEdge(), counts = new Map();
  const providerCookie = fakeSecret('provider-session'), queryKey = fakeSecret('provider-query');
  let effects = 0, uploadEffects = 0;
  const uploads = [], retainedPadding = 'p'.repeat(2 * 1024 * 1024 - 1024);
  fake.routes.set('continuation-provider.example', ({ url, method, body, headers }) => {
    const visible = new URL(url); visible.searchParams.delete('api_key');
    const key = method + visible.pathname + visible.search, count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (url.pathname === '/upload') {
      uploads.push({ body, key: headers['idempotency-key'], type: headers['content-type'] });
      if (count === 1) { uploadEffects++; return new Promise(resolve => setTimeout(() => resolve(jsonResponse({ id: 'saved-upload' })), 1000)); }
      return jsonResponse({ id: 'saved-upload' });
    }
    if (method === 'POST') {
      effects++;
      return new Promise(resolve => setTimeout(() => resolve(jsonResponse({ id: 'committed-invoice-1042' })), 1000));
    }
    if (url.pathname === '/invoices' && !url.searchParams.has('cursor')) return jsonResponse({ items: [{ id: count === 1 ? 'INV-1042' : 'changed-page', contact: 'retained-only@fieldstone.example' }], padding: retainedPadding, next: count === 1 ? 'second' : null }, 200, { 'set-cookie': providerCookie });
    if (count === 1) return jsonResponse({ error: 'read quota' }, 429, { 'retry-after': '31' });
    if (url.pathname === '/quote.pdf') return new Response('%PDF-1.4 Fieldstone quote', { headers: { 'content-type': 'application/pdf' } });
    return url.pathname === '/invoices' ? jsonResponse({ items: [{ id: 'INV-1043' }], next: null }) : jsonResponse({ id: 'committed-invoice-1042' });
  });
  fake.routes.set('slack.com', ({ url, body }) => {
    const cursor = new URLSearchParams(body).get('cursor'), key = 'slack:' + url.pathname + ':' + cursor, count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (!cursor) return jsonResponse({ ok: true, members: [{ id: 'UFIRST', name: count === 1 ? 'Priya Shah' : 'changed-name' }], response_metadata: { next_cursor: count === 1 ? 'second' : '' } });
    return count === 1 ? jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '31' }) : jsonResponse({ ok: true, members: [{ id: 'USECOND', name: 'Priya Shah' }], response_metadata: { next_cursor: '' } });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  let restored;
  try {
    const vendor = await connection(h, { app: 'http', label: 'Fieldstone invoice query credential', auth_kind: 'api_key', domains: ['continuation-provider.example'], secret: { key: queryKey, query: 'api_key' } });
    const paginated = await publish(h, 'Retained invoice pages', { trigger: { type: 'manual' }, steps: [
      { id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, connection_id: vendor.id, input: { url: 'https://continuation-provider.example/invoices' }, pagination: { kind: 'cursor', items_path: 'items', cursor_path: 'next', max_pages: 2 } },
    ] });
    const write = await publish(h, 'Invoice creation with retained readback', { trigger: { type: 'manual' }, steps: [
      { id: 'create', type: 'http', retry_policy: { base_delay_ms: 500 }, timeout_ms: 400, input: { method: 'POST', url: 'https://continuation-provider.example/create', body: { customer: 'Fieldstone Dental', amount_usd: '95.00' } }, readback: { url: 'https://continuation-provider.example/readback', path: 'id', equals: 'committed-invoice-1042' } },
    ] });
    const slack = await connection(h, { app: 'slack', label: 'Fieldstone test workspace', auth_kind: 'bearer', scopes: ['users:read'], secret: { token: fakeSecret('retained-slack') } });
    const lookup = await publish(h, 'Retained Slack user pages', { trigger: { type: 'manual' }, steps: [
      { id: 'find', type: 'slack.find_user_by_name', retry_policy: { base_delay_ms: 500 }, connection_id: slack.id, multi_match: 'all', input: { name: 'Priya Shah' } },
    ] });
    const files = await publish(h, 'Retained quotation download', { trigger: { type: 'manual' }, steps: [{ id: 'download', type: 'file.fetch', retry_policy: { base_delay_ms: 500 }, input: { url: 'https://continuation-provider.example/quote.pdf' } }] });
    const upload = await publish(h, 'Retained idempotent multipart delivery', { trigger: { type: 'manual' }, steps: [{ id: 'upload', type: 'http', timeout_ms: 400, retry_policy: { base_delay_ms: 31000 }, body_kind: 'multipart', idempotency_header: 'idempotency-key', input: { method: 'POST', url: 'https://continuation-provider.example/upload', body: { customer: 'Harbor Workshop', note: 'Line one\nLine two' } } }] });
    const parked = await Promise.all([startRun(h, paginated, {}), startRun(h, write, {}), startRun(h, lookup, {}), startRun(h, files, {}), startRun(h, upload, {})]);
    assert.ok(parked.every(r => r.status === 'waiting'), JSON.stringify(parked.map(r => ({ status: r.status, error: r.error, steps: r.steps }))));
    assert.equal(effects, 1);
    const subject = await h.post('data/subject', { subject: 'retained-only@fieldstone.example' });
    assert.equal(subject.workflow_runs.length, 1, 'DATA-002 finds a subject present only in a retained page');
    assert.equal(subject.workflow_runs[0].id, parked[0].id);
    assert.ok(subject.workflow_runs[0].blocked, 'unfinished continuation data cannot silently evade erasure review');
    const archived = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(archived.status, 200);
    assert.ok(!archived.text.includes(providerCookie) && !archived.text.includes(queryKey), 'continuation custody excludes credential headers and credential-bearing response URLs');
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    for (const invalid of ['credential', 'oversized']) {
      const unsafe = await retryArchive(archived.text, item => {
        if (item.table === 'crank_request_checkpoints') {
          const response = JSON.parse(item.row.response_json);
          if (invalid === 'credential') response.headers.push(['authorization', 'unsafe-imported-credential']);
          else if (item.row.path === 'read') { response.body_bytes = 2 * 1024 * 1024 + 1; response.chunk_count = 33; }
          item.row.response_json = JSON.stringify(response);
        }
        if (invalid === 'oversized' && item.table === 'crank_request_checkpoint_chunks' && item.row.path === 'read') {
          if (item.row.chunk_index !== 0) return [];
          return Array.from({ length: 33 }, (_, chunk_index) => ({ ...item, row: { ...item.row, chunk_index, content_base64: Buffer.alloc(chunk_index === 32 ? 1 : 65536).toString('base64') } }));
        }
        return [item];
      });
      const refused = await restored.send('/api/crank/data/restore', { archive: unsafe, confirm: 'RESTORE' }, restored.owner);
      assert.equal(refused.status, 400, refused.text); assert.match(refused.text, /staged_validation/);
      assert.equal((await restored.get('workflows')).length, 0, 'invalid continuation custody refuses atomically');
    }
    await restored.post('data/restore', { archive: archived.text, confirm: 'RESTORE' });
    const beforeRestoreTick = [...counts.entries()];
    await restored.restart(); await restored.tick(Date.now() + 120000);
    assert.deepEqual([...counts.entries()], beforeRestoreTick, 'restored continuation records have no receiving authority');
    assert.ok((await Promise.all(parked.map(r => restored.get('workflow-runs/' + r.id)))).every(r => r.status === 'paused'));
    await h.restart();
    const due = Math.max(...parked.flatMap(r => r.attempts.filter(a => a.retry_at).map(a => Date.parse(a.retry_at))));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due - Date.now()) + 20));
    await h.tick();
    const [pages, readback, users, downloaded, uploaded] = await Promise.all(parked.map(r => h.get('workflow-runs/' + r.id)));
    assert.ok([pages, readback, users, downloaded, uploaded].every(r => r.status === 'succeeded'), JSON.stringify([pages.error, readback.error, users.error, downloaded.error, uploaded.error]));
    assert.equal(uploadEffects, 1); assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1], uploads[0], 'an idempotent upload retains the same bytes, MIME boundary and operation key after parking/restart');
    assert.equal(stepOf(downloaded, 'download').output.name, 'quote.pdf');
    assert.equal(counts.get('GET/quote.pdf'), 2, 'file downloads share the retained request policy');
    assert.deepEqual(stepOf(pages, 'read').output.items, [{ id: 'INV-1042', contact: 'retained-only@fieldstone.example' }, { id: 'INV-1043' }]);
    assert.equal(stepOf(pages, 'read').output.body.padding, retainedPadding, 'near-limit completed response bytes survive parking and restart');
    assert.equal(counts.get('GET/invoices'), 1, 'a changed earlier page is not refetched');
    assert.equal(stepOf(readback, 'create').output.reconciled, true);
    assert.equal(effects, 1, 'the lost write is read back, never blindly repeated after suspension');
    assert.deepEqual(stepOf(users, 'find').output.records.map(u => u.id), ['UFIRST', 'USECOND']);
    assert.equal(counts.get('slack:/api/users.list:null'), 1, 'native connector pages use the same continuation custody');
    const exportAfter = await h.send('/api/crank/data/export', {}, h.owner);
    const rows = exportAfter.text.trim().split('\n').map(JSON.parse).flatMap(line => line.items ?? []);
    assert.equal(rows.filter(item => item.kind === 'row' && ['crank_request_checkpoints', 'crank_request_checkpoint_chunks'].includes(item.table)).length, 0, 'terminal steps discard transient response checkpoints');
  } finally { await restored?.close(); await h.close(); }
});


test('BASE-003 EXEC-002: long retry waits release workflow slots, survive restart and resume once on the due Cron tick with retained inputs and live authority', async () => {
  const fake = fakeEdge(), calls = new Map();
  fake.routes.set('parked-provider.example', ({ url }) => {
    const record = url.searchParams.get('record'), seen = calls.get(record) ?? [];
    calls.set(record, [...seen, Date.now()]);
    return record === 'ready' || seen.length ? jsonResponse({ id: record }) : jsonResponse({ error: 'provider quota window' }, 429, { 'retry-after': '31' });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const workflow = await publish(h, 'Fieldstone Dental invoice status reconciliation', { trigger: { type: 'manual' }, settings: { max_concurrency: 1 }, steps: [
      { id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, input: { url: 'https://parked-provider.example/invoices', query: { record: '{{trigger.input.invoice}}' } } },
    ] });
    const parked = await startRun(h, workflow, { invoice: 'INV-2026-1042' });
    assert.equal(parked.status, 'waiting'); assert.equal(parked.attempts.length, 1);
    assert.ok(parked.attempts[0].retry_parked_at); assert.equal(parked.attempts[0].retry_resumed_at, null);
    const operationKey = stepOf(parked, 'read').operation_key;
    const ready = await startRun(h, workflow, { invoice: 'ready' });
    assert.equal(ready.status, 'succeeded', 'a parked run does not occupy the workflow concurrency slot');
    const cancelled = await startRun(h, workflow, { invoice: 'cancelled-invoice' });
    await h.post('workflow-runs/' + cancelled.id + '/cancel');
    const revokedConnection = await connection(h, { app: 'http', label: 'Revoked supplier credential', auth_kind: 'bearer', domains: ['parked-provider.example'], secret: { token: fakeSecret('parked-account') } });
    const pausedWorkflow = await publish(h, 'Authorization changes during connector backoff', { trigger: { type: 'manual' }, steps: [
      { id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, connection_id: revokedConnection.id, input: { url: 'https://parked-provider.example/invoices', query: { record: 'paused-invoice' } } },
    ] });
    const paused = await startRun(h, pausedWorkflow, {});
    await h.post('connections/' + revokedConnection.id + '/revoke');
    await h.restart();
    await h.tick();
    assert.equal((await h.get('workflow-runs/' + parked.id)).status, 'waiting');
    assert.equal(calls.get('INV-2026-1042').length, 1, 'Cron before due cannot redrive the request');
    const queue = (await h.get('reports/operations')).execution_queue;
    assert.equal(queue.runs.find(r => r.id === parked.id).state, 'waiting');
    await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    const waitingPage = await h.send('/app/workflow-runs/' + parked.id, undefined, h.owner);
    assert.equal(waitingPage.status, 200); assert.ok(waitingPage.text.includes('datetime="' + parked.attempts[0].retry_at + '"'));
    assert.ok(waitingPage.text.includes('execution slot released'));
    const due = Math.max(Date.parse(parked.attempts[0].retry_at), Date.parse(paused.attempts[0].retry_at));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due - Date.now()) + 20));
    const actualTick = Date.now();
    await Promise.all([h.tick(actualTick), h.tick(actualTick)]);
    const complete = await h.get('workflow-runs/' + parked.id);
    assert.equal(complete.status, 'succeeded', JSON.stringify(complete.error));
    assert.equal(stepOf(complete, 'read').input.query.record, 'INV-2026-1042');
    assert.equal(stepOf(complete, 'read').operation_key, operationKey);
    assert.equal(complete.version_id, parked.version_id);
    assert.deepEqual(complete.attempts.map(a => a.http_status), [429, 200]);
    assert.ok(complete.attempts.every(a => a.budget_started_at === parked.attempts[0].budget_started_at));
    const resumed = complete.attempts[0];
    assert.equal(resumed.retry_at, parked.attempts[0].retry_at);
    assert.equal(resumed.retry_released_at, new Date(actualTick).toISOString());
    assert.ok(Date.parse(resumed.retry_resumed_at) >= Date.parse(resumed.retry_at));
    assert.ok(calls.get('INV-2026-1042')[1] >= Date.parse(resumed.retry_at));
    assert.equal(calls.get('INV-2026-1042').length, 2, 'concurrent Cron ticks dispatch one retry');
    assert.equal(calls.get('cancelled-invoice').length, 1, 'cancellation fences parked retries');
    assert.equal(calls.get('paused-invoice').length, 1, 'the retry checks current publish authority');
    assert.equal((await h.get('workflow-runs/' + paused.id)).status, 'paused');
    const page = await h.send('/app/workflow-runs/' + parked.id, undefined, h.owner);
    assert.equal(page.status, 200); assert.ok(page.text.includes('execution resumed'));
    assert.ok(page.text.includes('datetime="' + resumed.retry_resumed_at + '"'));
  } finally { await h.close(); }
});

test('EXEC-002: active-slice, one-hour and cumulative 24-hour budgets exhaust durably through owner-reviewed restore without another provider call', async () => {
  const fake = fakeEdge(); let calls = 0;
  fake.routes.set('retry-budget.example', () => { calls++; return jsonResponse({ error: 'temporary provider quota' }, 429, { 'retry-after': '31' }); });
  const source = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const workflow = await publish(source, 'Long-running invoice lookup recovery', { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, input: { url: 'https://retry-budget.example/invoices' } }] });
    const parked = await startRun(source, workflow, {});
    const archived = await source.send('/api/crank/data/export', {}, source.owner);
    assert.equal(archived.status, 200);
    for (const kind of ['active-slice', 'one-hour', '24-hour']) {
      const time = Date.now(), historical = await retryArchive(archived.text, item => {
        if (kind === 'active-slice' && item.table === 'crank_wf_runs') {
          const fence = JSON.parse(item.row.error_json); fence.previous_status = 'running';
          item.row.error_json = JSON.stringify(fence);
        }
        if (kind === 'active-slice' && item.table === 'crank_wf_steps') { item.row.status = 'running'; item.row.trace_json = null; }
        if (item.table !== 'crank_wf_attempts') return [item];
        item.row.retry_at = new Date(time - 1000).toISOString();
        if (kind === 'active-slice') {
          item.row.retry_parked_at = null;
          item.row.budget_started_at = item.row.slice_started_at = new Date(time - 61000).toISOString();
          return [item];
        }
        item.row.retry_parked_at = new Date(time - (kind === 'one-hour' ? 3601000 : 2000)).toISOString();
        if (kind === 'one-hour') return [item];
        item.row.number = 26;
        return [...Array.from({ length: 25 }, (_, index) => ({ ...item, row: { ...item.row, id: crypto.randomUUID(), number: index + 1, request_key: 'historical-request-' + index, retry_parked_at: new Date(time - 7200000).toISOString(), retry_resumed_at: new Date(time - 3600000).toISOString() } })), item];
      });
      const restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
      try {
        await restored.post('data/restore', { archive: historical, confirm: 'RESTORE' });
        const review = (await restored.get('workflows/' + workflow.id)).restore;
        await restored.post('workflows/' + workflow.id + '/publish', { restore_snapshot: review.snapshot, restore_decisions: { [parked.id]: 'resume' } }, restored.owner, 201);
        const before = calls;
        await restored.tick(); await restored.restart(); await restored.tick();
        const failed = await restored.get('workflow-runs/' + parked.id);
        assert.equal(failed.status, 'failed', JSON.stringify(failed.error));
        assert.equal(failed.error.exhausted, true); assert.ok(failed.error.next_owner_action);
        assert.match(failed.error.message, kind === 'active-slice' ? /active execution-slice/ : kind === 'one-hour' ? /one hour/ : /24 hours/);
        assert.equal(calls, before, 'expired historical waits never buy a new send or reset their budgets');
        const queue = (await restored.get('reports/operations')).execution_queue;
        assert.equal(queue.runs.find(r => r.id === failed.id).state, 'dead_letter');
      } finally { await restored.close(); }
    }
  } finally { await source.close(); }
});

test('EXEC-002 / WORK-008: restored in-flight versions and rollback retain their reviewed retry parameters while new publication uses the outage defaults', async () => {
  const fake = fakeEdge(); let quota = true;
  fake.routes.set('versioned-retry.example', () => quota ? jsonResponse({ error: 'quota' }, 429, { 'retry-after': '90' }) : jsonResponse({ error: 'outage' }, 503));
  const source = await harness('http://127.0.0.1:9', { edge: fake.edge });
  let receiving;
  try {
    const workflow = await publish(source, 'Reviewed historical connector retry policy', { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'http', input: { url: 'https://versioned-retry.example/invoices' } }] });
    const retained = await startRun(source, workflow, {});
    const original = await source.send('/api/crank/data/export', {}, source.owner);
    const reviewedPolicy = { read_attempts: 3, base_delay_ms: 1, write_base_delay_ms: 500 };
    const archive = await retryArchive(original.text, item => {
      if (item.table === 'crank_workflow_versions') item.row.retry_policy_json = JSON.stringify(reviewedPolicy);
      if (item.table === 'crank_wf_attempts') {
        item.row.retry_at = new Date(Date.now() - 1000).toISOString();
        item.row.retry_parked_at = new Date(Date.now() - 2000).toISOString();
      }
      return [item];
    });
    receiving = await harness('http://127.0.0.1:9', { edge: fake.edge });
    await receiving.post('data/restore', { archive, confirm: 'RESTORE' });
    const review = (await receiving.get('workflows/' + workflow.id)).restore;
    await receiving.post('workflows/' + workflow.id + '/publish', { restore_snapshot: review.snapshot, restore_decisions: { [retained.id]: 'resume' } }, receiving.owner, 201);
    quota = false; await receiving.tick();
    const finished = await receiving.get('workflow-runs/' + retained.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.attempts.length, reviewedPolicy.read_attempts);
    assert.deepEqual(finished.version.retry_policy, reviewedPolicy);
    const fresh = await startRun(receiving, workflow, {});
    assert.equal(fresh.status, 'waiting', 'a newly published unconfigured read parks for the homepage outage schedule');
    assert.ok(Date.parse(fresh.attempts[0].retry_at) - Date.parse(fresh.attempts[0].finished_at) >= 60000);
    await receiving.post('workflow-runs/' + fresh.id + '/cancel');
    await receiving.post('workflows/' + workflow.id + '/rollback', { version: 1 }, receiving.owner, 201);
    const rolledBack = await startRun(receiving, workflow, {});
    assert.equal(rolledBack.status, 'failed');
    assert.equal(rolledBack.attempts.length, reviewedPolicy.read_attempts);
    assert.deepEqual(rolledBack.version.retry_policy, reviewedPolicy);
  } finally { await receiving?.close(); await source.close(); }
});
