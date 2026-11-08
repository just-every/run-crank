# Business settings

This server module applies signed Business settings to a running seed's D1
database. Requests read the applied values without rebuilding the app. Start
with the [adoption recipe](ADOPTING.md); the runtime entry is the source file
`index.ts`, with types in `types.ts`.

The seed opts in through `rer-setup.json`:

```json
"business": {
  "settings": 1,
  "values": ["display_name", "owner_name", "brand_color", "logo", "timezone"],
  "team": {"roles": {"admin": "admin", "member": "member"}}
}
```

`values` is a unique, nonempty subset of those five names and must include
`display_name`. Omit `team` for a single-user seed. Team roles map Business's
`admin` and `member` to native non-owner roles. Currency, legal/tax details and
mail sender addresses retain their setup/environment semantics. Logo has only
the signed document path; `logo_ref` is not a setup Business-field hint.

## Construction and methods

`createBusinessSettings({db, business, trust?, team?, mail?})` accepts the seed's D1
binding, its manifest block, optional trust JSON/object, and optional team
adapter. All reads use D1; constructing per request is supported. Apply
`schema/0001_business_settings.sql`, then `schema/0002_business_people.sql`
before invoking database methods. Existing installations add only the second
migration; preserve the previously applied schema.

| Method | Result and behavior |
| --- | --- |
| `handle(request)` | `Response` for the three owned routes below; `null` for other paths. |
| `read()` | `{document, rev, appliedAt, stopped, overrides, logo, team}`. `document` is the last applied signed payload or `null`; `overrides` lists field names, `logo` is the effective logo hash, and `team` lists email/state pairs. Treat the snapshot as private. |
| `resolve(field, seedValue)` | Local override, else adopted document value, else `seedValue`. For `logo`, returns metadata `{sha256,type,bytes}` or `null`, never bytes. Missing scalar values use `seedValue`; documents replace the previous snapshot rather than patching it. |
| `setOverride(field, value, actor)` | Saves an override and audit row for an adopted field. `actor` is a nonblank audit identity, at most 254 characters; the caller authenticates and authorizes the editor. |
| `clearOverride(field, actor)` | Removes the override and records an audit row. Subsequent resolution uses the document or seed value. |
| `stop(actor, guard?)` | Permanently stops future document admission while retaining applied data. The optional `{sql,args}` authority guard is checked inside its D1 batch. The caller supplies fresh owner authority. |
| `publicBrand()` | `{displayName?, logo?}`, with a versioned same-origin logo URL. Safe public branding only; no roster or owner name. |

Scalar overrides use the document validators: trimmed nonempty strings, name
length at most 120, six-digit hex colour, and valid timezone at most 100
characters. To reset a scalar, use `clearOverride`, rather than storing null.
A logo override is `null` to hide the logo, or
`{sha256, type, bytes, data}` where `data` is standard base64, `bytes` is its
decoded byte count, and `sha256` is the lowercase hex digest. The module checks
the digest, length and detected media type. Clearing that override restores
the document logo. These methods do not expose an unauthenticated editor API.

## HTTP and trust

| Route | Contract |
| --- | --- |
| `POST /api/rer/business-settings` | JSON `{"settings":"<compact JWS>","logo":"<standard base64>"?}`, at most 512 KiB including encoding. Returns an ack on 200; replay/rollback returns 409 with the current ack. Missing trust or stopped admission returns 404. Other methods return 405. |
| `GET` / `HEAD /rer-business-logo` | Effective logo bytes; 404 when absent. `?v=<first 12 sha256 characters>` requires the current hash and caches for one year with `immutable`; unversioned caching is five minutes. SHA ETag and conditional 304 supported. Old version URLs return 404 rather than old bytes. |
| `GET` / `HEAD /rer-business.css` | `:root{--rer-business-accent:...;--rer-business-accent-text:...}` or an empty body. Public 60-second cache and an ETag reflecting revision and effective colour; conditional 304 supported. |

