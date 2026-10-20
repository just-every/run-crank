import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './harness.mjs';
import { connection, fakeEdge, fakeSecret, publish, startRun } from './kit.mjs';

/** Actual local receiver; only optional SaaS and mail are faked at the network edge. */
export async function ownedOperationFixture() {
  const effects = [], blocked = [], fake = fakeEdge(), providerToken = fakeSecret('removed-provider');
  const receiver = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes;
    const key = request.headers['idempotency-key']; effects.push({ key, body: JSON.parse(text) });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'local-' + effects.length, idempotencyKey: key }));
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${receiver.address().port}`;
  const edge = async request => {
    if (new URL(request.url).hostname === '127.0.0.1') return undefined;
    blocked.push(request.url); return fake.edge(request);
  };
  let h;
  try {
    h = await harness(target, { edge });
    const setup = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    assert.equal(setup.status, 303);
    const provider = await connection(h, { app: 'http', label: 'Former invoice provider · Harbor Workshop North America', auth_kind: 'bearer', domains: ['removed-provider.example'], secret: { token: providerToken } });
    const workflow = await publish(h, 'Harbor Workshop · customer invoice delivery after dispatch confirmation', { trigger: { type: 'manual' }, steps: [
      { id: 'invoice', type: 'http', connection_id: provider.id, input: { method: 'POST', url: 'https://removed-provider.example/invoices', body: { customer: '{{trigger.customer}}', amount_usd: '{{trigger.amount_usd}}' } } },
    ] });
    await h.post(`connections/${provider.id}/revoke`);
    return { h, target, effects, blocked, provider, providerToken, workflow, async close() { await h?.close(); await new Promise(resolve => receiver.close(resolve)); } };
  } catch (error) { await h?.close(); await new Promise(resolve => receiver.close(resolve)); throw error; }
}

export async function ownedOperationJourney() {
  const f = await ownedOperationFixture(), { h, provider, workflow } = f;
  let restored;
  try {
    // Ordinary native email-link sign-in; the installed mail transport is the only paid edge.
    assert.equal((await h.send('/auth/magic-link', { email: 'owner@example.test' })).status, 202);
    const href = h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
    const link = new URL(href), signedIn = await h.send('/auth/confirm', { token: link.searchParams.get('token') });
    assert.equal(signedIn.status, 303); assert.equal((await h.get('state', signedIn.cookie)).actor.role, 'owner');
    const flow = await h.flow('Harbor Workshop · dispatch receipt to the owned operations inbox');
    const run = await h.run(flow, 'shipment-1042', { customer: 'Harbor Workshop — North America', amount_usd: '521.00', note: '<script>globalThis.stolen = true</script>' });
    const approved = await h.post(`runs/${run.id}/approve`);
    assert.equal(approved.state, 'succeeded', JSON.stringify({ outcome: approved.outcome_json, effects: f.effects, blocked: f.blocked }));
    assert.equal(f.effects.length, 1); assert.equal(f.effects[0].body.note, '<script>globalThis.stolen = true</script>');
    const history = await h.get('state'); assert.equal(history.runs.find(r => r.id === run.id).state, 'succeeded');
    const page = await h.send('/app/runs/' + run.id, undefined, h.owner);
    assert.equal(page.status, 200); assert.ok(page.text.includes('&lt;script&gt;')); assert.ok(!page.text.includes('<script>globalThis.stolen'));
    const stopped = await startRun(h, workflow, { customer: 'Harbor Workshop', amount_usd: '521.00' });
    assert.ok(['paused', 'failed'].includes(stopped.status)); assert.equal(f.blocked.length, 0, 'BASE-001: removed provider is refused before a request; core operation makes no author request');
    const token = await h.post('tokens', { label: 'Source-only assistant', scope: 'agent' }, h.owner, 201);
    const archive = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(archive.status, 200);
    for (const secret of [f.providerToken, token.token, h.owner, signedIn.cookie]) assert.ok(!archive.text.includes(secret), 'BASE-001: installation authority and credential values never travel');
    // Only the owner's local receiver is reachable; any other destination is recorded and refused.
    restored = await harness(f.target, { edge: async request => { if (new URL(request.url).hostname === '127.0.0.1') return undefined; f.blocked.push(request.url); return new Response('refused', { status: 403 }); } });
    const receivingSetup = await restored.mf.dispatchFetch(restored.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: restored.origin, cookie: restored.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    assert.equal(receivingSetup.status, 303);
    await restored.post('data/restore', { archive: archive.text, confirm: 'RESTORE' });
    assert.notEqual(restored.owner, h.owner);
    await restored.get('state', h.owner, 401);
    await restored.get('state', '', 401, { authorization: 'Bearer ' + token.token });
    assert.equal((await restored.get('connections')).find(c => c.id === provider.id).status, 'revoked', 'BASE-001: a removed provider stays removed after restore');
    assert.equal((await restored.get('state')).flows.find(item => item.id === flow.id).status, 'draft');
    await restored.restart(); await restored.tick(Date.now() + 86400000);
    assert.equal(f.effects.length, 1, 'BASE-001: restart/restore cannot send an old event');
    await restored.post(`workflows/${workflow.id}/publish`, {}, restored.owner, 422);
    // New receiving-owner authority deliberately permits a local delivery again.
    await restored.post(`flows/${flow.id}/activate`);
    const fresh = await restored.run(flow, 'shipment-1043', { customer: 'Harbor Workshop — receiving installation' });
    await restored.post(`runs/${fresh.id}/approve`);
    assert.equal((await restored.get('state')).runs.find(r => r.id === fresh.id).state, 'succeeded');
    assert.equal(f.effects.length, 2); assert.equal(f.blocked.length, 0);
    assert.equal((await restored.send('/app/data', undefined, restored.owner)).status, 200);
  } finally { await restored?.close(); await f.close(); }
}
