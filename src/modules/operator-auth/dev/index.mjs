import { rejectedResponse } from '../rejected-response.mjs';
// Local dev identity. SERVER-ONLY and LOCAL-ONLY: load this layer only from a
// local-only Worker entry (a `wrangler dev` or Vite-serve entry), never from the
// deployed main. `rer build` refuses any build output containing the marker.
import { configure } from '../config.mjs';
import { AuthStore } from '../accounts/store.mjs';
import { createOperatorAuth } from '../service.mjs';
import { AuthError } from '../errors.mjs';
import { hashToken, opaqueToken } from '../crypto.mjs';
import { readCookie, sessionCookie, isLoopbackHost, escapeHtml } from '../http.mjs';
import { safeReturnTo } from '../policy.mjs';
import { isActiveOperator, defaultRolePolicy } from '../accounts/roles.mjs';
import { devGate, devNotFound } from '../dev-gate.mjs';
import { registerDevAdmission } from '../dev-admission.mjs';
import { definePersonas } from './personas.mjs';
import { cliSession } from './cli-session.mjs';
import { decorateLabel } from '../../demo/label.mjs';
import { pageResponse } from '../page.mjs';

export const DEV_LAYER_MARKER = 'rer-dev-layer:local-only-never-deploy';
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'x-rer-dev-layer': DEV_LAYER_MARKER };
const text = (status, body) => new Response(body, { status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });

// RER Managed sets RER_INSTALLATION_ID with its management origin. Dev identity
// never runs inside such an installation, even one reached from this computer.
export function managedInstallation(env) {
  if (!env.RER_INSTALLATION_ID || !env.RER_MANAGEMENT_ORIGIN) return false;
  try { return !isLoopbackHost(new URL(env.RER_MANAGEMENT_ORIGIN).hostname); } catch { return true; }
}

/**
 * Wraps a seed's Worker with dev sign-in (`/auth/dev/enter?as=…`), the persona
 * list (`/__dev/personas`). Every identity surface needs the key
 * gate and answers 404 without it. `config(env)` is the seed's own AuthConfig
 * and `personas()` its devPersonas() declaration.
 */
export function withDevIdentity(worker, { bindings = env => env, config: authConfig, personas = () => [] }) {
  const declared = definePersonas(personas());
  return {
    ...worker,
    async fetch(request, original, execution) {
      const env = bindings(original);
      if (managedInstallation(env)) {
        // Never admit a dev credential here; with dev identity on, serve nothing.
        registerDevAdmission(null);
        if (env.RER_DEV_IDENTITY !== 'off') return rejectedResponse(request, text(503, 'Dev identity refuses to run beside RER_INSTALLATION_ID with a non-loopback RER_MANAGEMENT_ORIGIN. Remove those bindings from local settings or use rer dev --login.'));
        return new URL(request.url).pathname === '/auth/dev/enter' || new URL(request.url).pathname === '/__dev/personas' || new URL(request.url).pathname === '/auth/local/cli-session' ? rejectedResponse(request, devNotFound()) : worker.fetch(request, original, execution);
      }
      const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true' });
      registerDevAdmission(gate ? r => gate.admits(r) : null);
      const path = new URL(request.url).pathname;
      if (path === '/__dev/key') return gate ? gate.exchange(request) : devNotFound();
      if (path === '/signin' && gate && env.RER_DEV_IDENTITY !== 'off' && request.method === 'GET') {
        if (!await gate.admits(request)) return new Response(null, { status: 303, headers: { ...headers, location: '/__dev/key' } });
        const { config } = identity(env, authConfig, declared);
        const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));
        const href = `/auth/dev/enter?as=owner&returnTo=${encodeURIComponent(returnTo)}`;
        return decorateLabel(await pageResponse({ branding: config.branding, heading: 'Open your local app', content: `<a class="action" href="${escapeHtml(href)}">Continue as owner</a>` }), env.RER_DEMO === '1' ? 'Demo' : 'Dev');
      }
      if (path === '/auth/dev/enter' || path === '/__dev/personas' || path === '/auth/local/cli-session') {
        if (!gate || env.RER_DEV_IDENTITY === 'off' || (path !== '/auth/local/cli-session' && !await gate.admits(request))) return rejectedResponse(request, devNotFound());
        const context = identity(env, authConfig, declared);
        try {
          const response = path === '/auth/local/cli-session' ? await cliSession(request, context, headers) : path === '/__dev/personas' ? Response.json(await context.list(), { headers }) : await enter(request, gate, context);
          return rejectedResponse(request, response);
        } catch (error) {
          if (error instanceof AuthError) return rejectedResponse(request, Response.json({ error: error.code }, { status: error.status, headers }));
          throw error;
        }
      }
      const response = await worker.fetch(request, original, execution);
      if (!gate || request.method !== 'GET' || path.startsWith('/__dev/')) return response;
      return decorateLabel(response, env.RER_DEMO === '1' ? 'Demo' : 'Dev');
    },
  };
}

