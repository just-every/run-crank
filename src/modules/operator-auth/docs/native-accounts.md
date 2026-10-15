# Native accounts and proof persistence

`createOperatorAuth({ db, config, accounts, proofs, ... })` selects native
composition for the **whole service**. Both adapters are required. Supplying
only one, `null`, `undefined`, missing methods or malformed optional methods
fails construction; it never selects OA as a fallback. Omit both options to
retain Base's existing OA composition and API.

The public declarations are `NativeAccountsAdapter<R>`, `NativePerson<R>`,
`NativeProofPersistence<R>` and `NativeOperatorAuth<R>` from
`modules/operator-auth/index.mjs`. `R` is the edition's own role union, for
example `'owner' | 'admin' | 'operator' | 'contact'`. IDs, roles, cookies and
existing sessions remain native. No role or tenant is taken from an OIDC claim,
request parameter or callback. Select the workspace/project tenant in the
server's adapter factory and scope every query and transaction to it.

```ts
const auth = createOperatorAuth({
  db, config,
  accounts: createNativeAccounts(db, { workspaceId }),
  proofs: createNativeProofs(db, { workspaceId }),
  mailSender, clientIp,
});
const handleAuth = createAuthHandler(auth);
```

`config` remains `AuthConfig`; the session secret keys email-token and rate-key
hashes, independently of the seed's native session-cookie digest. The OIDC
transaction secret remains separate. The accounts adapter reads the native
cookie in `getSession(request, { now })`, revokes its token and returns its
clearing cookie in `signOut`. The service never assumes the OA cookie name.

## Account contract

Retain the identity adapter methods (`findByEmail`, `findBinding`, `bind`,
`issueSession`, `revokeSession`, `owner`). Full native composition additionally
requires `findById`, `getSession`, `signOut`, `identityEnabled`, `policyVersion`,
`requiredProvider` and **atomic** `bindAndIssueSession`. The identity-only
`createAdmission` entry still accepts the earlier smaller interface. It does
not make an old adapter sufficient for the full service.

Project native account status into `active`, `invited` or `inactive`. Supply an
actual monotonic `version` (or an existing native authority revision) that
changes on email, status, role, ownership, credential fencing and any other
change that invalidates outstanding authority. A constant invented version
cannot meet this contract. `owner: boolean` is an authoritative projection, not
an inference that the native role string must be `'owner'`. `owner()` returns
the currently selected install owner. `findByEmail`/`findById` also expose the
native `role`, `displayName` and `createdAt` for the shared hook/session shape.

`getSession` rechecks current native account status/version, session expiry and
revocation. For new provider sessions it also checks current `(issuer, subject)`
binding, app policy generation, and the stored provider pin when issued through
the OIDC protocol. Server-verified identity seams carry no OIDC transaction pin. Preserve older native
sessions according to the seed's existing session contract; do not delete or
reinterpret them as provider sessions. The service strips the internal actor `hash` from public session responses and
normalizes completed/hook return paths before redirects. The service additionally enforces the
24-hour provider cap and disabled-provider setting, the dev gate, and loopback
review restrictions. Those outer checks are not a substitute for transactional
mutation fences.

`bindAndIssueSession` must commit all of the following together:

- Current tenant/account ID, email, status and version still match the admitted
  person; the domain rule still permits this provider (owners are exempt).
- `principal.providerGeneration` equals the durable app generation, identity
  sign-in is enabled. For protocol-issued principals, `principal.providerPin`
  must still identify a linked issuer/client/pin generation in
  `oa_identity_providers`. The server-verified seams below intentionally have no
  pin; do not bind undefined values or invent one.
- `(issuer, subject)` is unbound or already bound to this same native person.
  Never move a binding to another person. Revoke earlier password authority
  in the same transaction, including native password credentials **and every
  existing password session** for that person. Clearing a password field alone
  does not revoke those sessions. Preserve ordinary native email sessions and
  other people's password sessions.
- Insert a native session with issuer, subject, optional `sid`, pin, generation,
  current account version and expiry no more than 24 hours after creation.

Return a `CompletedSession<R>` only after commit, or `null` on a refused race.
`acceptInvitation`, if supplied, must enforce the same conditions plus the
current invitation/issuer authority atomically. It is otherwise refused.

