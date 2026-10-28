# Adopt the agent door

The edition owns its tools, native adapters, migrations and release evidence. The
module provides the shared transport, credentials, policy and review machinery.
Keep the edition's existing interface and authorization decisions authoritative.

## Copy committed runtime source

Choose an immutable full Base commit containing the module. A released or
unreleased commit is equally usable; a package release is not required to copy
runtime source. Use a Base checkout containing that commit and the previous pins
when refreshing existing copies.

For a first copy, from the edition's Git root, replace `FULL_BASE_COMMIT` and
`/absolute/base-checkout` with the chosen commit and checkout:

```sh
mkdir -p src/base/modules/agent-door
git -C /absolute/base-checkout archive FULL_BASE_COMMIT modules/agent-door | tar -x -C src/base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base src/base/modules/agent-door modules/agent-door FULL_BASE_COMMIT --base /absolute/base-checkout
```

This copies committed bytes from `modules/agent-door/` into
`src/base/modules/agent-door`. The record command writes its origin commit,
file digests and modes into `base-copies.json`. Review any reported differences,
omissions or edition-only files. Keep the record with the edition source.

Refresh recorded copies from the edition's Git root:

```sh
rer refresh-base --ref FULL_BASE_COMMIT --base /absolute/base-checkout
```

`--ref` accepts any full Base commit available from that checkout, released or
unreleased. The installed CLI version and the selected runtime-source commit are
separate pins. Refresh moves all recorded copies selected by the record, so
inspect the complete change. It preserves acknowledged adaptations and refuses
undeclared local edits. Applied migration history remains the edition's
responsibility: never refresh a copied schema over an applied migration. If the
edition uses a source lock, refresh it
with its existing authoring command after staging intentional changes. See the
[edition authoring guide](../../export/EDITION-AUTHORING.md) for offline refresh,
adaptations and copy verification.

## Wire the edition

Use explicit `.ts` extensions in runtime imports so the copied source can also
run under Node's TypeScript stripping. Copy the module's SQL into a new,
additive migration in the edition's migration sequence. Apply it through the
edition's existing migration runner; preserve all previously applied migrations.

Mount one door at the documented paths in the existing Worker and return its
response when its handler recognizes the request. Leave ordinary application
routes with the edition's existing router. Supply the edition origin, seed,
name, specialist, database, tool registry and people adapter.

Import `createAgentDoor` from the copied `index.ts` production entry, not an
internal implementation file or the test-only conformance signer. Route its
`handle` before ordinary app authentication redirects so MCP credentials and
signed policy adoption reach their own checks. Retain the edition's native
person session and Origin and CSRF controls. The [route and capacity reference](README.md)
lists the owned paths and defaults; these are request capacities, not company
policy limits.

Use `operatorAuthPeople({db, session, allowList})` to connect live operator accounts. Pass
the edition's native session reader as `session` and the same parsed
`AUTH_ALLOW_LIST` native session admission uses. Copy the additive
`modules/business-settings/schema/0002_business_people.sql` into a new migration
as well as adopting the Business settings module. Business sends `owner_id` and
team `id` before minting access tokens, using the same Business person id as
`sub`. `people.sponsor({sub})` resolves only through that durable mapping; token
email never selects a local account. Implement `people.person(id)` to re-read
native ids for approval execution, Undo, embedded agents and subscriptions.
Expose `businessMember(person)` from the same mapping for paired policy refs:
Business owner is owner, Business team admin is editor, member has no policy
role. The native role may differ. Local credentials return `sponsor: { id }`,
read by `people.person`, rather than an address. Sponsorship is resolved from
current native people on each request; an unknown or inactive sponsor cannot
act. A saved token never replaces this account check. Keep native permissions,
resource ownership and business invariants inside each tool's native service.
Carry the sponsor's native person ID for authorization and database relations;
record both the agent and sponsor in audit attribution.

