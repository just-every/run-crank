# Signed owner claim

This optional server-only module lets an installation owner claim an adopted
application using a five-minute Run Edit Run signature. It calls the existing
`createOperatorAuth().bootstrap()` with the application's hidden setup token.
The owner never receives that token. An existing operator or bootstrap ledger
permanently prevents another claim, including after the consumed claim expires.

## Adopting this module

1. Copy `modules/owner-claim/` and `modules/operator-auth/` together as source;
   preserve their relative paths. Apply `operator-auth/accounts/schema/operator-auth.sql`
   to a fresh store, then `owner-claim/schema/owner-claim.sql`, each as a new
   numbered application migration. Preserve existing migrations and ledgers.
2. Provision an independent random `SESSION_SECRET` (32 random bytes or more)
   through trusted secret provisioning. The signed manifest names a required,
   hidden generated setup-token field; the platform creates and stores its value
   encrypted when the owner saves the plan. Map that field to the app's
   `SETUP_TOKEN` configuration. Keep both secrets server-side; never include
   either in browser bundles, claims or logs. The app's deployment configuration
   must also supply the trusted RER issuer, installation ID, exact application
   origin, canonical owner email and public signing-key ring. Claims are never a
   configuration source.
3. Mount this handler before the operator-auth dispatcher; it owns only
   `/auth/owner-claim`. Continue protecting application routes with real
   operator-auth sessions. Never expose a server function taking authConfig or
   verified payload fields from browser input.
4. Declare the release setup manifest's owner claim step with
   `type: 'owner-claim'`, `mode: 'signed'`, `emailField` naming the public
   owner-email setup field, `path: '/auth/owner-claim'`, and `tokenField` naming
   the private hidden setup-token field. Map the manifest field named by
   `emailField` to both `authConfig.OWNER_EMAIL` and
   `expectedEmail`; map the generated secret named by `tokenField` to
   `authConfig.SETUP_TOKEN`. Map deployment installation ID and application
   origin to `installationId` and `appOrigin`.
   Use only the exact field names accepted by your pinned SETUP schema.
   Declare signed mode only in a new release containing this handler/migration.
   Existing releases which accept only setup-token must keep legacy claim mode.
5. Include the module's tests in the application's CI. Re-run the real workerd
   tests on operator-auth updates; bootstrap SQL changes intentionally fail
   closed and need an explicit adapter review.

```js
import { createOwnerClaimHandler } from './modules/owner-claim/index.mjs';

// Map the manifest emailField to OWNER_EMAIL and tokenField to SETUP_TOKEN in
// trusted app config. The platform supplies the fixed issuer, installation,
// app-origin and public-key values below; never derive them from a request.
const appOrigin = env.RER_OWNER_CLAIM_APP_ORIGIN;
const ownerEmail = env.OWNER_EMAIL;
const claim = createOwnerClaimHandler({
  db: env.DB,
  authConfig: {
    origin: appOrigin, OWNER_EMAIL: ownerEmail,
    SESSION_SECRET: env['SESSION_SECRET'], SETUP_TOKEN: env['SETUP_TOKEN'],
  },
  clientIp: request => request.headers.get('CF-Connecting-IP') ?? '',
  issuer: env.RER_OWNER_CLAIM_ISSUER,
  installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID,
  appOrigin,
  expectedEmail: ownerEmail, // canonical lowercase configured email
  publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS),
});
const response = await claim(request); // null means another dispatcher owns it
```

Use an infrastructure-authenticated client IP. For explicit local development,
operator-auth supports `local:true` and literal loopback HTTP with a matching
Host; production origins are HTTPS. Missing configuration fails closed. Public
key rotation may overlap old and new kids for the five-minute window, then remove
the old kid. Public keys are EC/P-256 JWKs, never private JWKs; missing/unknown kids
and untrusted issuers fail. Config is snapshotted when the handler is created.
Remove the hidden setup token after successful bootstrap as part of ordinary
application secret maintenance; never delete either admission ledger.

