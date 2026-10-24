import assert from 'node:assert/strict';
import {test} from 'node:test';
import {harness} from './harness.mjs';

test('Hosted sign-in uses the selected mail provider and refuses an unconfigured relay', async () => {
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
});