function identity(env, authConfig, declared) {
  const config = configure(authConfig(env)), store = new AuthStore(env.DB);
  const hash = token => hashToken(config.SESSION_SECRET, 'session', token);
  // The `owner` persona is the owner rer setup claimed while that owner is
  // active; after that owner has left, the earliest-created active owner; with
  // no active owner left, nobody (email null), so rer names who it signs in as.
  const owner = async () => {
    const setup = await store.byEmail(config.OWNER_EMAIL);
    if (setup?.role === 'owner' && isActiveOperator(setup, config.allowList)) return setup.email;
    const rows = (await store.statement(`SELECT email FROM oa_operators WHERE role='owner' AND status='active' ORDER BY created_at, id`).all()).results;
    return rows.find(row => isActiveOperator({ ...row, status: 'active' }, config.allowList))?.email ?? (setup ? null : config.OWNER_EMAIL);
  };
  const everyone = async () => [{ as: 'owner', email: await owner() }, ...declared];
  async function current(request) {
    const token = readCookie(request, config);
    if (!token) return null;
    const session = await store.session(await hash(token), Date.now());
    return session && isActiveOperator(session.operator, config.allowList) ? session : null;
  }
  return {
    config, store, hash, current, everyone,
    async ownerProof(request) {
      // Reuse the same persisted app-local proof guard as the administration
      // routes. This read-only guard never needs a mail sender or an IP budget.
      const auth = createOperatorAuth({ db: env.DB, config: authConfig(env), clientIp: () => null });
      const actor = await auth.requireStepUp(request, 'owner:transfer');
      if (!defaultRolePolicy({ actor: actor.operator, action: 'operators:invite', role: 'owner' })) throw new AuthError('forbidden', 403);
      return { ...actor, hash: await hash(readCookie(request, config)) };
    },
    list: async () => [...(await everyone()).map(({ as, email, role }) => ({ as, email, ...(role ? { role } : {}) })), { as: 'signed-out' }],
  };
}

async function enter(request, gate, { config, store, hash, current, everyone, ownerProof }) {
  if (request.method !== 'GET') return text(405, 'Method not allowed');
  const url = new URL(request.url), as = url.searchParams.get('as') ?? 'owner';
  const reply = new Headers(headers);
  // A harness presenting the key header also receives the browser cookie.
  if (!(request.headers.get('cookie') ?? '').includes(`${gate.cookieName}=`)) reply.append('set-cookie', await gate.setCookie());
  const existing = await current(request);
  if (as === 'signed-out') {
    const token = readCookie(request, config);
    if (token) await store.run('UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?', [Date.now(), await hash(token)]);
    reply.append('set-cookie', sessionCookie('', config, 0));
    reply.set('location', '/');
    return new Response(null, { status: 303, headers: reply });
  }
  const persona = (await everyone()).find(p => p.as === as);
  if (!persona) return devNotFound();
  if (!persona.email) return text(409, 'No active owner remains in this app. Sign in another way, or run rer reset --yes and rer setup for a new owner.');
  let operator = await store.byEmail(persona.email);
  // Personas are real operators, created only here, in local dev.
  if (!operator && persona.role) {
    if (persona.role === 'owner') {
      const actor = await ownerProof(request), now = Date.now(), id = crypto.randomUUID();
      const fence = store.actorFence(actor, now);
      const result = await store.first(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at)
        SELECT ?,?,?,'owner','active',? WHERE ${fence.sql} ON CONFLICT(email) DO NOTHING RETURNING id`,
        [id, persona.email, persona.displayName, now, ...fence.args]);
      if (result?.id !== id) throw new AuthError('authority_changed', 409);
    } else {
      await store.run(`INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES(?,?,?,?,'active',?) ON CONFLICT(email) DO NOTHING`,
        [crypto.randomUUID(), persona.email, persona.displayName, persona.role, Date.now()]);
    }
    operator = await store.byEmail(persona.email);
  }
  if (!operator) return text(409, 'The owner that rer setup claimed is not in this database. Run rer setup.');
  if (!isActiveOperator(operator, config.allowList)) return text(403, `${as} is not an active operator in this app.`);
  const domain = operator.email.slice(operator.email.lastIndexOf('@') + 1);
  if (operator.role !== 'owner' && await store.domainRule(domain)) return text(403, 'Sign-in refused');
  if (existing?.kind !== 'dev' || existing.operator.id !== operator.id) {
    const token = opaqueToken(), session = { id: crypto.randomUUID(), hash: await hash(token), expiresAt: Date.now() + config.sessionSeconds * 1000 };
    const issued = await store.issue({ operatorId: operator.id, expectedVersion: operator.version, session, now: Date.now(), kind: 'dev' });
    if (!issued) return text(409, 'The operator changed while signing in. Try again.');
    reply.append('set-cookie', sessionCookie(token, config, config.sessionSeconds));
  }
  reply.set('location', safeReturnTo(url.searchParams.get('returnTo')));
  return new Response(null, { status: 303, headers: reply });
}
