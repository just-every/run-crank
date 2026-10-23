import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, startRun, until } from './kit.mjs';

/** CONN-002 unattended scheduled renewal, serialized rotating tokens and live
 * revocation. Only the OAuth/provider network boundary is faked. */
export async function oauthRenewalJourney() {
  const fake = fakeEdge();
  let renewals = 0, issued = 0, broad = false, gate = null, entered = false, release = () => {};
  const apiCalls = [];
  fake.routes.set('api.hubapi.com', async ({ url, body, headers }) => {
    if (url.pathname === '/oauth/v1/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') return jsonResponse({ access_token: `synthetic-crank-access-${++issued}`, refresh_token: `synthetic-crank-refresh-${issued}`, expires_in: -3600, scope: 'contacts.read' });
      renewals++; entered = true;
      if (gate) await gate;
      return jsonResponse({ access_token: `synthetic-crank-renewed-${renewals}`, refresh_token: `synthetic-crank-next-${renewals}`, expires_in: 7200, scope: broad ? 'contacts.read contacts.write' : 'contacts.read' });
    }
    apiCalls.push(headers.authorization);
    return jsonResponse({ id: 'synthetic-crank-record', renewed: headers.authorization.startsWith('Bearer synthetic-crank-renewed-') });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    await h.post('oauth/apps/hubspot', { client_id: 'synthetic-crank-client', client_secret: 'synthetic-crank-client-secret' });
    const authorization = await h.post('oauth/start', { app: 'hubspot', label: 'Buyer account', scopes: ['contacts.read'] }, h.owner, 201);
    const account = await h.get('oauth/callback?code=synthetic-crank-code&state=' + new URL(authorization.authorize_url).searchParams.get('state'), h.owner, 201);
    const read = { id: 'read', type: 'http', connection_id: account.id, input: { url: 'https://api.hubapi.com/contacts' } };
    const scheduled = await publish(h, 'Scheduled customer read', { trigger: { type: 'schedule', every_minutes: 1, timezone: 'America/New_York' }, steps: [read] });
    // No session or owner action is supplied between restart and Cron dispatch.
    await h.restart(); await h.tick(Date.now() + 120000);
    const runs = (await h.get('workflow-runs?workflow=' + scheduled.id)).runs;
    assert.ok(runs.length > 0 && runs.every(run => run.status === 'succeeded'));
    assert.equal(renewals, 1); assert.ok(apiCalls.every(value => value === 'Bearer synthetic-crank-renewed-1'));
    const current = (await h.get('connections')).find(c => c.id === account.id);
    assert.equal(current.previous_expires_at, account.expires_at); assert.ok(current.renewed_at); assert.ok(current.expires_at > current.previous_expires_at);
    const history = await h.get(`connections/${account.id}/history`);
    assert.equal(history.filter(event => event.action === 'connection.token_renewed').length, 1);
    const renewal = history.find(event => event.action === 'connection.token_renewed');
    assert.equal(renewal.actor_id, 'system:oauth'); assert.equal(renewal.detail.previous_expires_at, account.expires_at); assert.equal(renewal.detail.expires_at, current.expires_at);
    await h.get(`connections/${account.id}/history`, '', 401);
    // Two runs needing the same rotating token share one refresh, then both use
    // the saved winning token; they cannot consume the old refresh token twice.
    const workflow = await publish(h, 'Concurrent customer reads', { settings: { max_concurrency: 2 }, trigger: { type: 'manual' }, steps: [read] });
    const expire = () => h.post(`connections/${account.id}/rotate`, { secret: { access_token: 'synthetic-crank-expired', refresh_token: 'synthetic-crank-rotating', expires_at: new Date(Date.now() - 3600000).toISOString() }, scopes: ['contacts.read'] });
    await expire(); entered = false;
    gate = new Promise(resolve => { release = resolve });
    const pending = [startRun(h, workflow, {}), startRun(h, workflow, {})];
    await until(() => entered, 'OAuth refresh boundary');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(renewals, 2, 'only one caller exchanges the rotating refresh token');
    release(); gate = null;
    const concurrent = await Promise.all(pending);
    assert.ok(concurrent.every(run => run.status === 'succeeded'), JSON.stringify(concurrent.map(run => ({ status: run.status, error: run.error }))));
    assert.equal(renewals, 2);
    // An owner's revocation while the token provider is replying wins the
    // compare-and-swap; the token cannot resurrect or dispatch this connection.
    await expire(); entered = false; gate = new Promise(resolve => { release = resolve });
    const before = apiCalls.length, revokedRun = startRun(h, workflow, {});
    await until(() => entered, 'revoked refresh boundary');
    await h.post(`connections/${account.id}/revoke`);
    release(); gate = null;
    const revoked = await revokedRun;
    assert.equal(revoked.status, 'paused'); assert.equal(apiCalls.length, before);
    assert.equal((await h.get('connections')).find(c => c.id === account.id).status, 'revoked');
    // Fresh consent may deliberately narrow a grant. A refresh cannot widen it.
    await expire(); broad = true;
    const refused = await startRun(h, workflow, {});
    assert.equal(refused.status, 'paused'); assert.equal(apiCalls.length, before);
    assert.match(refused.error.message, /fresh owner consent/);
    const narrowed = (await h.get('connections')).find(c => c.id === account.id);
    assert.deepEqual(narrowed.scopes, ['contacts.read']); assert.equal(narrowed.status, 'needs_reconnect');
    const exported = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(exported.status, 200);
    const publicState = JSON.stringify({ runs: await h.get('workflow-runs'), account: narrowed, history: await h.get(`connections/${account.id}/history`), audit: await h.get('audit') }) + exported.text;
    for (const secret of ['synthetic-crank-access-1', 'synthetic-crank-refresh-1', 'synthetic-crank-renewed-1', 'synthetic-crank-next-1', 'synthetic-crank-client-secret', 'synthetic-crank-rotating']) assert.ok(!publicState.includes(secret), 'tokens never appear in history, audit or export');
    assert.ok(!exported.text.includes('"table":"crank_oauth_refresh_leases"'));
  } finally { release(); await h.close(); }
}
