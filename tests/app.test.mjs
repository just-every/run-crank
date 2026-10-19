import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, startRun } from './kit.mjs';

// The app's pages through their HTTP doors: the Flow editor reads a published
// workflow's steps and runs, and an approval decided from the Approvals form
// continues the run it holds.
const edge = fakeEdge();
let h;
before(async () => { edge.routes.set('history.example', ({ body }) => { const input = JSON.parse(body); return jsonResponse(input.fail ? { customer: input.customer, private_note: 'restricted-provider-detail' } : { id: 'invoice-123', url: 'https://history.example/invoices/123' }, input.fail ? 400 : 201) }); h = await harness('http://127.0.0.1:9', { edge: edge.edge }) });
after(async () => { await h?.close() });

const page = async path => { const r = await h.send(path, undefined, h.owner); assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`); return r.text };
const form = async (fields, path = '/app/action') => h.mf.dispatchFetch(h.origin + path, { method: 'POST', redirect: 'manual', headers: { host: new URL(h.origin).host, origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('the flow editor shows the steps and runs; an approval decided from its form continues the run', async () => {
  assert.equal((await h.send('/app', undefined, h.owner)).headers.get('location'), '/setup', 'the owner finishes setup first');
  assert.equal((await form({ confirm: 'yes' }, '/setup')).headers.get('location'), '/app');
  const graph = { trigger: { type: 'manual', name: 'Started by hand' }, settings: { run_columns: [{ label: 'Customer', value: '{{trigger.input.customer}}' }] }, steps: [
    { id: 'paid', type: 'filter', name: 'Paid orders only', when: [[{ field: 'trigger.input.status', op: 'text.equals', value: 'paid' }]] },
    { id: 'check', type: 'approval', name: 'Ask an owner', instructions: 'Large orders wait for an owner.', input: { customer: '{{trigger.input.customer}}' } },
    { id: 'summary', type: 'map', name: 'Order summary', input: { customer: '{{trigger.input.customer}}' } },
  ] };
  const workflow = await publish(h, 'Paid orders to the team', graph);
  const run = await startRun(h, workflow, { customer: 'Harbor Workshop', status: 'paid' });
  assert.equal(run.status, 'awaiting_approval');

  const editor = await page(`/app/workflows/${workflow.id}`);
  for (const text of ['Paid orders to the team', 'Paid orders only', 'Ask an owner', 'Order summary', 'Runs today', 'Harbor Workshop', 'Waiting for approval']) assert.ok(editor.includes(text), `editor shows ${text}`);
  assert.ok((await page('/app/runs')).includes('Harbor Workshop'), 'the Runs page leads with the run’s own Customer column');
  const selected = await page(`/app/workflows/${workflow.id}?step=check`);
  assert.ok(selected.includes('Large orders wait for an owner.'), 'the inspector shows the selected step');

  const approvals = await page('/app/approvals');
  assert.ok(approvals.includes(run.id.slice(0, 8)), 'the waiting run is listed');
  const digest = approvals.match(/name="digest" value="([0-9a-f]{64})"/)[1];
  const decided = await form({ step_path: 'check', digest, return_to: '/app/approvals', reason: '', path: `/api/crank/workflow-runs/${run.id}/approve` });
  assert.equal(decided.status, 303); assert.equal(decided.headers.get('location'), '/app/approvals');
  assert.equal((await h.get('workflow-runs/' + run.id)).status, 'succeeded');
  assert.ok((await page('/app/approvals')).includes('Nothing needs you'), 'nothing waits after the decision');
  assert.ok((await page(`/app/workflow-runs/${run.id}`)).includes('Order summary'), 'the run page lists its steps');
});


test('EXEC-005: older business-key history, date/error filters, mapping decisions, comparison and restricted payloads through API and app', async () => {
  const w = await publish(h, 'Wholesale invoices · Harbor Workshop', { trigger: { type: 'manual' }, steps: [
    { id: 'eligible', type: 'filter', when: [[{ field: 'trigger.input.amount', op: 'number.gt', value: 0 }]] },
    { id: 'invoice', type: 'http', input: { method: 'POST', url: 'https://history.example/invoices', body: { customer: '{{trigger.input.customer}}', fail: '{{trigger.input.fail}}' } } },
  ] });
  const failed = await h.post(`workflows/${w.id}/run`, { input: { customer: 'Harbor Workshop', amount: 100, fail: true }, business_key: 'customer-harbor' }, h.owner, 201);
  const passed = await h.post(`workflows/${w.id}/run`, { input: { customer: 'Harbor Workshop', amount: 100, fail: false }, business_key: 'customer-harbor' }, h.owner, 201);
  const stopped = await startRun(h, w, { customer: 'Harbor Workshop', amount: 0, fail: false });
  assert.equal(failed.status, 'failed'); assert.equal(passed.status, 'succeeded'); assert.equal(stopped.status, 'stopped_by_filter');
  const prefix = `workflow-runs?workflow=${w.id}`;
  const first = await h.get(prefix + '&limit=1');
  assert.ok(first.next);
  const second = await h.get(prefix + '&limit=1&before=' + encodeURIComponent(first.next));
  assert.notEqual(first.runs[0].id, second.runs[0].id);
  const day = new Date().toISOString().slice(0, 10);
  const found = await h.get(prefix + '&business_key=customer-harbor&status=failed&error=provider&from=' + day + '&to=' + day);
  assert.deepEqual(found.runs.map(r => r.id), [failed.id]);
  const detail = await h.get('workflow-runs/' + failed.id);
  assert.equal(detail.steps.find(s => s.path === 'invoice').input.body.customer, 'Harbor Workshop');
  assert.equal(detail.attempts[0].http_status, 400); assert.ok(detail.attempts[0].started_at); assert.ok(detail.attempts[0].finished_at);
  assert.equal(detail.attempts[0].destination_origin, 'https://history.example');
  assert.equal(detail.steps.find(s => s.path === 'eligible').trace.groups[0].rules[0].result, true);
  const history = await page('/app/runs?workflow=' + w.id + '&business_key=customer-harbor&status=failed&error=provider&from=' + day + '&to=' + day);
  assert.ok(history.includes(failed.id.slice(0, 8))); assert.ok(!history.includes(passed.id.slice(0, 8)));
  const compared = await page(`/app/workflow-runs/${failed.id}?compare=${passed.id}`);
  for (const value of ['Harbor Workshop', 'invoice-123', 'https://history.example/invoices/123', 'provider', passed.id.slice(0, 8)]) assert.ok(compared.includes(value), value);
  assert.ok((await page('/app/workflow-runs/' + passed.id)).includes('href="https://history.example/invoices/123"'));
  const email = 'history-reader@example.test';
  assert.equal((await h.send('/auth/invite', { email, displayName: 'History reader', role: 'member' }, h.owner)).status, 202);
  const message = h.mail.findLast(m => m.to.includes(email));
  const token = new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), h.origin).searchParams.get('token');
  const cookie = (await h.send('/auth/confirm', { token })).cookie;
  const safe = await h.get('workflow-runs/' + failed.id, cookie);
  assert.equal(safe.status, 'failed'); assert.ok(safe.received_at); assert.equal(safe.payload, 'restricted');
  assert.equal(safe.steps.find(s => s.path === 'invoice').input, undefined);
  assert.ok(!JSON.stringify(safe).includes('restricted-provider-detail'));
  const restrictedPage = await h.send(`/app/workflow-runs/${failed.id}?compare=${passed.id}`, undefined, cookie);
  assert.equal(restrictedPage.status, 200); assert.ok(!restrictedPage.text.includes('restricted-provider-detail')); assert.ok(!restrictedPage.text.includes('invoice-123'));
  await h.get(prefix + '&limit=NaN', h.owner, 422);
});
