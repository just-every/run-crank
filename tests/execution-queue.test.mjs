import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { deliver, fakeEdge, hookUrl, jsonResponse, publish, runs, settled, startRun, until } from './kit.mjs';

// Only the receiver is faked. Admissions, versions, leases, checkpoints, durable
// storage and the Worker's Cron door all use the application's real handlers.
function receiver() {
  const fake = fakeEdge(), release = new Map();
  let blocking = true;
  fake.routes.set('queue-receiver.example', ({ body }) => {
    const input = JSON.parse(body);
    if (!input.block || !blocking) return jsonResponse({ id: 'effect:' + input.job }, 201);
    return new Promise(resolve => release.set(input.job, () => resolve(jsonResponse({ id: 'effect:' + input.job }, 201))));
  });
  return { fake, release, block() { blocking = true; }, unblock() {
    blocking = false;
    for (const done of release.values()) done();
    release.clear();
  } };
}

test('EXEC-001: simultaneous public runs respect default and explicit workflow concurrency, then Cron drains the durable backlog', async () => {
  const remote = receiver(), h = await harness('http://127.0.0.1:9', { edge: remote.fake.edge });
  const pending = [];
  try {
    for (const settings of [{}, { max_concurrency: 2 }]) {
      const cap = settings.max_concurrency ?? 1;
      const workflow = await publish(h, 'Limited receiver ' + cap, { trigger: { type: 'manual' }, settings, steps: [
        { id: 'send', type: 'http', input: { method: 'POST', url: 'https://queue-receiver.example/effects', body: '{{trigger.input}}' } },
      ] });
      const jobs = Array.from({ length: cap + 2 }, (_, index) => `cap-${cap}-${index}`);
      // Race more public admissions than slots; whichever requests acquire the
      // slots remain at the remote edge until the public history is inspected.
      const requests = jobs.map(job => startRun(h, workflow, { job, block: true }));
      pending.push(...requests);
      const admitted = await until(async () => {
        const current = await runs(h, workflow);
        return current.length === jobs.length && current.filter(run => run.status === 'running').length === cap
          && current.filter(run => run.status === 'queued').length === 2 ? current : null;
      }, 'bounded public execution claims');
      await until(() => remote.fake.requests.filter(request => jobs.includes(JSON.parse(request.body).job)).length === cap,
        'claimed effects reach the receiver');
      for (const run of admitted.filter(run => run.status === 'queued')) {
        assert.deepEqual((await h.get('workflow-runs/' + run.id)).steps, [], 'queued runs have not begun a step');
      }
      // Change only future receiver responses; releasing each actual in-flight
      // request lets every subsequent durable admission finish normally.
      remote.unblock();
      const responses = await Promise.all(requests);
      assert.equal(responses.filter(run => run.status === 'queued').length, 2);
      await h.tick();
      const completed = await runs(h, workflow);
      assert.ok(completed.every(run => run.status === 'succeeded'));
      const delivered = remote.fake.requests.filter(request => jobs.includes(JSON.parse(request.body).job));
      assert.deepEqual(delivered.map(request => JSON.parse(request.body).job).sort(), jobs.slice().sort(), 'each admitted effect completes once');
      remote.block();
    }
  } finally {
    remote.unblock();
    await Promise.allSettled(pending);
    await h.close();
  }
});

