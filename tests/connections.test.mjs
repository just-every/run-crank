import {freshGatewayOwner,nativeGatewayEnrollment,gatewayPost,signedGatewayHeaders,pollPayload,namedManifest,manifestDestinations} from './gateway-fixture.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './harness.mjs';
import { gustoHandoffJourney } from './gusto-handoff-journey.mjs';
import { effectReadbackJourney, quickbooksInputJourney, quickbooksReconciliationJourney } from './effect-readback-journey.mjs';
import { oauthRenewalJourney } from './oauth-renewal-journey.mjs';
import { connection, deliver, fakeEdge, fakeSecret, jsonResponse, publish, runs, settled, startRun, stepOf, until } from './kit.mjs';

const fake = fakeEdge();
let h;
before(async () => {
  fake.routes.set('crm.example', () => jsonResponse({ ok: true }, 201));
  fake.routes.set('files.example', ({ url }) => url.pathname === '/moved' ? new Response(null, { status: 302, headers: { location: 'http://192.168.1.10/quote.pdf' } })
    : new Response('%PDF-1.4 quote body', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="quote.pdf"' } }));
  h = await harness('http://127.0.0.1:9', { edge: fake.edge });
});
after(async () => { await h?.close() });
const form = s => new URLSearchParams(s);

test('HTTP-002/EXEC-005: requests use stored connections, map responses, route business failures, read back lost writes and refuse other destinations', async t => {
  const token = fakeSecret('vendor'), records = { r1: { id: 'r1', status: 'new' } };
  let lose = false;
  const pendingResponses = new Set();
  t.after(async () => { await Promise.allSettled([...pendingResponses]); });
  fake.routes.set('api.vendor.example', ({ method, url, headers, body }) => {
    if (headers.authorization !== 'Bearer ' + token) return jsonResponse({ error: 'unauthorized' }, 401);
    if (method === 'PATCH') {
      Object.assign(records.r1, JSON.parse(body));
      // The effect lands before the request deadline, but its acknowledgement
      // arrives too late. Drain this edge fixture before another journey starts.
      if (!lose) return jsonResponse(records.r1);
      const pending = new Promise(resolve => setTimeout(() => resolve(jsonResponse(records.r1)), 1500));
      pendingResponses.add(pending); pending.finally(() => pendingResponses.delete(pending));
      return pending;
    }
    if (url.pathname === '/conflict') return jsonResponse({ error: 'duplicate order' }, 409);
    if (url.pathname === '/forms' || url.pathname === '/uploads') return jsonResponse({ ok: true, type: headers['content-type'] });
    return jsonResponse(records.r1);
  });
  const vendor = await connection(h, { app: 'http', label: 'Vendor', auth_kind: 'bearer', domains: ['api.vendor.example'], secret: { token } });
  const patch = { id: 'patch', type: 'http', connection_id: vendor.id, timeout_ms: 400, input: { method: 'PATCH', url: 'https://api.vendor.example/records/r1', headers: { 'X-Request-Source': 'crank' }, body: { status: '{{trigger.input.status}}' } },
    readback: { url: 'https://api.vendor.example/records/r1', path: 'status', equals: '{{trigger.input.status}}' } };
  const w = await publish(h, 'Vendor update', { trigger: { type: 'manual' }, steps: [patch,
    { id: 'read', type: 'http', connection_id: vendor.id, input: { url: 'https://api.vendor.example/records/r1' } },
    { id: 'apply', type: 'http', connection_id: vendor.id, body_kind: 'form', input: { method: 'POST', url: 'https://api.vendor.example/forms', body: { name: 'Ada', plan: 'pro' } } },
    { id: 'fetch', type: 'file.fetch', input: { url: 'https://files.example/quote.pdf' } },
    { id: 'upload', type: 'http', connection_id: vendor.id, body_kind: 'multipart', input: { method: 'POST', url: 'https://api.vendor.example/uploads', body: { doc: '{{steps.fetch}}', note: 'Signed quote' } } },
    { id: 'conflict', type: 'http', connection_id: vendor.id, business_failures: [409], on_error: 'continue', input: { method: 'POST', url: 'https://api.vendor.example/conflict', body: {} } },
    { id: 'route', type: 'paths', mode: 'exclusive', branches: [{ id: 'failed', when: [[{ field: 'steps.conflict.ok', op: 'boolean.is_false' }]], steps: [{ id: 'escalate', type: 'http', input: { method: 'POST', url: 'https://crm.example/exceptions', body: { status: '{{steps.conflict.status}}' } } }] }] }] });
  const run = await startRun(h, w, { status: 'shipped' });
  assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
  const sent = fake.to('api.vendor.example');
  assert.equal(sent[0].headers['x-request-source'], 'crank'); assert.equal(stepOf(run, 'read').output.body.status, 'shipped');
  assert.equal(sent.find(r => r.url.pathname === '/forms').body, 'name=Ada&plan=pro');
  const upload = sent.find(r => r.url.pathname === '/uploads');
  assert.match(upload.headers['content-type'], /^multipart\/form-data/); assert.match(upload.body, /filename="quote.pdf"/); assert.match(upload.body, /%PDF-1.4 quote body/);
  assert.equal(stepOf(run, 'conflict').output.error.category, 'business'); assert.deepEqual(stepOf(run, 'route').output.matched, ['failed']);
  assert.equal(JSON.parse(fake.to('crm.example').at(-1).body).status, 409);
  assert.ok(!JSON.stringify(run).includes(token), 'no credential in run history');

  lose = true;
  const patches = () => fake.to('api.vendor.example').filter(r => r.method === 'PATCH').length, before = patches();
  const lost = await startRun(h, w, { status: 'delivered' });
  assert.equal(stepOf(lost, 'patch').output.reconciled, true, 'readback by business key before any retry');
  assert.equal(patches(), before + 1);
  const blind = await publish(h, 'Blind patch', { trigger: { type: 'manual' }, steps: [{ ...patch, readback: undefined }] });
  const uncertain = await startRun(h, blind, { status: 'returned' });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.attempts.length, 1); assert.equal(uncertain.attempts[0].error_category, 'network');
  const uncertainHistory = await h.get('workflow-runs?workflow=' + blind.id + '&status=uncertain');
  assert.deepEqual(uncertainHistory.runs.map(r => r.id), [uncertain.id]);
  assert.equal((await h.get('workflow-runs?workflow=' + blind.id + '&status=failed')).runs.length, 0); assert.equal(uncertain.error.category, 'uncertain'); assert.equal(patches(), before + 2, 'no automatic retry after an uncertain write');
  lose = false;

  const elsewhere = await publish(h, 'Exfiltration', { trigger: { type: 'manual' }, steps: [{ id: 'leak', type: 'http', connection_id: vendor.id, input: { url: 'https://evil.example/collect' } }] });
  const leaked = await startRun(h, elsewhere, {});
  assert.equal(leaked.error.category, 'egress'); assert.match(leaked.error.message, /outside the API domains/);
  const internal = await publish(h, 'Internal', { trigger: { type: 'manual' }, steps: [{ id: 'probe', type: 'http', input: { url: 'http://10.1.2.3/admin' } }] });
  assert.equal((await startRun(h, internal, {})).error.category, 'egress');
  const redirected = await publish(h, 'Redirected file', { trigger: { type: 'manual' }, steps: [{ id: 'grab', type: 'file.fetch', input: { url: 'https://files.example/moved' } }, { id: 'store', type: 'http', input: { method: 'POST', url: 'https://crm.example/files', body: { file: '{{steps.grab}}' } } }] });
  const refusedFile = await startRun(h, redirected, {});
  assert.match(refusedFile.error.message, /file fetch failed/);
  assert.ok(!fake.requests.some(r => ['evil.example', '10.1.2.3', '192.168.1.10'].includes(r.url.hostname)), 'no request past a refusal');
  assert.ok(!fake.to('crm.example').some(r => r.url.pathname === '/files'));
  await effectReadbackJourney();
});

test('CONN-002: OAuth consent, refresh and accounts per step; secrets never leave the server; restores require reconnecting', async () => {
  const tokens = [], [access1, access2, refresh1, refresh2, clientSecret] = ['access', 'access', 'refresh', 'refresh', 'client'].map(fakeSecret);
  fake.routes.set('api.hubapi.com', ({ url, body, headers }) => {
    if (url.pathname === '/oauth/v1/token') {
      const params = form(body); tokens.push(Object.fromEntries(params));
      return params.get('grant_type') === 'authorization_code' ? jsonResponse({ access_token: access1, refresh_token: refresh1, expires_in: 30, token_type: 'bearer' })
        : jsonResponse({ access_token: access2, refresh_token: refresh2, expires_in: 1800 });
    }
    return jsonResponse({ results: [{ id: '501', email: 'lee@example.com' }], fresh: headers.authorization === 'Bearer ' + access2 });
  });
  await h.post('oauth/apps/hubspot', { client_id: 'hub-client', client_secret: clientSecret });
  const start = await h.post('oauth/start', { app: 'hubspot', label: 'HubSpot sales', scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'] }, h.owner, 201);
  const authorize = new URL(start.authorize_url);
  assert.equal(authorize.host, 'app.hubspot.com'); assert.equal(authorize.searchParams.get('scope'), 'crm.objects.contacts.read crm.objects.contacts.write');
  const callback = `oauth/callback?code=auth-code-1&state=${encodeURIComponent(authorize.searchParams.get('state'))}`;
  const hub = await h.get(callback, h.owner, 201);
  assert.deepEqual(hub.scopes, ['crm.objects.contacts.read', 'crm.objects.contacts.write']); assert.equal(hub.auth_kind, 'oauth2');
  assert.equal(tokens[0].code, 'auth-code-1'); assert.equal(tokens[0].redirect_uri, h.origin + '/api/crank/oauth/callback');
  await h.get(callback, h.owner, 400);
  const w = await publish(h, 'Find contacts', { trigger: { type: 'manual' }, steps: [{ id: 'list', type: 'http', connection_id: hub.id, input: { url: 'https://api.hubapi.com/crm/v3/objects/contacts' } }] });
  const run = await startRun(h, w, {});
  assert.equal(tokens[1].grant_type, 'refresh_token'); assert.equal(tokens[1].refresh_token, refresh1);
  assert.equal(stepOf(run, 'list').output.body.fresh, true, 'the token is refreshed before expiry');

  const seen = [], [eastKey, westKey, eastRotated] = ['east', 'west', 'east'].map(fakeSecret);
  fake.routes.set('two.example', ({ headers }) => { seen.push(headers['x-api-key']); return jsonResponse({ ok: true }) });
  const east = await connection(h, { app: 'http', label: 'East account', auth_kind: 'api_key', domains: ['two.example'], secret: { key: eastKey, header: 'x-api-key' } });
  const west = await connection(h, { app: 'http', label: 'West account', auth_kind: 'api_key', domains: ['two.example'], secret: { key: westKey, header: 'x-api-key' } });
  const both = await publish(h, 'Two accounts', { trigger: { type: 'manual' }, steps: [{ id: 'east', type: 'http', connection_id: east.id, input: { url: 'https://two.example/a' } }, { id: 'west', type: 'http', connection_id: west.id, input: { url: 'https://two.example/b' } }] });
  await startRun(h, both, {});
  assert.deepEqual(seen, [eastKey, westKey]);
  await h.post(`connections/${east.id}/rotate`, { secret: { key: eastRotated, header: 'x-api-key' } });
  await startRun(h, both, {});
  assert.equal(seen[2], eastRotated);
  const listed = JSON.stringify(await h.get('connections'));
  for (const secret of [eastKey, westKey, eastRotated, access1, access2, refresh1, refresh2, clientSecret]) assert.ok(!listed.includes(secret), 'a credential never appears in API state');

  const exported = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(exported.status, 200, exported.text);
  for (const secret of [eastKey, westKey, eastRotated, access1, access2, refresh1, refresh2, clientSecret]) assert.ok(!exported.text.includes(secret), 'a credential is not exported');
  const other = await harness('http://127.0.0.1:9');
  try {
    await other.post('data/restore', { archive: exported.text, confirm: 'RESTORE' });
    const restored = await other.get('connections');
    assert.ok(restored.length >= 3 && restored.every(c => c.status === 'needs_reconnect'));
    const flows = await other.get('workflows');
    assert.ok(flows.length > 0 && flows.every(f => f.status === 'paused' || f.status === 'draft'), 'restored workflows do not dispatch');
  } finally { await other.close() }
  await oauthRenewalJourney();
});

const slackSign = (secret, body, t = Math.floor(Date.now() / 1000)) => ({ 'x-slack-request-timestamp': String(t), 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update(`v0:${t}:${body}`).digest('hex'), 'content-type': 'application/json' });
test('CONN-004: Slack posts by channel name and user email, applies search outcomes, finds or creates once, and admits signed events once', async () => {
  const channels = [{ id: 'C01', name: 'general' }, { id: 'C02', name: 'sales' }], posts = [];
  let failUsers = false;
  fake.routes.set('slack.com', ({ url, body }) => {
    const method = url.pathname.replace('/api/', ''), p = form(body);
    if (method === 'auth.test') return jsonResponse({ ok: true, team: 'Acme', user: 'crankbot' });
    if (method === 'conversations.list') return jsonResponse({ ok: true, channels, response_metadata: { next_cursor: '' } });
    if (method === 'conversations.create') { if (channels.some(c => c.name === p.get('name'))) return jsonResponse({ ok: false, error: 'name_taken' }); const c = { id: 'C' + (channels.length + 1), name: p.get('name') }; channels.push(c); return jsonResponse({ ok: true, channel: c }) }
    if (method === 'users.lookupByEmail') {
      if (failUsers) return new Response('upstream', { status: 500 });
      return p.get('email') === 'rep@acme.example' ? jsonResponse({ ok: true, user: { id: 'U01', name: 'rep', profile: { email: 'rep@acme.example' } } }) : jsonResponse({ ok: false, error: 'users_not_found' });
    }
    if (method === 'conversations.open') return jsonResponse({ ok: true, channel: { id: 'D01' } });
    if (method === 'chat.postMessage') { posts.push(Object.fromEntries(p)); return jsonResponse({ ok: true, channel: p.get('channel'), ts: '1700000000.00' + posts.length, message: { text: p.get('text') } }) }
    return jsonResponse({ ok: false, error: 'unknown_method' });
  });
  const slack = await connection(h, { app: 'slack', label: 'Acme Slack', auth_kind: 'bearer', scopes: ['chat:write', 'chat:write.customize', 'im:write', 'users:read.email', 'channels:read', 'channels:manage'], secret: { token: fakeSecret('bot') } });
  assert.deepEqual(await h.post(`connections/${slack.id}/test`), { ok: true, account: 'Acme', user: 'crankbot' });
  const notify = await publish(h, 'Lead alerts', { trigger: { type: 'manual' }, steps: [
    { id: 'post', type: 'slack.send_channel_message', connection_id: slack.id, input: { channel: '#general', text: 'New lead {{trigger.input.name}}', username: 'Crank Bot', icon_emoji: ':robot_face:', mention_emails: ['rep@acme.example'] } },
    { id: 'dm', type: 'slack.send_direct_message', connection_id: slack.id, input: { email: '{{trigger.input.rep}}', text: 'This lead is yours' } }] });
  const run = await startRun(h, notify, { name: 'Harbour Workshop', rep: 'rep@acme.example' });
  assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
  assert.deepEqual([posts[0].channel, posts[0].username, posts[0].text], ['C01', 'Crank Bot', '<@U01> New lead Harbour Workshop']);
  assert.equal(posts[1].channel, 'D01'); assert.equal(stepOf(run, 'post').output.ts, '1700000000.001');

  const search = no_match => ({ trigger: { type: 'manual' }, steps: [{ id: 'who', type: 'slack.find_user_by_email', retry_policy: { base_delay_ms: 500 }, connection_id: slack.id, no_match, input: { email: '{{trigger.input.email}}' } },
    { id: 'route', type: 'paths', mode: 'exclusive', branches: [{ id: 'missing', when: [[{ field: 'steps.who.outcome', op: 'text.equals', value: 'not found' }]], steps: [] }], fallback: { steps: [] } }] });
  const lookup = await publish(h, 'Owner lookup', search('continue'));
  assert.deepEqual(stepOf(await startRun(h, lookup, { email: 'nobody@acme.example' }), 'route').output.matched, ['missing']);
  assert.equal(stepOf(await startRun(h, lookup, { email: ' Rep@Acme.example ' }), 'who').output.record.id, 'U01', 'emails compare after trimming, case-insensitively');
  const halting = await publish(h, 'Owner lookup (halt)', search('halt')), mails = h.mail.length;
  assert.equal((await startRun(h, halting, { email: 'nobody@acme.example' })).status, 'stopped_by_search');
  assert.equal(h.mail.length, mails, 'a search halt sends no failure notice');
  assert.equal((await startRun(h, lookup, { email: '' })).error.category, 'validation', 'an empty key is a validation error, never a match-all');
  failUsers = true;
  const broken = await startRun(h, lookup, { email: 'rep@acme.example' });
  assert.equal(broken.status, 'failed'); assert.equal(broken.error.category, 'provider', 'a provider error is never "not found"');
  failUsers = false;

  const room = await publish(h, 'Deal room', { trigger: { type: 'manual' }, steps: [{ id: 'room', type: 'slack.find_channel_by_name', connection_id: slack.id, create_if_not_found: {}, input: { name: 'deals-won' } }] });
  assert.equal(stepOf(await startRun(h, room, {}), 'room').output.outcome, 'created');
  assert.equal(stepOf(await startRun(h, room, {}), 'room').output.outcome, 'found');
  assert.equal(channels.filter(c => c.name === 'deals-won').length, 1);
  const {searchOutcomesJourney}=await import('./search-outcomes-journey.mjs');await searchOutcomesJourney();

  const secret = fakeSecret('signing');
  const signing = await connection(h, { app: 'webhook', label: 'Slack signing secret', auth_kind: 'signing_secret', secret: { secret } });
  const listenerEffectsBefore = posts.length;
  const listener = await publish(h, 'Channel listener', { trigger: { type: 'slack_event', connection_id: slack.id, signing_connection_id: signing.id, event: 'message', channel: 'C01' }, steps: [{ id: 'said', type: 'map', input: { text: '{{trigger.event.text}}' } }, { id: 'forward', type: 'slack.send_channel_message', connection_id: slack.id, input: { channel: '#sales', text: '{{trigger.event_id}}' } }] });
  const hookPath = `${h.origin}/hooks/slack/${slack.id}`;
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-123' });
  assert.deepEqual((await deliver(h, hookPath, { method: 'POST', headers: slackSign(secret, challenge), body: challenge })).value, { challenge: 'c-123' });
  const eventTime = Math.floor(Date.now() / 1000);
  const event = (id, extra, at = eventTime) => JSON.stringify({ type: 'event_callback', event_id: id, event_time: at, team_id: 'T1', event: { type: 'message', channel: 'C01', user: 'U02', text: 'hello', ...extra } });
  for (const body of [event('Ev1'), event('Ev1'), event('Ev2', { bot_id: 'B1' }), event('Ev3', { channel: 'C02' })]) assert.equal((await deliver(h, hookPath, { method: 'POST', headers: slackSign(secret, body), body })).status, 200);
  assert.equal((await deliver(h, hookPath, { method: 'POST', headers: slackSign(fakeSecret('wrong'), event('Ev4')), body: event('Ev4') })).status, 401);
  const heard = await until(async () => { const list = await runs(h, listener); return list.length && list.every(r => r.status === 'succeeded') ? list : null }, 'listener run').catch(async error => { const details = await Promise.all((await runs(h, listener)).map(run => h.get('workflow-runs/' + run.id))); throw new Error(error.message + ': ' + JSON.stringify(details.map(run => ({ status: run.status, error: run.error, steps: run.steps }))), { cause: error }); });
  assert.equal(heard.length, 1, 'one run per event ID; bot messages and other channels start nothing');
  const sendEvent = body => deliver(h, hookPath, { method: 'POST', headers: slackSign(secret, body), body });
  await h.db.prepare('UPDATE crank_trigger_events SET payload_digest=? WHERE workflow_id=? AND dedup_key=?').bind('Ev1', listener.id, 'slack:Ev1').run();
  assert.equal((await sendEvent(event('Ev1'))).status, 200, 'pre-upgrade source identities remain duplicate fences');
  assert.equal((await runs(h, listener)).length, 1);
  // TRIG-003: source event order does not drop an older, previously unseen event.
  const concurrent = event('synthetic-crank-concurrent', { text: 'newer' });
  const delivered = await Promise.all([sendEvent(concurrent), sendEvent(concurrent)]);
  assert.ok(delivered.every(response => response.status === 200));
  const older = event('synthetic-crank-older', { text: 'older' }, eventTime - 60);
  assert.equal((await sendEvent(older)).status, 200);
  await until(async () => (await runs(h, listener)).length === 3, 'both distinct source events');
  const newerRun = (await runs(h, listener)).find(run => run.source_id === 'slack:synthetic-crank-concurrent');
  assert.equal((await settled(h, newerRun.id)).status, 'succeeded');
  await h.tick(); // The normal Cron door drains work queued behind workflow concurrency.
  assert.equal((await sendEvent(event('synthetic-crank-concurrent', { text: 'conflicting body' }))).status, 409, 'a new receipt binds its source identity to the admitted contents');
  const oldRun = (await runs(h, listener)).find(run => run.source_id === 'slack:synthetic-crank-older');
  const retained = await settled(h, oldRun.id).catch(async error => { throw new Error(error.message + ': ' + JSON.stringify(await h.get('workflow-runs/' + oldRun.id)), { cause: error }); });
  assert.equal(retained.source_time, new Date((eventTime - 60) * 1000).toISOString());
  assert.equal(stepOf(retained, 'said').output.text, 'older');

  const interrupted = event('synthetic-crank-interrupted');
  await h.db.exec(`CREATE TRIGGER interrupt_slack_run BEFORE INSERT ON crank_wf_runs WHEN NEW.workflow_id='${listener.id}' BEGIN SELECT RAISE(ABORT,'injected app admission interruption'); END;`);
  try { assert.equal((await sendEvent(interrupted)).status, 500); }
  finally { await h.db.exec('DROP TRIGGER interrupt_slack_run'); }
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?').bind(listener.id, 'slack:synthetic-crank-interrupted').first()).n, 0, 'failed admission retains no claim that could suppress a provider retry');
  await h.restart();
  assert.equal((await sendEvent(interrupted)).status, 200);
  await until(async () => (await runs(h, listener)).length === 4, 'retried interrupted event');
  const retriedRun = (await runs(h, listener)).find(run => run.source_id === 'slack:synthetic-crank-interrupted');
  assert.equal((await settled(h, retriedRun.id)).status, 'succeeded');
  await h.restart();
  assert.equal((await sendEvent(interrupted)).status, 200);
  assert.equal((await runs(h, listener)).length, 4, 'restart and redelivery never repeat committed work');
  await until(async () => posts.length === listenerEffectsBefore + 4, 'one Slack effect for each admitted event');
  assert.deepEqual(posts.slice(listenerEffectsBefore).map(post => post.text).sort(), ['Ev1', 'synthetic-crank-concurrent', 'synthetic-crank-interrupted', 'synthetic-crank-older'].sort());

  await h.post(`workflows/${listener.id}/pause`);
  const paused = event('synthetic-crank-paused');
  await h.db.exec(`CREATE TRIGGER interrupt_slack_hold BEFORE INSERT ON crank_hold_items BEGIN SELECT RAISE(ABORT,'injected app hold interruption'); END;`);
  try { assert.equal((await sendEvent(paused)).status, 500); }
  finally { await h.db.exec('DROP TRIGGER interrupt_slack_hold'); }
  assert.equal((await h.get(`workflows/${listener.id}/holds`)).length, 0, 'failed hold and its event claim roll back together');
  await h.restart();
  assert.equal((await sendEvent(paused)).status, 200);
  assert.equal((await sendEvent(paused)).status, 200);
  const [hold] = await h.get(`workflows/${listener.id}/holds`);
  const held = await h.get('holds/' + hold.id);
  assert.equal(held.counts.held, 1);
  assert.equal(held.items[0].source_time, new Date(eventTime * 1000).toISOString());
  assert.equal((await runs(h, listener)).length, 4);
  await h.post(`workflows/${listener.id}/resume`);

  // An authority change inside admission cannot leave a run or event claim.
  const raced = event('synthetic-crank-revoked');
  await h.db.exec(`CREATE TRIGGER revoke_slack_during_admission AFTER INSERT ON crank_trigger_events WHEN NEW.dedup_key='slack:synthetic-crank-revoked' BEGIN UPDATE crank_connections SET status='revoked' WHERE id='${slack.id}'; END;`);
  try { assert.equal((await sendEvent(raced)).status, 409); }
  finally { await h.db.exec('DROP TRIGGER revoke_slack_during_admission'); }
  assert.equal((await runs(h, listener)).length, 4);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?').bind(listener.id, 'slack:synthetic-crank-revoked').first()).n, 0);
  await h.post(`connections/${slack.id}/revoke`);
  assert.equal((await sendEvent(raced)).status, 409, 'a still-valid signing secret never revives a revoked managed connection');
  assert.equal((await runs(h, listener)).length, 4);
  assert.equal(posts.length, listenerEffectsBefore + 4, 'failed admissions, holds and revoked deliveries produce no extra provider effect');

});

test('CONN-001: the catalog lists exact native operations and the coverage report classifies an inventory honestly', async () => {
  const catalog = await h.get('catalog');
  const slack = catalog.apps.find(a => a.app === 'slack');
  assert.ok(slack.actions.some(a => a.id === 'send_channel_message') && slack.searches.every(s => s.outcomes.includes('not found')));
  const report = await h.post('coverage', { items: [
    { app: 'Slack', operation: 'send_channel_message' }, { app: 'Slack', operation: 'archive_channel' }, { app: 'HubSpot', operation: 'create_contact' },
    { app: 'Webhooks', operation: 'catch_hook' }, { app: 'Formatter', operation: 'text.split' }, { app: 'Acme Partner Portal', operation: 'sync', public_api: 'partner' }, { app: 'Docs Tool', operation: 'create', public_api: 'openapi' }] });
  assert.deepEqual(report.items.map(i => i.status), ['native', 'agent-buildable', 'agent-buildable', 'native', 'native', 'blocked', 'agent-buildable']);
  const n8n = await h.post('coverage', { n8n: { name: 'Lead flow', nodes: [{ type: 'n8n-nodes-base.webhook' }, { type: 'n8n-nodes-base.if' }, { type: 'n8n-nodes-base.slack', parameters: { resource: 'message', operation: 'post' } }, { type: 'n8n-nodes-base.hubspot', parameters: { resource: 'contact', operation: 'upsert' } }] } });
  assert.deepEqual(n8n.items.map(i => i.status), ['native', 'native', 'native', 'agent-buildable']);
});

test('EXEC-002: two accounts progress independently through 429, backoff, permanent auth and exhausted read failures; attempts retain retry timing', async () => {
  const times = new Map(), sequences = new Map();
  fake.routes.set('retry.vendor.example', ({ headers, url }) => {
    const account = headers.authorization;
    const key = account + url.pathname + url.search, seen = sequences.get(key) ?? 0;
    sequences.set(key, seen + 1);
    times.set(key, [...(times.get(key) ?? []), Date.now()]);
    if (url.pathname === '/pages') return !url.searchParams.has('cursor') ? jsonResponse({ items: [{ id: 'order-1' }], next: 'second' })
      : seen === 0 ? jsonResponse({ error: 'temporary second-page outage' }, 503) : jsonResponse({ items: [{ id: 'order-2' }], next: null });
    if (url.pathname === '/always-unavailable') return jsonResponse({ error: 'maintenance' }, 503);
    if (url.pathname === '/long-wait') return jsonResponse({ error: 'quota exhausted' }, 429, { 'retry-after': '3601' });
    if (url.pathname === '/date-wait') return seen === 0 ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': new Date(Date.now() + 2500).toUTCString() }) : jsonResponse({ id: 'after-provider-date' });
    if (url.pathname === '/malformed-after') return seen === 0 ? jsonResponse({ error: 'unavailable' }, 503, { 'retry-after': 'later please' }) : jsonResponse({ id: 'after-backoff' });
    if (account === 'Bearer ' + slowToken) return seen === 0 ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' })
      : seen === 1 ? jsonResponse({ error: 'transient' }, 503) : jsonResponse({ error: 'invalid credentials' }, 401);
    return jsonResponse({ id: 'healthy-account' });
  });
  const [slowToken, healthyToken] = [fakeSecret('slow-account'), fakeSecret('healthy-account')];
  const accounts = await Promise.all([slowToken, healthyToken].map((token, i) => connection(h, { app: 'http', label: i ? 'Healthy supplier' : 'Throttled supplier', auth_kind: 'bearer', domains: ['retry.vendor.example'], secret: { token } })));
  const workflow = async (account, path) => publish(h, 'Retry policy ' + account.label + path, { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, connection_id: account.id, input: { url: 'https://retry.vendor.example' + path } }] });
  const slow = await workflow(accounts[0], '/records'), healthy = await workflow(accounts[1], '/records');
  const delayed = startRun(h, slow, {});
  await until(() => times.has('Bearer ' + slowToken + '/records'), 'throttled account first request');
  const good = await startRun(h, healthy, {});
  assert.equal(good.status, 'succeeded');
  assert.equal(sequences.get('Bearer ' + slowToken + '/records'), 1, 'another account completes while the first is in backoff');
  const bad = await delayed;
  assert.equal(bad.status, 'failed'); assert.equal(bad.error.category, 'auth');
  assert.deepEqual(bad.attempts.map(a => a.http_status), [429, 503, 401]);
  const at = times.get('Bearer ' + slowToken + '/records');
  assert.ok(at[1] - at[0] >= 1000, 'Retry-After is a lower bound');
  assert.ok(at[2] - at[1] >= 1000, 'a missing header uses growing backoff rather than zero');
  assert.ok(bad.attempts.slice(0, 2).every(a => a.retry_at && a.retry_reason));
  assert.ok(bad.attempts.slice(1).every((a, i) => Date.parse(a.started_at) >= Date.parse(bad.attempts[i].retry_at)));
  await h.restart(); await h.tick();
  assert.equal(sequences.get('Bearer ' + slowToken + '/records'), 3, 'permanent auth errors have no automatic redrive');

  const policy = (await h.get('catalog')).apps.find(a => a.app === 'slack').retry_policy;
  const exhausted = await startRun(h, await workflow(accounts[1], '/always-unavailable'), {});
  assert.equal(exhausted.status, 'failed'); assert.equal(exhausted.attempts.length, policy.read_attempts);
  assert.equal(exhausted.error.exhausted, true); assert.ok(exhausted.error.next_owner_action);
  const gaps = exhausted.attempts.slice(0, 2).map(a => Date.parse(a.retry_at) - Date.parse(a.finished_at));
  assert.ok(gaps[0] > 0 && gaps[1] > gaps[0], 'growing backoff schedules are visible in attempts');
  const deadline = await startRun(h, await workflow(accounts[1], '/long-wait'), {});
  assert.equal(deadline.error.category, 'rate_limit'); assert.equal(deadline.error.exhausted, true);
  assert.equal(deadline.attempts.length, 1); assert.ok(Date.parse(deadline.attempts[0].retry_at) - Date.parse(deadline.attempts[0].finished_at) >= 3601000, 'the one-hour wait budget ends without capping Retry-After to an earlier send');
  for (const path of ['/date-wait', '/malformed-after']) {
    const result = await startRun(h, await workflow(accounts[1], path), {});
    assert.equal(result.status, 'succeeded'); assert.equal(result.attempts.length, 2);
    assert.ok(Date.parse(result.attempts[1].started_at) >= Date.parse(result.attempts[0].retry_at));
  }
  const paged = await publish(h, 'Retry a later inventory page', { trigger: { type: 'manual' }, steps: [
    { id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, connection_id: accounts[1].id, input: { url: 'https://retry.vendor.example/pages' }, pagination: { kind: 'cursor', items_path: 'items', cursor_path: 'next', max_pages: 2 } },
  ] });
  const pages = await startRun(h, paged, {});
  assert.equal(pages.status, 'succeeded'); assert.deepEqual(stepOf(pages, 'read').output.items, [{ id: 'order-1' }, { id: 'order-2' }]);
  assert.deepEqual(pages.attempts.map(a => a.http_status), [200, 503, 200]);
  assert.ok(pages.attempts[1].retry_at); assert.ok(Date.parse(pages.attempts[2].started_at) >= Date.parse(pages.attempts[1].retry_at));
  const queue = (await h.get('reports/operations')).execution_queue;
  assert.equal(queue.runs.find(r => r.id === exhausted.id).state, 'dead_letter');
  assert.equal(queue.runs.find(r => r.id === deadline.id).state, 'dead_letter');
  await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
  const page = await h.send('/app/workflow-runs/' + exhausted.id, undefined, h.owner);
  assert.equal(page.status, 200); assert.ok(page.text.includes(exhausted.error.next_owner_action), 'exhaustion shows the owner the next action');
  for (const attempt of exhausted.attempts.filter(a => a.retry_at)) assert.ok(page.text.includes(`datetime="${attempt.retry_at}"`), 'attempt history shows the stored earliest retry instant');
});

test('EXEC-002: native Slack reads honor retry timing and account isolation; permanent auth and lost writes stop', async () => {
  const [slowToken, healthyToken] = [fakeSecret('slack-throttled'), fakeSecret('slack-healthy')];
  const times = new Map(); let writes = 0;
  fake.routes.set('slack.com', ({ url, body, headers }) => {
    const method = url.pathname.replace('/api/', ''), email = form(body).get('email');
    if (method === 'auth.test') return jsonResponse({ ok: true, team: 'Retry workspace', user: 'crankbot' });
    if (method === 'chat.postMessage') {
      writes++;
      // The provider commits the effect, then the network drops its response.
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('provider response lost after commit')); } }));
    }
    const key = headers.authorization + ':' + email, at = [...(times.get(key) ?? []), Date.now()];
    times.set(key, at);
    if (email === 'permanent@acme.example') return jsonResponse({ ok: false, error: 'token_revoked' });
    if (email === 'unavailable@acme.example') return new Response('temporary outage', { status: 503 });
    if (email === 'long-wait@acme.example') return jsonResponse({ ok: false, error: 'ratelimited' }, 200, { 'retry-after': '3601' });
    if (email === 'json-limit@acme.example' && at.length === 1) return jsonResponse({ ok: false, error: 'ratelimited' }, 200, { 'retry-after': '1' });
    if (headers.authorization === 'Bearer ' + slowToken) return at.length === 1 ? jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' })
      : at.length === 2 ? new Response('temporary outage', { status: 503 }) : jsonResponse({ ok: false, error: 'invalid_auth' });
    return jsonResponse({ ok: true, user: { id: 'UHEALTHY', name: 'healthy', profile: { email } } });
  });
  const accounts = await Promise.all([slowToken, healthyToken].map((token, i) => connection(h, { app: 'slack', label: i ? 'Healthy Slack' : 'Throttled Slack', auth_kind: 'bearer', scopes: ['users:read.email', 'chat:write'], secret: { token } })));
  assert.deepEqual(await h.post(`connections/${accounts[0].id}/test`), { ok: true, account: 'Retry workspace', user: 'crankbot' }, 'connection checks work without an execution ledger');
  const workflow = account => publish(h, account.label + ' lookup', { trigger: { type: 'manual' }, steps: [
    { id: 'who', type: 'slack.find_user_by_email', retry_policy: { base_delay_ms: 500 }, connection_id: account.id, input: { email: '{{trigger.input.email}}' } },
  ] });
  const [slow, healthy] = await Promise.all(accounts.map(workflow));
  const key = (token, email) => 'Bearer ' + token + ':' + email;
  const delayed = startRun(h, slow, { email: 'rep@acme.example' });
  await until(() => times.has(key(slowToken, 'rep@acme.example')), 'native Slack first throttled request');
  const good = await startRun(h, healthy, { email: 'rep@acme.example' });
  assert.equal(good.status, 'succeeded'); assert.equal(stepOf(good, 'who').output.record.id, 'UHEALTHY');
  assert.equal(times.get(key(slowToken, 'rep@acme.example')).length, 1, 'an independent connection progresses during native Slack backoff');
  const bad = await delayed;
  assert.equal(bad.status, 'failed'); assert.equal(bad.error.category, 'auth');
  assert.deepEqual(bad.attempts.map(a => a.http_status), [429, 503, 200]);
  assert.deepEqual(bad.attempts.map(a => a.error_category), ['rate_limit', 'provider', 'auth']);
  assert.deepEqual(bad.attempts.map(a => a.retry_number), [1, 2, 3]);
  assert.ok(bad.attempts.every(a => a.method === 'POST' && a.budget_started_at === bad.attempts[0].budget_started_at));
  const policy = (await h.get('catalog')).apps.find(a => a.app === 'slack').retry_policy;
  const at = times.get(key(slowToken, 'rep@acme.example'));
  assert.ok(at[1] - at[0] >= 1000, 'native Retry-After is a lower bound');
  assert.ok(at[2] - at[1] >= 500 * 2 ** (bad.attempts[1].retry_number - 1), 'a transient 503 uses growing backoff');
  assert.ok(bad.attempts.slice(0, 2).every(a => a.retry_at && a.retry_reason));
  assert.ok(bad.attempts.slice(1).every((a, i) => Date.parse(a.started_at) >= Date.parse(bad.attempts[i].retry_at)));

  const permanent = await startRun(h, healthy, { email: 'permanent@acme.example' });
  assert.equal(permanent.error.category, 'auth'); assert.equal(permanent.attempts.length, 1);
  assert.equal(times.get(key(healthyToken, 'permanent@acme.example')).length, 1, 'permanent Slack auth is never retried');
  const limited = await startRun(h, healthy, { email: 'json-limit@acme.example' });
  assert.equal(limited.status, 'succeeded'); assert.deepEqual(limited.attempts.map(a => a.http_status), [200, 200]);
  assert.equal(limited.attempts[0].error_category, 'rate_limit'); assert.ok(limited.attempts[0].retry_at);
  assert.ok(Date.parse(limited.attempts[1].started_at) >= Date.parse(limited.attempts[0].retry_at));
  const exhausted = await startRun(h, healthy, { email: 'unavailable@acme.example' });
  assert.equal(exhausted.error.category, 'provider'); assert.equal(exhausted.error.exhausted, true);
  assert.equal(exhausted.attempts.length, policy.read_attempts); assert.ok(exhausted.error.next_owner_action);
  const deadline = await startRun(h, healthy, { email: 'long-wait@acme.example' });
  assert.equal(deadline.error.category, 'rate_limit'); assert.equal(deadline.error.exhausted, true); assert.equal(deadline.attempts.length, 1);
  assert.ok(Date.parse(deadline.attempts[0].retry_at) - Date.parse(deadline.attempts[0].finished_at) >= 3601000, 'native JSON throttling cannot dispatch early outside the budget');

  const posting = await publish(h, 'Uncertain native Slack post', { trigger: { type: 'manual' }, steps: [
    { id: 'post', type: 'slack.send_channel_message', connection_id: accounts[1].id, input: { channel: 'C01234567', text: 'Commit this once' } },
  ] });
  const uncertain = await startRun(h, posting, {});
  assert.equal(uncertain.status, 'uncertain', JSON.stringify(uncertain.error)); assert.equal(uncertain.error.category, 'uncertain');
  assert.equal(uncertain.attempts.length, 1); assert.equal(uncertain.attempts[0].error_category, 'network');
  assert.equal(uncertain.attempts[0].retry_at, null); assert.equal(writes, 1, 'a committed Slack write with a lost acknowledgement is never blindly retried');
  const queue = (await h.get('reports/operations')).execution_queue;
  assert.equal(queue.runs.find(r => r.id === exhausted.id).state, 'dead_letter');
  assert.equal(queue.runs.find(r => r.id === uncertain.id).state, 'dead_letter');
  const history = JSON.stringify([bad, good, limited, exhausted, deadline, uncertain]);
  for (const token of [slowToken, healthyToken]) assert.ok(!history.includes(token), 'native attempts do not retain credentials');
});

