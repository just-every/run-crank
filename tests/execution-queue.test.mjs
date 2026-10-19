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
