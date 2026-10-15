# TanStack Start adoption

Keep auth, D1, mail construction and Worker bindings in server-owned modules.
The client-importable server-function wrapper may be a normal `.ts` file, but
load true server modules dynamically inside each handler, following
[`TANSTACK-START-MIGRATION.md`](../../../TANSTACK-START-MIGRATION.md). A route's
parent session check protects its document; every child server function that
reads or changes private data must check the session again before its first
private operation.

## Build the server instance

The following server module keeps a fixed canonical origin, accepts the actual
Worker bindings, uses the selected IF-056 mail sender, and never exports auth
configuration to route data:

```ts
// src/core/platform/operator-auth.server.ts
import { createMailSender } from '../../../modules/mail/index.mjs'
import { createOperatorAuth, createAuthHandler } from '../../../modules/operator-auth/index.mjs'

const appOrigin = 'https://app.example.com'

export interface OperatorBindings {
  DB: D1Database
  OWNER_EMAIL: string
  SESSION_SECRET: string
  SETUP_TOKEN?: string
  MAIL_FROM?: string
  MAIL_PROVIDER?: 'sendgrid' | 'resend' | 'cloudflare'
  MAIL_API_KEY?: string
  MAIL_ACCOUNT_ID?: string
}

export function operatorAuth(bindings: OperatorBindings) {
  // Secrets are Worker secret bindings, never source text.
  const { SESSION_SECRET, SETUP_TOKEN, MAIL_API_KEY: apiKey } = bindings
  const mailSender = bindings.MAIL_PROVIDER && apiKey && bindings.MAIL_FROM
    ? createMailSender({
        provider: bindings.MAIL_PROVIDER,
        mode: 'production',
        apiKey,
        ...(bindings.MAIL_ACCOUNT_ID ? { accountId: bindings.MAIL_ACCOUNT_ID } : {}),
      })
    : undefined

  return createOperatorAuth({
    db: bindings.DB,
    config: {
      origin: appOrigin,
      OWNER_EMAIL: bindings.OWNER_EMAIL,
      SESSION_SECRET,
      ...(SETUP_TOKEN ? { SETUP_TOKEN } : {}),
      ...(bindings.MAIL_FROM ? { MAIL_FROM: bindings.MAIL_FROM } : {}),
    },
    mailSender,
    // Trust this header only when Cloudflare is the public Worker boundary.
    clientIp: (request) => request.headers.get('CF-Connecting-IP') ?? '',
  })
}

export function authHandler(bindings: OperatorBindings) {
  return createAuthHandler(operatorAuth(bindings))
}
```

The optional mail construction is solely for the first-owner period: bootstrap
does not need it, while link and invitation requests return `503 mail_unavailable`
until a real sender and `MAIL_FROM` are configured. It does not select a test or
alternate provider. On other hosting boundaries, replace the IP resolver with a
server-verified address source; never use caller-controlled `X-Forwarded-For`.

## Mount auth before private APIs and Start

Mount the HTTP handler in Hono before protected namespaces and before dispatching
to Start. Forward the returned `Response` unchanged so its status, redirect and
`Set-Cookie` are retained. If OIDC is enabled, invoke its handler first at its
own exact paths, then invoke this core handler.

```ts
// src/core/app/hono.ts
import { Hono, type Context, type Next } from 'hono'
import start from '@tanstack/react-start/server-entry'
import { authHandler, operatorAuth, type OperatorBindings } from '../platform/operator-auth.server'
import type { Session } from '../../../modules/operator-auth/index.mjs'

const app = new Hono<{ Bindings: OperatorBindings; Variables: { operatorSession: Session } }>()

app.all('/auth/*', async (context) => {
  const response = await authHandler(context.env)(context.req.raw)
  return response ?? context.notFound()
})

const protectPrivate = async (context: Context<{ Bindings: OperatorBindings; Variables: { operatorSession: Session } }>, next: Next) => {
  const session = await operatorAuth(context.env).getSession(context.req.raw)
  if (!session) return context.json({ error: 'unauthenticated' }, 401)
  context.set('operatorSession', session)
  await next()
}
app.use('/api/private', protectPrivate)
app.use('/api/private/*', protectPrivate)

app.get('/api/private/profile', (context) => {
  const session = context.get('operatorSession')
  return context.json({ operator: { id: session.operator.id, role: session.operator.role } })
})

// Add every existing Hono-owned API path to this explicit predicate.
// Keep queue, scheduled, email and named Worker exports on this Worker.
function isHonoRequest(pathname: string) {
  return pathname === '/auth' || pathname.startsWith('/auth/') ||
    pathname === '/api/private' || pathname.startsWith('/api/private/')
}

export default {
  fetch(request: Request, bindings: OperatorBindings, execution: ExecutionContext) {
    return isHonoRequest(new URL(request.url).pathname)
      ? app.fetch(request, bindings, execution)
      : start.fetch(request)
  },
}
```

