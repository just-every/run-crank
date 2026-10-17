# Application dependency links

This module implements the application side of the pull-link protocol. Auth's
provider implementation (auth-7) is separate. `createDependencies` mounts the
well-known routes and owner controls; `AuthConfig.dependencies: true` resolves
OIDC client settings from the persisted link and the server-generated key.
No client ID or private-key environment answer is needed. The default seed and
composed foundation declare an optional `oidc-provider@1` dependency using the
`IDENTITY_PROVIDER` URL answer. A blank answer keeps email-link access working.
Other interfaces use the same handshake, storage and callback; only the OIDC
adapter adds OIDC discovery, sessions, domain policy and owner claims.

## Discovery and registration

`GET /.well-known/rer-dependencies` returns `name`, `version: 1`, the exact
`origin`, stable `sector_id`, `provides`, `dependencies`, `claim`, `callback`, and
`jwks_uri`. Each dependency has `interface` (for example `oidc-provider@1`),
`optional`, `cardinality: 1`, selected `provider` origin or null, registered
same-origin `paths` as absolute URLs, and a per-interface `jwks_uri`.
`GET /.well-known/rer-link/jwks/INTERFACE` publishes an ES256 public JWK only.
The unqualified JWKS URL selects the identity interface. The application retains
its private key in the server database. Sector/install identity survives re-link,
provider moves and export/import. Keys are isolated per interface.

Provider origins and metadata endpoints require HTTPS. Under `rer dev` (the
`local` option, which needs a loopback app origin) a provider may instead be
another locally running seed at `http://127.0.0.1`, `http://[::1]` or
`http://localhost` on any port, so two local seeds can link; every other `http`
address and every hosted deploy still requires HTTPS.
Every provider serves `/.well-known/rer-dependencies` with the same graph fields,
including its `provides` list and selected dependency provider origins. The CLI
traverses these documents before setup effects, including selected optional
edges, and refuses cycles, invalid references and oversized graphs.

A provider serves `GET /.well-known/rer-provider` with `issuer`, `version: 1`,
`interface` or `provides`, and absolute `initiate`, `redeem`, `deregister` URLs.
All three endpoints must be HTTPS on exactly that issuer, with no query,
fragment or URL credentials. OIDC additionally serves standards discovery with
`rer_interfaces: ["oidc-provider@1.0.0"]` and compatible authorization, token,
JWKS, ES256 and private_key_jwt support. The application pins those metadata and
interface versions; callback input cannot select an endpoint or change the pin.

## Owner approval and pull handshake

1. The provider owner approves this exact app origin, interface and callback set.
   For unattended `rer setup` or `rer deploy`, the provider issues an opaque,
   one-use approval lasting at most one hour. Save it in an untracked 0600 file
   named by `RER_LINK_TOKEN_FILE`. For multiple interfaces, use
   `RER_LINK_TOKEN_FILES` instead: a JSON map such as
   `{"oidc-provider@1":"auth-approval.json","error-sink@1":"errors-approval.json"}`.
   Each interface needs a distinct private file; all pending approvals are
   validated before setup effects and each consumed file is deleted. Its JSON envelope is
   `{token, issuer, interface, origin, callbacks, issuedAt, expiresAt}`; times are
   integer epoch milliseconds. `callbacks` is exactly the fixed link callback
   plus the dependency's registered paths. Git-tracked files are refused.
2. Before any provider callback, the app must hold its own ten-minute approval.
   On an empty app, `POST /auth/dependencies/setup` accepts `{issuer,interface,token}`
   using the app's private setup token, or the local CLI proof on loopback only.
   Local onboarding opens these approvals before native bootstrap. Hosted deploy
   uses the deployed app's setup token, never a local HMAC. Base account bootstrap binds
   pending setup approvals to that owner's version and exact bootstrap session;
   callback commit requires that session to remain active, unrevoked and unexpired.
   A signed IdP owner claim may convert that same session to OIDC while sibling
   setup approvals remain pending. Those approvals also require enabled provider
   sign-in, the current policy generation and the session's matching linked
   provider pin, including when claim completes during callback redemption.
   After claim, use the current owner's fresh email proof at
   `/auth/dependencies/relink`.
   The CLI posts `{origin, interface, token}` to the provider's pinned `initiate`
   endpoint. Interactive provider-owned approval can start the same pull without
   a CLI token. The provider fetches the app's document and public JWKS, verifies
   its approval against that origin and exact callback set, and stores the key,
   sector, interface and registration paths with a short one-use code.