test('EXEC-002: executor loss during a retry wait retains the original request budget and earliest retry time', async () => {
  let calls = 0;
  fake.routes.set('restart-retry.example', () => { calls++; return jsonResponse({ error: 'temporary outage' }, 503, { 'retry-after': '2' }); });
  const workflow = await publish(h, 'Durable supplier retry', { trigger: { type: 'manual' }, steps: [
    { id: 'read', type: 'http', retry_policy: { base_delay_ms: 500 }, input: { url: 'https://restart-retry.example/inventory' } },
  ] });
  // Dispose the actual executor after it commits the first response and retry
  // deadline, before its timer fires. Only the provider edge is faked.
  const interrupted = startRun(h, workflow, {}).catch(() => null);
  const waiting = await until(async () => {
    const run = (await runs(h, workflow))[0];
    if (!run) return null;
    const detail = await h.get('workflow-runs/' + run.id);
    return detail.attempts[0]?.retry_at ? detail : null;
  }, 'persisted retry deadline');
  const budget = waiting.attempts[0].budget_started_at, due = waiting.attempts[0].retry_at;
  await h.restart(); await interrupted;
  assert.equal((await h.get('workflow-runs/' + waiting.id)).status, 'running', 'executor loss leaves a lease for Cron to reconcile');
  await h.tick(Date.now() + 6 * 60000);
  const finished = await h.get('workflow-runs/' + waiting.id);
  const maximum = (await h.get('catalog')).apps.find(a => a.app === 'webhooks').actions[0].retry_policy.read_attempts;
  assert.equal(finished.status, 'failed'); assert.equal(finished.error.exhausted, true);
  assert.equal(calls, maximum, 'executor loss does not buy another attempt budget');
  assert.equal(finished.attempts.length, maximum);
  assert.ok(finished.attempts.every(a => a.budget_started_at === budget));
  assert.ok(Date.parse(finished.attempts[1].started_at) >= Date.parse(due), 'restart cannot dispatch before the stored deadline');
});

