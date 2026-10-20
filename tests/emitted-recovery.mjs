import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { emittedProcess, until } from './emitted-recovery-process.mjs';
import { archiveRecovery } from './emitted-recovery-archive.mjs';

const cost = { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Isolated acceptance receiver does not bill this installation' })) };
const endpoint = path => 'https://emitted-recovery.example' + path;

async function receiverEdge() {
  const requests = [], held = new Set(), blockFirst = new Set(['/legacy', '/write', '/read', '/delayed']);
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const entry = { path: new URL(request.url, 'http://receiver.test').pathname, method: request.method, key: request.headers['idempotency-key'], body };
    requests.push(entry);
    // Receipt is recorded before withholding the acknowledgement: a killed
    // sender cannot infer whether this external effect was committed.
    if (blockFirst.delete(entry.path)) { held.add(response); response.once('close', () => held.delete(response)); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: entry.key ?? 'receipt:' + entry.path.slice(1), idempotencyKey: entry.key, accepted: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests,
    count: path => requests.filter(request => request.path === path).length,
    async close() { for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function unavailable(h, missing) {
  const started = Date.now(), result = await h.send('/health');
  assert.equal(result.status, 503); assert.equal(result.value.ok, false);
  assert.equal(result.value.status, 'unavailable');
  assert.ok(Date.now() - started < 5000, 'health failure has a bounded response');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  if (missing) {
    for (const name of missing) assert.ok(result.value.missing_bindings.includes(name));
    assert.ok(result.value.missing_bindings.every(name => ['DB', 'AUTH_ORIGIN', 'OWNER_EMAIL', 'SESSION_SECRET'].includes(name)), 'only safe binding names are disclosed');
  } else {
    assert.equal(result.value.dependencies.DB, 'unavailable');
    assert.equal(result.value.dependencies.executor_storage, 'unavailable');
  }
  assert.ok(!/sqlite|no such table|recovery-owner@example|synthetic-network-edge/i.test(result.text), 'health discloses no database errors or configuration values');
}

async function workflow(h, name, steps, settings = {}) {
  const value = await h.post('workflows', { name, graph: { trigger: { type: 'manual' }, settings, steps } }, 201);
  await h.post(`workflows/${value.id}/estimate`, { cost });
  await h.post(`workflows/${value.id}/publish`, {}, 201);
  return value;
}
const http = (id, method, path) => ({ id, type: 'http', input: { method, url: endpoint(path), ...(method === 'POST' ? { body: '{{trigger.input}}' } : {}) } });

/** BASE-003: emitted deployment, real HTTP/native sessions, durable D1 and
 * SIGKILL/restart. Only receiver acknowledgement and mail are network fakes.
 * No application bundles, mocks, direct state edits or injected outcomes. */
export async function emittedRecovery() {
  const receiver = await receiverEdge();
  let h;
  const pending = [];
  // Capture transport failures immediately: each request is intentionally
  // disconnected when its actual executor process group is killed.
  const inFlight = promise => { const captured = promise.then(value => ({ value }), error => ({ error })); pending.push(captured); return captured; };
  try {
    h = await emittedProcess(receiver.origin);
    await h.start(['DB']);
    await unavailable(h, ['DB']);
    await h.restart(['AUTH_ORIGIN', 'OWNER_EMAIL', 'SESSION_SECRET']);
    await unavailable(h, ['AUTH_ORIGIN', 'OWNER_EMAIL', 'SESSION_SECRET']);
    await h.restart();
    await unavailable(h); // DB binding exists but its schema has not been installed.
    await h.command('migrate');
    const repaired = await h.send('/health');
    assert.equal(repaired.status, 200); assert.equal(repaired.value.ok, true);
    assert.deepEqual(repaired.value.dependencies, { DB: 'available', executor_storage: 'available' });
    await h.bootstrap();
    assert.equal((await h.send('/api/crank/reports/operations', undefined, '')).status, 401);

    const flow = await h.post('flows', { name: 'Interrupted legacy delivery', source_app: 'Support desk', destination_app: 'Acceptance receiver', target_url: endpoint('/legacy') }, 201);
    await h.post(`flows/${flow.id}/estimate`, { cost });
    await h.post(`flows/${flow.id}/activate`);
    const legacy = await h.post(`flows/${flow.id}/runs`, { event_id: 'emitted-process-loss', input: { invoice: 'INV-BASE-003' } }, 201);
    const write = await workflow(h, 'Interrupted invoice write', [http('send', 'POST', '/write'), { id: 'after', type: 'map', input: { done: true } }]);
    const read = await workflow(h, 'Interrupted safe read and queue', [http('read', 'GET', '/read')]);
    const delayed = await workflow(h, 'Durable delayed Cron read', [{ id: 'pause', type: 'delay', mode: 'for', input: { amount: 1, unit: 'minutes' } }, http('read', 'GET', '/delayed')], { priority: 20 });
    const waiting = await h.post(`workflows/${delayed.id}/run`, { input: {} }, 201);
    assert.equal(waiting.status, 'waiting'); assert.equal(receiver.count('/delayed'), 0);

    const delivery = inFlight(h.post(`runs/${legacy.id}/approve`));
    const writing = inFlight(h.post(`workflows/${write.id}/run`, { input: { invoice: 'INV-WRITE-003' } }, 201));
    const reading = inFlight(h.post(`workflows/${read.id}/run`, { input: {} }, 201));
    await until(() => ['/legacy', '/write', '/read'].every(path => receiver.count(path) === 1), 'all three requests accepted at the receiver');
    const writeRun = (await h.get('workflow-runs?workflow=' + write.id)).runs[0];
    const readRun = (await h.get('workflow-runs?workflow=' + read.id)).runs[0];
    assert.equal(writeRun.status, 'running'); assert.equal(readRun.status, 'running');
    assert.equal((await h.get('runs/' + legacy.id)).state, 'running');
    const queued = await h.post(`workflows/${read.id}/run`, { input: { queued: true } }, 201);
    assert.equal(queued.status, 'queued');
    assert.deepEqual((await h.get('workflow-runs/' + queued.id)).steps, []);

    await h.restart(); // Actual SIGKILL with all three requests in flight.
    for (const response of await Promise.all([delivery, writing, reading])) assert.ok(response.error, 'killed HTTP request loses its response');
    assert.equal((await h.get('workflow-runs/' + waiting.id)).status, 'waiting');
    assert.equal((await h.get('workflow-runs/' + queued.id)).status, 'queued');
    const time = Date.now();
    const interruptedCron = inFlight(h.command('tick', { time: time + 6 * 60000 }));
    await until(() => receiver.count('/delayed') === 1, 'Cron releases the durable delay and reaches its receiver');
    const operations = (await h.get('reports/operations')).recovery.operations;
    const started = operations.find(job => job.kind === 'scheduler' && job.status === 'running');
    assert.ok(started, 'the in-flight Cron pass has a durable operation journal');
    await h.restart(); // Kill a real maintenance pass before it can finish.
    assert.ok((await interruptedCron).error);
    await h.command('tick', { time: time + 22 * 60000 });
    await until(async () => (await h.get('workflow-runs/' + waiting.id)).status === 'succeeded', 'Cron resumes the interrupted safe delayed read');
    // A pass snapshots eligible queue entries. Another pass drains any queued
    // sibling that could not acquire the workflow slot in the earlier pass.
    await h.command('tick', { time: time + 23 * 60000 });
    const lostWrite = await h.get('workflow-runs/' + writeRun.id);
    assert.equal(lostWrite.status, 'uncertain');
    assert.equal(lostWrite.steps[0].status, 'uncertain');
    assert.equal(lostWrite.steps.length, 1, 'no follow-up after an interrupted remote write');
    await h.post(`workflow-runs/${writeRun.id}/resume`, {}, 409);
    assert.equal((await h.get('workflow-runs/' + readRun.id)).status, 'succeeded');
    assert.equal((await h.get('workflow-runs/' + queued.id)).status, 'succeeded');
    assert.equal(receiver.count('/write'), 1, 'uncertain workflow write is never automatically repeated');
    assert.equal(receiver.count('/read'), 3, 'one safe read resumes and the distinct queued read executes once');
    assert.equal(receiver.count('/delayed'), 2, 'interrupted delayed read resumes once');

    // The legacy claim uses the real wall clock, unlike the platform's chosen
    // Cron scheduledTime. Let its existing lease expire without editing D1.
    const state = await until(async () => { const state = await h.get('state'); return state.runs.find(run => run.id === legacy.id)?.state === 'failed' ? state : null; }, 'legacy lease expires after process loss', 40000);
    const legacyOutcome = state.runs.find(run => run.id === legacy.id);
    const outcome = legacyOutcome.outcome ?? JSON.parse(legacyOutcome.outcome_json);
    assert.equal(outcome.uncertain, true); assert.equal(outcome.code, 'delivery_interrupted');
    assert.equal(state.attempts.filter(attempt => attempt.run_id === legacy.id).length, 1);
    assert.equal(receiver.count('/legacy'), 1, 'legacy recovery records uncertainty without resending');
    const report = await h.get('reports/operations');
    assert.equal(report.recovery.operations.find(job => job.id === started.id).status, 'interrupted');
    assert.equal(report.recovery.executor.status, 'observed');
    assert.ok(report.execution_queue.runs.some(run => run.id === writeRun.id && run.uncertain_steps === 1));
    assert.equal(report.recovery.backup.verified_external_copy, false);
    await archiveRecovery(h);
    console.log('BASE-003 passed against emitted service: bounded dependency failure/repair, killed legacy and workflow delivery, durable queue/delay recovery, interrupted Cron, resumable archive transfer and authorized reconciliation and custody');
  } finally {
    await h?.close();
    await Promise.allSettled(pending);
    await receiver.close();
  }
}