3. The provider posts only `{issuer, interface, code}` to the fixed app URL
   `/.well-known/rer-link/callback`. The app accepts only its configured/trusted
   issuer named by that fresh app-local approval. Every callback, including an
   unchanged link or a link after unlink, requires a new approval. The exact
   attempt, owner/session authority and link snapshot are rechecked atomically
   after redemption; replacing an approval invalidates in-flight callbacks. It never
   follows a callback URL supplied in the request.
4. The app durably consumes the code digest and posts to the pinned `redeem`
   endpoint: `{code, interface, origin, callback, client_assertion_type,
   client_assertion}`. Assertion type is
   `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`. Its signed ES256 JWT
   has `iss` and `sub` equal to the app origin, `aud` equal to the redeem URL,
   `iat`, `exp` at most 60 seconds later, unique `jti`, `code`, `interface`,
   `sector_id` and the fixed `callback`.
5. The provider verifies the signature against the key fetched at approval,
   audience, times, unique assertion/code use and every bound registration
   property. Code redemption is atomic: concurrent requests have one winner.
   The response contains `{issuer, interface, origin, callback, sector_id,
   client_id}`. For an existing same-provider link it must retain the client ID
   and provide `continuity: "previous-key"` after proving the previous key, or
   `continuity: "provider-owner"` after fresh provider-owner approval. A new key
   alone is never continuity proof. The app checks these values and commits the
   link and OIDC pins in one transaction. The provider returns `{linked:true}`
   from initiation only after the app accepted the callback.
6. The CLI checks the app's accepted link then deletes its approval file. The
   token never enters public answers, runtime variables, logs or exports. An
   unchanged completed link needs no token on later setup. An explicitly supplied
   token is always validated. Changed provider answers retain the old link and
   require a new app-local approval and provider approval.

Provider implementations must enforce code and token expiry, one-use redemption,
origin/callback binding and key continuity themselves. The application-side
network tests model those provider obligations without contacting a live service.

## App owner controls and claims

Normal Base account setup claims the native owner first, then links. Only that first setup's
successful identity link enables `idpSignIn` automatically. The setup attempt
 must have been opened before that native claim; a native claim without one
 closes eligibility in its transaction. A link completed before a native claim
 cannot authorize a later relink to enable sign-in. The CLI closes that
first-setup eligibility after successful setup, including a blank optional
provider. Existing and imported installs remain off until their current owner
enables the app setting. `GET/POST /auth/settings/identity` has JSON and plain HTML
forms, requires the current owner, records effective changes in `oa_auth_audit`,
and never accepts platform authority. Any valid settings POST closes setup
eligibility, including an unchanged value, without auditing a nonexistent change
or advancing the session generation. Turning off increments a session generation
and revokes provider sessions. In-flight callbacks cannot cross that generation;
turning on never restores old sessions. Provider identity or roles alone grant no
app membership: accounts or invitations remain authoritative.

An app linked before claim advertises `claim: true` and requests the OIDC `claim`
scope. SETUP owner-claim mode `idp` names the declared identity dependency and
`/auth/owner-claim`. The provider can return `install_owner` from link redemption
or an OIDC ID token containing the grant. The former value is itself a signed JWT;
the latter is the signed ID token. Both use the pinned issuer, client audience,
subject, fresh verified designated email, unique jti, iat and exp (at most five
minutes), and `install_owner: {client_id, sector_id, subject, email}`. The app
requires all four properties to match its own installation and designated owner.
The existing bootstrap transaction commits owner, grant consumption, binding,
setting audit and provider session together. Durable issuer/client uniqueness
allows one owner grant even after a restart; the grant never becomes an ordinary
role or a general sign-in credential. CLI readiness also verifies the local owner
exists; linking alone is insufficient.