test('Custom connector review, agent OpenAPI proposal and sandbox gates retain exact versions, scope refusals and signed duplicate-event proof', async () => {
  const {customDefinition,installDefinition,draftTest,customEventProof}=await import('./custom-fixture.mjs');
  const id='harbour-public-connector',body={id:'stock-24',quantity:24},matches=[{id:'stock-2',quantity:12},{id:'stock-1',quantity:24}];let requests=0,searchRows=matches,searchFailure=false;
  fake.routes.set('custom.example',({url})=>{requests++;if(url.pathname==='/search'){assert.equal(url.searchParams.get('query'),'oak');return searchFailure?jsonResponse({error:'invalid provider query'},400):jsonResponse(searchRows)}return jsonResponse(body)});
  const agent=await h.post('tokens',{label:'Connector preparation agent',scope:'agent'},h.owner,201);
  const openapi={openapi:'3.0.3',info:{title:'Harbour public stock API',version:'1'},servers:[{url:'https://custom.example'}],'x-crank-id':id,'x-crank-disclosure':customDefinition(id).disclosure,components:{securitySchemes:{stock:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'https://custom.example/token',scopes:{'records.read':'Read stock','scope.refused':'Read private notes'}}}}}},paths:{'/record':{get:{operationId:'record',summary:'Read stock',security:[{stock:['records.read']}],'x-crank-kind':'action',responses:{200:{description:'Current stock'}}}},'/notes':{get:{operationId:'notes',security:[{stock:['scope.refused']}],responses:{200:{description:'Private notes'}}}}}};
  const proposed=await h.post('custom-connectors/propose',{openapi},'',200,{authorization:'Bearer '+agent.token});
  const tool=await h.send('/api/crank/v1/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'propose_connector',arguments:{openapi}}},'',{authorization:'Bearer '+agent.token,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'});
  assert.equal(tool.status,200);assert.equal(tool.value.result.isError,false);assert.equal(tool.value.result.structuredContent.value.definition.id,id);
  assert.equal(proposed.requires_owner_review,true);assert.equal(proposed.definition.operations.length,2);
  assert.equal((await h.send('/api/crank/custom-connectors',{definition:proposed.definition,reviewed_digest:proposed.digest,granted_scopes:['records.read'],disclosure_confirmed:true},'',{authorization:'Bearer '+agent.token})).status,403);
  await h.get('custom-connectors','',403,{authorization:'Bearer '+agent.token});
  await h.get('gateways','',401);
  await h.post('custom-connectors',{definition:proposed.definition,reviewed_digest:'synthetic-crank-5',granted_scopes:['records.read'],disclosure_confirmed:true},h.owner,409);
  const openapiInstalled=await h.post('custom-connectors',{definition:proposed.definition,reviewed_digest:proposed.digest,granted_scopes:['records.read'],disclosure_confirmed:true},h.owner,201);
  assert.deepEqual(openapiInstalled.definition.operations.map(op=>op.id),['record']);
  await h.post('custom-connectors',{definition:proposed.definition,reviewed_digest:proposed.digest,granted_scopes:['records.read'],disclosure_confirmed:true},h.owner,409);
  await h.post('custom-connectors/propose',{openapi:{...openapi,servers:[{url:'https://169.254.169.254'}]}},h.owner,422);
  const structured={...openapi,paths:{'/unsafe':{get:{operationId:'unsafe',parameters:[{name:'payload',in:'query',schema:{type:'object'}}],responses:{200:{description:'unsafe'}}}}}};
  await h.post('custom-connectors/propose',{openapi:structured},h.owner,400);
  for(const [recipe,host,key,operation,expectedPath,envelope] of [
    ['servicenow_incidents','harbour.service-now.example','sys_id','get_incident','/api/now/table/incident/INC%200042',{result:{number:'INC0042',short_description:'Warehouse scanner'}}],
    ['sap_business_partners','harbour.sap.example','BusinessPartner','get_business_partner',"/sap/opu/odata/SAP/API_BUSINESS_PARTNER/A_BusinessPartner(BusinessPartner='O%27%27Neil')",{d:{BusinessPartner:"O'Neil",BusinessPartnerFullName:'Harbour Workshop'}}],
  ]) {
    const tenant='https://'+host,recipeInput={recipe,tenant_origin:tenant,id:'harbour-'+recipe,version:1,scopes:['records.read'],disclosure:{...customDefinition(id).disclosure,recipient:tenant,fields:[key,'selected record fields']}};
    const proposal=await h.post('custom-connectors/propose',recipeInput,'',200,{authorization:'Bearer '+agent.token});
    const connector=await h.post('custom-connectors',{definition:proposal.definition,reviewed_digest:proposal.digest,granted_scopes:['records.read'],disclosure_confirmed:true},h.owner,201);
    const credential=await connection(h,{app:'http',label:'Harbour '+recipe,auth_kind:'bearer',purpose:'test',domains:[host],scopes:['records.read'],secret:{token:'synthetic-crank-15'}});
    let called=0;fake.routes.set(host,({url,method,headers})=>{called++;assert.equal(url.pathname,expectedPath);assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer synthetic-crank-15');return jsonResponse(envelope)});
    const recipeStep={id:'enterprise',type:'custom.request',connector_id:connector.id,connector_version:1,operation,connection_id:credential.id,input:{[key]:recipe==='servicenow_incidents'?'INC 0042':"O'Neil"}};
    const readback=await draftTest(h,'Harbour reviewed '+recipe,[recipeStep],{},{[credential.id]:credential.id});assert.equal(readback.run.status,'succeeded',JSON.stringify(readback.run.error));assert.deepEqual(stepOf(readback.run,'enterprise').output.body,envelope);assert.equal(called,1);
    await h.post(`custom-connectors/${connector.id}/versions/1/revoke-scopes`,{scopes:['records.read']});
    const denied=await draftTest(h,'Harbour revoked '+recipe,[recipeStep],{},{[credential.id]:credential.id});assert.equal(denied.run.status,'failed');assert.equal(called,1);
    await h.post('custom-connectors/propose',{...recipeInput,tenant_origin:'https://127.0.0.1',disclosure:{...recipeInput.disclosure,recipient:'https://127.0.0.1'}},h.owner,422);
  }
  const definition=customDefinition('harbour-sandbox-gates'),searchOperation={id:'find_stock',name:'Find stock',kind:'search',method:'GET',path:'https://custom.example/search',scopes:['records.read'],inputs:{query:{type:'string',required:true,location:'query'}}};
  definition.operations.push(searchOperation);
  for(const operation of definition.operations.filter(op=>['scope_probe','refused'].includes(op.id))) Object.assign(operation,{...searchOperation,id:operation.id,scopes:operation.scopes});
  const installed=await installDefinition(h,definition);
  const account=await connection(h,{app:'http',label:'Harbour stock sandbox',auth_kind:'bearer',purpose:'test',domains:['custom.example'],scopes:['records.read','scope.probe'],secret:{token:'synthetic-crank-6'}});
  const step={id:'stock',type:'custom.request',connector_id:installed.id,connector_version:1,operation:'record',connection_id:account.id,input:{}};
  const search={...step,id:'lookup',operation:'find_stock',input:{query:'{{trigger.input.query}}'},sort:{field:'id',direction:'asc'}};
  const pending=await h.post('workflows',{name:'Stock production gate',graph:{trigger:{type:'manual'},steps:[step]}},h.owner,201);
  await h.post(`workflows/${pending.id}/publish`,{},h.owner,422);
  const read=await draftTest(h,'Stock readback',[step],{},{[account.id]:account.id});assert.equal(read.run.status,'succeeded');
  const searched=await draftTest(h,'Custom search sandbox readback',[{...search,multi_match:'all'}],{query:'oak'},{[account.id]:account.id});assert.equal(searched.run.status,'succeeded');assert.deepEqual(stepOf(searched.run,'lookup').output.records,[matches[1],matches[0]]);
  const refusedBefore=requests,refusedSearch=await draftTest(h,'Refused search scope',[{...search,operation:'refused'}],{query:'oak'},{[account.id]:account.id});assert.equal(refusedSearch.run.status,'failed');assert.equal(stepOf(refusedSearch.run,'lookup').error.category,'auth');assert.equal(requests,refusedBefore,'A refused search scope prevents provider dispatch');
  const event=await customEventProof(h,installed);
  await h.post(`custom-connectors/${installed.id}/versions/1/revoke-scopes`,{scopes:['scope.probe']});
  const before=requests,revoked=await draftTest(h,'Revoked custom search scope',[{...search,operation:'scope_probe'}],{query:'oak'},{[account.id]:account.id});assert.equal(revoked.run.status,'failed');assert.equal(stepOf(revoked.run,'lookup').error.custom_scope,true);assert.equal(requests,before);
  const receipt={readbacks:[{run_id:read.run.id,step_id:'stock',path:'body',equals:body},{run_id:searched.run.id,step_id:'lookup',path:'records',equals:[matches[1],matches[0]]}],duplicate_run_id:event.run.id,revoked_run_id:revoked.run.id};
  await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,{...receipt,readbacks:[{...receipt.readbacks[0],equals:{id:'wrong'}}]},h.owner,422);
  await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,{...receipt,duplicate_run_id:read.run.id},h.owner,422);
  const unknown=await draftTest(h,'Unknown operation cannot impersonate scope revocation',[{...step,operation:'unknown_operation'}],{},{[account.id]:account.id});
  await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,{...receipt,revoked_run_id:unknown.run.id},h.owner,422);
  const ready=await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,receipt);assert.equal(ready.status,'ready');
  await h.post(`workflows/${pending.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner test sandbox; no network charges'}))}});
  await h.post(`workflows/${pending.id}/publish`,{},h.owner,201);
  assert.deepEqual(stepOf(await startRun(h,pending,{}),'stock').output.body,body);
  const afterSearch={id:'after',type:'map',input:{outcome:'{{steps.lookup.outcome}}'}},searchFlow=(name,settings,tail=[afterSearch])=>publish(h,name,{trigger:{type:'manual'},steps:[{...search,...settings},...tail]});
  const [missingContinue,missingHalt,firstMatch,stopMultiple,allMatches]=await Promise.all([
    searchFlow('Custom search missing continues',{no_match:'continue'}),searchFlow('Custom search missing halts',{no_match:'halt'}),
    searchFlow('Custom search first is sorted',{multi_match:'first'}),searchFlow('Custom search multiple stops',{multi_match:'stop'}),
    searchFlow('Custom search all feeds a loop',{multi_match:'all'},[{id:'each',type:'loop',max_items:10,concurrency:2,order:'input',empty:'allow',item_errors:'stop',input:{items:'{{steps.lookup.records}}'},result:'{{steps.seen.id}}',steps:[{id:'seen',type:'map',input:{id:'{{item.id}}'}}]}]),
  ]);
  searchRows=[];
  const continued=await startRun(h,missingContinue,{query:'oak'});assert.equal(continued.status,'succeeded');assert.equal(stepOf(continued,'lookup').output.outcome,'not found');assert.equal(stepOf(continued,'after').output.outcome,'not found');
  const halted=await startRun(h,missingHalt,{query:'oak'});assert.equal(halted.status,'stopped_by_search');assert.equal(stepOf(halted,'lookup').output.outcome,'not found');assert.equal(stepOf(halted,'after'),undefined);
  searchRows=matches;
  for(const rows of [matches,[...matches].reverse()]) {searchRows=rows;const first=await startRun(h,firstMatch,{query:'oak'});assert.equal(first.status,'succeeded');assert.deepEqual(stepOf(first,'lookup').output.record,matches[1]);assert.equal(stepOf(first,'lookup').output.count,2)}
  const multiple=await startRun(h,stopMultiple,{query:'oak'});assert.equal(multiple.status,'stopped_by_search');assert.equal(stepOf(multiple,'lookup').output.outcome,'multiple matches');assert.equal(stepOf(multiple,'after'),undefined);
  searchRows=matches;
  const all=await startRun(h,allMatches,{query:'oak'});assert.equal(all.status,'succeeded');assert.deepEqual(stepOf(all,'lookup').output.records,[matches[1],matches[0]]);assert.deepEqual(stepOf(all,'each').output.results,['stock-1','stock-2']);
  const boundedMatches=await searchFlow('Custom search exposes a declared bound',{multi_match:'all',limit:1},[{id:'route',type:'paths',mode:'exclusive',branches:[{id:'bounded',when:[[{field:'steps.lookup.outcome',op:'text.equals',value:'truncated'}]],steps:[]}],fallback:{steps:[]}}]);
  const bounded=await startRun(h,boundedMatches,{query:'oak'});assert.equal(bounded.status,'succeeded');
  assert.equal(stepOf(bounded,'lookup').output.outcome,'truncated');assert.equal(stepOf(bounded,'lookup').output.count,1);assert.equal(stepOf(bounded,'lookup').output.truncated,true);
  assert.deepEqual(stepOf(bounded,'lookup').output.records,[matches[1]]);assert.deepEqual(stepOf(bounded,'route').output.matched,['bounded']);
  searchRows={rows:[matches[0]],complete:false};
  const incomplete=await startRun(h,firstMatch,{query:'oak'});assert.equal(incomplete.status,'failed');assert.equal(incomplete.error.outcome,'search incomplete');assert.equal(stepOf(incomplete,'after'),undefined);
  const singlePartial=await startRun(h,allMatches,{query:'oak'});assert.equal(singlePartial.status,'succeeded');assert.equal(stepOf(singlePartial,'lookup').output.outcome,'truncated');assert.equal(stepOf(singlePartial,'lookup').output.truncated,true);assert.deepEqual(stepOf(singlePartial,'each').output.results,['stock-2']);
  searchRows={rows:[],truncated:true};
  const incompleteEmpty=await startRun(h,missingContinue,{query:'oak'});assert.equal(incompleteEmpty.status,'failed');assert.equal(incompleteEmpty.error.category,'provider');assert.equal(stepOf(incompleteEmpty,'after'),undefined);
  searchRows=matches;
  searchFailure=true;
  const failed=await startRun(h,missingContinue,{query:'oak'});assert.equal(failed.status,'failed');assert.equal(failed.error.category,'provider');assert.equal(stepOf(failed,'lookup').output?.outcome,undefined);assert.equal(stepOf(failed,'after'),undefined,'Provider failure never follows the not-found continuation');
  searchFailure=false;
  for(const query of ['   ',42]) {const beforeInvalid=requests,invalid=await startRun(h,missingContinue,{query});assert.equal(invalid.status,'failed');assert.equal(invalid.error.category,'validation');assert.equal(requests,beforeInvalid,'Empty or wrongly typed search input prevents provider dispatch')}
  const v2=await installDefinition(h,{...customDefinition(installed.id),version:2});assert.equal(v2.status,'sandbox');
  const versions=await h.get('custom-connectors');assert.equal(versions.find(v=>v.id===installed.id&&v.version===1).status,'ready');
  let failures=0;fake.routes.set('custom.example',()=>++failures===1?jsonResponse({error:'sandbox read quota'},429,{'retry-after':'31'}):jsonResponse(body));
  const retryWorkflow=await publish(h,'Stock quota continuation',{trigger:{type:'manual'},steps:[step]});
  const parked=await startRun(h,retryWorkflow,{});assert.equal(parked.status,'waiting');assert.equal(parked.attempts[0].http_status,429);
  await h.restart();await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(parked.attempts[0].retry_at)-Date.now())+20));await h.tick();
  const resumed=await h.get('workflow-runs/'+parked.id);assert.equal(resumed.status,'succeeded');assert.equal(stepOf(resumed,'stock').operation_key,stepOf(parked,'stock').operation_key);assert.deepEqual(resumed.attempts.map(a=>a.http_status),[429,200]);assert.equal(resumed.attempts[0].budget_started_at,resumed.attempts[1].budget_started_at);
  fake.routes.set('custom.example',()=>jsonResponse(body));
  const disclosures=await h.get('data/flows');assert.equal(disclosures.flows.find(f=>f.id==='custom:'+installed.id+':1').purpose,installed.definition.disclosure.purpose);
  assert.equal(JSON.stringify(disclosures).includes('synthetic-crank-6'),false);
  await h.post(`custom-connectors/${installed.id}/versions/1/revoke`);
  const current=(await h.get('custom-connectors')).find(v=>v.id===installed.id&&v.version===1);
  await h.post(`custom-connectors/${installed.id}/versions/1/review`,{reviewed_digest:current.digest,disclosure_confirmed:true,granted_scopes:current.granted_scopes});
  await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,receipt,h.owner,422);
  assert.equal((await h.get('custom-connectors')).find(v=>v.id===installed.id&&v.version===1).status,'sandbox','Re-review requires fresh readback and duplicate-event proof');
  await h.post(`custom-connectors/${installed.id}/versions/1/revoke-scopes`,{scopes:['records.read']});
  const deniedBefore=fake.to('custom.example').length,deniedSearch=await draftTest(h,'Revoked stock search',[search],{query:'oak'},{[account.id]:account.id});assert.equal(deniedSearch.run.status,'failed');assert.equal(stepOf(deniedSearch.run,'lookup').error.custom_scope,true);assert.equal(fake.to('custom.example').length,deniedBefore);
  const pickers=await import('./custom-picker-fixture.mjs');
  await pickers.proveCustomPickers(h,account,agent,fake);
  await pickers.provePagedPickers(h,fake);
  const decisions=await h.get('audit');assert.ok(decisions.some(d=>d.action==='custom.owner_denied'&&d.detail.session_kind==='agent'));
});

test('Enrolled private gateway reads a real database, checkpoints file pages across restart, revokes dispatch and restores without gateway authority', async t => {
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{createServer}=await import('node:http'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{DatabaseSync}=await import('node:sqlite');
  const {customDefinition,installDefinition,draftTest}=await import('./custom-fixture.mjs');
  const dir=await mkdtemp(join(tmpdir(),'crank-private-gateway-')),statePath=join(dir,'state.json'),manifestPath=join(dir,'manifest.json'),cli=promisify(execFile),deliveries=[],results=[];
  let restored,tamperPoll=false;
  const bridge=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const headers={...req.headers};delete headers['content-length'];const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,body:raw});let value=await response.text();if(tamperPoll && req.url.endsWith('/poll') && response.ok){tamperPoll=false;const envelope=JSON.parse(value);envelope.signature='synthetic-crank-99';value=JSON.stringify(envelope)}if(req.url.endsWith('/poll') && response.ok){const task=pollPayload(value).task;if(task)deliveries.push(task)}if(req.url.endsWith('/result') && response.ok)results.push({path:req.url,input:JSON.parse(raw)});res.writeHead(response.status,{'content-type':'application/json'});res.end(value)}catch{res.writeHead(503);res.end('{}')}});
  t.after(async()=>{bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await restored?.close();await rm(dir,{recursive:true,force:true})});
  await new Promise(r=>bridge.listen(Number(new URL(h.origin).port),'127.0.0.1',r));
  const db=new DatabaseSync(join(dir,'inventory.sqlite'));db.exec("CREATE TABLE stock(name TEXT,quantity INTEGER); INSERT INTO stock VALUES ('Oak workbench',24),('Brass lamp',9)");db.close();
  await writeFile(join(dir,'stock-lines.txt'),'Oak workbench,24\nBrass lamp,9\nCedar shelf,12\nWalnut desk,6\nSteel cabinet,3\n');
  const connectorId='harbour-private-stock',installed=await installDefinition(h,customDefinition(connectorId,{gateway:true}));
  const manifest={version:1,operations:{stock:{type:'sqlite-query',connector_id:connectorId,connector_version:1,destination:'inventory-db',parameters:{name:{type:'string',maxLength:100}},database:'inventory.sqlite',query:'SELECT name,quantity FROM stock WHERE name=:name',maxRows:10},stock_probe:{type:'sqlite-query',connector_id:connectorId,connector_version:1,destination:'inventory-db',parameters:{name:{type:'string',maxLength:100}},database:'inventory.sqlite',query:'SELECT name,quantity FROM stock WHERE name=:name',maxRows:10},lines:{type:'file-lines',connector_id:connectorId,connector_version:1,destination:'inventory-files',parameters:{cursor:{type:'string',optional:true}},path:'stock-lines.txt',pageLines:2}}};
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  await assert.rejects(cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin','http://synthetic-crank-80.example','--code','synthetic-crank-81','--environment','production','--state',join(dir,'insecure-origin.json'),'--manifest',manifestPath],{timeout:20000}),e=>/HTTPS/.test(e.stderr),'The real outbound gateway refuses an unencrypted non-loopback Crank origin before enrollment');
  for(const type of ['postgres-query','mysql-query','sqlserver-query']){
    const unsafe=join(dir,type+'.json'),remote={...manifest.operations.stock,type,read_only_credentials:true,connection:{[type==='sqlserver-query'?'server':'host']:'127.0.0.1',port:9,database:'synthetic-crank-7',user:'synthetic-crank-8',password:'synthetic-crank-9'},query:'WITH removed AS (DELETE FROM stock RETURNING *) SELECT * FROM removed',parameter_order:['name']};
    await writeFile(unsafe,JSON.stringify(namedManifest({version:1,operations:{stock:remote}})),{mode:0o600});
    await assert.rejects(cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',h.origin,'--code','synthetic-crank-10','--environment','production','--state',join(dir,type+'-state.json'),'--manifest',unsafe],{timeout:20000}),e=>/read-only SELECT|Mutation|one supported/.test(e.stderr),'A mutation-bearing remote query is rejected before enrollment or any DB connection');
  }

  const unencrypted=join(dir,'unencrypted.json');await writeFile(unencrypted,JSON.stringify(namedManifest({version:1,operations:{stock:{...manifest.operations.stock,type:'postgres-query',read_only_credentials:true,connection:{host:'warehouse.synthetic.example',port:5432,database:'synthetic-crank-11',user:'synthetic-crank-12',password:'synthetic-crank-13',ssl:false},query:'SELECT name FROM stock WHERE name=$1',parameter_order:['name']}}})),{mode:0o600});
  await assert.rejects(cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',h.origin,'--code','synthetic-crank-14','--environment','production','--state',join(dir,'unencrypted-state.json'),'--manifest',unencrypted],{timeout:20000}),e=>/verified TLS/.test(e.stderr),'Credentials cannot leave the gateway over an unverified database connection');
  await nativeGatewayEnrollment(h,{label:'Unconfirmed enrollment',environment:'production'},403);
  await freshGatewayOwner(h);
  const expiredCode=await nativeGatewayEnrollment(h,{label:'Expired warehouse enrollment',environment:'production'},201);
  const {createHash,randomBytes}=await import('node:crypto');
  const persisted=await h.db.prepare('SELECT code_hash,code_expires_at FROM crank_gateways WHERE id=?').bind(expiredCode.gateway.id).first();
  assert.equal(persisted.code_hash,createHash('sha256').update(expiredCode.code).digest('hex'));assert.equal(Buffer.from(expiredCode.code,'base64url').byteLength,32);
  await h.db.prepare('UPDATE crank_gateways SET code_expires_at=? WHERE id=?').bind(new Date(Date.now()-1000).toISOString(),expiredCode.gateway.id).run();
  await assert.rejects(cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',h.origin,'--code',expiredCode.code,'--environment','production','--state',join(dir,'expired.json'),'--manifest',manifestPath],{timeout:20000}),e=>/HTTP 403/.test(e.stderr));
  assert.equal((await h.get('gateways')).gateways.find(g=>g.id===expiredCode.gateway.id).status,'revoked');
  const prepared=await h.post('tokens',{label:'Gateway preparation credential cannot enroll',scope:'agent'},h.owner,201);
  await h.post('gateways',{label:'Refused API enrollment',environment:'production'},'',403,{authorization:'Bearer '+prepared.token});
  await h.post('gateways',{label:'API cannot enroll even after email confirmation',environment:'production'},h.owner,403);
  await h.post('v1/gateways',{label:'Versioned API cannot enroll',environment:'production'},h.owner,403);
  const enrollment=await nativeGatewayEnrollment(h,{label:'Harbour workshop private inventory',environment:'production'},201),base=`gateways/${enrollment.gateway.id}`;
  await h.post('gateways/enroll',{code:enrollment.code,environment:'staging'},h.owner,403);
  await cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',h.origin,'--code',enrollment.code,'--environment','production','--state',statePath,'--manifest',manifestPath],{timeout:20000});
  await h.post('gateways/enroll',{code:enrollment.code,environment:'production'},h.owner,403);
  const state=JSON.parse(await readFile(statePath,'utf8')),headers={};
  await gatewayPost(h,state,base+'/poll',{environment:'staging'},403);
  const input={environment:'production'},path='/api/crank/'+base+'/poll';
  const {createIdentity}=await import('../gateways/node/identity.mjs');
  await gatewayPost(h,state,base+'/poll',input,401,{privateKey:createIdentity().private_key});
  await gatewayPost(h,state,base+'/poll',input,401,{timestamp:Math.floor(Date.now()/1000)-301});
  const nonce=randomBytes(32).toString('base64url');
  assert.equal(pollPayload(await gatewayPost(h,state,base+'/poll',input,200,{nonce})).task,null);
  await gatewayPost(h,state,base+'/poll',input,401,{nonce});
  await h.post(base+'/poll',input,'',401,{authorization:'Bearer synthetic-crank-98'});

  await h.get(base+'/secrets','',401,headers);
  const grant=await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record','file','scope_probe'],destinations:manifestDestinations(manifest,manifestPath)},h.owner,201);
  const record={id:'stock',type:'custom.request',connector_id:connectorId,connector_version:1,operation:'record',gateway_id:state.gateway.id,environment:'production',input:{name:'Oak workbench'}},file={...record,id:'file',operation:'file',input:{}};
  const test=await draftTest(h,'Harbour private database and paginated stock file',[record,file]);assert.equal(test.run.status,'waiting');
  const work=()=>cli(process.execPath,['gateways/node/cli.mjs','work','--state',statePath,'--manifest',manifestPath,'--once'],{timeout:20000});
  await work();const duplicate=results[0];assert.ok(duplicate);assert.equal((await gatewayPost(h,state,duplicate.path,duplicate.input)).replayed,true);
  await h.tick();let progress=await h.get('workflow-runs/'+test.run.id);assert.equal(stepOf(progress,'stock').status,'succeeded');assert.deepEqual(stepOf(progress,'stock').output.body.rows,[{name:'Oak workbench',quantity:24}]);assert.equal(progress.status,'waiting');
  await work();await h.restart();await h.tick();assert.equal(deliveries.length,2,'restart consumes the saved first file page without dispatching it again');
  await work();await h.tick();await work();await h.tick();
  const done=await h.get('workflow-runs/'+test.run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));
  const lines=['Oak workbench,24','Brass lamp,9','Cedar shelf,12','Walnut desk,6','Steel cabinet,3'];assert.deepEqual(stepOf(done,'file').output.body,{items:lines,pages:3,complete:true});
  assert.equal(deliveries.length,4);assert.equal(new Set(deliveries.map(task=>task.id)).size,4);assert.equal(deliveries[1].input.cursor,undefined);assert.ok(deliveries[2].input.cursor);assert.ok(deliveries[3].input.cursor);
  const outsideManifest=structuredClone(manifest);outsideManifest.operations.stock.database='ungranted.sqlite';await writeFile(manifestPath,JSON.stringify(outsideManifest),{mode:0o600});
  const outside=await draftTest(h,'A local alias cannot widen its concrete destination grant',[record]);await work();
  const outsideDone=await h.get('workflow-runs/'+outside.run.id);assert.equal(outsideDone.status,'failed');assert.equal(stepOf(outsideDone,'stock').error.gateway_error_category,'operation_refused');
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  for(const patch of [{connector_version:2},{connector_operation:'file'}]) {
    const changedManifest=structuredClone(manifest);Object.assign(changedManifest.operations.stock,patch);await writeFile(manifestPath,JSON.stringify(changedManifest),{mode:0o600});
    const mismatch=await draftTest(h,'Host manifest cannot substitute an ungranted connector version or operation',[record]);await work();
    assert.equal(stepOf(await h.get('workflow-runs/'+mismatch.run.id),'stock').error.gateway_error_category,'operation_refused');
  }
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  await h.post(`gateways/grants/${grant.id}/revoke`);
  const restrictedGrant=await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record'],destinations:manifestDestinations({operations:{stock:manifest.operations.stock}},manifestPath)},h.owner,201);
  const operationRefused=await draftTest(h,'Crank refuses an operation absent from the owner grant',[file]);assert.equal(operationRefused.run.status,'failed');
  const pendingGrant=await draftTest(h,'Grant revocation withholds an already claimed private read',[record]);
  const pendingTask=pollPayload(await gatewayPost(h,state,base+'/poll',{environment:'production'})).task;assert.ok(pendingTask);
  await h.post(`gateways/grants/${restrictedGrant.id}/revoke`);
  await gatewayPost(h,state,`gateways/${state.gateway.id}/tasks/${pendingTask.id}/result`,{environment:'production',output:{rows:[]}},403);
  await h.tick();const grantStopped=await h.get('workflow-runs/'+pendingGrant.run.id);assert.equal(grantStopped.status,'failed');assert.match(grantStopped.error.message,/gateway revoked/);assert.equal(stepOf(grantStopped,'stock').output,null);
  await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record','file'],destinations:manifestDestinations({operations:{stock:manifest.operations.stock}},manifestPath)},h.owner,400); // Every selected operation needs its own reviewed concrete recipient.
  const destinationRefused=await draftTest(h,'Crank refuses a destination absent from the owner grant',[file]);assert.equal(destinationRefused.run.status,'failed');
  await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record','file','scope_probe'],destinations:manifestDestinations(manifest,manifestPath)},h.owner,201);
  const dnsId='synthetic-crank-dns-edge',dnsDefinition=customDefinition(dnsId,{gateway:true});dnsDefinition.operations=dnsDefinition.operations.filter(op=>op.id==='record');await installDefinition(h,dnsDefinition,['records.read']);
  const dnsHost='synthetic-crank-dns.example',dnsManifest=namedManifest({version:1,operations:{stock:{type:'postgres-query',connector_id:dnsId,connector_version:1,destination:'inventory-db',read_only_credentials:true,connection:{host:dnsHost,port:5432,database:'synthetic-crank-61',user:'synthetic-crank-62',password:'synthetic-crank-63',ssl:true},query:'SELECT name FROM stock WHERE name=$1',parameter_order:['name'],parameters:{name:{type:'string'}},maxRows:10}}});
  await h.post(base+'/grants',{environment:'production',connector_id:dnsId,connector_version:1,operations:['record'],destinations:manifestDestinations(dnsManifest,manifestPath)},h.owner,201);
  await writeFile(manifestPath,JSON.stringify(dnsManifest),{mode:0o600});
  const {pathToFileURL}=await import('node:url');
  for(const address of ['169.254.169.254','::ffff:169.254.169.254','fe80::1']) {
    const probing=await draftTest(h,'Hostile DNS answers cannot reach metadata',[{...record,connector_id:dnsId}]);
    await cli(process.execPath,['gateways/node/cli.mjs','work','--state',statePath,'--manifest',manifestPath,'--once'],{timeout:20000,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(join(process.cwd(),'tests/gateway-dns-edge.mjs')).href}`,CRANK_TEST_DNS_HOST:dnsHost,CRANK_TEST_DNS_ADDRESS:address}});
    const denied=await h.get('workflow-runs/'+probing.run.id);assert.equal(denied.status,'failed');assert.equal(stepOf(denied,'stock').error.gateway_error_category,'operation_refused','Gateway DNS resolution must refuse before creating a private socket');
  }
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const version2=customDefinition(connectorId,{gateway:true});version2.version=2;await installDefinition(h,version2);
  const ungranted=await draftTest(h,'A connector repair cannot reuse another version grant',[{...record,connector_version:2}]);assert.equal(ungranted.run.status,'failed');
  const before=deliveries.length,cross=await draftTest(h,'Staging cannot read production database',[{...record,environment:'staging'}]);assert.equal(cross.run.status,'failed');assert.equal(deliveries.length,before);
  await h.post(`custom-connectors/${connectorId}/versions/1/revoke-scopes`,{scopes:['scope.probe']});
  const revoked=await draftTest(h,'Scope revoked before any private dispatch',[{...record,operation:'scope_probe'}]);assert.equal(revoked.run.status,'failed');assert.equal(stepOf(revoked.run,'stock').error.custom_scope,true);
  const suite=await h.post(`custom-connectors/${connectorId}/versions/1/sandbox`,{readbacks:[{run_id:done.id,step_id:'stock',path:'body.rows',equals:[{name:'Oak workbench',quantity:24}]},{run_id:done.id,step_id:'file',path:'body.items',equals:lines}],revoked_run_id:revoked.run.id,duplicate_run_id:done.id});assert.equal(suite.status,'ready');
  const shared=await h.post('workflows',{name:'Harbour warehouse — delegated private inventory preparation',graph:{trigger:{type:'manual'},steps:[record,file]}},h.owner,201);
  const invitationBuilder=await h.send('/auth/invite',{email:'warehouse-builder@example.test',displayName:'Warehouse builder',role:'member'},h.owner);assert.equal(invitationBuilder.status,202,invitationBuilder.text);
  const builderLink=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
  const builder=await h.send('/auth/confirm',{token:new URL(builderLink).searchParams.get('token')});assert.equal(builder.status,303,builder.text);
  const people=await h.send('/auth/operators',undefined,h.owner),builderId=people.value.find(p=>p.displayName==='Warehouse builder').id;
  const share=connection_ids=>h.post('team/'+builderId,{role:'builder',workflow_ids:[shared.id],connection_ids});
  await share([]);await h.post(`workflows/${shared.id}/test`,{},builder.cookie,403);
  await share(['gateway:'+state.gateway.id]);
  await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record'],destinations:manifestDestinations({operations:{stock:manifest.operations.stock}},manifestPath)},builder.cookie,403);
  const builderRead=await h.post(`workflows/${shared.id}/test`,{},builder.cookie,201);assert.equal(builderRead.status,'waiting');
  for(let page=0;page<5;page++)await work();
  assert.equal((await h.get('workflow-runs/'+builderRead.id)).status,'succeeded');
  await h.post(`workflows/${shared.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-local private read acceptance'}))}});
  await h.post(`workflows/${shared.id}/publish`,{},builder.cookie,201);
  const interrupted=await h.post(`workflows/${shared.id}/test`,{},builder.cookie,201);
  const claimed=pollPayload(await gatewayPost(h,state,base+'/poll',{environment:'production'})).task;assert.ok(claimed);
  await share([]);
  const late=await h.send(`/api/crank/gateways/${state.gateway.id}/tasks/${claimed.id}/result`,{environment:'production',output:{rows:[]}},'',signedGatewayHeaders(state,`/api/crank/gateways/${state.gateway.id}/tasks/${claimed.id}/result`,{environment:'production',output:{rows:[]}}));
  assert.equal(late.status,403,late.text);
  await share(['gateway:'+state.gateway.id]);await h.restart();await h.tick();
  const stopped=await h.get('workflow-runs/'+interrupted.id);assert.equal(stopped.status,'paused');assert.equal(stepOf(stopped,'stock').output,null);
  const afterScopeEnd=results.length;await work();assert.equal(results.length,afterScopeEnd,'A later scope regrant cannot resume a frozen paused run');
  const scopedAccountInput={label:'Private inventory preparation',environment:'production',workflow_ids:[shared.id],connection_ids:[]};
  await h.post('service-accounts',scopedAccountInput,h.owner,403);
  const service=await h.post('service-accounts',{...scopedAccountInput,connection_ids:['gateway:'+state.gateway.id]},h.owner,201);
  await h.get('workflows/'+shared.id,'',200,{authorization:'Bearer '+service.token});
  await h.post(`workflows/${shared.id}/draft`,{graph:{trigger:{type:'manual'},steps:[{...record,gateway_id:'synthetic-crank-unshared'}]}},'',403,{authorization:'Bearer '+service.token});
  const productionSecret=await connection(h,{app:'http',label:'Production-only inventory credential',purpose:'test',environment:'production',auth_kind:'bearer',domains:['private-account.example'],secret:{token:'synthetic-crank-52'}});
  const stagingWorkflow=await h.post('workflows',{name:'Staging cannot read a production secret',environment:'staging',graph:{trigger:{type:'manual'},steps:[{id:'secret',type:'http',connection_id:productionSecret.id,input:{url:'https://private-account.example/read'}}]}},h.owner,201);
  const crossSecret=await h.post(`workflows/${stagingWorkflow.id}/test`,{bindings:{[productionSecret.id]:productionSecret.id}},h.owner,201);
  assert.equal(crossSecret.status,'failed');assert.equal(crossSecret.error.access_decision,'cross_environment');
  assert.ok((await h.get('audit')).some(a=>a.subject_id===crossSecret.id && a.action==='access.denied' && a.detail.reason_class==='cross_environment'));
  assert.equal(fake.to('private-account.example').length,0);
  const production=await publish(h,'Harbour production inventory pipeline',{trigger:{type:'manual'},steps:[record,file]});
  const waiting=await startRun(h,production,{});assert.equal(waiting.status,'waiting');
  const pendingResults=results.length;tamperPoll=true;
  await assert.rejects(work(),e=>/signature or installation binding/.test(e.stderr),'The real gateway must reject an unsigned or altered installation job');
  assert.equal(results.length,pendingResults,'An altered signed job cannot execute or return output');
  const dispatchedBeforeRevoke=deliveries.length;
  const invitation=await h.send('/auth/invite',{email:'warehouse-admin@example.test',displayName:'Warehouse administrator',role:'admin'},h.owner);assert.equal(invitation.status,202,invitation.text);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');const admin=await h.send('/auth/confirm',{token:new URL(link).searchParams.get('token')});assert.equal(admin.status,303,admin.text);
  const scopedAdmin=(await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.email==='warehouse-admin@example.test');
  await h.post('team/'+scopedAdmin.id,{role:'admin',workflow_ids:[production.id],connection_ids:['gateway:'+state.gateway.id]});
  await h.post(base+'/grants',{environment:'production',connector_id:connectorId,connector_version:1,operations:['record'],destinations:manifestDestinations({operations:{stock:manifest.operations.stock}},manifestPath)},admin.cookie,403);
  await h.post(base+'/revoke',{},admin.cookie);await h.tick();const refused=await h.get('workflow-runs/'+waiting.id);assert.equal(refused.status,'failed');assert.match(refused.error.message,/gateway revoked/);assert.equal(deliveries.length,dispatchedBeforeRevoke);assert.equal(stepOf(refused,'stock').output,null);
  await gatewayPost(h,state,`gateways/${state.gateway.id}/tasks/${deliveries.at(-1).id}/result`,{environment:'production',output:{rows:[{name:'Oak workbench',quantity:999}]}},401);
  await gatewayPost(h,state,base+'/poll',{environment:'production'},401);
  const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='gateway.environment_denied'&&a.detail.environment==='staging'));assert.ok(audit.some(a=>a.action==='gateway.code_expired'));assert.ok(audit.some(a=>a.action==='gateway.request_denied'&&a.detail.reason_class==='signature'));assert.ok(audit.some(a=>a.action==='gateway.dispatch_denied'&&a.detail.reason_class==='cross_environment'));
  const inventory=await h.get('data/flows'),disclosure=inventory.flows.find(f=>f.id===`custom:${connectorId}:1`);assert.match(disclosure.credentials,/credentials stay on the customer gateway/);assert.equal(JSON.stringify(inventory).includes('inventory.sqlite'),false);
  const exported=await h.send('/api/crank/data/export',{},h.owner);assert.equal(exported.status,200,exported.text);assert.equal(exported.text.includes(state.private_key),false);assert.equal(exported.text.includes(enrollment.code),false);assert.ok(!exported.text.includes(state.public_key),'Archives contain no gateway key');
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge});await restored.post('data/restore',{archive:exported.text,confirm:'RESTORE'});
  const imported=await restored.get('custom-connectors');assert.equal(imported.find(c=>c.id===connectorId && c.version===1).status,'needs_review');assert.equal(imported.find(c=>c.id===connectorId && c.version===1).sandbox,null);assert.ok((await restored.get('gateways')).gateways.every(g=>g.status==='revoked'));assert.ok((await restored.get('gateways')).grants.every(g=>g.status==='revoked'));
  assert.equal((await restored.get('workflows/'+production.id)).status,'paused');
  const importedVersion=imported.find(c=>c.id===connectorId && c.version===1);await restored.post(`custom-connectors/${connectorId}/versions/1/review`,{reviewed_digest:importedVersion.digest,disclosure_confirmed:true,granted_scopes:importedVersion.granted_scopes});assert.equal((await restored.get('custom-connectors')).find(c=>c.id===connectorId && c.version===1).status,'sandbox');assert.ok((await restored.get('gateways')).gateways.every(g=>g.status==='revoked'));assert.ok((await restored.get('gateways')).grants.every(g=>g.status==='revoked'));
  await restored.post(`custom-connectors/${connectorId}/versions/1/sandbox`,{readbacks:[{run_id:done.id,step_id:'stock',path:'body.rows',equals:[{name:'Oak workbench',quantity:24}]}],revoked_run_id:revoked.run.id,duplicate_run_id:done.id},restored.owner,422);
  await gatewayPost(restored,state,base+'/poll',{environment:'production'},401);
});


test('Private gateway read retries retain admission, inputs and budget across restart, recover automatically and stop at exhaustion',async()=>{
  const {privateRetryFixture}=await import('./private-retry-fixture.mjs');
  const isolated=await harness('http://127.0.0.1:9');let source;
  try {
    source=await privateRetryFixture(isolated,{retry_policy:{read_attempts:2,base_delay_ms:1}});
    const recovery=await source.start();await source.work();
    const waiting=await isolated.get('workflow-runs/'+recovery.run.id);assert.equal(waiting.status,'waiting',JSON.stringify(waiting.error));assert.equal(waiting.attempts.length,1);assert.equal(waiting.attempts[0].error_category,'network');
    await isolated.restart();source.ready();await source.work();
    const recovered=await isolated.get('workflow-runs/'+recovery.run.id);assert.equal(recovered.status,'succeeded',JSON.stringify(recovered.error));
    assert.deepEqual(stepOf(recovered,'stock').output.body,{rows:[{name:'Oak workbench',quantity:24}]});assert.equal(recovered.attempts.length,2);
    assert.equal(recovered.attempts[0].request_key,recovered.attempts[1].request_key);assert.equal(recovered.attempts[0].budget_started_at,recovered.attempts[1].budget_started_at);
    assert.deepEqual(recovered.attempts.map(a=>a.retry_number),[1,2]);assert.equal(source.arrivals.length,2);
    source.offline();const failing=await source.start();await source.work();await source.work();
    const exhausted=await isolated.get('workflow-runs/'+failing.run.id);assert.equal(exhausted.status,'failed');assert.equal(exhausted.error.exhausted,true);assert.ok(exhausted.error.next_owner_action);assert.equal(exhausted.attempts.length,2);
    const count=source.arrivals.length;await source.work();assert.equal(source.arrivals.length,count,'The gateway cannot send another request after the run exhausts its budget');
    const admissions=await isolated.db.prepare('SELECT COUNT(*) AS n FROM crank_request_admissions WHERE finished_at IS NULL AND expires_at>?').bind(Date.now()).first();assert.equal(admissions.n,0,'Completed attempts release their physical account slots');
  } finally {await source?.close();await isolated.close()}
});

test('Connection credentials are never resent past a redirect that leaves the API origin, from workflow steps or URL polls', async () => {
  const token = fakeSecret('trusted-bearer'), key = fakeSecret('trusted-key');
  fake.routes.set('api.trusted.example', ({ url }) => url.pathname === '/away' ? new Response(null, { status: 302, headers: { location: 'http://collector.example/capture' } })
    : url.pathname === '/plain' ? new Response(null, { status: 302, headers: { location: 'http://api.trusted.example/records' } })
    : url.pathname === '/renamed' ? new Response(null, { status: 301, headers: { location: '/records' } })
    : jsonResponse([{ id: 'r1' }]));
  fake.routes.set('collector.example', () => jsonResponse([{ id: 'captured' }]));
  const bearer = await connection(h, { app: 'http', label: 'Trusted bearer API', auth_kind: 'bearer', domains: ['api.trusted.example'], secret: { token } });
  const keyed = await connection(h, { app: 'http', label: 'Trusted key API', auth_kind: 'api_key', domains: ['api.trusted.example'], secret: { key, header: 'x-trusted-key' } });
  const read = (account, path) => publish(h, 'Trusted read ' + path, { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'http', connection_id: account.id, input: { url: 'https://api.trusted.example' + path } }] });
  const within = await startRun(h, await read(bearer, '/renamed'), {});
  assert.equal(within.status, 'succeeded', 'a redirect inside the API origin is still followed');
  for (const account of [bearer, keyed]) for (const path of ['/away', '/plain']) {
    const run = await startRun(h, await read(account, path), {});
    assert.equal(run.status, 'failed', `${account.label} ${path}`); assert.equal(run.error.category, 'egress');
  }
  const poll = await publish(h, 'Trusted poll', { trigger: { type: 'url_poll', url: 'https://api.trusted.example/away', items_path: '', connection_id: keyed.id, interval_minutes: 1, backfill: 'existing' }, steps: [] });
  await h.tick(Date.now() + 10 * 60000);
  assert.equal((await h.get(`workflows/${poll.id}/trigger`)).poll.last_status, 'error');
  assert.equal((await runs(h, poll)).length, 0);
  assert.deepEqual(fake.requests.filter(r => r.url.host === 'collector.example' || r.url.protocol === 'http:' && r.url.host === 'api.trusted.example').map(r => r.url.href), [], 'no credentialed request leaves the API origin or its HTTPS scheme');
});

test('Native financial effects reconcile after restart, continue once and require separate compensation approval', async () => {
  await quickbooksInputJourney();
  await quickbooksReconciliationJourney();
  const { quickbooksSearchJourney } = await import('./quickbooks-search-journey.mjs');
  await quickbooksSearchJourney();
});
test('Regulated Gusto handoffs retain obligations until exact provider agreement and scope consent', gustoHandoffJourney);

test('Invoice outcomes stay open after successful requests until granted repair and independent provider readback, with inactive complete reconciliation records', async () => {
  const { invoiceOutcomeJourney } = await import('./invoice-outcome-journey.mjs');
  await invoiceOutcomeJourney();
});


test('Managed Calendar creation reads back the exact event and reconciles response loss without repeating writes',async()=>{
 const {googleCalendarJourney}=await import('./google-calendar-journey.mjs');await googleCalendarJourney();
});

test('Native Nook delivery binds installation and conversation, retains one effect across lost acknowledgements and fences current authority', async () => {
  const {nookJourney}=await import('./nook-journey.mjs');
  await nookJourney();
});

test('Native Orbit deals preserve scoped lookup, conditional update and readback across loss, revocation and inactive custody', async () => {
 const {orbitJourney}=await import('./orbit-journey.mjs');await orbitJourney();
});

test('Native Orbit snapshots admit watched deal changes and new records once, retaining pages and erasure fences', async () => {
 const {orbitPollJourney}=await import('./orbit-journey.mjs');await orbitPollJourney();
});

test('Private custom find or create retains exact approval, key ownership and accountable readback',async()=>{
  const {customSearchJourney}=await import('./custom-search-journey.mjs');await customSearchJourney();
});
