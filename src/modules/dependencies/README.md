# Application dependency links

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

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
its private key in the server database as an AES-256-GCM envelope
`{version:1,kid,iv,ciphertext}`. The 96-bit random IV and 128-bit tag authenticate the
AAD `rer-at-rest-v1|rer_dependency_keys|<interface>|1|<kid>`, binding the table,
interface, envelope version and installation key ID. HKDF-SHA-256 derives a
dedicated encryption key from
`INSTALLATION_KEY` with the `rer-at-rest-v1:dependency-key` domain. The envelope's
`kid` identifies that installation secret; it is separate from the signing JWK's ID.
`INSTALLATION_KEY` requires the generated 256-bit key's 64 lowercase hex
characters; passphrases and other formats are refused. `rer setup` generates the
secret in the private settings file; hosted deploys
keep their own generated secret in `.rer/deploy/<environment>.secrets.env`
(mode 0600), exactly like `SESSION_SECRET`. Neither secret enters archives.
Pass both installation bindings to `createDependencies` and `AuthConfig`.

Legacy plaintext is accepted only before the installation records sealed
custody; a read upgrades the requested interface, and full rekey upgrades every
row in one D1 batch. After the last legacy key is upgraded, the durable
`keys_sealed` marker prevents plaintext from being reintroduced. The non-secret
`key_ids` history distinguishes retired versions from damaged envelopes. An
optional `INSTALLATION_KEY_PREVIOUS` permits reads across rotation; old rows
are re-sealed under the current key. Missing keys, malformed envelopes, wrong
keys and changed interface AAD fail closed with `installation_key_missing` or
`installation_key_unavailable` (503), without treating ciphertext as plaintext.
Rotate hosted custody with `rer deploy --rotate-secret INSTALLATION_KEY`:
rer retains both values privately, publishes both bindings in one Worker version,
re-seals every row, checks that every row opens with only the current key, then
retires the previous Worker binding. Routine rotation uses only the current/previous
pair; older retired keys require explicit reopen. By default, every retired
private value stays in the same 0600, Git-ignored file as `SESSION_SECRET`, in
`INSTALLATION_KEY_RETIRED=<kid>:<value>[,<kid>:<value>...]`; none is routinely
bound to the Worker. An interrupted operation resumes with the same pair. Back
up this private custody securely and retain it when moving checkouts.

Retain each retired key until no D1 Time Travel recovery point or exported backup
predates the completed rotation that retired it or otherwise needs that key.
After any rotation or reopen has finished, edit
`.rer/deploy/<environment>.secrets.env` and remove only its `<kid>:<value>` entry
from `INSTALLATION_KEY_RETIRED`, keeping valid comma separators; remove the
assignment if no entries remain. Preserve the current key, all other entries
and the file's owned 0600 permissions. There is no per-key removal command;
reopening a removed ID refuses before provider writes unless its custody is restored.

Restoring D1 backups or Time Travel from before a rotation may require an older
key. `rer deploy --reopen-installation-key KID` explicitly publishes the current
key and that retained retired key as `INSTALLATION_KEY_PREVIOUS`, re-seals and
verifies every row under the current key, then removes the previous binding.
CLI-side reopen rekey uses every validated retired key in private custody, so a
mid-rotation snapshot containing rows under multiple retired keys can be reopened
with either retained ID. Only the selected pair is published to the Worker.
Reopen/rekey reports the D1 `key_ids` tail and whether each history ID is in
custody before opening rows, including when the tail check refuses the restore.
It retains retired custody and resumes the same pair after interruption. Missing
retired custody refuses with `installation_key_unavailable`; recover the private
file before reopening. A whole pre-rotation D1 restore also restores `key_ids`:
if its tail is absent from configured custody, reads refuse with
`installation_key_unavailable` before inspecting envelopes. When that custody
check succeeds, a historically known envelope key ID whose key is no longer
configured yields `installation_key_version_unknown` (for example, a row-only
restore that retains the current installation history);
wrong configuration, malformed ciphertext and unrecognised key IDs yield
`installation_key_unavailable`. Neither failure generates a replacement key.

Base before #367 cannot open sealed keys. Keep sealing-capable code or roll
forward after restoring D1. Current Base refuses sealed envelopes on its
plaintext signing path with `installation_key_sealed_rollback`; old binaries
cannot acquire that check retroactively.
Session rotation never changes this key.

This protects signing keys in a D1 dump or backup obtained without the Worker
secret. It does not protect them from a compromised Worker or someone holding
both the database and the installation secret. Sector/install identity survives re-link,
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

To back up and restore this installation, apply the following identity policy
to its archives. This is separate from bringing records in through the door.
Archives omit server link keys, approvals, code state, provider sessions and OIDC
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