test('EXEC-001: webhook backlog keeps published priority across draft edits and restart, then Cron sends higher priority first', async () => {
  const remote = receiver(), h = await harness('http://127.0.0.1:9', { edge: remote.fake.edge });
  try {
    const graph = priority => ({ trigger: { type: 'webhook' }, settings: { priority }, steps: [
      { id: 'send', type: 'http', input: { method: 'POST', url: 'https://queue-receiver.example/effects', body: '{{trigger.body}}' } },
    ] });
    const low = await publish(h, 'Standard deliveries', graph(-5)), high = await publish(h, 'Urgent deliveries', graph(7));
    const lowUrl = await hookUrl(h, low), highUrl = await hookUrl(h, high);
    const admit = async (url, job, block = false) => {
      const response = await deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job, block }) });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.value.accepted, true);
      return response.value.run_id;
    };
    const blockers = [await admit(lowUrl, 'low-in-flight', true), await admit(highUrl, 'high-in-flight', true)];
    await until(() => remote.release.size === 2, 'both workflow slots reach the receiver');
    const older = await admit(lowUrl, 'older-lower-priority'), newer = await admit(highUrl, 'newer-higher-priority');
    await until(async () => (await h.get('workflow-runs/' + older)).status === 'queued' && (await h.get('workflow-runs/' + newer)).status === 'queued', 'two queued webhooks');
    await h.post(`workflows/${low.id}/draft`, { graph: graph(20) });
    await h.post(`workflows/${high.id}/draft`, { graph: graph(-20) });
    remote.unblock();
    for (const blocker of blockers) assert.equal((await settled(h, blocker)).status, 'succeeded');
    await h.restart();
    assert.equal((await h.get('workflow-runs/' + older)).status, 'queued');
    assert.equal((await h.get('workflow-runs/' + newer)).status, 'queued');
    await h.tick();
    assert.equal((await h.get('workflow-runs/' + older)).status, 'succeeded');
    assert.equal((await h.get('workflow-runs/' + newer)).status, 'succeeded');
    assert.deepEqual(remote.fake.requests.slice(2).map(request => JSON.parse(request.body).job), [
      'newer-higher-priority', 'older-lower-priority',
    ], 'persisted published priority governs dispatch rather than arrival order or mutable drafts');
  } finally {
    remote.unblock();
    await h.close();
  }
});

test('EXEC-001: a multi-step batch restarts before and after writes, exposes durable checkpoints and cancels without undoing completed effects', async () => {
  const fake = fakeEdge();
  fake.routes.set('batch-queue.example', ({ body }) => jsonResponse({ id: 'receipt:' + JSON.parse(body).order }, 201));
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const workflow = await publish(h, 'Warehouse invoice batch', { trigger: { type: 'manual' }, settings: { priority: 8 }, steps: [
      { id: 'orders', type: 'loop', max_items: 10, concurrency: 1, order: 'input', empty: 'error', item_errors: 'stop', input: { items: '{{trigger.input.orders}}' }, result: '{{steps.invoice.body.id}}', steps: [
        { id: 'before', type: 'delay', mode: 'for', input: { amount: 1, unit: 'minutes' } },
        { id: 'invoice', type: 'http', input: { method: 'POST', url: 'https://batch-queue.example/invoices', body: '{{item}}' } },
        { id: 'after', type: 'delay', mode: 'for', input: { amount: 1, unit: 'minutes' } },
      ] },
    ] });
    const input = { orders: [{ order: 'INV-101' }, { order: 'INV-102' }] };
    let run = await startRun(h, workflow, input);
    assert.equal(run.status, 'waiting'); assert.equal(fake.requests.length, 0, 'stop before the first write');
    const received = run.received_at;
    let clock = Date.now();
    for (let item = 0; item < 2; item++) {
      await h.restart();
      run = await h.get('workflow-runs/' + run.id);
      assert.equal(run.status, 'waiting');
      await h.tick(clock += 120000);
      run = await h.get('workflow-runs/' + run.id);
      const checkpoint = run.steps.find(s => s.path === `orders/items/${item}/invoice`);
      assert.equal(checkpoint.status, 'succeeded');
      assert.equal(checkpoint.output.body.id, 'receipt:' + input.orders[item].order);
      const operationKey = checkpoint.operation_key;
      assert.equal(fake.requests.length, item + 1);
      await h.restart();
      const queue = (await h.get('reports/operations?workflow=' + workflow.id + '&from=2000-01-01&to=2001-01-01')).execution_queue;
      assert.equal(queue.depth, 1, 'live pending work is not hidden by historical dates');
      const waiting = queue.states.find(s => s.state === 'waiting');
      assert.equal(waiting.depth, 1); assert.equal(waiting.oldest_received_at, received);
      assert.ok(waiting.oldest_age_ms >= 0);
      assert.equal(queue.runs[0].priority, 8); assert.ok(queue.runs[0].owner && queue.runs[0].owner_id);
      assert.equal(queue.runs[0].completed_steps, run.steps.filter(s => s.status === 'succeeded').length);
      assert.equal((await h.get('workflow-runs/' + run.id)).steps.find(s => s.path === checkpoint.path).operation_key, operationKey);
      await h.tick(clock += 120000);
    }
    run = await h.get('workflow-runs/' + run.id);
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(run.steps.find(s => s.path === 'orders').output.results, ['receipt:INV-101', 'receipt:INV-102']);
    assert.equal(fake.requests.length, 2, 'each completed effect survives executor restart exactly once');
    assert.equal((await h.get('reports/operations?workflow=' + workflow.id)).execution_queue.depth, 0);

    for (const afterWrite of [false, true]) {
      let cancelled = await startRun(h, workflow, { orders: [{ order: afterWrite ? 'INV-104' : 'INV-103' }] });
      if (afterWrite) await h.tick(Date.now() + 120000);
      await h.restart();
      cancelled = await h.post(`workflow-runs/${cancelled.id}/cancel`);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.steps.filter(s => s.step_id === 'invoice').length, afterWrite ? 1 : 0);
      assert.ok(cancelled.waits.every(w => w.resolved_at && w.resolution.cancelled || w.resolved_at && w.resolution.released));
      await h.restart(); await h.tick(Date.now() + 86400000);
      assert.equal((await h.get('workflow-runs/' + cancelled.id)).status, 'cancelled');
    }
    assert.deepEqual(fake.requests.map(r => JSON.parse(r.body).order), ['INV-101', 'INV-102', 'INV-104']);
  } finally { await h.close(); }
});