The server-only `admitVerifiedIdentity` and `createIdentityAdmission` seams
remain available with `config.externalIssuers`. The caller must already have
verified the identity cryptographically; association maps belong to server
configuration, never HTTP input. Native composition snapshots `policyVersion()`
before admission and supplies it as `principal.providerGeneration`. It strips
OIDC pin/generation fields from caller input. Both seams still enforce current
identity enablement, trusted email age, tenant/person status, immutable binding
and domain policy; only protocol-created principals carry a provider pin.
Adapters must apply the same generation, person and binding fences to these
sessions and allow pinless sessions in their step-up/owner mutation fences.
Do not add an HTTP endpoint accepting asserted identity JSON in a real app.

## Email-link lifecycle and atomic persistence

`identity/email-link/index.mjs` exports `createEmailLinkLifecycle`,
`STEP_UP_ACTIONS` and `STEP_UP_SECONDS`, with declarations beside it. It accepts
ordinary `AuthConfig` and normalizes defaults itself. Base's OA service and the
native service both use this implementation. For direct adoption supply
`EmailLinkPersistence<R>`: the native proof methods below plus account lookup,
authentication, required-provider lookup, authorized preview and atomic
consumption composition. The exported declaration gives every exact argument.
The full native service supplies that composition from `accounts` and `proofs`.

A direct `hooks.afterConfirm` runs exactly once after session issuance; return
paths are normalized and a throwing hook revokes the new session through
`persistence.revokeSession(id)` before returning refusal. Supply this durable
revocation capability with any direct completion hook; otherwise construction
fails before issuing authority. Composed services instead pass
`admission.afterConfirm`, which already owns hooks and account-store revocation.
The separate `afterConfirm` callback and `hooks.afterConfirm` are mutually
exclusive, so a callback cannot silently drop a supplied veto. Other hooks,
including `beforeMagicLink`, remain available with either composition.

`NativeProofPersistence` implements:

| Method | Required durable behavior |
| --- | --- |
| `limits(keys, now, windowMs)` | Atomically increment IP and email buckets; return each count. Keys are HMAC digests. |
| `token(record)` | Store only `hash`, never the raw bearer; bind current person ID/version/email, safe return, expiry. Recheck current authority and route; return whether inserted. |
| `preview(digest, now)` | Read a live magic proof and current authority; return the declared `NativeLinkPreview`. Never consume or create a session. |
| `consumeLink({ request, digest, person, now, returnTo })` | In one transaction recheck proof unused/not revoked/not expired, tenant, person ID/version/email/status and domain policy; consume once and issue a native session with a persisted fresh app-local proof. Return completed session after commit. Use the proof's stored safe return. |
| `revokeLink(id, now)` | Durably revoke even on uncertain delivery; errors propagate, never claim success. |
| `stepUpChallenge(record, actor)` | Store digest/action/return/expiry bound to this exact current session and person version. Recheck full current session authority atomically. |
| `stepUpPreview(digest, now)` | Inert read of the unconsumed live challenge. |
| `consumeStepUp(digest, actor, now)` | Recheck asking session ID, current person ID/version/email/status, revocation/expiry and provider authority; consume once and record local proof on that same session atomically. Issue no new session. |
| `revokeStepUp(id, now)` | Durably revoke the challenge after rejected, thrown or uncertain mail delivery. |
| `steppedUp(actor, since, now)` | Re-read current session/person authority and persisted local proof, with proof time between `since` and `now` and matching person version. Never infer proof from provider authentication. |

Use a database transaction such as D1 `batch` with an aborting guard and unique
proof digest. A preview/read followed by an unguarded consume and session insert
is **not** sufficient: restart, simultaneous confirmations and authority changes
must never yield a second or unauthorized session. A SQL update followed by a
`changes() = 1` abort guard in the same transaction is one workable approach.
All provider actor mutations repeat the stored generation, pin and 24-hour cap
inside the transaction, as well as person/session checks; an outer
`requireStepUp` read can race with revocation or a policy change.

GET/HEAD remain inert. Confirmation requires same-origin POST; unknown addresses
receive the same accepted response. Returned paths are stored after
`safeReturnTo`. Mail rejection, exception, rate-limit or uncertain status revokes
the issued proof. `development` mail counts only in configured local mode.
Step-up lasts ten minutes and only an app-local email proof can satisfy it.
The separate provider email-trust rule remains thirty days, including already
bound subjects and explicit associations with an asserted stale proof.

## Optional capabilities and refusals

