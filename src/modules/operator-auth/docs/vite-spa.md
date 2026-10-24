# Vite SPA adoption

Keep the auth module, D1 access, sender construction, and every credential in the
Worker's server entry. The browser imports no auth module and never receives
`OWNER_EMAIL`, `SESSION_SECRET`, `SETUP_TOKEN`, `MAIL_*`, D1 bindings, or raw
confirmation tokens. Serve the SPA and API from the same canonical origin so
its HTTP-only session cookie is sent naturally.

## Worker API

This Hono example uses the actual `createOperatorAuth` and
`createAuthHandler` entry points. `createMailSender` is the real IF-056 factory
from the selected `modules/mail/index.mjs`; production configuration must include
the provider's real server-side credentials.

```ts
// src/server.ts
import { Hono, type Context, type Next } from 'hono'
import { env } from 'cloudflare:workers'
import { createMailSender } from '../modules/mail/index.mjs'
import { createOperatorAuth, createAuthHandler, type Session } from '../modules/operator-auth/index.mjs'

const origin = 'https://app.example.com'
// Secrets are Worker secret bindings, never source text.
const { SESSION_SECRET, SETUP_TOKEN, MAIL_API_KEY: apiKey } = env
const mailSender = env.MAIL_PROVIDER && apiKey && env.MAIL_FROM
  ? createMailSender({
      provider: env.MAIL_PROVIDER,
      mode: 'production',
      apiKey,
      ...(env.MAIL_ACCOUNT_ID ? { accountId: env.MAIL_ACCOUNT_ID } : {}),
    })
  : undefined
const auth = createOperatorAuth({
  db: env.DB,
  config: {
    origin,
    OWNER_EMAIL: env.OWNER_EMAIL,
    SESSION_SECRET,
    SETUP_TOKEN,
    ...(env.MAIL_FROM ? { MAIL_FROM: env.MAIL_FROM } : {}),
  },
  mailSender,
  // This is trusted only because Cloudflare is the public Worker boundary.
  clientIp: (request) => request.headers.get('CF-Connecting-IP') ?? '',
})

const handleAuth = createAuthHandler(auth)
const app = new Hono<{ Variables: { operatorSession: Session } }>()

app.all('/auth/*', async (context) => {
  const response = await handleAuth(context.req.raw)
  return response ?? context.notFound()
})

const protectPrivate = async (context: Context<{ Variables: { operatorSession: Session } }>, next: Next) => {
  const session = await auth.getSession(context.req.raw)
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

export default { fetch: (request: Request) => app.fetch(request, env) }
```

Keep auth dispatch ahead of protected route matching so private unknown routes
are gated before their 404. For browser mutations, check exact Origin and
Fetch Metadata, validate input, and call `getSession(context.req.raw)` before
the product's real persistence operation.
`getSession(request)` must protect each private API request independently; a
client-side route guard or an earlier profile request does not authorize another
request.

When first-owner setup is pending, omit `mailSender` and `MAIL_FROM` from the
auth construction; bootstrap needs neither. Keep `SETUP_TOKEN` in the
server-only setup operation and invoke POST `/auth/bootstrap` there. Never embed
the token in the SPA bundle, form, or browser request. The endpoint creates no
product data, only the configured owner and its session. Remove the token binding
after verifying first-owner access.

## SPA sign-in and private requests

The sign-in page requests a link; it does not receive one. The public response is
uniform for unknown or disallowed addresses. The browser never gets the token
from the email and cannot consume a link through GET or HEAD: the confirmation
page posts its hidden value only when the operator presses Confirm.

```ts
export async function requestOperatorLink(email: string) {
  const response = await fetch('/auth/magic-link', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, returnTo: '/app' }),
  })
  if (response.status !== 202) throw new Error('Sign-in is unavailable; try again later.')
  return 'If this address is eligible, a sign-in link will arrive shortly.'
}

export async function loadOperatorProfile() {
  const response = await fetch('/api/private/profile', { credentials: 'same-origin' })
  if (response.status === 401) {
    window.location.assign('/signin')
    return null
  }
  if (!response.ok) throw new Error('The operator profile could not be loaded.')
  return response.json() as Promise<{ operator: { id: string; role: 'owner' | 'admin' | 'member' } }>
}
```

The same-origin cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production;
JavaScript does not read or write it. The auth handler enforces POST and exact
Origin for its mutations. The product's own state-changing APIs keep their
Origin/Fetch-Metadata checks too. Never use a client role or cached profile as
the server's authorization decision.

## Real sender outcomes and OIDC

Pass the actual `createMailSender` result directly to the auth core. An
`accepted` result records provider submission only. `rejected`, `rate_limited`,
`uncertain`, and production `development` results revoke the new link and become
`503 mail_unavailable`; there is no fallback or automatic retry. Resolve an
uncertain attempt before requesting another link.

Optional OIDC remains server-side: configure `config.providers` and an
independent `OIDC_TRANSACTION_SECRET` on `createOperatorAuth`;
`createAuthHandler` serves the provider routes. Preserve every `Set-Cookie`
header individually. See the [OIDC guide](../identity/oidc/README.md) for provider
configuration and trusted `subjectEmails` mappings. An existing issuer/subject binding may sign in again, while a
different principal cannot join an already-bound operator by presenting the same
verified email. Configure any subject-to-existing-email association from trusted
server configuration, never callback or browser input. Do not expose its
provider response, tokens or callback query string. The conformance suite's
optional provider-key-free case exercises only a first verified identity
admission into the shared native session store; the separate OIDC tests prove
the protocol.
