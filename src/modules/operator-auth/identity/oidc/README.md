# Identity providers (OpenID Connect)

Server-only portable ESM using Fetch and WebCrypto. An app offers several
providers at once; each is pinned when linked and has its own routes. A
provider's output is a verified principal, which the admission (an accounts
adapter, `../admission.mjs`) turns into a session. Apply `schema/oidc.sql` as a
new numbered migration on the primary D1 database; every statement is
`IF NOT EXISTS`, so a store that had the earlier single-issuer adapter applies it
again as its next migration.

```js
import { createOperatorAuth, createAuthHandler, createSignInHandler } from './modules/operator-auth/index.mjs';
const clientAuthMethod = 'client_secret_basic';
const auth = createOperatorAuth({
  db: env.DB, clientIp, mailSender,
  // The runtime's fetch; on workerd use redirect 'manual' and refuse every 3xx.
  fetch: providerFetch,
  waitUntil: promise => execution.waitUntil(promise),
  config: {
    origin: 'https://app.example.com', OWNER_EMAIL: env.OWNER_EMAIL, SESSION_SECRET: env.SESSION_SECRET,
    // Independent of SESSION_SECRET; at least 32 characters. Both are Worker secrets.
    OIDC_TRANSACTION_SECRET: env.OIDC_TRANSACTION_SECRET,
    providers: [
      // The app's private key (a Worker secret) authenticates it: no shared secret exists.
      { id: 'auth', preset: 'auth', issuer: env.IDENTITY_PROVIDER, clientId: env.IDENTITY_CLIENT_ID, privateKey: JSON.parse(env.IDENTITY_PRIVATE_KEY) },
      { id: 'google', preset: 'google', clientId: env.GOOGLE_CLIENT_ID, tokenAuthMethod: clientAuthMethod, clientSecret: env.GOOGLE_CLIENT_SECRET },
      { id: 'corp', preset: 'okta', issuer: 'https://corp.okta.com', clientId: env.OKTA_CLIENT_ID, privateKey: JSON.parse(env.OKTA_PRIVATE_KEY),
        subjectEmails: { '00u1abcd': 'operator@corp.example' } },
    ],
  },
});
// GET /signin: "Continue with…" for each linked, reachable provider, then the email link.
const page = await createSignInHandler(auth)(request);
// /auth/oidc/<id>/start and /auth/oidc/<id>/callback, with the rest of /auth/*.
const response = page ?? await createAuthHandler(auth)(request);
```

Register each provider's own redirect URI: `${origin}/auth/oidc/<id>/callback`,
or an explicit same-origin `redirectUri` for an incumbent route. Both exported
HTTP handlers own that configured callback outside `/auth/oidc/` too. The old
default route is unowned after an override. Conflicting callbacks, foreign
origins, credentials, query and fragment components are refused.
`createOidcProviders({ admission, db, config, clientIp, fetch, clock, waitUntil })`
is the same client for a seed whose accounts adapter is its own.

## Presets

| Preset | Issuer | ID-token algorithms | Client authentication | Email trust |
| --- | --- | --- | --- | --- |
| `auth` (RER's Auth) | the install's exact HTTPS issuer | ES256 | `private_key_jwt` only | `email_verified` with `email_verified_at` in the last 30 days |
| `google` | `https://accounts.google.com` (fixed) | RS256 | `private_key_jwt` (default), `client_secret_basic`, `client_secret_post` | `email_verified`, and only for `@gmail.com` or tokens carrying a matching `hd` |
| `microsoft` | `https://login.microsoftonline.com/<tenant>/v2.0` from `tenant` (never `common`, `organizations` or `consumers`) | RS256 | as Google | never by email: only `subjectEmails` |
| `okta` | the organisation's exact HTTPS issuer | RS256 | as Google | never by email: only `subjectEmails` |
| `legacy-rs256` (explicit incumbent opt-in) | exact HTTPS issuer plus required exact `endpointPins` | RS256 | as Google | signed verified email; missing timestamp counts at sign-in, supplied timestamp must be current and valid |

`none` and every `HS*` algorithm are never accepted; a token whose `alg` is not
in its link's pin is refused before any key is looked up. GitHub is not an
OpenID provider and is not offered. Outside the explicit incumbent preset, other upstreams identify people only
through explicit `subjectEmails`, a trusted server map from the provider's `sub`
to an existing operator's email (never populated from a callback, a token email
or a request).