For a private mutation, validate the application's normal exact-Origin and
Fetch-Metadata policy, validate the input, then call `getSession` on the actual
same-origin request before the first private read or write. The auth handler
already checks POST, exact configured Origin, Host, and Fetch Metadata for its
own mutation routes. Keep Start's default server-function CSRF middleware; if a
custom `src/start.ts` replaces it, preserve
`createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })`.

## Protect documents and server functions

Keep the wrapper importable from routes, then dynamically load auth and bindings
inside the handler. The code below follows the repository's pinned Start 1.168.50
pattern. `requestBindings()` is the product's existing server-only binding
accessor.

```ts
// src/core/app/loaders.ts
import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'

export const requireOperator = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ operatorAuth }, { requestBindings }, { getRequestHeader }] = await Promise.all([
    import('../platform/operator-auth.server'),
    import('../platform/bindings.server'),
    import('@tanstack/react-start/server'),
  ])
  const bindings = requestBindings()
  const auth = operatorAuth(bindings)
  const headers = new Headers({ cookie: getRequestHeader('cookie') ?? '' })
  const host = getRequestHeader('host')
  if (host) headers.set('host', host)
  const session = await auth.getSession(new Request('https://app.example.com/', { headers }))
  if (!session) throw redirect({ to: '/signin' })
  return { id: session.operator.id, email: session.operator.email, role: session.operator.role }
})

export const loadOperatorRoster = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ operatorAuth }, { requestBindings }, { getRequestHeader }] = await Promise.all([
    import('../platform/operator-auth.server'),
    import('../platform/bindings.server'),
    import('@tanstack/react-start/server'),
  ])
  const bindings = requestBindings()
  const auth = operatorAuth(bindings)
  const headers = new Headers({ cookie: getRequestHeader('cookie') ?? '' })
  const host = getRequestHeader('host')
  if (host) headers.set('host', host)
  const session = await auth.getSession(new Request('https://app.example.com/', { headers }))
  if (!session) throw redirect({ to: '/signin' })
  return auth.listOperators(new Request('https://app.example.com/', { headers }))
})
```

Replace the example origin and queue service with the product's fixed canonical
origin and real service. Never derive the configured origin from Host or forwarded
headers. Preserve the incoming Host header when available so the core can reject
an unexpected authority. Do not return `CompletedSession.cookie`, setup token,
mail configuration or D1 objects from a server function. Returning the small
operator record is safe; role checks still belong on each server-side action.

Mount `requireOperator()` at the private document boundary and call an equivalent
session check inside every private server-function handler. The roster example
then calls the module's real `listOperators` API, which applies its role policy
again. The browser-visible
generated RPC ID is not authorization; direct requests to a private server
function must reach the same session denial before any product data or mutation.

## One-time owner bootstrap

Provision `OWNER_EMAIL`, `SESSION_SECRET`, and `SETUP_TOKEN` in server bindings.
Generate independent high-entropy values (for example, two separate
`openssl rand -hex 32` invocations for the secrets). Keep `SETUP_TOKEN` out of
HTML, forms, `VITE_*`, and client RPC arguments. The owner-controlled setup
operation must invoke the actual POST `/auth/bootstrap` contract while keeping
the token in server-only input; it succeeds once, creates only the configured
owner and native session, and works with no mail sender. Verify the session, then
remove `SETUP_TOKEN`. A second setup call is rejected; changing the token does
not reset the bootstrap ledger. Do not seed an owner or demo product rows as a
side effect of a sign-in or OIDC request.

After setup, configure `MAIL_PROVIDER`, `MAIL_API_KEY`, optional Cloudflare
`MAIL_ACCOUNT_ID`, and `MAIL_FROM` as server bindings. IF-056 `accepted` means the
provider accepted the submission, not that the mailbox received it. `rejected`,
`rate_limited`, and `uncertain` results do not leave a usable auth link; callers
see a redacted `503`. Reconcile an uncertain send before deciding whether to
issue a new link. The auth module never retries or selects another sender.

## Optional local review

Enable `review:{enabled:true,operatorEmail}` only in a local review configuration
with an existing active operator. Bind the Worker to loopback. The issue request
must be POST with the exact local Origin and a matching literal loopback Host;
the cookie is local-only and each request is checked against the loopback
boundary. Forwarded headers do not make a public listener local. Disable review
in production and never create a fixture operator for it.