There is no OA fallback for native account administration, invitations, role or
status mutations, listing/revoking arbitrary sessions, domain/provider owner
administration or credential minting. Those service methods return
`native_capability_unavailable` (501). Keep the native administration UI/routes;
use `requireStepUp` for owner-sensitive writes and repeat its proof/authority
conditions in that route's atomic mutation. This includes owner invitations,
reissue/cancellation, owner activation/deactivation, grants/removals, transfer
and owner dev provisioning.

Optional native methods are deliberately explicit:

- `issueLocalSession` enables server-verified password admission and loopback
  review. It rechecks person/version/domain policy; password issuance additionally
  requires no provider binding and a still-valid native password credential.
  The caller owns real password verification and its rate limiting.
- `bootstrap` enables setup-token owner/session creation. It must claim exactly
  one native owner atomically. The service verifies configured setup token,
  origin, allow list and rate limits before invoking it. Without durable native
  dependency setup provenance it must close first-setup identity eligibility in
  that transaction. A stale `first_setup` flag is never permission to enable
  provider sign-in on an ordinary owner-approved link.
- `completeLocalSetup` runs only behind the existing local CLI proof and with a
  current owner. Its native mutation still owns its authority fence.
- `setIdentitySettings` fences the current owner/session, audits the setting,
  increments the durable policy generation and revokes native provider sessions
  on disable. Missing `identityEnabled` storage must mean off.
- `currentBoundSubject` is required for provider-session editor authority. No
  method/no unique current subject means the editor grant is refused.
- `checkCredentialFence` enables fence checks for native minted credentials.
  Missing/null fences, inactive people and old versions are refused. It is not a
  native credential mint implementation; keep the edition's credential routes.

## Incumbent callback and legacy trust

Configure `redirectUri` explicitly for an incumbent callback, for example
`https://slate.example/api/auth/identity/callback`. Both exported HTTP handlers
own the selected callback even outside `/auth/oidc/`. The default remains
`/auth/oidc/<id>/callback`; once overridden that old path is unowned. The same
selected URI is used in authorization and token exchange. Foreign origins,
credentials, query/hash components, duplicate callback paths and conflicts with
shared auth/dependency routes are refused. Callback or policy changes invalidate
outstanding transactions; protocol state/cookie/issuer/audience/nonce/algorithm
and replay checks are unchanged.

The opt-in `preset: 'legacy-rs256'` trusts an incumbent issuer's signed
`email_verified: true`, with missing proof time counted at that sign-in. It
requires explicit exact `issuer` and `endpointPins: { authorization, token,
jwks }`, all HTTPS and allowed by `endpointOrigins`. Discovery must match these
pins, and the real RS256 signature must verify. Supplied malformed, stale or
future timestamps never become the current time. Normal Auth dated-email,
Google's gmail/hd rule, and subject-only Microsoft/Okta remain unchanged. This
preset is not a configurable bypass on those presets. Trust-preset/issuer/client
changes keep the existing pin pending an owner-approved re-link; endpoint
metadata changes refuse until the pin is explicitly re-linked. Any requested
trust/configuration change also changes the transaction fingerprint.

## Dependency reuse and migrations

Apply **only** `identity/oidc/schema/oidc.sql` for shared identity storage, and
`modules/dependencies/schema/dependencies.sql` followed by
`modules/dependencies/schema/approval-attempt.sql` if dependency linking is enabled.
Existing native adopters add `approval-attempt.sql` as a new numbered migration;
it invalidates old approvals, which must be renewed through local owner proof.
Their `oa_oidc_*`, `oa_identity_providers` and provider-health names are identity
storage, not account storage. Do not install any `accounts/schema/*.sql` for a
native seed, including `accounts/schema/dependency-setup.sql`. Add native
proof/rate/session authority columns/tables in new
numbered migrations; never edit applied migrations or copy OA people/sessions.
Preserve native roles, IDs, membership/workspace/project and existing sessions.

With `config.dependencies: true`, supply the complete
`accounts.dependencies: NativeDependencyAuthority<R>` capability. Missing or
partial capability refuses construction. `createDependencies({ auth, ... })`
and `linkedProviders` reuse the existing auth-6 pull/discovery/redemption/pinning
protocol; there is no second linking implementation. The native capability
contributes SQL fences and D1 statements to its **same** transaction:

- `unclaimed()` checks native ownership, never OA people. Optional `claimOwner`
  accepts the verified owner claim using native durable claim semantics; without
  it the claim is refused. A supplied native `bootstrap` is a separate setup-token
  path and does not imply support for identity-provider owner claim.
- Every callback needs a fresh ten-minute app-local approval obtained through
  `/auth/dependencies/relink` with the current owner's fresh local email proof.
  Configured issuer, existing link and provider continuity never replace it.