test('BASE-003 EXEC-001: lease loss retains uncertain writes as dead letters; cancellation fences running and queued work and identifies started effects', async () => {
  const remote = receiver(), h = await harness('http://127.0.0.1:9', { edge: remote.fake.edge });
  const pending = [];
  try {
    const workflow = await publish(h, 'Purchase-order dispatch', { trigger: { type: 'manual' }, steps: [
      { id: 'send', type: 'http', input: { method: 'POST', url: 'https://queue-receiver.example/effects', body: '{{trigger.input}}' } },
      { id: 'followup', type: 'http', input: { method: 'POST', url: 'https://queue-receiver.example/followups', body: { job: 'must-not-start' } } },
    ] });
    pending.push(startRun(h, workflow, { job: 'lost-lease', block: true }));
    await until(() => remote.release.has('lost-lease'), 'remote write is in flight');
    let current = (await runs(h, workflow))[0];
    await h.tick(Date.now() + 6 * 60000);
    let lost = await h.get('workflow-runs/' + current.id);
    assert.equal(lost.status, 'uncertain'); assert.equal(lost.steps[0].status, 'uncertain');
    assert.equal(lost.steps.length, 1, 'no next step after the lost lease');
    remote.unblock(); await Promise.all(pending);
    await h.restart(); await h.tick();
    lost = await h.get('workflow-runs/' + current.id);
    assert.equal(lost.status, 'uncertain'); assert.equal(remote.fake.requests.length, 1, 'no blind retry after lease recovery or restart');
    await h.post(`workflow-runs/${lost.id}/resume`, {}, h.owner, 409);
    let queue = (await h.get('reports/operations?workflow=' + workflow.id)).execution_queue;
    assert.equal(queue.states.find(s => s.state === 'dead_letter').depth, 1);
    assert.equal(queue.runs[0].uncertain_steps, 1); assert.equal(queue.runs[0].error_category, 'uncertain');

    remote.block();
    pending.push(startRun(h, workflow, { job: 'cancel-in-flight', block: true }));
    await until(() => remote.release.has('cancel-in-flight'), 'second write is in flight');
    const queued = await startRun(h, workflow, { job: 'cancel-before-start' });
    assert.equal(queued.status, 'queued');
    queue = (await h.get('reports/operations?workflow=' + workflow.id)).execution_queue;
    assert.equal(queue.states.find(s => s.state === 'queued').depth, 1);
    assert.equal(queue.states.find(s => s.state === 'running').depth, 1);
    assert.equal(queue.states.find(s => s.state === 'queued').oldest_received_at, queued.received_at);
    const running = queue.runs.find(r => r.state === 'running');
    assert.ok(running.lease_expires_at); assert.equal(running.max_concurrency, 1);
    assert.deepEqual((await h.post(`workflow-runs/${queued.id}/cancel`)).steps, []);
    const cancelled = await h.post(`workflow-runs/${running.id}/cancel`);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps[0].status, 'uncertain');
    assert.match(cancelled.steps[0].error.message, /already-started write/);
    remote.unblock(); await Promise.all(pending);
    await h.restart(); await h.tick(Date.now() + 86400000);
    assert.equal((await h.get('workflow-runs/' + running.id)).status, 'cancelled');
    assert.equal((await h.get('workflow-runs/' + queued.id)).status, 'cancelled');
    assert.deepEqual(remote.fake.requests.map(r => JSON.parse(r.body).job), ['lost-lease', 'cancel-in-flight']);
    await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    const page = await h.send('/app/operations?workflow=' + workflow.id, undefined, h.owner);
    assert.equal(page.status, 200); assert.ok(page.text.includes('/app/workflow-runs/' + lost.id));
    assert.ok(page.text.includes('1 uncertain writes'));
    const detail = await h.send('/app/workflow-runs/' + running.id, undefined, h.owner);
    assert.equal(detail.status, 200); assert.ok(detail.text.includes('already-started write may have completed'));
    remote.fake.routes.set('invalid-queue.example', () => jsonResponse({ error: 'invalid account reference' }, 400));
    const invalid = await publish(h, 'Invalid account reference', { trigger: { type: 'manual' }, steps: [
      { id: 'lookup', type: 'http', input: { url: 'https://invalid-queue.example/accounts' } },
    ] });
    const failed = await startRun(h, invalid, {});
    assert.equal(failed.status, 'failed'); assert.equal(failed.steps[0].status, 'failed');
    await h.restart(); await h.tick();
    queue = (await h.get('reports/operations')).execution_queue;
    assert.equal(queue.states.find(s => s.state === 'dead_letter').depth, 2);
    assert.equal(queue.runs.find(r => r.id === failed.id).state, 'dead_letter');
    assert.equal(remote.fake.to('invalid-queue.example').length, 1, 'terminal provider failures are not automatically redriven');
    await h.post('reports/settings', { assignments: [{ workflow_id: invalid.id, team: 'Accounts' }] });
    queue = (await h.get('reports/operations?team=Accounts')).execution_queue;
    assert.deepEqual(queue.runs.map(r => r.id), [failed.id], 'live queue honors the report team scope');
    const paused = await publish(h, 'Paused supplier intake', { trigger: { type: 'webhook' }, steps: [
      { id: 'send', type: 'http', input: { method: 'POST', url: 'https://queue-receiver.example/intake', body: '{{trigger.body}}' } },
    ] });
    const hook = await hookUrl(h, paused);
    await h.post(`workflows/${paused.id}/pause`);
    const count = remote.fake.requests.length;
    const intake = await deliver(h, hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'supplier-101', job: 'held-while-paused' }) });
    assert.equal(intake.value.held, true);
    await h.post(`workflows/${paused.id}/run`, { input: {} }, h.owner, 409);
    await h.restart(); await h.tick();
    assert.equal(remote.fake.requests.length, count, 'paused intake produces no effects across restart');
    assert.deepEqual(await runs(h, paused), []);
    const holds = await h.get(`workflows/${paused.id}/holds`);
    assert.equal((await h.get('holds/' + holds[0].id)).counts.held, 1);
  } finally { remote.unblock(); await Promise.allSettled(pending); await h.close(); }
});
