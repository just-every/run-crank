# Operator auth (IF-055-CORE-v1)

Portable server-only ESM: import `createOperatorAuth`, `createAuthHandler` and
`createSignInHandler` from `modules/operator-auth/index.mjs`. TypeScript
declarations are `index.d.mts`. No framework or mail transport is bundled. Apply
`accounts/schema/operator-auth.sql` once for a fresh auth database (and
`identity/oidc/schema/oidc.sql` when the app offers identity providers). Preserve applied migration history in an existing
store and follow “Adopting this version” below for its additive upgrade. Tables
use the `oa_` namespace. This module does not seed any product data.

```js
import { createOperatorAuth, createAuthHandler } from './modules/operator-auth/index.mjs';
import { createMailSender } from './modules/mail/index.mjs';
// Secrets are Worker secret bindings, never source text.
const { SESSION_SECRET, SETUP_TOKEN, MAIL_API_KEY: apiKey } = env;
const auth = createOperatorAuth({
  db: env.DB,
  config: {
    origin: 'https://app.example.com', OWNER_EMAIL: env.OWNER_EMAIL,
    SESSION_SECRET, SETUP_TOKEN,
    MAIL_FROM: env.MAIL_FROM,
    // Optional; omit for neutral workspace wording and /signin recovery.
    branding: { productName: 'Example', accentColor: '#334155', signInPath: '/signin' },
    // Optional explicit address list further restricts active operators.
    // allowList: ['owner@example.com', 'staff@example.com'],
  },
  mailSender: createMailSender({ provider: env.MAIL_PROVIDER, mode: 'production', apiKey,
    ...(env.MAIL_PROVIDER === 'cloudflare' ? { accountId: env.MAIL_ACCOUNT_ID } : {}) }),
  // Use only infrastructure-authenticated client addresses. In Cloudflare's
  // public Worker boundary CF-Connecting-IP is edge-owned. Do not reuse this
  // resolver behind a proxy which lets callers supply that header.
  clientIp: request => request.headers.get('CF-Connecting-IP') ?? '',
});
const response = await createAuthHandler(auth)(request);
// response === null means another dispatcher owns this path.
```

For first setup omit `mailSender` and `MAIL_FROM` entirely. Provision independent
random `SESSION_SECRET` and `SETUP_TOKEN` secrets (at least 32 characters; generate
32 random bytes or more). POST `/auth/bootstrap` with `{token,displayName,returnTo}`
creates the configured owner and session atomically only on an empty auth store.
Remove SETUP_TOKEN after bootstrap. Changing it never resets the bootstrap ledger.
No owner is automatically provisioned when requesting a link or invoking OIDC.

All public mutation APIs require POST, the exact configured request origin and
`Origin` header, and reject cross-site Fetch Metadata. Never derive `origin` from
request headers. `Host`, when supplied, must match the configured authority; local
HTTP additionally requires an explicit matching loopback Host. Browser forms and
JSON are accepted by the handler (8 KiB maximum). Parsed query/form parameters
with duplicate decoded names or JSON object keys are rejected with `invalid_input` before
auth processing, including escaped names. POST tokens are accepted only in the
body; a query token on a POST is rejected as an ambiguous credential source.
Protect every private API, server function and document with
`auth.getSession(request)`. Missing/invalid,
expired, revoked, deactivated and disallowed sessions yield null; host violations
throw `AuthError` with 403. Never return a private page then check in the browser.

## Layers

Base's operator auth is the only staff sign-in, in three layers:

| Directory | Holds | Interface |
| --- | --- | --- |
| `identity/` | Proving who a person is: the email link (`identity/email-link/`), identity providers over OpenID Connect (`identity/oidc/`, see [its README](identity/oidc/README.md)), and the admission that turns a verified principal into a session (`identity/admission.mjs`). | Outputs a **verified principal** `{issuer, subject, provider?, email?, emailVerified?, emailVerifiedAt?, amr?}`; `identity/index.mjs`. |
| `accounts/` | Who a person is in this app and what they may do: operators, roles, invitations, sessions, domain rules and step-up proofs in the `oa_` store (`accounts/store.mjs`, `accounts/schema/`). | The **accounts adapter interface** (`accounts/adapter.mjs`); Base's implementation over `oa_` is `accounts/oa.mjs`. |
| `dev/` | Local-only dev sessions, personas and mode labels, loaded only from a local-only Worker entry. | `dev/index.mjs`; see "Local dev identity" below. |

The files at the root are shared by all three: HTTP and input checks, crypto,
configuration and branding, the shared page frame (`page.mjs`), the key gate
(`dev-gate.mjs`, `dev-admission.mjs`, which production loads to *refuse* dev
credentials), the composition (`service.mjs`), the HTTP adapter (`routes.mjs`)
and the sign-in page (`signin/`).

### Native composition

`createOperatorAuth({ accounts, proofs, ... })` routes the complete service
through the seed's native accounts, cookies, sessions and durable email/step-up
proof persistence. Both are required; partial injection fails closed. Native
roles are generic types, and unsupported administration/provisioning explicitly
refuses. Apply identity/dependency storage only, without OA account tables.
See the [native adoption contract](docs/native-accounts.md) for exact APIs,
transaction fences, optional capabilities, callback/trust settings and the
Slate/HappyToHelp continuation steps.

