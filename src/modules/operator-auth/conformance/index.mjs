import { checkConfirmation, checkMail } from './presentation.mjs';
const BASE_CONFIG = Object.freeze({
  origin: 'https://auth.conformance.test',
  OWNER_EMAIL: 'owner@example.test',
  SESSION_SECRET: 'example-conformance-session-secret-with-32-bytes',
  SETUP_TOKEN: 'example-conformance-owner-setup-token-with-32-bytes',
  MAIL_FROM: 'Operator Auth <auth@example.test>',
});

const MAIL_STATUSES = new Set(['accepted', 'rejected', 'uncertain']);

function fixture(adapter, overrides = {}) {
  const config = {
    ...BASE_CONFIG,
    ...(adapter.oidcIssuer ? { externalIssuers: [adapter.oidcIssuer] } : {}),
    ...(overrides.allowList ? { allowList: overrides.allowList } : {}),
    ...(overrides.ipLimit ? { ipLimit: overrides.ipLimit } : {}),
    ...(overrides.emailLimit ? { emailLimit: overrides.emailLimit } : {}),
  };
  if (overrides.localReview) {
    Object.assign(config, {
      origin: 'http://localhost:8787',
      local: true,
      review: { enabled: true, operatorEmail: config.OWNER_EMAIL },
    });
  }
  return {
    config,
    mailStatus: overrides.mailStatus ?? 'accepted',
    noMail: overrides.noMail ?? false,
  };
}

function cookie(response) {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected the auth response to set a session cookie.');
  return value.split(';', 1)[0];
}

function post(input, cookieValue, extra = {}) {
  return { method: 'POST', input, ...(cookieValue ? { cookie: cookieValue } : {}), ...extra };
}

async function bootstrap(runtime, config) {
  const response = await runtime.call('/auth/bootstrap', post({ token: config.SETUP_TOKEN, displayName: 'Conformance Owner' }));
  if (response.status !== 303) throw new Error(`Owner bootstrap returned ${response.status}: ${await response.clone().text()}`);
  return cookie(response);
}

async function capturedLink(runtime, index = -1) {
  const messages = await runtime.mails();
  const message = messages.at(index);
  if (!message) throw new Error('Expected the test-only mail adapter to capture a message.');
  const url = message.text.match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) throw new Error('The captured auth message has no confirmation URL.');
  return new URL(url);
}

async function confirmCaptured(runtime, index = -1) {
  const link = await capturedLink(runtime, index);
  const response = await runtime.call('/auth/confirm', post({ token: link.searchParams.get('token') }));
  return { link, response, cookie: response.status === 303 ? cookie(response) : null };
}

function requireRuntime(runtime) {
  for (const name of ['call', 'privateRequest', 'mails', 'close']) {
    if (typeof runtime?.[name] !== 'function') throw new TypeError(`Conformance runtime must provide ${name}().`);
  }
}

/**
 * Register black-box checks for a real operator-auth Worker and its native private API.
 * The adapter is test infrastructure: it must mount this module against disposable D1,
 * capture synthetic mail only, and route privateRequest through the consumer's real guard.
 */