Pass the installation's existing owner-claim trust into the door: issuer,
installation ID, application origin (`appOrigin`) and public key ring. Keep that
origin aligned with the edition's canonical origin. Do not create another key
ring for agent access. Business credentials use the existing ring; local
credentials come only from the edition's explicit `localCredentials` adapter.
With `trust: null`, an independently operated installation can use that local
adapter under its owner's configuration. A recognizable Business credential
that fails validation is refused; it cannot become a local credential.

## Implement native tools and resources

Declare each tool's input and output JSON Schemas, scope, policy classes and
contract clauses. Classify the exact proposed effects before execution, using
native facts and units. Add only the native actions the edition supports and
retain native validation, access checks, transaction boundaries and audit.
Mutating tools require a server-computed `summary(args,ctx)` describing target,
recipients, amount, payee, role or item names. Read summaries retain declared
arguments or the resource URI. Approval views expose `summary` and
`summary_sha256`; approval and rejection send both that hash and `revision`.
Approved native actions receive `ctx.approvers`, while the agent remains the
preparer. Native reversal receives `UndoContext`: the reviewer is `person`,
`agent` is null, and `actor.kind` is person.

Tools declaring access or security require `authority(args,ctx)`, returning the
authority subject and whether the proposed change widens it. Name the native
person id, email or agent id; the door normalises these and refuses self-widening
before classification and again at approval execution. Return null only when
no standing authority is changed. Other people's changes still follow policy.
Declare `escalations: [{ id, tool, args }]` in `agent-surface.json`, covering each
access or security tool. Use `{ "$sponsor": "id" }` or
`{ "$sponsor": "email" }` as argument values; the conformance journey resolves
these and requires `self_escalation` with an unchanged native witness. Retain a
journey call proving an ordinary narrowing change too.

Return resource references for outcomes the user can inspect. Supply undo only
when the native action has a real reversal; review and approval do not invent one.

The maintained reference pattern is
`default-seed/src/agent-door/index.server.ts`, with native people and access tools
in that directory. Its tools call the seed's existing people repository and
operator-account services. Follow that division: the edition owns native
actions, resources and permission checks, while the copied module owns the
agent transport and policy pipeline. Do not copy Base's people model into an
edition with a different domain. Use `door.invoke` for embedded agents and
`door.emit` after native person changes so both enter the same event vocabulary.

Expose resources through explicit readers and treat imported or external
content as untrusted. Every resource declares non-empty catalogue `classes`
and `classify(record,ctx)`, based on the record itself. Resource reads pass through
the same policy, approval, review and audit path as tools. A resource read must enforce the current person's native
access. Mark device, screen, connector, import-door and installation operations
as outside the tool registry when they require another supported door.

## Keep runtime and CLI evidence separate

The copied module is application runtime source pinned by `base-copies.json`.
The edition's pinned `rer` CLI remains its command and authoring dependency.
Updating one does not prove or update the other. CLI conformance runs as plain
ESM against the pinned CLI; it must not depend on TypeScript loading or the
application's bundler.

`conformance/index.mjs` exports `runAgentDoorConformance`. Connect its fetch,
canonical origin, Agent surface, test-only signer and `{email,cookie,sub}` to
a disposable real installation with the edition's actual D1 schema and native
actions. Never include test signer material or fixture authority in production.
The harness's stable point prefixes describe its implemented checks; they do
not mean every baseline clause has been exercised. Module tests under `tests/`
are separate from this installation journey and the edition's browser and UI parity
work. `rer verify` pairs its per-run ring through `RER_BUSINESS_TRUST`, posts a
real signed settings document with the owner's Business `owner_id`, then mints
journey tokens carrying that subject and `consent`. No setup-mode bypass exists. Retain explicit gaps for Business consent propagation, spend and byte budgets,
long jobs, grant narrowing, outside mail, standalone policy forms and token
issuance, self-host delivery and stranger-specialist completion. Platform adoption
of the shared policy source is also separate from copying it into an edition.

Validate the integrated edition through its public doors: current sponsor and
scope checks, all exposed tool effects, policy and review decisions, migrations,
resources, audit, subscriptions and retained outcomes. Keep successful and
failed outcome evidence for at least 24 hours. This module currently retains it
indefinitely; adoption must not introduce earlier cleanup. Report the exact
edition behavior verified, separately from Base module or CLI results.