Logo responses include `nosniff`, a sandbox CSP and
`Cross-Origin-Resource-Policy: cross-origin`. PNG, JPEG, WebP and restricted SVG
are accepted, at most 256 KiB decoded. Logo bytes are required when a new
document hash differs from the stored hash; matching hashes can omit bytes.
A document with `logo:null` clears the stored document logo. Overrides survive.

`RER_BUSINESS_TRUST` is public verification configuration, never a signing key:

```ts
type Trust = {
  v: 1
  issuer: string                 // exact platform origin
  audience: string               // exact app origin, or "self-host"
  subject: string                // installation id, or Business/app identity
  email?: string                // normalized claimed-owner email
  keys: Record<string, JsonWebKey> // kid -> public EC P-256 JWK
}
```

An omitted `email` must be supplied by `team.ownerEmail()`. If both exist, the
payload must match both. This owner binding is required even for documents
without a team; a seed without an adapter must include `email` in trust.
Hosted requests must also arrive at the configured audience origin.

The closed JWS header is `{alg:"ES256",typ:"rer-business-settings+jwt",kid}`.
Its closed payload contains `v:1`, `iss`, `aud`, `sub`, `business`, `email`,
`jti`, `iat`, `exp`, safe integer `rev`, `values`, `logo`, `team`, and
optionally `owner_id` and `detached:true`. The signed lifetime is at most 24 hours. Scalar
`values` holds only the four non-logo slots. `logo` is null or
`{sha256,type,bytes}`. `team` is null or up to 500 unique normalized emails
with `{id?,email,name,role,invite}`; `role` is `admin` or `member`, and `invite` is a
nonnegative integer used to request re-invitation. `owner_id` and member `id`
are optional nonblank Business person identifiers. Supplied member IDs must
be unique and differ from `owner_id`. Documents without IDs remain valid.

The ack is `{rev, applied, overrides, logo, team}`. `applied` and `overrides`
contain field names, `logo` is the effective logo hash or null, and
`team` contains `{email,state}` where state is `invited`, `active`, `inactive`
or `conflict`. It includes teammate emails; do not expose it publicly or log
document bodies, tokens or roster data.

## Team and lifetime

The [team adapter contract](ADOPTING.md#5-integrate-native-team-accounts) keeps
settings, logo, native accounts and managed-member records in one D1 batch.
The module owns revision comparison, its per-apply nonce fence, and `bs_team`.
The adapter prepares native writes, then sends invitations only after commit.
`team:null` leaves membership unchanged; `team:[]` removes all Business-managed
members. Existing accounts not owned by this integration are conflicts, and
the owner is never changed or granted through the roster.

`bs_settings.owner_id` stores the signed owner identifier. `bs_team` stores
`business_id` and the signed `business_role` beside its native `operator_id`;
the Business role remains `admin` or `member` even when native roles use other
names. These values belong to the module, so custom adapters do not need to
return them. The adapter still returns the complete managed ledger, including
inactive native identities. A later document that omits IDs retains established
bindings. An explicit ID follows its native operator when either the signed
roster email or the native sign-in email changes. Replacing an established
owner ID, reassigning a roster binding to another ID, or moving onto another
retained binding's email is refused. Unused IDs can be added to legacy records.
Business token sponsors must resolve these stored IDs to native operators;
email matching is not a Business token authentication method. Check native
account activity and the ledger state on each call.

`stop()` and signed `detached:true` keep the last values, logo, overrides and
members. They close the document door; rendering and existing team access
continue. Detachment records the newer revision while keeping the previous
content. There is no public restart/reset method. Removing trust also closes
the door without deleting data.

`testing/index.mjs` exports `fixtureKeys`, `testTrust`, `testDocument` and
`signSettings` for tests. It loads a fixture signing key and Node APIs: import
it only from test code, never from a Worker or browser bundle. It is a source
test entry, not a claimed npm package export.