## Wire and browser transport

`verifyOwnerClaim(token, config)` validates compact JWS ES256, a 64-byte P1363
signature, and an exact protected header `{alg:'ES256',typ:'rer-owner-claim+jwt',kid}`.
The exact payload fields are `{v:1,iss,aud,installationId,email,jti,iat,exp}`.
`aud` is the exact app origin; `iss` is the configured RER origin; `jti` is a UUID.
`iat` and `exp` are integer epoch seconds: issuance may be at most 30 seconds
ahead of the consumer clock, inclusive. Expiry must be strictly in the future
with no expiry tolerance; `exp` must exceed `iat` and their difference must be
at most 300 seconds. These time bounds are checked at verification and again
immediately before the atomic admission batch. Config fields are
`{issuer,installationId,appOrigin,expectedEmail,publicKeys,now?}`; `now` is optional
epoch seconds. The async verifier returns a frozen claim or throws
`OwnerClaimError`. The handler's optional `clock` returns milliseconds.

The installation screen opens the bare `/auth/owner-claim` page. Its confirmation
GET/HEAD writes zero and issues no cookie. The page sends
`{type:'rer-owner-claim-ready'}` to its opener at the configured issuer. The
installation checks the popup source and exact application origin before sending
`{type:'rer-owner-claim',token}` to that origin. The consumer accepts only that
opener and exact issuer, retains the token in its in-memory form, clears its
opener, and waits for the owner to press Claim your workspace. Native form POST
carries the token in the body and the exact Origin; its 303 supplies the existing
auth cookie and a safe local redirect. JSON POST accepts the same `token`, optional
`displayName` and `returnTo` fields. It accepts no email/config overrides.

Never place claims in URLs, fragments, history, browser storage, logs or durable
installation records. RER returns a token only in the authorized owner's response.
Query/fragment credentials and duplicate body fields are rejected. Every response
is no-store. Confirmation uses a nonce CSP and `strict-origin` Referrer-Policy so
native POST retains Origin; the URL never contains credentials. Browser opener
isolation policies must permit the initial cross-origin handshake; do not apply
COOP `same-origin` to these two cooperating screens.

## Atomic admission and checks

Operator-auth normally commits its client-IP rate limit before bootstrap. This
budget is per client, so wrong setup tokens from another client cannot block a
valid signed claim. A request-local D1 adapter reads the actual existing counter
and projects the real UPSERT result without writing. It defers that unchanged
UPSERT until the real bootstrap's unchanged three-statement batch. One D1
transaction inserts the single-use claim, checks an empty auth store, runs the
original limit and bootstrap SQL, then checks owner/session identity and the
actual client-IP threshold before committing.
A SQL CHECK failure or racing claim rolls the entire batch back. No application
mock, substitute owner/session creation, in-memory lock or retry is involved.
The adapter accepts only that exact SQL protocol and never serves other auth APIs.

Invalid signatures, expiry, audiences, issuer, email, request origin, unknown key,
replay and already-initialized stores cause zero durable writes, including rate
limits. Valid claims preserve auth's durable limiter, cookie, allow-list and
session policy. The claim table stores only binding metadata and IDs, never the
raw credential. Keep this ledger permanently; rolling application code back
must retain migrations and admission state.

Run `node --test --test-concurrency=1 modules/owner-claim/tests/*.test.mjs`.
The suite uses ephemeral test-only keys, deterministic verifier/transaction clock
boundaries with a test-only SQLite adapter, actual workerd+D1 with per-table write
audits, concurrent claims, restart/replay, forced SQL rollback and exhausted real
rate limits. Chromium exercises 1440/390 confirmation, opener transport, native
Origin-preserving POST and a real authenticated session. Runtime fixtures are
never exported or deployed. Declarations are `index.d.mts`; verifier-only copying
uses `verify.mjs` without auth imports. Local runtime/browser proof is distinct
from deployed application adoption and hosted-provider acceptance.