- `ownerFence` and `approvalFence` repeat current tenant/owner/session/version,
  fresh local proof and provider pin/generation/24h authority inside the shared
  mutation transaction. Shared code always checks the captured `attempt_id`,
  issuer/callback set, expiry and exact approving person/session/version both
  before network I/O and at commit. `approvalFence` contributes native authority
  for that snapshot; it does not need to duplicate the shared pending query.
  Replacing an approval invalidates an in-flight callback without consuming the
  replacement or changing the link, key, settings or audit.
- `linkedStatements` receives that `pending` snapshot, closes stale setup
  eligibility, advances generation and revokes native sessions from changed
  links. An ordinary existing-owner approval must preserve disabled identity;
  never enable it from `first_setup` alone. Owner settings and setup eligibility
  remain seed-owned. A provider move lifts native domain rules naming the old
  provider.
- `unlinkStatements` revokes native sessions, lifts domain rules, advances
  generation and records native audit rows. Shared code deletes the link,
  private key and pending approval, preserves the sector, and updates the
  identity pin in the same transaction. Native setup authority, if a seed later
  supports it, must also be deleted by this native contribution.
- `consumeLogout` receives a cryptographically verified logout and pinned link.
  Atomically recheck that exact dependency link and current native binding,
  resolve/check `sub`/`sid`, claim the unique `(issuer,jti)` once, revoke the
  intended native provider sessions, and bump the native person fence for a
  fence event. The bump must invalidate **all** that person's fenced sessions
  and minted credentials. Shared code retains the full signature/issuer/audience/
  time/events/nonce validation. Return false for refused/replayed consumption.

Static incumbent providers remain visible beside linked Auth. `auth` and its
callback are reserved when the dependency is enabled. Shared owner-claim,
dev-entry, key-exchange and persona routes also refuse callback overrides.

Dependency setup before the first native owner is an **optional, currently
unsupported capability**. The composed service exposes `authorizeDependencySetup`
but explicitly refuses it with `native_capability_unavailable` (501).
`/auth/dependencies/setup` refuses before OA SQL, pending approval or key mutation,
even with a valid setup token or local CLI proof. No OA setup migration supplies
native authority, and `bootstrap` or `claimOwner` alone does not enable this route.
Existing native installs can link immediately after their owner's ordinary
email confirmation or step-up. New native installs must first claim an owner
through their supported native bootstrap, then obtain that same local proof.
An empty native install cannot use an initial dependency link for IdP owner
claim through this composition; seed integrations requiring that journey must
add and verify native setup provenance first.

Supporting that optional journey in future requires one atomic native setup
contribution to this same protocol: unclaimed/setup-token or loopback CLI
authority, unique attempt, native bootstrap owner/version/exact session/expiry,
current provider policy and pin where applicable, and completion/replacement
and unlink provenance. It must not create a parallel approval protocol or query
OA account/session/setup tables. Until supplied, refusal is deliberate.

## Slate and HappyToHelp continuation

`withDevIdentity` remains Base's OA-specific local persona wrapper; do not mount
it over a native seed. Native dev entry/persona provisioning remains the seed's
responsibility, with the shared dev key gate and owner-proof rules. The composed
native service reads already-issued native dev sessions only behind that gate.

Slate's prepared identity-only adapter is a starting point, not ready to mount:
add native session lookup/signout, durable person authority revisions, proof
persistence and atomic provider binding/issuance. Keep its server-selected
workspace, member IDs, groups/guest roles and native cookie; configure its exact
`/api/auth/identity/callback` and incumbent issuer/endpoints. Preserve historical
bindings and live native sessions. Retire the native identity engine only after
its real integration and previous-store fixture passes with the new migrations.

HappyToHelp supplies its owner/admin/operator/contact role union unchanged and
selects project/account scope server-side. End-customer widget sessions remain
outside this staff service. Keep password verification for unbound accounts;
provider binding must atomically revoke password authority. Its optional `idp`
claim needs its own atomic native owner claim adapter and may ask for a password
afterwards only if the product still offers passwords. Provider-issued editor
grants require the current native owner and current bound issuer/subject.

The real workerd/D1 native fixture in `tests/native/` demonstrates these
transactions with no OA account/session tables. It is test data, not a seed
schema to copy blindly. The declarations compile a different native role union
in `tests/native-types.check.mts`. Each seed still must prove its own native
adapter and applied migrations; Base verification does not certify a cutover.