### The accounts adapter interface

Identity never decides who may enter; it asks the app's accounts. A seed that
keeps its own tables (HappyToHelp, Slate) implements these methods over them and
passes the adapter to `createAdmission` from `identity/index.mjs`:

| Method | Contract |
| --- | --- |
| `findByEmail(email)` | The person whose account holds this **proven** email, or null. A person is `{id, email, status: 'active'\|'invited'\|'inactive', owner: boolean}`. |
| `findBinding({issuer, subject})` | The person bound to this provider principal, or null. |
| `bind({issuer, subject, person, associated})` | Binds `(iss, sub)` to the person and returns whether it now names them. Never rebinds a principal bound to someone else; binds only proven emails (or an explicit configured association, `associated: true`); revokes the person's earlier password credentials. |
| `issueSession({person, principal, method, returnTo, request})` | A completed session `{session, operator, cookie, returnTo}`, or null when the person changed meanwhile. |
| `revokeSession(sessionId)` | Ends one session (used when a seed's `afterConfirm` refuses a sign-in). |
| `identityEnabled()` *(optional)* | The app-owned provider sign-in setting; omission means off. |
| `currentBoundSubject({personId,issuer})` *(optional)* | The current bound subject for this person at this issuer; null for ambiguity. Required for OIDC editor authority. |
| `bindAndIssueSession(...)` *(optional)* | Atomically bind and issue the session with current person and provider-setting fences; Base uses this path. |
| `owner()` | The app's owner, or null. |
| `acceptInvitation(...)` *(optional)* | Accepts a pending invitation through a principal that proves the invited email. |
| `requiredProvider(email)` *(optional)* | The provider id the email's domain must use, or null. |

`accounts/oa.mjs` is Base's own implementation: bindings live in
`oa_external_identities`, sessions in `oa_sessions` (fenced to the operator's
version), domain rules in `oa_domain_rules`. `auth.accounts` exposes it and
`auth.admission` the admission built on it.

## HTTP contract

| Path | Method | Input / result |
| --- | --- | --- |
| `/auth/bootstrap` | POST | token, displayName, returnTo?; 303 with cookie and safe Location |
| `/auth/magic-link` | POST | email, returnTo?; 202 `{status:'accepted', requiredProvider?}` for admitted/unknown/disallowed address. A native HTML form post (URL-encoded) gets a 303 back to the sign-in page with `notice=sent` instead. |
| `/auth/confirm?token=…` | GET/HEAD | 200 confirmation form, or 400 expired/invalid; **no writes, no session cookie** |
| `/auth/confirm` | POST | token; consume once, create session and 303 to stored returnTo. A step-up link completes only in the session that asked for it and sets no new cookie. |
| `/auth/session` | GET | session and operator, or 401 |
| `/auth/signout` | POST | `{}`; revoke current session, clear cookie, 204 |
| `/auth/invite` | POST | email, displayName, role? (member), returnTo?; mail invitation, 202 |
| `/auth/invite/cancel` | POST | operatorId; cancel pending invitation, return inactive operator, 200 |
| `/auth/operators` | GET | authorized operator list |
| `/auth/operator/status` | POST | operatorId, status (`active`/`inactive`) |
| `/auth/operator/role` | POST | operatorId, role |
| `/auth/sessions?operatorId=…` | GET | authorized session metadata, no credentials |
| `/auth/session/revoke` | POST | sessionId; 204 |
| `/auth/review-session` | POST | returnTo?; explicitly configured loopback review session |
| `/auth/step-up` | POST | action, returnTo?; email a step-up link to the signed-in operator, 202 (a form post gets 303 with `notice=step_up_sent`) |
| `/auth/domain-rules` | GET / POST | list rules; POST domain, provider (null lifts); owner only, step-up |
| `/auth/providers` | GET | the pinned provider links; owner only |
| `/auth/providers/unlink`, `/auth/providers/relink` | POST | provider; owner only, step-up |
| `/auth/oidc/<id>/start`, `/auth/oidc/<id>/callback` | POST / GET | each provider's own routes (see [identity/oidc](identity/oidc/README.md)) |
| `/auth/owner-signin?token=…` | GET/HEAD | 200 owner sign-in confirmation for a live `rer signin` link, or 400 invalid/used/expired; **no writes** |
| `/auth/owner-signin` | POST | token; consume once for the active owner it names, 303 with cookie; see "Owner sign-in without mail" |
| `/auth/email` | POST | email; the signed-in operator's own sign-in email; fresh step-up proof; 409 `email_in_use` |

Unknown `/auth/*` paths return 404. Unsupported methods return 405. Except for invalid/expired confirmation GET/HEAD documents, known public
errors are JSON `{error:code}`: invalid input 400, unauthenticated 401, policy/host/
Origin rejection 403, missing resource 404, conflict/last owner 409, oversized input
413, unsupported content type 415, rate limit 429, missing mail/database 503.
Internal errors are redacted as `auth_unavailable`. Methods throw typed AuthError;
the Fetch adapter translates it. Every response has no-store headers. Successful
confirmation GET/HEAD responses use `Referrer-Policy: strict-origin` so native
form POSTs retain their Origin without exposing the token path or query in
Referer; HTTPS-to-HTTP downgrade requests omit Referer. Other responses retain
`Referrer-Policy: no-referrer`. Exact Origin/CSRF validation is unchanged.
Do not log confirmation URLs, input tokens, cookies or provider message bodies.

## Confirmation and branding

GET/HEAD confirmation uses a self-contained, responsive document. A magic link
says “Confirm sign-in to Example”; an invitation says “Accept your invitation to
Example”. Both explain that the link works once and show its remaining lifetime,
rounded up to days for lifetimes of a day or more, otherwise minutes (singular
for one day or minute). The sole primary form button is
“Confirm”. Only its hidden POST field contains the token. Invalid, expired,
consumed or unauthorized links return a styled 400 document with “Request a new
link” pointing to the configured sign-in page. HEAD has the same status and
headers without a body. Preview never writes auth state or sets a cookie.

The heading uses 30px type (28px at viewport widths up to 480px), 1.3 line
height, -.02em tracking and a 24px bottom margin; the brand-to-heading gap is
32px. Confirmation documents contain one inline stylesheet, and the CSP adds
only that stylesheet's exact UTF-8 SHA-256 hash.

Optional `config.branding` fields are independently defaulted and validated:

| Field | Default | Validation |
| --- | --- | --- |
| `productName` | `your workspace` | At most 80 UTF-16 code units before trimming, with at least one visible letter, number, punctuation or symbol; rejects C0/C1 controls, U+2028/U+2029 and default-ignorable code points, except contextual script joiners and emoji presentation described below |
| `accentColor` | `#334155` | Exactly six hexadecimal digits after `#` |
| `signInPath` | `/signin` | Same-origin absolute path, at most 2048 characters; no scheme, network-path reference, backslash or control characters, including encoded variants |

Product names preserve letters and combining marks in every script. ZWNJ
(U+200C) is allowed after a letter (including its combining marks) when a letter
or decimal digit follows, directly or after spaces, as in Persian "کتاب‌ ها" and
"سال‌۱۴۰۰". ZWJ (U+200D) is allowed between letters and after a virama, including
at the end of a word, so legacy Malayalam chillu forms are kept. ZWJ also joins
emoji pictographs, including an emoji presentation selector or skin-tone modifier
on the preceding emoji. U+FE0F is allowed immediately after an emoji pictograph,
and after a keycap base (0–9, # or *) only when U+20E3 follows; all other
variation selectors are rejected. Rejected default-ignorable characters include
U+200B/U+200E/U+200F, bidi overrides and isolates, U+2060–U+206F, U+FEFF, U+061C,
U+180E, U+034F, U+115F/U+1160, U+3164 and U+FFA0. The object replacement
character U+FFFC and lone surrogates (text that is not well formed) are rejected.
Space-only and invisible-only names are invalid; the braille blank U+2800 does not
count as a visible symbol.

The consumer must serve that sign-in path. Query strings and fragments are
allowed; malformed encodings in the configured value are rejected. Encoded
percent data is preserved, and nested encoded separators and controls are still
rejected. Invalid branding throws
`AuthError('invalid_configuration', 503)`. Branding is copied and frozen at
construction. `auth.presentation` exposes only the three normalized branding
fields; it never exposes configuration secrets. `previewLink` returns only
`{kind, expiresInMinutes}` for an authorized link, otherwise null. Names are
HTML-escaped in documents and mail. The accent chooses black or white button
text for contrast, with a visible keyboard focus ring in light and dark schemes.

The module's confirmation HTML responses contain exactly one inline stylesheet. Their
CSP adds only its exact UTF-8 SHA-256 `style-src` hash to the existing restrictive
policy. No scripts, external resources, style attributes, CSS URLs or imports
are included in the document. JSON errors, redirects and other responses retain
the original CSP. Do not add a broad inline-style allowance to an adopting seed.

An application can compose its same-origin brand font head onto this document,
as Base's foundation/reference do. Preserve the inline style hash, private
headers and native form behavior; permit only same-origin styles and fonts,
with no scripts or third-party resources. Set the conformance adapter's
`confirmationFonts: true` for this composition. The same public auth scenarios
then require one fixed same-origin stylesheet and primary font preload, the
unchanged hash and restrictive CSP, and all existing token/session protections.
The standalone module's default conformance still requires no font resources.

## Sessions, tokens and policies

Opaque 256-bit credentials are HMAC-SHA256 hashed with domain separation at rest.
Cookies are host-only, Path=/, HttpOnly, SameSite=Lax; production uses Secure and
`__Host-operator_session`. Explicit `local:true` allows only literal localhost,
127.0.0.1 or [::1] and uses `operator_session_local_<port>` (for example
`operator_session_local_8787`): browsers keep cookies per host, not per port, so
checkouts side by side on one loopback host each keep their own session. Session expiry defaults to
7 days (maximum 30), sign-in and step-up links to 15 minutes (maximum 60), and
invitations to 7 days; no silent sliding renewal.
`returnTo` must be a local absolute path; unsafe values become `/app`. It is stored
with the token, and cannot be replaced on confirmation. Auth methods never return
raw link tokens. `CompletedSession.cookie` is server-only and must only be emitted
as Set-Cookie, never serialized into browser data.

D1 batches transactionally claim setup, consume links, accept invitations, bind
external identities and issue sessions. A unique token/session relation prevents
double consumption. Operator version fences invalidate **all** old links and
sessions after status/role changes, including after reactivation. Mutation SQL
rechecks the actor's active session and authority snapshot. Last active owner
removal/demotion is rejected by SQL triggers, including competing mutations.
Reactivate never bypasses invitation acceptance. Retrying an invitation with the
same email/role resends it and revokes older links; an existing active or
ordinarily inactive operator conflicts. An inactive operator with a durable
cancellation marker can be reinvited as described below. Unknown addresses never
become operators through sign-in.

`cancelInvitation(request, operatorId)` uses the existing `operators:deactivate`
policy with the pending operator as target. It changes only an `invited` operator
to `inactive`, retaining the operator ID, bootstrap ledger and history. The SQL
write fences the actor's session and authority version and the target's status
and version. Its existing version trigger invalidates every outstanding link;
GET/HEAD preview and POST confirmation then fail. A durable cancellation ledger
and SQL trigger reject ordinary activation with `invitation_required`, even after
credentials are pruned. A cancelled identity can receive a fresh invitation only
when the requested role matches its recorded role. Reissue changes that same row
back to `invited`, updates its display name, and leaves its ID and creation/history
intact. Its status trigger advances the version; the fenced D1 batch inserts a new
link and revokes older unconsumed links. The cancellation ledger remains present
while the replacement is pending. Cancelling that pending invitation again is
allowed and refreshes the durable marker, so repeated cancel/reissue cycles retain
the same guard. Existing active and ordinarily deactivated operators still conflict,
as do role mismatches; a same-role pending invitation can still be resent with
status 202. A completed invitation cannot be cancelled.

The cancellation ledger is removed only inside the successful token-consume batch,
witnessed by the session inserted from that invitation immediately before the
operator is activated. Session creation, ledger removal, activation and token
consumption commit atomically. An ordinary status update cannot supply that
acceptance evidence. A confirmation racing with cancellation has one winner: a
completed join makes cancellation conflict; a completed cancellation prevents the
join and session creation. Use `setOperatorStatus` for explicit active-operator
removal; its last-owner protection remains in force.

The full `accounts/schema/operator-auth.sql` includes the cancellation ledger and triggers
for a fresh database. In an existing store that lacks these objects, apply
`accounts/schema/invitation-cancellation.sql` as a **new numbered migration before switching
to this runtime**: the runtime reads the ledger for reinvitation and consumes it
on confirmation. Inspect the seed's migration history and assign its next unused
number; never rewrite an applied migration. Do not apply both files to a fresh
store. Missing cancellation schema fails closed. The additive migration leaves
existing rows and credentials unchanged and does not infer historical acceptance
for existing active or inactive operators; only a witnessed pending cancellation
writes a ledger row. Keep the ledger and triggers on rollback, and never prune
`oa_invitation_cancellations` as maintenance.

Invitations also bind their issuer's identity and authority version. Preview and
confirmation require that issuer to remain active and allowed, and re-evaluate
the configured `operators:invite` policy for the issued role. Confirmation fences
that issuer/version in the same transaction as invitation acceptance and session
creation. Changing the issuer's status or role permanently invalidates unused
invitations, even after restoration; an authorized operator must issue a fresh
link. Signing out or revoking just the issuing browser session does not invalidate
an invitation whose issuer still has authority.

Durable fixed-window limits pair the client-IP resolver with a normalized email;
defaults are 30 per IP and 5 per email per 15 minutes. `limitWindowSeconds`,
`ipLimit` and `emailLimit` configure those defaults. Bootstrap, magic link,
invitation, confirmation and review use separate scopes. Bootstrap uses only
the client-IP budget: its configured owner email is shared by every caller,
so wrong setup tokens from one client cannot exhaust another client's budget.
The same bootstrap policy applies to signed owner claims. Confirmation limits bind
the presented opaque token instead of the address. `clientIp` is mandatory;
unavailable addresses fail closed (503). Header trust belongs to the deployment
boundary. Do not trust X-Forwarded-For.
Periodically prune old oa_limits rows and expired tokens/sessions in an
edition-owned maintenance job; preserve referenced rows or delete referencing
sessions first. Never delete oa_bootstrap as maintenance.

Default applied: **owner/admin/member**. Owner manages all operators; admin invites
members and manages members; members view/revoke their own sessions. Only owners
can promote roles. `rolePolicy({actor,action,target,role})` replaces this policy
for product variations. It receives current persisted operators, never caller
role claims; keep it deterministic and side-effect-free. Active operator, active
session, allow-list, version fences and last-owner safeguards cannot be overridden.
The exported `isActiveOperator` is the shared admission predicate.

## Mail, OIDC, password and review seams

Invitation links default to seven days (604800 seconds). `invitationSeconds`
can shorten that lifetime, up to the seven-day maximum. `linkSeconds` remains
independent: sign-in and step-up links default to 15 minutes and allow at most
one hour. Invitation mail and confirmation pages describe the longer lifetime
in days; single use, cancellation and issuer-authority checks still apply.

Magic and invitation mail include both plain text and HTML. Each part has exactly
one confirmation URL; the HTML part presents it as a button with inline mail-safe
styling. The body sets Arial; its centered main content has a 480px maximum width
and 32px by 24px padding. The “Confirm” link opens a page; the copy says “Open this link to review and confirm”.
Both parts direct readers to press Confirm on that page and explain single use and configured expiry.
The invitation subject is “You're invited to Example”; no subject includes a
credential. The product name is escaped in HTML and is plain text in the subject
and text part. Delivery results still control revocation as described below.

Mail consumes actual IF-056-MAIL-v1 `createMailSender(config).send(message)`;
`deliveryId` is the token record UUID. No parallel transport or implicit outbox
exists. Missing/failing/uncertain transport revokes the link and reports
`mail_unavailable`; retries require a new link. Explicit development results are
accepted only in local mode. Auth never claims mailbox receipt.

Identity providers verify the whole protocol and hand the admission a verified
principal; [identity/oidc/README.md](identity/oidc/README.md) describes them. The
original server seams remain for existing callers:
`auth.admitVerifiedIdentity(request, identity, {returnTo})` requires
`{issuer,subject,email,emailVerified:true}` from an issuer in
`config.externalIssuers`, and `auth.createIdentityAdmission({issuer,
subjectEmails})` snapshots an exact issuer's subject associations:

```js
const admit = auth.createIdentityAdmission({
  issuer: 'https://idp.example.com',
  subjectEmails: { 'independently-verified-subject': 'operator@example.com' },
});
// Only after full protocol validation; the mapping supplies the account.
const result = await admit(request, { issuer, subject }, { returnTo });
```

Both now admit through the accounts adapter, under the same rules as provider
sign-in. A binding on `(iss, sub)` is never silently rebound: a bound principal
always names the same account, and one presenting another existing account's
email is refused. A proven email binds a person's **first** principal at each
issuer; another subject at the same issuer needs an explicit association, while
a different issuer may bind its own principal by a proven email. Binding revokes
the person's password sessions, and `admitVerifiedPassword` then refuses with
`password_revoked`. An email counts only when proven in the last 30 days
(`emailVerifiedAt`, where sent). Identity providers also refuse, in a production
app (not `local`), `amr` containing `dev` and addresses under `.localhost`,
`.test` or `.invalid`.
A pending invitation is accepted when a principal proves the invited email.
Neither path provisions operators or changes roles. The subject map must come
from trusted deployment configuration, never HTTP input or token claims.

`admitVerifiedPassword(request, operatorId, {returnTo})` supports a seed's existing
real password verifier. It requires POST/Origin and shares active-operator,
allow-list, version, domain-rule and session policy; an operator bound to a
provider has no password admission. The caller must verify and rate-limit the
password **before** invoking it. It neither creates an operator nor claims setup;
there is no password checker or password endpoint in this module.

For a loopback review session, configure `review:{enabled:true,operatorEmail}` and invoke
`issueReviewSession`. It requires an already-active operator, POST/Origin, and
literal loopback URL **and Host**. Non-loopback Host returns 403 regardless of
flags or forwarded headers; admission of the resulting review cookie checks the
same boundary every time. Review defaults/maxes at one hour. Disable the flag to
invalidate review admission immediately. Bind the local review listener to a
loopback interface; a forged Host is not network isolation. Production configuration
must never enable review. No fixture/sample operator is created for review.

## The sign-in page

`createSignInHandler(auth, {setup, links, defaultReturnTo})` serves the one
sign-in page every Base seed mounts, at `branding.signInPath` (GET and HEAD; null
for other requests). It is server-rendered plain HTML with no script, so it works
before hydration and without JavaScript, in the same hashed-style frame as the
confirmation page (light and dark, the seed's `rer-theme.css` when declared).
It shows "Continue with…" for each linked, reachable provider, then the email
link, then optional seed links and, while the first owner is
unclaimed, the setup form. A provider that has failed discovery or JWKS for 5
minutes, or answered 404 or a DNS failure, is hidden, and a browser that still
posts to it comes back to this page with a notice and the email link instead of
being redirected away. Its `form-action` allows exactly this origin plus each
visible provider's authorization origin, since the start route redirects there.

Two hooks on `createOperatorAuth({hooks})` keep a seed's own sign-in work in place:

- `beforeMagicLink({request, email, operator})` runs before an email link is sent
  to an active operator; returning `false` sends nothing (the public answer is
  unchanged).
- `afterConfirm({request, operator, session, method, returnTo})` runs after an
  email-link or provider sign-in (`method: 'email' | 'oidc'`). Return
  `{returnTo}` to redirect (Vector's restored-operator review), do other work
  (Pencil's audit mail), or throw an `AuthError` to refuse: the session it was
  about to get is revoked first (Cradle's forgery check).

## Domain rules and step-up

An owner can require a provider for an email domain (`POST /auth/domain-rules`
`{domain, provider}`; `provider: null` lifts it). Sign-ins for an address in that
domain by any other route are refused: the email link is not sent (the public
answer is the same, and names the domain's provider), another provider is
refused with `oidc_provider_required`, and the password and review seams refuse
with `provider_required`. App owners are exempt. Domains match exactly.
Unlinking a provider lifts the rules naming it.

An identity provider can assert any email, so these actions need a fresh
**app-local email-link proof**: unlinking or changing a provider, changing domain
rules, transferring ownership (making or unmaking an owner), export, delete and
minting long-lived credentials (`STEP_UP_ACTIONS`). `POST /auth/step-up
{action}` emails a link to the signed-in operator's own address; confirming it in
the same session records the proof, which lasts 10 minutes. An email-link
sign-in within those 10 minutes is itself a proof. A provider-issued session is
never one. Base's own routes enforce it; a seed guards its export, delete and
credential-minting routes with `await auth.requireStepUp(request, action)`,
which refuses with `step_up_required` (403).

The shared administrative actor guard applies that proof to every owner role
grant or removal, owner invitation (new, reissued or reinstated after cancellation),
owner invitation cancellation, and owner activation or deactivation. Unchanged
roles/statuses and non-owner status changes retain their usual authorization.
The existing version fences and last-active-owner protection still apply after
the proof succeeds.
With the `RER_DEMO=1` demo guard active, the configured owner's authenticated
session supplies this proof inside its own visitor container because mail is
mocked. Authentication still checks the container's own session secret and
store; another visitor's session is refused. Ordinary hosted instances keep
requiring the real proof described above.
Creating a server-declared owner dev persona also requires the signed-in owner's
fresh local proof in addition to the checkout key. Its creation repeats the actor
session/version fence in the database write.

## Owner sign-in without mail (`rer signin`)

An owner whose mail does not work yet, or whose `OWNER_EMAIL` was mistyped, gets
in with `rer signin [--environment NAME]`. rer uses only the Cloudflare
credentials that deployed that environment: it checks that the live Worker is
the one its deploy record names, writes one row into `oa_owner_signins` in the
deployment's own D1 through the D1 API, and prints the link
`/auth/owner-signin?token=…` once to the terminal. The row holds the SHA-256 of
the 256-bit token (`owner-signin-grant.mjs`), the claimed owner's id and
version, and an expiry 15 minutes ahead; the token itself is never stored, and
rer writes it to no log, receipt or deploy record.

GET only shows a confirmation page (link scanners cannot use it). POST consumes
the grant in one transaction with the session it opens, and only while the
grant is unused, unexpired, at most 15 minutes from the Worker's own clock
(whatever clock minted it), and names the operator that is still the active
owner at the same version (a role or status change voids it). The same
transaction records `owner:signin-link` in `oa_auth_audit` for that owner and
counts as a fresh step-up proof. The route uses the confirmation rate limit,
the exact Origin and the secure cookie of every other sign-in.

Why it is safe: writing that table needs the same Cloudflare token that can
already replace the Worker or read and write its database, so the link adds no
authority beyond the deploy credentials. It works once, only for the recorded
owner, within 15 minutes, and its use is logged. Production email-link sign-in
is unchanged. Native accounts (`createNativeAuth`) do not mount this route.

A wrong sign-in email is corrected in the app: `POST /auth/email {email}`
changes the signed-in operator's own address after a fresh proof (a step-up
link to the current address, a recent email-link sign-in, or a `rer signin`
link). It revokes unused links sent to the old address and keeps sessions and
provider bindings. An address another operator holds is refused with
`email_in_use`. `STEP_UP_ACTIONS` gains `email:change`.

## Local dev identity and the key gate

`dev-gate.mjs` (exported as `devGate`, production-safe) is the per-checkout key
gate. `rer setup` writes a random `RER_DEV_KEY` to `.rer/local/dev-key.env`;
only local runtimes receive it as a binding, and `rer deploy` refuses it, so a
deployed Worker has no gate and every gated surface answers 404. A tunnel or
local reverse proxy makes remote requests look local (forwarded requests carry
a loopback URL and Host, and `CF-Connecting-IP` is whatever the caller sent), so
the gate is the key, not the network. `devGate({key, origin, local})` returns
null unless the key is present and the origin is an explicit loopback origin in
local mode. `admits(request)` accepts the `rer_dev_gate_<port>` cookie (an HMAC of the
key, so a reset key refuses old cookies) or the key in `x-rer-dev-key` (the rer
CLI and test harnesses). `exchange(request)` serves `GET /__dev/key` and trades
the key from the URL fragment, through a same-origin POST, for a host-only
`HttpOnly; SameSite=Strict; Path=/` cookie.

`dev/` is the dev layer: **server-only and local-only**. Import it only from a
local-only Worker entry (a Vite-serve or local `wrangler dev` entry), never
from the deployed main; its `DEV_LAYER_MARKER` lets `rer build` refuse any output
that bundles it. `withDevIdentity(worker, {bindings, config, personas})` wraps
the seed's Worker and serves, behind the gate only:

| Path | Result |
| --- | --- |
| `/auth/dev/enter?as=owner\|signed-out\|PERSONA&returnTo=` | Creates or reuses a real `oa_sessions` row of kind `dev` for the configured owner or persona and 303s to `returnTo` (default `/app`); `signed-out` revokes the current session. |
| `POST /auth/local/cli-session` | Owner-side tooling proves possession of the session secret with `x-rer-local-cli`; exact loopback and origin checks precede issuing a native owner session and fresh local proof. This route exists only in the dev entry. |
| `/__dev/personas` | `[{as,email,role?}]`, used by `rer dev` for `RER_SIGNED_IN`. |

`personas()` returns the seed's `devPersonas()`: `[{as, role, displayName?}]`,
real operators at `<as>@dev.localhost` created only by dev sign-in. Dev
sessions pass the same version fences, revocation, deactivation and allow-list
as every other session. An admitted local dev session also confirms sensitive
actions directly, so dev never waits for an email step-up link. The core admits a `dev` session, and any credential
minted while using one (`oa_dev_credentials`, today an invitation link, whose
confirmation then yields a `dev` session), only when the dev layer's
registered check passes for that request; a production Worker never registers
one. HTML documents gain the Dev suffix on product labels marked with
`data-rer-name` and document titles; a demo receives Demo instead. The dedicated
`/__dev/key` document exchanges the RER_OPEN fragment without placing the key in
request URLs. `RER_DEV_IDENTITY=off` disables dev sign-in and personas. The
layer answers 503 to every request when `RER_INSTALLATION_ID` is set beside a
non-loopback `RER_MANAGEMENT_ORIGIN`.

In dev and isolated hosted demos, `/signin` lists **Sign in as <name>** for
active people and people with a live invitation. The default operator screen
gets `signInUrl` on those `/auth/operators` records and offers the same action.
`GET /auth/one-click?as=EMAIL&returnTo=/app` accepts the invitation with the
existing atomic issuer, expiry, version and cancellation checks. Local sessions
are always `dev` and require the checkout key on every request; hosted demo
sessions belong only to that visitor's database. Production answers 404. The
local persona list also includes invited/active people by email. Suppressed
email-link form requests direct the admitted visitor to this same one-click
entry rather than telling them to wait for mail.

`dev/sign-in-as.mjs` is the test harness door: `signInAs({origin, key, as})`
returns the cookies a test browser or fetch client installs, and
`readDevKey(root)` reads the checkout's key.

Portable archives never carry dev identity: export drops `dev` sessions and
dev-minted credentials and marks personas suspended, and import refuses an
archive holding either (`modules/portability/dev-data.mjs`). Seeds that mint
their own credentials while signed in record them in `oa_dev_credentials` and
admit them only behind the gate.

## Integration and checks

Copy this directory as source; import only its server entry from `.server` modules.
A Start server function must call getSession on each invocation. A Vite SPA must
use protected HTTP APIs and never bundle this implementation, secrets or D1. The
consumer owns its native unauthorized document redirect and API 401 behavior.
Mount `/auth/*` before private namespace guards and before Start; keep private
unknown API paths behind authentication before returning 404.

At the Base repository root, `pnpm run verify:operator-auth` runs the operator-auth,
identity-provider and sign-in page `.test.mjs` suites; `pnpm run verify:modules` runs the module `.test.ts`
suites. The default suite includes a static pre-ledger schema and populated-row
upgrade fixture, exercising current handlers and persistent D1 with a fixed test
clock; its provenance is documented in `tests/fixtures/pre-ledger/README.md`.
`tests/prior-data.test.mjs` runs a store written by the auth-1 main's own API
(`tests/fixtures/auth-1-store/README.md`) through these layers after the two
additive migrations below.
The "cancelled before the ledger" fixture row represents a state reachable only
by a direct database update, not through the cancellation API before its ledger
exists. The prior-data test executes every statement in the shipped migration
and checks that the applied count matches the file's statement count.
The pre-update source upgrade check is separate from those globs. Prepare
an independently captured pre-update source snapshot containing the complete
`operator-auth/` directory (including `tests/worker.mjs` and
`accounts/schema/invitation-cancellation.sql`) and `pre-cancellation.sql` at the snapshot
root. With the frozen workspace dependencies installed, run:

```sh
OA_BASELINE_SOURCE=/path/to/snapshot node --test modules/operator-auth/tests/reinvitation-upgrade.mjs
```

Runtime tests use the locked Wrangler Miniflare/esbuild dependencies and run the
bundled implementation in real workerd with D1. They create disposable test data and
dispose runtimes. Adversarial request tests use a test-only envelope to preserve
literal Host and Origin through Miniflare's local proxy; the production handler,
crypto and D1 execute in workerd. These are module-level checks, not proof of an
adopting seed's emitted browser transport or deployment. Each seed must wire its
corresponding auth and browser checks into CI. Hosted provider/IdP proof and
deployment remain separate.

## Adopting this version

Copy the **complete** `modules/operator-auth/` directory from one reviewed Base
revision into the seed's operator-auth source location. Keep its layers
(`identity/`, `accounts/`, `dev/`), runtime files, declarations, schema,
conformance files and tests from that same revision; `rer check` names any copied
file that differs from the pinned revision (`SC-05.auth-copy.*`); the runtime imports neighboring helpers within the module. Keep imports
server-only, reconcile the seed's route integration, and run that seed's real auth
and browser checks.

The sign-in page fills in its email field from `?login_hint=<email>` (a complete
address; anything else is ignored; never submitted for the visitor), so a link
from the platform's Open app or a seed's own page can pass the claimed owner.

Wire `config.branding` with the seed's `productName`, `accentColor` and
`signInPath`; the defaults are `your workspace`, `#334155` and `/signin`. Keep
`MAIL_FROM` in auth config and provide a real `mailSender` that implements
`send(message)`. The Base example builds it with `createMailSender` from
[the mail module](../mail/README.md), using mail config fields `provider`, `mode`, `apiKey` and
Cloudflare-only `accountId`; its sample maps `provider` to `MAIL_PROVIDER`,
`apiKey` to `MAIL_API_KEY`, and Cloudflare `accountId` to `MAIL_ACCOUNT_ID`, with
`mode: 'production'`. `MAIL_FROM` is a separate auth config field. If sending is
intentionally unavailable for first setup, omit both `mailSender` and `MAIL_FROM`
until mail is configured.

For a fresh auth database, install `accounts/schema/operator-auth.sql` through the seed's
initial schema or migration process, once. In an existing store that has the
earlier operator-auth schema but lacks cancellation objects,
apply `accounts/schema/invitation-cancellation.sql` under the seed's next unused migration
number **before switching the runtime**. The consume path now reads and removes
the ledger during invitation acceptance, so the migration is a runtime prerequisite
for such stores. Never rewrite an applied migration, infer cancellation for old
inactive rows, or apply both schema files to a fresh store. The complete fresh
schema already includes the ledger. This update adds no schema objects beyond
that existing cancellation-capable schema.

The updated invite behavior permits same-role reissue of an inactive identity only
when it carries the durable cancellation marker. Same-role invitations that remain
pending, including expired pending invitations, retain the existing resend path.
Cancelled reissue preserves the identity row and history, creates a fresh invitation
link, invalidates older links and retains the marker until a successful confirmation
creates a session. Repeated cancellation/reissue is supported. Existing active or
ordinarily inactive identities and role mismatches still conflict; an ordinary
status change cannot accept a pending invitation.
Pre-ledger cancelled identities have no cancellation record and remain refused
for reinvitation until the owner deliberately removes the identity and reinvites
the same email; the current status API cannot distinguish them from ordinary
inactive identities.

**Dev sessions.** The fresh schema admits session kind `dev` and includes
`oa_dev_credentials`. An existing store needs `accounts/schema/dev-sessions.sql` as a
**new numbered migration under the seed's next unused number, before switching
to this runtime**: SQLite cannot change a CHECK in place, so it rebuilds
`oa_sessions` with `dev` added, keeping every row, column, index and
constraint (no table refers to `oa_sessions`), and creates
`oa_dev_credentials`. The runtime reads that table when previewing and
confirming links, so a store without it fails closed. Unlike the cancellation
migration, this file is also safe after the fresh schema. The reference seed
applies it as `migrations/core/0007_dev_sessions.sql`;
`tests/dev-sessions-upgrade.test.mjs` upgrades a populated store built from
the reference's earlier migrations and proves every stored session keeps its id
and expiry. Native, review and password sessions retain usable authority after
the later additive migrations. Legacy provider sessions require a new sign-in:
upgrades start with provider sign-in off, and enabling it does not manufacture
missing provider session provenance.

**Layers, domain rules and step-up.** An existing store needs
`accounts/schema/domain-rules-step-up.sql` (`oa_domain_rules`,
`oa_step_up_challenges`) and, when it offers providers or had the earlier OIDC
adapter, `identity/oidc/schema/oidc.sql` again (it adds `oa_identity_providers`
and `oa_identity_provider_health`; every statement is `IF NOT EXISTS`), each as
a new numbered migration before switching to this runtime. Both are additive and
safe after the fresh schema; the runtime reads them when previewing links and
requesting email links. The reference applies them as
`migrations/core/0008_identity_providers.sql` and
`0009_domain_rules_step_up.sql`. The earlier single-issuer `oidc/` adapter
(`createOidcClient`) is replaced by `config.providers`; its existing bindings keep
signing in once the same issuer is configured as a provider.

**Owner sign-in links.** `rer signin` needs `oa_owner_signins`: apply
`accounts/schema/owner-signin.sql` as a new numbered migration (additive, safe
after the fresh schema; the reference applies it as
`migrations/core/0024_owner_signin.sql`). Only the owner-signin route reads it;
until it exists, `rer signin` refuses before writing anything.

Seeds copy this module at different revisions, and an older copy lacks the
cancellation migration and the optional OIDC and conformance files. Check each
seed's present source and applied migrations before adopting. A seed owns its
route configuration, CI and release; Base checks do not establish integrated
adoption or deployment.

The application-side dependency, owner-setting and logout protocol is documented in [dependencies](../dependencies/README.md). Existing stores default to provider sign-in off, and provider admission requires the app-owned setting.
