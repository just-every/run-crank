import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { harness } from './harness.mjs';
import { connection, deliver, fakeEdge, fakeSecret, jsonResponse, publish, settled, startRun, stepOf } from './kit.mjs';
import { ownershipGraph, ownershipInput, ownershipProviders } from './ownership-workflow.mjs';

test('BASE-001/BASE-004: an owned installation publishes and finishes every shipped step type while author traffic is blocked', async () => {
  const fake = fakeEdge(), refused = [];
  ownershipProviders(fake, jsonResponse);
  // All unconfigured destinations are refused, including every author domain
  // and subdomain. No successful author, telemetry or licensing response exists.
  const h = await harness('http://127.0.0.1:9', { edge: async request => {
    if (!fake.routes.has(new URL(request.url).host)) { refused.push(new URL(request.url).hostname); return new Response('Outbound traffic blocked', { status: 503 }); }
    return fake.edge(request);
  } });
  try {
    const setup = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    assert.equal(setup.status, 303);
    const slack = await connection(h, { app: 'slack', label: 'Harbor sales team', auth_kind: 'bearer', secret: { token: fakeSecret('slack') } });
    const executor=await connection(h,{app:'http',label:'Owner code executor',auth_kind:'bearer',domains:['executor.example'],secret:{token:fakeSecret('executor')}});
    const {preparePublicCustom}=await import('./custom-fixture.mjs');
    fake.routes.set('custom.example',()=>jsonResponse({id:'stock-24',quantity:24}));
    const custom=await preparePublicCustom(h,{id:'owned-stock'});
    const graph = ownershipGraph(slack.id,executor.id);graph.steps.unshift(custom.step);
    const workflow = await publish(h, 'Harbor wholesale · owned installation', graph);
    const initial = await startRun(h, workflow, ownershipInput);
    assert.equal(initial.status, 'waiting', JSON.stringify(initial.error));
    assert.equal(initial.waits[0].kind, 'delay');
    await h.restart();
    await h.tick(Date.parse(initial.waits[0].due_at) + 1000);
    const callback = await h.get('workflow-runs/' + initial.id);
    assert.equal(callback.waits.find(w => !w.resolved_at).kind, 'callback');
    const invoice = fake.to('ledger.example');
    assert.equal(invoice.length, 1);
    const body = JSON.parse(invoice[0].body);
    assert.equal(body.customer, ownershipInput.customer.trim());
    assert.equal(body.lines.length, 2);
    const receipt = await deliver(h, body.callback, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'receipt-1042' }) });
    assert.equal(receipt.status, 202);
    const review = await settled(h, initial.id);
    assert.equal(review.status, 'awaiting_approval');
    const wait = review.waits.find(w => w.kind === 'approval');
    await h.post(`workflow-runs/${initial.id}/approve`, { path: wait.path, digest: wait.proposal_digest });
    const done = await h.get('workflow-runs/' + initial.id);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.deepEqual(done.response.body, { customer: ownershipInput.customer.trim(), receipt: 'receipt-1042', invoice: 'invoice-harbor-1042' });
    assert.equal(stepOf(done, 'rep_name').output.record.id, 'U000001');
    assert.equal(stepOf(done, 'find_note').output.count, 1);
    assert.equal(stepOf(done, 'quote').output.size, new TextEncoder().encode('Harbor Workshop quote: $521.00').length);
    assert.equal(fake.to('ledger.example').length, 1, 'restart and approval do not repeat the invoice');
    // Discover the live registry rather than pinning a version-specific list.
    // Execution itself above goes exclusively through HTTP and Worker Cron.
    const registry = await build({ stdin: { contents: "export { STEP_TYPES } from './src/crank/engine/steps/index.ts'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
    const { STEP_TYPES } = await import('data:text/javascript;base64,' + Buffer.from(registry.outputFiles[0].text).toString('base64'));
    const succeeded = new Set(done.steps.filter(s => s.status === 'succeeded').map(s => s.type));
    for (const type of [...Object.keys(STEP_TYPES), 'paths', 'loop']) assert.ok(succeeded.has(type), `BASE-004 needs a successful public-door journey for ${type}`);
    assert.deepEqual(refused, [], 'core operation never tries an author or other unconfigured host');
    assert.equal((await h.send('/app/workflow-runs/' + done.id, undefined, h.owner)).status, 200);
  } finally { await h.close(); }
});

test('BASE-001: disconnected native sign-in, local HTTP, literal history and credential-free export restore with fresh authority', async () => {
  const { ownedOperationJourney } = await import('./owned-operation.mjs');
  await ownedOperationJourney();
});

