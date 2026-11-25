import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {publish} from './kit.mjs';

test('Hosted sign-in routes through the configured provider or uses a one-time owner link with mail off', async () => {
  for (const provider of ['rer', 'resend', 'sendgrid', 'cloudflare']) {
    const deliveries = [];
    const relay = 'https://mail.example.test/installations/crank';
    const endpoints = {rer: relay, sendgrid: 'https://api.sendgrid.com/v3/mail/send', cloudflare: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`};
    const h = await harness('https://receiver.example.test', {
      bindings: {MAIL_PROVIDER: provider, MAIL_API_KEY: 'synthetic-crank-1', MAIL_RELAY_URL: relay, MAIL_ACCOUNT_ID: 'a'.repeat(32)},
      edge: async request => {
        assert.equal(request.url, endpoints[provider]);
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.get('authorization'), 'Bearer synthetic-crank-1');
        deliveries.push(await request.json());
        return new Response(JSON.stringify(provider === 'cloudflare' ? {success: true, errors: [], result: {message_id: 'synthetic-crank-2', delivered: [], queued: ['owner@example.test'], permanent_bounces: []}} : {messageId: '<synthetic-crank-2@mail.example.test>'}), {status: provider === 'cloudflare' ? 200 : 202, headers: {'content-type': 'application/json'}});
      },
    });
    try {
      const sent = await h.send('/auth/magic-link', {email: 'owner@example.test'});
      assert.equal(sent.status, 202, `${provider}: ${sent.text}`);
      const body = provider === 'resend' ? h.mail.at(-1) : deliveries.at(-1);
      assert.ok(body, `${provider} received the sign-in message`);
      if (provider === 'rer') {
        assert.equal(body.to, 'owner@example.test');
        assert.equal(body.from, undefined);
        assert.equal(body.installationId, undefined);
      }
      const html = provider === 'sendgrid' ? body.content.find(part => part.type === 'text/html').value : body.html;
      const link = new URL(html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'));
      assert.equal(link.origin, h.origin);
      const confirmed = await h.send('/auth/confirm', {token: link.searchParams.get('token')});
      assert.equal(confirmed.status, 303, confirmed.text);
      const session = await h.send('/auth/session', undefined, confirmed.cookie);
      assert.equal(session.status, 200);
      assert.equal(session.value.operator.email, 'owner@example.test');
    } finally { await h.close(); }
  }
  let requested = false;
  const h = await harness('https://receiver.example.test', {
    bindings: {MAIL_PROVIDER: 'rer', MAIL_API_KEY: 'synthetic-crank-1'},
    edge: async () => { requested = true; throw Error('Unconfigured relay must not send'); },
  });
  try {
    const sent = await h.send('/auth/magic-link', {email: 'owner@example.test'});
    assert.equal(sent.status, 503);
    assert.equal(requested, false);
    assert.equal(h.mail.length, 0);
  } finally { await h.close(); }
  await mailOffJourney();
});

async function mailOffJourney() {
  const outbound = [];
  const h = await harness('https://receiver.example.test', {
    bindings: {MAIL_PROVIDER: 'none', MAIL_FROM: '', MAIL_API_KEY: ''},
    edge: async request => { outbound.push(new URL(request.url).hostname); return Response.error(); },
  });
  try {
    assert.equal((await h.send('/health')).status, 200);
    const signIn = await h.send('/signin');
    assert.equal(signIn.status, 200);
    assert.doesNotMatch(signIn.text, /action="\/auth\/magic-link"/);
    const refused = await h.send('/auth/magic-link', {email: 'owner@example.test'});
    assert.equal(refused.status, 503);
    assert.equal(refused.value.error, 'mail_unavailable');

    // Stand in for the Cloudflare D1 write made by `rer signin`.
    const token = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update('owner-signin\0' + token).digest('hex');
    const now = Date.now();
    await h.db.prepare(`INSERT INTO oa_owner_signins(id,token_hash,operator_id,operator_version,created_at,expires_at)
      SELECT ?,?,id,version,?,? FROM oa_operators WHERE role='owner' AND status='active'`).bind(randomUUID(), digest, now, now + 60000).run();
    assert.equal((await h.send('/auth/owner-signin?token=' + token)).status, 200);
    const confirmed = await h.send('/auth/owner-signin', {token});
    assert.equal(confirmed.status, 303);
    assert.equal((await h.send('/auth/session', undefined, confirmed.cookie)).value.operator.email, 'owner@example.test');
    assert.equal((await h.send('/auth/owner-signin', {token})).status, 400);

    const workflow = await publish(h, 'Harbor Workshop invoice approval', {trigger: {type: 'manual'},
      steps: [{id: 'review', type: 'approval', input: {invoice: 'INV-1042', amount: '95.00'}}]});
    const run = await h.post(`workflows/${workflow.id}/run`, {input: {}}, confirmed.cookie, 201);
    assert.equal(run.status, 'awaiting_approval');
    const deliveries = () => h.get(`notices/deliveries?run_id=${run.id}`, confirmed.cookie);
    const [notice] = await deliveries();
    assert.deepEqual({channel: notice.channel, state: notice.state, failure: notice.failure},
      {channel: 'email', state: 'suppressed', failure: 'mail_off'});
    await h.tick(Date.now() + 120000);
    assert.deepEqual(await deliveries(), [notice]);
    assert.deepEqual(outbound, []);
    assert.deepEqual(h.mail, []);
  } finally { await h.close(); }
}