export function registerOperatorAuthConformance({ test, adapter }) {
  if (typeof test !== 'function') throw new TypeError('A test registrar is required.');
  if (!adapter || typeof adapter.open !== 'function') throw new TypeError('A conformance runtime adapter is required.');
  if (adapter.oidcIssuer !== undefined && (typeof adapter.oidcIssuer !== 'string' || !adapter.oidcIssuer.startsWith('https://'))) {
    throw new TypeError('oidcIssuer must be the exact HTTPS issuer configured by the test adapter.');
  }
  if (adapter.confirmationFonts !== undefined && typeof adapter.confirmationFonts !== 'boolean') {
    throw new TypeError('confirmationFonts must be boolean.');
  }
  const { branding = {} } = adapter;
  if (typeof branding !== 'object' || Object.keys(branding).some(key => !['productName', 'theme'].includes(key))
    || (branding.productName !== undefined && typeof branding.productName !== 'string')
    || (branding.theme !== undefined && !/^\/(?!\/)[A-Za-z0-9._~/-]+\.css$/.test(branding.theme))) {
    throw new TypeError('branding declares only the consumer\'s productName and same-origin theme stylesheet.');
  }

  async function scenario(name, options, run) {
    test(name, async () => {
      const opened = fixture(adapter, options);
      const runtime = await adapter.open(opened);
      try {
        requireRuntime(runtime);
        await run(runtime, opened.config);
      } finally {
        if (typeof runtime?.close === 'function') await runtime.close();
      }
    });
  }

  scenario('bootstrap claims one owner without mail or product seed data', { noMail: true }, async (runtime, config) => {
    assertStatus(await runtime.call('/auth/bootstrap', post({ token: 'example-wrong-conformance-setup-token', displayName: 'Wrong Owner' })), 403);
    assertStatus(await runtime.privateRequest(), 401);
    if ((await runtime.mails()).length !== 0) throw new Error('Bootstrap must not invoke mail.');

    const ownerCookie = await bootstrap(runtime, config);
    const session = await json(await runtime.call('/auth/session', { cookie: ownerCookie }));
    equal(session.operator.email, config.OWNER_EMAIL, 'bootstrap owner email');
    equal(session.operator.role, 'owner', 'bootstrap owner role');
    equal(session.kind, 'native', 'bootstrap session kind');
    assertStatus(await runtime.privateRequest(ownerCookie), 200);
    assertStatus(await runtime.call('/auth/bootstrap', post({ token: config.SETUP_TOKEN, displayName: 'Second Owner' })), 409);
    const operators = await json(await runtime.call('/auth/operators', { cookie: ownerCookie }));
    equal(operators.length, 1, 'only the configured operator exists');
    equal((await runtime.mails()).length, 0, 'bootstrap remains mail-free');
  });

  scenario('magic-link preview is read-only; POST confirms once and keeps its stored returnTo', {}, async (runtime, config) => {
    const ownerCookie = await bootstrap(runtime, config);
    const issued = await runtime.call('/auth/magic-link', post({ email: config.OWNER_EMAIL, returnTo: '/app/queue?sort=week' }));
    assertStatus(issued, 202);
    const link = await capturedLink(runtime);
    const path = `${link.pathname}${link.search}`;

    for (const method of ['GET', 'HEAD']) {
      const preview = await runtime.call(path, { method });
      assertStatus(preview, 200);
      equal(preview.headers.get('set-cookie'), null, `${method} preview has no session cookie`);
    }
    const confirmed = await runtime.call('/auth/confirm', post({ token: link.searchParams.get('token'), returnTo: 'https://attacker.example/' }));
    assertStatus(confirmed, 303);
    equal(confirmed.headers.get('location'), '/app/queue?sort=week', 'confirmation uses the issued safe returnTo');
    const confirmedCookie = cookie(confirmed);
    const session = await json(await runtime.call('/auth/session', { cookie: confirmedCookie }));
    equal(session.operator.email, config.OWNER_EMAIL, 'link session owner');
    assertStatus(await runtime.call('/auth/confirm', post({ token: link.searchParams.get('token') })), 400);
    assertStatus(await runtime.privateRequest(confirmedCookie), 200);
    assertStatus(await runtime.privateRequest('operator_session_missing=invalid'), 401);
    if (!ownerCookie.startsWith('__Host-operator_session=')) throw new Error('Production auth cookie must use the frozen __Host name.');
  });

  scenario('confirmation and multipart mail share the consumer\'s public branding', {}, async (runtime, config) => {
      const owner = await bootstrap(runtime, config);
      const productName = branding.productName ?? 'your workspace';
      for (const kind of ['magic', 'invite']) {
        const response = await runtime.call(kind === 'magic' ? '/auth/magic-link' : '/auth/invite', post(kind === 'magic'
          ? { email: config.OWNER_EMAIL } : { email: 'presentation@example.test', displayName: 'Presentation' }, owner));
        assertStatus(response, 202);
        const link = await capturedLink(runtime);
        const token = link.searchParams.get('token');
        checkMail((await runtime.mails()).at(-1), { kind, productName, token });
        const path = `${link.pathname}${link.search}`;
        const preview = await runtime.call(path);
        const headers = [...preview.headers];
        await checkConfirmation(preview, { kind, productName, token, confirmationFonts: adapter.confirmationFonts === true, theme: branding.theme });
        const head = await runtime.call(path, { method: 'HEAD' });
        assertStatus(head, 200);
        equal(await head.text(), '', 'HEAD has no body');
        for (const name of ['content-security-policy', 'referrer-policy', 'content-type', 'cache-control']) {
          equal(head.headers.get(name), headers.find(([key]) => key === name)?.[1], 'HEAD presentation headers');
        }
        assertStatus(await runtime.call('/auth/confirm', post({ token })), 303);
        await checkConfirmation(await runtime.call(path), { productName, confirmationFonts: adapter.confirmationFonts === true, theme: branding.theme });
      }
  });

  scenario('default roles constrain administration and revoke sessions on role change and explicit revoke', {}, async (runtime, config) => {
    const ownerCookie = await bootstrap(runtime, config);
    const owner = await json(await runtime.call('/auth/session', { cookie: ownerCookie }));

    assertStatus(await runtime.call('/auth/invite', post({ email: 'admin@example.test', displayName: 'Admin', role: 'admin' }, ownerCookie)), 202);
    const adminJoin = await confirmCaptured(runtime);
    assertStatus(adminJoin.response, 303);
    const admin = await json(await runtime.call('/auth/session', { cookie: adminJoin.cookie }));
    equal(admin.operator.role, 'admin', 'invited admin role');
    assertStatus(await runtime.call('/auth/operators', { cookie: adminJoin.cookie }), 200);
    assertStatus(await runtime.call('/auth/confirm', post({ token: adminJoin.link.searchParams.get('token') })), 400);

    assertStatus(await runtime.call('/auth/operator/role', post({ operatorId: owner.operator.id, role: 'admin' }, adminJoin.cookie)), 403);
    assertStatus(await runtime.call('/auth/invite', post({ email: 'other-admin@example.test', displayName: 'Other Admin', role: 'admin' }, adminJoin.cookie)), 403);
    assertStatus(await runtime.call('/auth/invite', post({ email: 'member@example.test', displayName: 'Member' }, adminJoin.cookie)), 202);
    const staleMemberLink = await capturedLink(runtime);

    assertStatus(await runtime.call('/auth/operator/role', post({ operatorId: admin.operator.id, role: 'member' }, ownerCookie)), 200);
    assertStatus(await runtime.call('/auth/session', { cookie: adminJoin.cookie }), 401);
    assertStatus(await runtime.privateRequest(adminJoin.cookie), 401);
    assertStatus(await runtime.call('/auth/confirm', post({ token: staleMemberLink.searchParams.get('token') })), 400);

    assertStatus(await runtime.call('/auth/invite', post({ email: 'member@example.test', displayName: 'Member' }, ownerCookie)), 202);
    const memberJoin = await confirmCaptured(runtime);
    assertStatus(memberJoin.response, 303);
    const member = await json(await runtime.call('/auth/session', { cookie: memberJoin.cookie }));
    equal(member.operator.role, 'member', 'invitation default role');
    assertStatus(await runtime.call('/auth/operators', { cookie: memberJoin.cookie }), 403);
    assertStatus(await runtime.call('/auth/confirm', post({ token: memberJoin.link.searchParams.get('token') })), 400);

    const revoke = await runtime.call('/auth/session/revoke', post({ sessionId: member.id }, ownerCookie));
    assertStatus(revoke, 204);
    assertStatus(await runtime.call('/auth/session', { cookie: memberJoin.cookie }), 401);
    assertStatus(await runtime.privateRequest(memberJoin.cookie), 401);
    const sessions = await json(await runtime.call(`/auth/sessions?operatorId=${encodeURIComponent(member.operator.id)}`, { cookie: ownerCookie }));
    equal(sessions.some((session) => session.id === member.id && session.active === false), true, 'revoked session is visible only as inactive metadata');
  });

  scenario('allow-list masking and independent IP/email limits fail closed before mail', { allowList: ['owner@example.test'], ipLimit: 1, emailLimit: 1 }, async (runtime, config) => {
    await bootstrap(runtime, config);
    const blocked = await runtime.call('/auth/magic-link', post({ email: 'blocked@example.test' }, undefined, { ip: '192.0.2.20' }));
    assertStatus(blocked, 202);
    equal((await runtime.mails()).length, 0, 'disallowed address is masked and not mailed');

    const admitted = await runtime.call('/auth/magic-link', post({ email: config.OWNER_EMAIL }, undefined, { ip: '192.0.2.30' }));
    assertStatus(admitted, 202);
    const emailLimit = await runtime.call('/auth/magic-link', post({ email: config.OWNER_EMAIL }, undefined, { ip: '192.0.2.31' }));
    assertStatus(emailLimit, 429);
    const ipLimit = await runtime.call('/auth/magic-link', post({ email: 'another@example.test' }, undefined, { ip: '192.0.2.30' }));
    assertStatus(ipLimit, 429);
    equal((await runtime.mails()).length, 1, 'limited or disallowed requests do not send');
  });

  scenario('local review rejects forwarded-Host spoofing at issue and session admission', { localReview: true, noMail: true }, async (runtime, config) => {
    const ownerCookie = await bootstrap(runtime, config);
    for (const host of ['evil.test', 'localhost.evil.test', '127.0.0.2:8787']) {
      assertStatus(await runtime.call('/auth/review-session', post({}, ownerCookie, {
        headers: { Host: host, 'X-Forwarded-Host': 'localhost:8787', Forwarded: 'host=localhost:8787' },
      })), 403);
    }

    const issued = await runtime.call('/auth/review-session', post({ returnTo: '/app/review' }, ownerCookie));
    assertStatus(issued, 303);
    equal(issued.headers.get('location'), '/app/review', 'review session safe returnTo');
    const reviewCookie = cookie(issued);
    if (!reviewCookie.startsWith(`operator_session_local_${new URL(config.origin).port}=`)) throw new Error('Local review must use the local-only cookie name for its own port.');
    const reviewSession = await json(await runtime.call('/auth/session', { cookie: reviewCookie }));
    equal(reviewSession.kind, 'review', 'review session kind');
    assertStatus(await runtime.privateRequest(reviewCookie), 200);
    assertStatus(await runtime.call('/auth/session', { cookie: reviewCookie, headers: {
      Host: 'evil.test', 'X-Forwarded-Host': 'localhost:8787', Forwarded: 'host=localhost:8787',
    } }), 403);
    assertStatus(await runtime.privateRequest(reviewCookie, { headers: {
      Host: 'evil.test', 'X-Forwarded-Host': 'localhost:8787', Forwarded: 'host=localhost:8787',
    } }), 403);
    equal((await runtime.mails()).length, 0, 'local review has no mail side effect');
  });

  for (const mailStatus of MAIL_STATUSES) {
    scenario(`IF-056 ${mailStatus} mail result is handled explicitly`, { mailStatus }, async (runtime, config) => {
      await bootstrap(runtime, config);
      equal((await runtime.mails()).length, 0, 'owner bootstrap does not use the mail adapter');
      const response = await runtime.call('/auth/magic-link', post({ email: config.OWNER_EMAIL }));
      if (mailStatus === 'accepted') {
        assertStatus(response, 202);
        const link = await capturedLink(runtime);
        assertStatus(await runtime.call(`${link.pathname}${link.search}`), 200);
      } else {
        assertStatus(response, 503);
        equal((await json(response)).error, 'mail_unavailable', `${mailStatus} is not reported as accepted`);
        const link = await capturedLink(runtime);
        assertStatus(await runtime.call(`${link.pathname}${link.search}`), 400);
      }
      equal((await runtime.mails()).length, 1, 'test-only adapter captured exactly one attempted message');
    });
  }

  if (adapter.oidcIssuer) {
    scenario('optional verified OIDC admission shares native owner sessions without provider credentials', {}, async (runtime, config) => {
      if (typeof runtime.admitVerifiedIdentity !== 'function') {
        throw new TypeError('An adapter with oidcIssuer must implement test-only admitVerifiedIdentity().');
      }
      const ownerCookie = await bootstrap(runtime, config);
      assertStatus(await runtime.call('/auth/settings/identity', post({ idpSignIn: true }, ownerCookie)), 200);
      const completed = await runtime.admitVerifiedIdentity({
        issuer: adapter.oidcIssuer,
        subject: 'conformance-subject',
        email: config.OWNER_EMAIL,
        emailVerified: true,
      }, '/app/oidc');
      equal(completed.session.kind, 'oidc', 'OIDC admission uses the shared session table');
      equal(completed.returnTo, '/app/oidc', 'OIDC admission preserves safe returnTo');
      const session = await json(await runtime.call('/auth/session', { cookie: completed.cookie.split(';', 1)[0] }));
      equal(session.id, completed.session.id, 'OIDC and native endpoints read the same session');
      assertStatus(await runtime.privateRequest(completed.cookie.split(';', 1)[0]), 200);
    });
  }
}

async function json(response) {
  return response.json();
}

function assertStatus(response, expected) {
  if (response.status !== expected) throw new Error(`Expected HTTP ${expected}; received ${response.status}.`);
}

function equal(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