## Verification owner lifecycle

`rer verify` reads the same `rer-setup.json` owner-claim step as installation.
For `mode: "signed"` it signs a fresh five-minute `rer-owner-claim+jwt` with
the disposable installation's per-run key, matching its configured issuer,
installation ID, origin and owner email. It posts that claim to the declared
path through the production handler. Setup-token mode retains the native token
POST. No production key is read, and signed admission still rejects raw tokens.

Seeds with a native initializer or a different owner binding declare this in
`agent-surface.json`:

```json
{
  "verification": {
    "owner": {
      "email": "synthetic-owner@example.com",
      "emailField": "SETUP_OPERATOR_EMAIL",
      "tokenField": "H2H_SETUP_TOKEN",
      "initializer": "tests/initialize-agent-owner.mjs"
    }
  }
}
```

All four keys are optional. Email defaults to `synthetic-base-1@example.com`;
the manifest's email and token fields are always bound too. The initializer is
a contained seed module default-exporting an async function receiving
`{request, origin, email, sub, displayName, token, claim, returnTo}`. `claim` is
`{mode, path, token}` with the signed credential when signed mode is declared;
`token` is the private per-run setup token. Use `request(absoluteURL, init)` to
drive the seed's real project/password, owner and member-linking lifecycle.
It permits only the fresh hosted origin. Return the native final 303 `Response`
with its session cookies; then the runner posts the signed Business settings
document and runs the journey. Never create an owner with direct SQL, substitute
an auth adapter, or add a verification-only production route. Initializer code
runs as trusted test tooling in Node; it must use the supplied request function
and must not contact providers or read real credentials.

## Verification provider edges

`agent-surface.json.verification.network` declares an optional test-only edge:

```json
{
  "module": "tests/provider-edge.mjs",
  "origins": ["https://api.openai.com", "https://receiver.example.invalid"]
}
```

The contained ES module default-exports `{async fetch(request) { ... }}`.
It receives the full Web `Request`: method, exact URL, headers and raw body,
and returns a Web `Response`, including JSON or a streaming body. Relative
helper imports are supported. Run the seed's own signature/payload validation
and return realistic provider receipts here; keep native preparation, permission
checks, state commits and receipt validation in the application.
The module runs in an isolated workerd with no application bindings, Node
capabilities or network access. Its own `fetch` requests are denied, including
requests to declared origins. Only declared exact origins reach the module;
other outbound effects receive HTTP 502. Built-in Resend, SendGrid and Cloudflare
mail adapters remain available by default. Never place production credentials
in this declaration or ship the test adapter as application authority.

## Base source from an archive

A plain directory export can supply the source without a Base Git checkout:

```sh
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base src/base/modules/agent-door modules/agent-door --base-archive /absolute/base-export --ref FULL_BASE_COMMIT
rer refresh-base --base-archive /absolute/base-export --ref FULL_BASE_COMMIT
```

Use the full 40-character commit SHA from the authenticated archive acquisition.
The directory must preserve Base's paths and executable modes. It is the source
at that declared SHA; the CLI cannot authenticate an archive's commit without
Git history. Copy mapping and byte digests follow the same rules as a checkout.
History-dependent refresh operations require the historical source evidence
described in the [authoring guide](../../edition-authoring/README.md); they fail
closed when that evidence is absent.

## Interim policy boundaries

Do not register provider `cost`: construction refuses it until spend reservations
are enforced. Standalone `spend.caps` cannot be saved. A paired Business document
can contain caps but state and the page plainly report that they are not enforced.
Only seed-scoped `max_per_day` rules can be adopted from Business; company-wide
reservation requires a future Business door. Business `person:` references must
map to active local people at adoption. Business role references use the mapping,
so promoting a seed admin does not confer Business approval authority.

Business can revoke agents or consents in the signed envelope's optional
`revoked` lists. Tokens require `consent`; affected pending approvals expire and
execution rechecks revocation. Retain both these lists and historical attribution.