An `auth` provider must state, in discovery, the interface it serves:
`"rer_interfaces": ["oidc-provider@1.0.0"]`. One below the minimum
(`MINIMUM_PROVIDER_VERSION`, or a provider's higher `minimumVersion`) is refused
and nothing is pinned.

The incumbent preset requires `endpointPins: { authorization, token, jwks }`.
Discovery must match these exact HTTPS URLs; this does not loosen Okta,
Microsoft, Google or Auth trust. See [native adoption](../../docs/native-accounts.md)
for the full persistence and callback contract.

Callback overrides cannot occupy shared owner-claim, sign-in, auth, dependency
or dev routes, including `/auth/owner-claim`, `/auth/dev/enter`, `/__dev/key` and
`/__dev/personas`. These routes keep their original handlers; an incumbent path
such as `/api/auth/identity/callback` is supported with the same transaction
binding as the default callback.

## Linking and pinning

A provider is linked at its first use: discovery is fetched and the link pins
the issuer, client id, JWKS URI, authorization and token endpoints, the allowed
algorithms (the preset's, as advertised), the client authentication method, and
whether the provider sends RFC 9207 `iss`. Every later start fetches discovery
again and refuses (and hides the provider) if it no longer matches the pin; only
the owner's re-link changes a pin.

A changed configuration (for example a new `IDENTITY_PROVIDER` answer: another
issuer or client id) only records a **pending re-link**. Sign-in keeps using the
pinned provider; nothing is swapped in place. The owner completes the re-link at
`POST /auth/providers/relink {provider}`, or ends a link at
`POST /auth/providers/unlink {provider}`, each with a fresh step-up proof.
`GET /auth/providers` lists the pins and pending re-links. Completing a re-link
invalidates logins in flight. An unlinked provider stays unlinked even while its
configuration remains, until the owner re-links it.

## The protocol

`POST /auth/oidc/<id>/start` (exact Origin, matching Host, no cross-site Fetch
Metadata; JSON or a native form with `returnTo`, at most 4096 bytes) sends
`response_type=code`, `response_mode=query`, the preset's scope, independent
256-bit state and nonce, and mandatory S256 PKCE to the pinned authorization
endpoint, with a per-state browser-binding cookie (`__Host-oa_oidc_<state>`, or
`oa_oidc_local_<port>_<state>` on a loopback origin). State is keyed to its provider:
an authorization response for one provider presented at another provider's
redirect URI finds no transaction and is refused (the mix-up defence), and no
code reaches the wrong token endpoint.

`GET /auth/oidc/<id>/callback`, in order: exact route and method, no duplicate
parameters, state and its browser binding consume the durable transaction once
(`DELETE … RETURNING`, before any exchange), the transaction belongs to this
provider, RFC 9207: `iss` must equal the pinned issuer where the provider sends
it (and is required where its discovery says so), a provider error is reported
without its text, then the code is exchanged at the pinned token endpoint. With
`private_key_jwt` the app sends a one-minute RFC 7523 assertion signed by its own
key (`iss`=`sub`=client id, `aud` the token endpoint, unique `jti`); no secret is
shared. The ID token's header must name a pinned algorithm and a kid; the key
comes from the link's cached JWKS, refetched **once** when the kid is unknown and
refused if still unknown; a substituted key under a known kid fails without a
refetch. Then the signature, `iss` (the pinned issuer), `aud`/`azp` (this client,
plus explicitly trusted `additionalAudiences`), `exp`/`iat`/`nbf`, `nonce`, and
`at_hash`/`c_hash` when present. Access and refresh tokens are never stored or
returned.

The principal then carries the provider's email only as far as its preset
trusts it, and the admission refuses, in production (not `local`), `amr`
containing `dev` and addresses under `.localhost`, `.test` or `.invalid`. A
proof older than 30 days does not count. Successful callback returns 303 to the
**stored** local `returnTo` with the session cookie.

Errors are JSON `{error:code}` for API callers; a browser navigation or native
form post (`Accept: text/html`) is sent back to the sign-in page with
`?notice=<code>` and the email link. Codes include `oidc_invalid_correlation`,
`oidc_issuer_mismatch`, `oidc_audience_mismatch`, `oidc_algorithm_refused`,
`oidc_unknown_key`, `oidc_provider_denied`, `oidc_admission_denied`,
`oidc_provider_required`, `oidc_provider_unavailable`, `oidc_relink_required`,
`oidc_provider_version_unsupported`, `oidc_rate_limited`, `oidc_storage_unavailable`.

## Reachability

Every discovery and JWKS call records the provider's health in
`oa_identity_provider_health`. A provider that has failed discovery or JWKS for
5 minutes (`HIDE_AFTER_MS`), or answered 404 or a DNS failure (a resolver error,
or the 530 a Worker receives for an origin DNS failure), is hidden from the
sign-in page, which offers the email link instead of redirecting. A hidden
provider is checked again at most once a minute, after the page answers
(`waitUntil`), and shown again once a check succeeds.

Connection health is separate from the pin's `status`. `list().linked` and
`links().healthy` require a successfully exchanged, signature- and claim-verified
ID token for the current `linkedAt` generation, with no subsequent provider-side
exchange or reachability failure. A token endpoint's HTTP 400 `invalid_grant`
refuses the bad or replayed code without changing connection health. Network
failures, HTTP 5xx, `invalid_client`, and invalid ID tokens or JWKS still invalidate
exchange health. A pin created by discovery alone is not healthy. Successful
discovery or a JWKS probe cannot clear exchange failure; a valid new exchange
can. Application membership and admission remain separate from provider health.
The existing health table stores exchange observations under reserved
`exchange:<id>:<linkedAt>` keys (configured IDs cannot contain colons), so older
stores need no schema change. Writes fence the current pin and prune obsolete
exchange generations. Relinking therefore requires fresh exchange proof.

After upgrading, existing provider links show **not linked** until the next
successful sign-in through **each provider**, because older stores have no
verified exchange observation for those links.

## Storage and limits

`oa_oidc_transactions` stores domain-separated HMAC hashes of state, binding and
the provider's pin, plus the AES-GCM sealed nonce, verifier, returnTo, expiry and
provider id. `oa_oidc_limits` counts starts per provider, client address and
15-minute window (default 30, `identityStartLimit`). `oa_identity_providers`
holds the pins and cached JWKS. Delete expired rows from the two transaction
tables periodically (`expires_at <= now`, milliseconds). Discovery and token
JSON are limited to 64 KiB, JWKS to 256 KiB and 100 keys; each call has a
deadline including the body (default 5000 ms, `identityTimeoutMs`); redirects are
never followed.

## Checks and proof boundary

`node --test modules/operator-auth/identity/oidc/tests/*.test.mjs` runs the
protocol suite on Node SQLite (`client.test.mjs`, `boundaries.test.mjs`) and the
fake-provider suite through the public HTTP door in real workerd with D1
(`providers.test.mjs`): a happy path per preset, the mix-up, wrong `iss` and
`aud`, `none`/HS256/unlisted algorithms, an unknown kid refetched once then
refused, a replayed state, `amr: ["dev"]`, unverified, stale and unproven
emails, bindings, the domain rule, step-up for each action, reachability, the
minimum version and the re-link. Fakes stand only at the provider edge
(`idp.mjs`, `fake-worker.mjs`). This proves the module, not a real provider
account, client registration or deployment.