test('BASE-001: inspect configured recipients and field categories without leaking graph literals or credentials', async () => {
  const { ownedOperationFixture } = await import('./owned-operation.mjs');
  const f = await ownedOperationFixture(), { h } = f;
  try {
    const slackToken = fakeSecret('disclosure-slack'), sinkToken = fakeSecret('disclosure-sink'), clientSecret = fakeSecret('disclosure-oauth');
    const slack = await connection(h, { app: 'slack', label: '<script>Harbor sales</script>', auth_kind: 'bearer', secret: { token: slackToken } });
    await h.post('oauth/apps/slack', { client_id: 'harbor-owner-app', client_secret: clientSecret });
    const sink = await h.post('reports/log-sinks', { label: 'Owner audit storage', kind: 's3', endpoint: 'https://storage.example', region: 'us-east-1', bucket: 'buyer-audit', fields: ['event', 'status'], secret: { access_key: fakeSecret('access'), secret_key: sinkToken }, enabled: true }, h.owner, 201);
    const graph = { trigger: { type: 'feed', urls: ['https://feed.example/news?private_query=not-for-inventory'], interval_minutes: 1, backfill: 'from_now' }, steps: [
      { id: 'fetch', type: 'file.fetch', input: { url: '{{trigger.file_url}}' } },
      { id: 'loop', type: 'loop', input: { items: '{{trigger.items}}' }, max_items: 2, concurrency: 1, order: 'input', empty: 'allow', item_errors: 'stop', result: '{{steps.note}}', steps: [
        { id: 'note', type: 'slack.send_channel_message', connection_id: slack.id, input: { channel: 'C123', text: '{{trigger.title}}' } },
        { id: 'post', type: 'http', input: { method: 'POST', url: 'https://ledger.example/events?key=do-not-disclose', body: { customer: '{{trigger.customer}}', secret_literal: 'never-return-this-value' } } },
      ] },
    ] };
    const w = await publish(h, 'Harbor Workshop · feed and supporting files', graph);
    const legacy = await h.flow('Local shipment receipt · Harbor Workshop');
    const inventory = await h.get('data/flows'), text = JSON.stringify(inventory);
    assert.equal((await h.send('/api/crank/data/flows')).status, 401);
    const agent = await h.post('tokens', { label: 'Read-only agent', scope: 'agent' }, h.owner, 201);
    await h.get('data/flows', '', 403, { authorization: 'Bearer ' + agent.token });
    const byId = id => inventory.flows.find(flow => flow.id === id);
    assert.equal(byId('connection:' + f.provider.id).state, 'revoked');
    assert.equal(byId('log:' + sink.id).state, 'enabled');
    assert.ok(byId('flow:' + legacy.id).recipients.includes(f.target));
    assert.ok(byId('receiver').recipients.includes(f.target));
    assert.ok(byId('log:' + sink.id).fields.includes('status')); assert.ok(byId('log:' + sink.id).region.includes('us-east-1'));
    assert.ok(byId('oauth:slack').recipients.includes('https://slack.com'));
    assert.ok(byId('mail').recipients.includes('https://api.resend.com'));
    assert.ok(inventory.flows.some(flow => flow.kind === 'poll' && flow.recipients.includes('https://feed.example')));
    assert.ok(inventory.flows.some(flow => flow.kind === 'file.fetch' && flow.recipients.some(value => value.includes('runtime'))));
    assert.ok(inventory.flows.some(flow => flow.kind.startsWith('slack.') && flow.credentials.includes('bearer')));
    assert.ok(inventory.flows.some(flow => flow.kind === 'http' && flow.fields.includes('body.customer') && flow.recipients.includes('https://ledger.example')));
    for (const flow of inventory.flows) for (const key of ['purpose', 'credentials', 'region', 'retention']) assert.ok(flow[key], `BASE-001: ${flow.id} discloses ${key}`);
    for (const key of ['region', 'retention']) assert.equal(byId('oauth:slack')[key], 'Provider-controlled; not verified by Crank. Consult your provider agreement.', 'BASE-001: unestablished provider terms are labelled unverified, never invented');
    assert.ok(byId('log:' + sink.id).region.includes('not provider-verified'), 'BASE-001: owner-entered region is labelled as owner-entered');
    for (const secret of [slackToken, sinkToken, clientSecret, f.providerToken, 'never-return-this-value', 'not-for-inventory', 'do-not-disclose']) assert.ok(!text.includes(secret), 'BASE-001: inventory omits values');
    const page = await h.send('/app/data', undefined, h.owner);
    assert.equal(page.status, 200); assert.ok(page.text.includes('&lt;script&gt;Harbor sales&lt;/script&gt;')); assert.ok(!page.text.includes('<script>Harbor sales'));
    await h.post('reports/log-sinks', { id: sink.id, label: 'Owner audit storage', kind: 's3', endpoint: 'https://storage.example', region: 'us-east-1', bucket: 'buyer-audit', fields: ['event', 'status'], enabled: false }, h.owner, 201);
    assert.equal((await h.get('data/flows')).flows.find(flow => flow.id === 'log:' + sink.id).state, 'disabled');
    assert.equal(f.blocked.length, 0, 'BASE-001: inspection never contacts an external destination');
    assert.equal((await h.get('workflows/' + w.id)).status, 'published');
  } finally { await f.close(); }
});
