import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

/** Third-party APIs faked at the network edge: `routes` maps a host to a handler that
 * receives {method,url,headers,body} and returns a Response. Loopback passes through. */
export function fakeEdge() {
  const routes = new Map(), requests = [];
  const edge = async request => {
    const url = new URL(request.url);
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return undefined;
    const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
    const entry = { method: request.method, url, headers: Object.fromEntries(request.headers), body };
    requests.push(entry);
    const handler = routes.get(url.host);
    return handler ? await handler(entry) : new Response('no fake for ' + url.host, { status: 599 });
  };
  return { routes, requests, edge, to: host => requests.filter(r => r.url.host === host) };
}
export const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

export async function publish(h, name, graph, expected = 201) {
  const workflow = await h.post('workflows', { name, graph }, h.owner, 201);
  const published = await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, expected);
  return { ...workflow, published };
}
export const hookUrl = async (h, workflow, input = {}) => (await h.post(`workflows/${workflow.id}/hooks`, input, h.owner, 201)).url;
/** Sends to a public inbound door (no session, no Origin). */
export async function deliver(h, url, init = {}) {
  if (init.body instanceof FormData) {
    // Encode multipart bytes here; the test dispatcher would stringify a FormData body.
    const encoded = new Response(init.body);
    init = { ...init, body: await encoded.arrayBuffer(), headers: { ...(init.headers ?? {}), 'content-type': encoded.headers.get('content-type') } };
  }
  const response = await h.mf.dispatchFetch(url, { redirect: 'manual', ...init });
  const text = await response.text(); let value; try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, value, text, headers: response.headers };
}
export async function until(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + label);
    await new Promise(r => setTimeout(r, 50));
  }
}
export const runs = async (h, workflow, query = '') => (await h.get(`workflow-runs?workflow=${workflow.id}${query}`)).runs;
export const settled = (h, runId) => until(async () => { const run = await h.get('workflow-runs/' + runId); return ['queued', 'running'].includes(run.status) ? null : run }, 'run ' + runId);
export const stepOf = (run, id) => run.steps.find(s => s.step_id === id);
export async function startRun(h, workflow, input) { return h.post(`workflows/${workflow.id}/run`, { input }, h.owner, 201) }
export const connection = (h, body) => h.post('connections', body, h.owner, 201);
/** Credentials for fakes are generated per run, so no secret-shaped literal is committed. */
export const fakeSecret = label => `${label}-${randomUUID()}`;

/** An owner explicitly quotes every cost component before releasing held work. */
export async function estimateHold(h, holdId, amounts = {}) {
  return h.post(`holds/${holdId}/estimate`, { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: amounts[kind] ?? '0', assumption: 'Local acceptance journey; network edges do not charge this installation' })) } });
}

/** The shared import door at /api/operator/import/, through the owner's session. */
export const door = (h, action, body, cookie = h.owner, headers = {}) => h.send('/api/operator/import/' + action, body, cookie, { 'X-Import-Source': 'n8n', ...headers });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** Upload one small source and plan it; returns the door's plan. */
export async function doorPlan(h, text, catchup) {
  const bytes = Buffer.from(text), upload = await door(h, 'uploads', { name: 'n8n-workflows.json', bundleSha256: sha(bytes), totalBytes: bytes.length, totalChunks: 1, index: 0, chunkSha256: sha(bytes), base64: bytes.toString('base64') });
  assert.equal(upload.status, 200, upload.text);
  return door(h, 'plan', { uploadId: upload.value.uploadId, ...(catchup ? { catchup } : {}) });
}
export async function doorImport(h, text) {
  const plan = await doorPlan(h, text);
  assert.equal(plan.status, 200, plan.text);
  const applied = await door(h, 'apply', { planId: plan.value.planId, reviewedFingerprint: plan.value.fingerprint });
  assert.equal(applied.value.job?.state, 'completed', applied.text);
  return plan.value;
}

/** Base's copyable public HTTP conformance (import-kit door ADOPTING.md). */
export async function checkDoor({request, bytes, name, nativeSnapshot,
  assertApplied, assertUndone}) {
  const hash = b => createHash('sha256').update(b).digest('hex');
  const json = async (action, body, review, expected = 200) => {
    const response = await request(action, body, review);
    assert.equal(response.status, expected, `${action}: ${response.status}`);
    return response.json();
  };
  const until = async (action, body, review, state) => {
    for (let batch = 0; batch < 100; batch++) {
      const result = await json(action, body, review);
      if (result.job?.state === state) return result.job;
      assert.ok(['queued','applying','undoing'].includes(result.job?.state));
    }
    assert.fail(`${action} did not finish`);
  };
  assert.ok(bytes.length > 0);
  const before = await nativeSnapshot(), bundleSha256 = hash(bytes);
  const totalChunks = Math.ceil(bytes.length / 65536);
  let uploadId;
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * 65536, (index + 1) * 65536);
    const uploaded = await json('uploads', {uploadId, name, bundleSha256,
      totalBytes:bytes.length, totalChunks, index,
      chunkSha256:hash(chunk), base64:chunk.toString('base64')});
    uploadId = uploaded.uploadId;
  }
  const inventory = await json('uploads', {uploadId});
  assert.equal(inventory.complete, true);
  assert.equal(inventory.bundleSha256, bundleSha256);
  assert.equal(inventory.received.reduce((n,c) => n + c.size, 0), bytes.length);
  const plan = await json('plan', {uploadId});
  assert.equal(plan.bundleSha256, bundleSha256);
  assert.ok(plan.summary.sourceRecords > 0);
  assert.deepEqual(await nativeSnapshot(), before);
  const review = {fingerprint:plan.fingerprint,
    approvalRecordId:randomUUID(), approvedAt:new Date().toISOString()};
  const wrong = (plan.fingerprint[0] === '0' ? '1' : '0') + plan.fingerprint.slice(1);
  await json('apply', {planId:plan.planId, reviewedFingerprint:wrong}, review, 403);
  assert.deepEqual(await nativeSnapshot(), before);
  const job = await until('apply', {planId:plan.planId,
    reviewedFingerprint:plan.fingerprint}, review, 'completed');
  const status = await json('status', {planId:plan.planId});
  assert.equal(status.job.id, job.id);
  assert.equal(status.job.state, 'completed');
  const report = await json('reconcile', {planId:plan.planId});
  assert.equal(report.ok, true);
  assert.equal(report.fingerprint, plan.fingerprint);
  assert.equal(report.bundleSha256, bundleSha256);
  assert.equal(report.counts.sourceRecords, plan.summary.sourceRecords);
  assert.equal(report.counts.present + report.counts.explained, report.counts.sourceRecords);
  assert.equal(report.sourceIds.length, report.counts.sourceRecords);
  await assertApplied(before, await nativeSnapshot(), report);
  await until('undo', {planId:plan.planId}, undefined, 'undone');
  await assertUndone(before, await nativeSnapshot());
}