`POST /auth/dependencies/relink` with `{interface,issuer}` requires the current
owner's fresh app-local email proof. It creates a ten-minute pending approval
bound to interface, issuer, exact callback set, owner, owner version and session. A provider move
keeps existing principal bindings immutable; new-issuer access needs a newly
proved email matching an existing account/invitation. `POST
/auth/dependencies/unlink` with `{interface}` uses the same owner proof, deletes
that interface's link, key and pending approval while retaining the sector, revokes only its provider sessions, and lifts only its
provider domain rules before any network call. Signed deregistration is best
effort; offline providers cannot prevent local removal.

## Sessions, logout and portability

Provider sessions record issuer, subject, sid and policy generation and last at
most 24 hours. OIDC sessions also record their provider pin. Each completed
re-link advances that provider's monotonic link timestamp, including an unchanged
metadata re-link in the same millisecond. Binding, invitation acceptance and
session issuance check the captured pin inside their transaction; session reads
and privileged writes also require that pin to remain linked. Unrelated
providers and native sessions retain their own authority. Existing consumers
apply `accounts/schema/provider-pins.sql` as a new numbered migration (the
default seed uses `0014_provider_pins.sql`). Existing consumers also apply
`operator-auth/accounts/schema/dependency-setup.sql` and
`dependencies/schema/approval-attempt.sql` as new migrations (default-seed
`0015` and `0016`). Native-account consumers apply only the latter alongside
their own native migrations; they must not install the OA setup schema. The
latter invalidates older pending approvals. Auth email proof must be dated, valid and no older than 30 days,
even for a bound account. Explicit mappings between an upstream subject and email remain
supported only when they do not contradict an asserted stale proof.

`POST /auth/oidc/auth/logout` accepts `logout_token` and ignores other fields.
Use a signed JWT with `typ: "logout+jwt"`, pinned issuer/client audience, current
iat/exp, nonempty durable one-use jti, no nonce property, and sub or sid. When
both selectors exist they must agree. `events` must contain an empty object at
`http://schemas.openid.net/event/backchannel-logout` or
`https://runeditrun.com/events/identity-fence`; unknown events are refused.
The fence event increments only the selected person's durable identity fence.
All their fenced sessions and minted credentials then fail admission, while
other people remain active. Ordinary ID tokens with any `events` property are
refused. Credential consumers must record/check the fence; the provided
`mintCredential`/`authenticateCredential` functions also refuse legacy credentials
with no recorded fence. Editor grants require the actual current install owner;
OIDC sessions must also match that owner's current issuer/subject account binding.

Exports omit server link keys, approvals, code state, provider sessions and OIDC
transients, preserve durable people/bindings/grant use/sector, set sign-in off and
mark links as needing re-link. Import checks these conditions and requires an
explicit fresh provider approval. Local `rer import` returns `needsRelink: true`
and `nextCommand: "rer setup"`; that setup continuation consumes the fresh approval
and retains the imported sector and bindings. `rer doctor` reports dangling providers or a
needed re-link without reading or emitting private keys or approvals.

## Native accounts

Native `createOperatorAuth` composition reuses this protocol with
`accounts.dependencies: NativeDependencyAuthority<R>`. Missing capabilities
refuse enablement. Native authority checks and revocation statements join the
same D1 link/unlink transaction; verified logout consumption uses the native
binding/session/fence store atomically. No OA account tables are queried.
Every native callback requires a new local owner approval, including initial
and unchanged links. Shared code fences the exact attempt and approving
person/session/version snapshot at preflight and commit; native contributions
repeat their own current authority. Ordinary owner linking preserves disabled
identity regardless of stale setup flags. Unlink deletes the link, key and
pending approval while preserving the sector.

Native dependency setup before a first owner is currently unsupported:
`/auth/dependencies/setup` and `auth.authorizeDependencySetup` explicitly refuse
with `native_capability_unavailable` (501) before pending/key mutation or OA
setup SQL. Claim the native owner through the seed's supported bootstrap, then
confirm a local email proof and approve at `/auth/dependencies/relink`. A native
`claimOwner` capability alone does not make an empty installation's initial IdP
link/claim journey available. Static incumbent providers remain available beside
linked Auth.
See [the exact native contract](../operator-auth/docs/native-accounts.md) for
method arguments, migration selection, proof fences and adoption steps.
