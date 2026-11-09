# Adopt the agent door

The edition owns its tools, native adapters, migrations and release evidence. The
module provides the shared transport, credentials, policy and review machinery.
Keep the edition's existing interface and authorization decisions authoritative.

A review-disposition call that completes must retain its linked review; a native refusal must audit `refused` with the returned code, open no review, and preserve any bracketing native witness.

## Declare a native company-policy decision

A seed may pass `companyPolicy: { decide }` to `createAgentDoor`. Omit it to keep
existing behavior. This read-only server hook narrows the existing class-policy
decision; it supplies no default dispositions and cannot bypass incomplete
policy, Pause, scopes, native authority, proof, revocation or idempotency.
HappyToHelp's computed action classes, Lamp AUTO-001's component/source rules,
and Slate NOTIF-001's person-needed decisions use the same boundary.

```ts
companyPolicy: {
  async decide({ tool, args, classes, target, policy }, ctx) {
    return nativePolicyDecision(tool, args, classes, target, policy, ctx)
  }
}
```

The input contains the tool name, declared action arguments (without the door's
idempotency/revision fields), server-computed classes/facts, resolved native
target and the existing class-policy decision. Inputs and the identity context
are immutable snapshots. Resolve current native rules with the sponsor and
agent in `ctx`; caller flags and record text cannot supply policy authority.
The hook must perform no effects. Return exactly one audit-safe answer:

- `{ decision: 'allow', rule, revision }` retains the existing disposition.
- `{ decision: 'hold', rule, revision, approvers, wait }` requires the existing
  exact-revision approval flow. `approvers` uses the existing `sponsor`,
  `role:owner`, `role:editor` or `person:<id>` references; `wait` uses the existing
  fixed ISO duration range (one hour through thirty days). Existing policy
  approvers remain required and the shorter wait wins.
- `{ decision: 'deny', rule, revision }` refuses with `company_policy_denied`.

`rule` and `revision` are nonempty, bounded, non-secret strings identifying the
native rule and its revision. Unknown or malformed answers refuse with
`company_policy_invalid`; a thrown hook refuses with
`company_policy_unavailable`. No hook error text is returned or audited.
Class policy that is unset or blocked stops the call before this hook.

MCP, integration aliases and embedded calls share this evaluation before
execution, including completed retries. Held calls return the existing
`input_required` (or legacy `approval_required`), pending handle and signed-in
approval URL. Approval execution evaluates again: changed native policy
answers, facts, targets or summaries refuse `approval_evidence_changed` and
require a new request. A previous approval cannot satisfy a newly held rule or
revision. Rejected and expired holds retain the existing typed refusals.

The result's decision and the existing audit row carry `company_policy` with
the exact validated answer alongside the class-policy revision/rules. Pending
approval summaries bind that answer into their existing summary hash; saved
audit evidence retains it for replay comparison. The normal audit endpoint
checks the combined disposition against both saved decisions. Rule identifiers
must be redacted for the permitted audit audience; do not return private record
content or credentials. This hook adds no routes, tables or policy engine and
makes no claim that an adopting seed has satisfied BASE-AGENT-007.

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

## Refreshing a copy older than 0.2.96

The tagged schemas in `rer-v0.2.93` and `rer-v0.2.94` are identical.
`rer-v0.2.95` adds erasure/replay custody (reference migrations `0038` and
`0039`); `rer-v0.2.96` adds the relay (`0040`). The current source additionally needs policy-reference suppression (`0041`) and relay privacy (`0043`).
These are the additive upgrades to the current schema:

| Starting Base release | Additive SQL needed for current source |
| --- | --- |
| 0.2.93 | The older-schema SQL below, then the relay SQL and retirement SQL below. |
| 0.2.94 | The same older-schema SQL below, then the relay SQL and retirement SQL below. |
| 0.2.95 | The relay SQL and retirement SQL below; both columns, the expiry index and replay-alias objects already exist. |
| 0.2.96 | The retirement SQL below, then the relay privacy SQL below; relay and replay custody already exist. |

Write only the deltas the seed's applied schema lacks. SQLite has no
`ADD COLUMN IF NOT EXISTS`: check `PRAGMA table_info(agent_door_agents)` and
`PRAGMA table_info(agent_door_calls)` first (and `sqlite_schema` for indexes,
tables and triggers). Put the missing deltas in **ONE new numbered migration**
ahead of the relay DDL in that migration; never edit an applied migration.
The older-schema SQL is:

<!-- schema-upgrade:0.2.93:begin -->
```sql
ALTER TABLE agent_door_agents ADD COLUMN tombstone TEXT;
ALTER TABLE agent_door_calls ADD COLUMN expires_at INTEGER;
-- Backfill only legacy completed calls, using their start, never upgrade time.
UPDATE agent_door_calls SET expires_at=created_at + 30*24*60*60*1000
WHERE state NOT IN ('running','pending') AND expires_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_door_calls_expiry ON agent_door_calls(expires_at);
CREATE TABLE IF NOT EXISTS agent_door_replay_aliases (
  agent TEXT NOT NULL, alias TEXT NOT NULL, call_id TEXT NOT NULL, tombstone TEXT NOT NULL,
  PRIMARY KEY(agent,alias)
);
CREATE TRIGGER IF NOT EXISTS agent_door_delete_replay_aliases AFTER DELETE ON agent_door_calls
BEGIN
  DELETE FROM agent_door_replay_aliases WHERE agent=OLD.agent AND call_id=OLD.decision_id;
END;
CREATE INDEX IF NOT EXISTS agent_door_replay_aliases_call ON agent_door_replay_aliases(agent,call_id);
```
<!-- schema-upgrade:0.2.93:end -->

The replay-alias objects above are exactly [schema/replay-aliases.sql](schema/replay-aliases.sql).
For the relay SQL, append the exact contents of
[`0040_agent_door_relay.sql`](../../default-seed/migrations/core/0040_agent_door_relay.sql):
the table, two indexes, four triggers and one-time audit backfill. Do not replay
the seed's existing migrations. Relay DDL alone does not add the older columns:
current tool admission reads `agent_door_calls.expires_at`, so an older schema
returns 500 before producing decisions and fails `BASE-AGENT-009.relay.count`.
Append the retirement SQL below for every starting release in the table. It is
the policy-reference upgrade from 0.2.96 (reference migration `0041_agent_retired_refs.sql`):

<!-- schema-upgrade:retired-refs:begin -->
```sql
CREATE TABLE agent_door_retired_refs (digest TEXT PRIMARY KEY, marker TEXT NOT NULL);
```
<!-- schema-upgrade:retired-refs:end -->

For **every** starting release above, append the exact contents of
[`0043_agent_door_relay_privacy.sql`](../../default-seed/migrations/core/0043_agent_door_relay_privacy.sql)
after the earlier SQL. For copies from 0.2.97 through 0.2.103 that already have
retired refs, only this privacy migration is needed. It drops and recreates the
audit membership triggers so linked executions inherit their decision’s Business,
including no membership, and removes only provable cross-Business execution
memberships produced by the old triggers. Audits are preserved. Its comment
provides a count query before applying. Never edit a shipped migration.

The frozen-schema upgrade test executes these SQL blocks and both relay files,
comparing all objects against the schema applied fresh. The suppression table
travels in installation archives; do not add it to portability exclusions.

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
signed policy adoption reach their own checks. Also route
`POST /api/rer/agent-decisions` to the same `handle` before app authentication.
The relay migration, route and erasure-map declaration must land in the same
seed commit. For an older applied schema, first follow
[Refreshing a copy older than 0.2.96](#refreshing-a-copy-older-than-0296).
Copy the relay DDL from `schema/agent-door.sql` into a new numbered migration and backfill existing MCP audits with consent to the current
envelope Business, as in `default-seed/migrations/core/0040_agent_door_relay.sql`.
Do not alter an applied migration. The Business drops pre-join history; this
backfill cannot reconstruct older pairing authority. Declare
`agent_door_relay(sequence,decision_id,business)` as `unrelated` in each native
artifact map: it holds only decision ids and the installation Business id.
Record an external custody store for the Business: per relayed decision it
holds only the 17-key public projection, including raw resource URIs for records
the decision touched, readable only by the owner of the Business. Record erasure
purges the live projection through a tombstone pull; unpairing, re-pairing or
stopping the seed purges that installation's Business copy. Apply the remaining
authority and unreachable purge rules in the
[relay wire](README.md#business-decision-relay-w-r1w-r5). The seed keeps no
additional copy beyond its own audit and the bounded relay feed (one row per
decision).
`BASE-AGENT-009.relay` runs after the audit phase against the hosted build and
refuses a missing route or one accepting a foreign signature. Retain the edition's native
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
role. The native role may differ. A custom adapter must expose `businessStopped()` according to the
[Business stop contract](README.md#wire-and-authority): the shared runtime uses that one
positive-false rule for token admission, Business references, held calls and relay pulls.
Adopt the runtime update without a migration; `operatorAuthPeople` already supplies the reader.
Keep `sponsor()` resolving subjects after a stop so signed policy naming Business people is still adopted.
Local credentials return `sponsor: { id }`,
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
Build that trust from the `RER_OWNER_CLAIM_*` bindings and pass `null` when they
are absent: `rer verify` ends with `BASE-AGENT-004.7`, re-serving the same
installation without those bindings and `RER_BUSINESS_TRUST`, and the door must
then refuse Business tokens while owner sessions and native clients keep working.
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
access or security tool that can widen authority. Use `{ "$sponsor": "id" }` or
`{ "$sponsor": "email" }` as argument values; the conformance journey resolves
these and requires `self_escalation` with an unchanged native witness. Retain a
journey call proving an ordinary narrowing change too.

For a tool whose only effect is revocation or reduction, declare `widens: false`
and `narrowing: {effect: 'revoke', target: 'id'}` (or effect `narrow`) in both
its runtime definition and surface tool. Include its exact native `inputSchema`
in the surface. This checked contract accepts a closed object with one required
string target identifier (`id` or a name ending `_id`), or a nonempty array of
distinct such identifiers for a composite native target. For example,
`narrowing: {effect:'revoke', target:['team_id','operator_id']}` accepts only
those two required string fields. The native grant witness must supply and match
every identifier. The schema refuses extra fields,
open objects, references and schema unions. An operation accepting roles, scopes
or grants to add must retain its escalation fixture. Separate the revoke-only
operation from an operation that also grants authority when needed.

A narrowing-only tool still declares `authority`, returning `widens: false`.
A contradictory widening answer refuses as `narrowing_contract_violation`.
Unlike ordinary tools' ignored extras, undeclared narrowing-tool arguments
refuse as `invalid_arguments`, including attempts to replay a prior key.
When a journey step's `inject` adds an undeclared narrowing argument, the
injected replay must return `invalid_arguments` and leave the native witness
unchanged. An injection containing only declared arguments retains the success
expectation, as does an ordinary valid replay; neither repeats the native effect.
Every such tool needs a normal journey step and a `narrowings` entry:

```json
{
  "tool": "seed.access.revoke",
  "step": "revoke",
  "witness": {
    "tool": "seed.access.grants",
    "args": {"id": {"$from": "grant", "pointer": "/id"}},
    "pointer": "/grants"
  }
}
```

The read-only witness returns the targeted subject's native effective grants as
unique strings. Use the same target argument in the witness and revoke call.
The journey prepares a nonempty grant set through native tools, then proves a
strict subset after the action and refuses a smuggled grant-adding argument
without an effect. Output point names identify every narrowing tool. No tool
is exempted from execution, policy, audit, schema or journey coverage.

## Keep worker tools behind invoke

Set `exposure: 'invoke'` on a tool definition to admit it only through this
seed's `door.invoke`. Omitting the field preserves MCP discovery and calls;
other values are rejected. Read-only tools may use the flag too. Invoke-only
tools are hidden from MCP tool listings, tool-list subscription changes and OAuth
`scopes_supported` (a scope shared with an exposed tool remains advertised).
MCP calls receive the same `tool_not_found` response and audit treatment as an
unknown name, without running the seed callback. Keep these tools out of the
public agent-surface declaration.

`invoke` still applies full admission: current person, agent and consent,
scopes, Pause, policy, native continuation binding, idempotency and embedded
audit. Their classes still contribute to policy questions and usage; saved
approval and review flows can still resolve them.

## Hand off native human proof

A native authentication requirement stays independent of company approval.
Declare `proof: 'native', proofKind: 'step_up'` on the runtime and surface tool.
Supply `nativeProof: {handoff, verify}` to `createAgentDoor`. Both hooks receive
`{kind, tool, principal}`; `verify` also receives the exact native `args` and an
opaque `reference`. The seed verifies its own recent human proof and returns
true only for the matching person, originating agent/client and action. Base
never handles passwords, second factors, recovery codes or session credentials.

Without a valid reference, the tool returns `native_proof_required` with `kind`
and a same-origin `handoff` URL from the seed hook. Keep secrets out of that URL.
The challenge has its own complete refused audit row and makes no native effect,
including under autonomous company policy. The human opens the native handoff
and completes the seed's authentication. The agent retries with the opaque
reference in `params._meta["com.runeditrun/native-proof"]`; an embedded caller
passes it as `door.invoke(name,args,principal,proofReference)`.

The reference is retained with a pending approval and the seed verifier checks
it again immediately before native execution. Expired or revoked proof refuses
with the same challenge even if all business approvers have approved. A valid
proof still passes scopes, classification, company policy and named approval.
The native action receives the verified `{kind, reference}` as `ctx.nativeProof`.
The seed must fence the proof and grant checks within its native transaction
when concurrent revocation requires it. Native proof references must be opaque,
non-secret handles of at most 512 characters, never bearer credentials.

For disposable conformance, declare
`verification: {proof: {module: 'tests/native-proof.mjs'}}` in the surface.
That contained test module default-exports an async function receiving
`{request, origin, agentId, tool, args, kind, handoff}` and returns a valid native
proof reference using the seed's human lifecycle. The supplied `request(path,
init)` uses the test person's native session and only the fresh installation's
origin. It must never contact providers or read real credentials. As with owner
initializers, this is trusted test tooling and never production authority.
Direct harness callers can provide the same function as `prove`.

Conformance challenges each proof tool, refuses a bogus reference with an
unchanged native witness, checks those audits, and succeeds with the test hook's
valid proof through autonomous and held policy. The ordinary autonomous-success
requirement applies directly to tools without `proof`; proof tools require the
native reference first.

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
and `classify(record,ctx)`, based on the record itself. Resource adapters receive consent and operation identity (`consent`, `operationId`, `idempotencyKey`, and optional `continuationItemId`) alongside `{person, agent, clientId, scopes, db}`; a resource that changes between check and read refuses `resource_changed`.
Use this authenticated authority for service and client fences, including events
and subscriptions; a sponsor's administrator role never bypasses a registered
resource's reader. `ToolContext` carries the same scopes and client id.
`door.invoke(name,args,{person,agent,scopes,clientId})` requires explicit scopes
and never supplies registry scopes. Omit `clientId` only for a native agent with
no separate client identity.

If the seed has mutable client grants, declare `currentScopes(principal)` to
read them from its native store. The door intersects this with the original
credential scopes before calls and again at approval execution and subscription
delivery. It cannot widen the token or saved approval. Removing the tool's scope
before approval execution returns `insufficient_scope`, runs no native action,
and retains the execution audit linked to its original decision. Seeds without
client grants can omit the hook. Approval retries and idempotency digests retain
the originating client id; approved-read retries recheck native resource access
before returning retained content. Keep grant checks in the native transaction too
when the seed needs a fence against concurrent grant edits.

Resource reads pass through
the same policy, approval, review and audit path as tools. A resource read must enforce the current person's native
access. Mark device, screen, connector, import-door and installation operations
as outside the tool registry when they require another supported door.

## Durable invocation consent and operation identity

Every tool callback receives this admission metadata on `ToolContext`:

```ts
readonly consent?: string             // originating Business consent record id
readonly scopes: readonly string[]    // effective grant recorded at admission
readonly operationId: string          // door-issued original decision/audit id
readonly idempotencyKey: string | null // original key; null for reads
readonly clientId?: string
readonly person: Readonly<Person>      // native sponsor, including id
readonly agent: Readonly<Agent>        // originating agent, including id
readonly approvers: readonly Readonly<{ id: string; name: string }>[]
```

The context and its copied identity, scope, actor, proof and approver objects are
frozen at runtime and read-only in TypeScript. `db` remains the native service
capability, and `emit` still records effects. Mutation of a context cannot edit
the door's principal or a later callback. A tool returning a native queued-effect
handle should include `ctx.operationId` in that handle. Its audit row carries the
same `operation_id`, plus `consent`, `scopes`, `client_id` and `idempotency_key`.
Approved execution retains the original operation id and key, while its own
execution audit still has a distinct `id` and original `decision_id`.

Persist the originating context alongside the native queue item. For example,
a preparation tool records the following identity before returning its handle:

```ts
const identity = {
  person: { id: ctx.person.id }, agent: ctx.agent, consent: ctx.consent,
  scopes: ctx.scopes, clientId: ctx.clientId, operationId: ctx.operationId,
}
// Persist identity, ctx.idempotencyKey and native job arguments atomically.
```

The trusted worker re-enters a registered native execution tool through the
public door, using exactly those saved values and the same public key:

```ts
const result = await door.invoke('example.queue.execute', {
  id: job.id, idempotency_key: job.idempotencyKey,
}, job.identity)
```

`invoke` accepts `operationId` only at the trusted worker boundary; MCP arguments
cannot supply it. The door checks it against the retained completed admission,
including the exact sponsor, agent (id, name and specialist), consent, client,
granted scope set and key. The execution context restores recorded scope order
and agent metadata from that admission.
Missing, incomplete or mismatched admissions return `operation_mismatch` without
running the tool. It does not reconstruct scopes from the registry. The door
re-reads the current native person, current grants and signed policy. A removed
admission scope returns `insufficient_scope` and requires fresh preparation;
revoked consent still returns `consent_revoked` with no effect. Keep the same
checks in the native effect transaction when concurrent edits need a fence.

For a tool that executes multiple native items from one preparation, register a
`continuationItem(args, ctx)` resolver on the execution tool. Re-read the native
queue row and return `{id: job.id, operationId: job.identity.operationId}` or
`null` if the item is unavailable. The door validates the nonempty item id (at
most 200 characters, without NUL) and its exact originating operation before
claiming, replaying or executing it. It resolves the item again before the native
effect, including delayed approval execution. The resolver must use persisted
native identity, never a caller-selected replay suffix. Such tools require the
trusted worker's saved `operationId`; an ordinary MCP call cannot execute them.

After current scope and revocation checks, an unset, removed or unavailable policy
or Business Pause refuses before continuation input validation or native item
resolution, including calls without an operation. Refusal-path target and
classification remain best-effort as for other tools; a native `ToolRefusal` is
recorded as `classification_refusal` without replacing the policy refusal.

Each native item has its own once-only claim under the original operation, tool
and public key, so replay returns that item's recorded result rather than the
preparation handle or a sibling effect. Tools without a resolver retain the
single-continuation claim. Reusing an item with changed arguments returns
`idempotency_conflict`. The immutable context exposes `continuationItemId` and
the audit records `continuation_item_id`; the original operation, consent,
sponsor, scopes, approvers and public idempotency key remain unchanged. Public keys may not contain NUL, which
separates these
internal claims from ordinary keys. The existing calls table stores the claims;
no new schema migration is needed. Keep the originating audit, approvals and
idempotency records for as long as the queue may execute or replay them.
Approver ids come from the retained approved execution and are re-resolved to
active native people; a seed cannot supply them.

For independently prepared scheduled work with no earlier tool admission, omit
`operationId` and supply its original native sponsor, agent, explicit scopes,
client id and consent to `invoke`. This makes a fresh door admission. Consent is
optional only for work originating independently of Business consent. Never drop
or replace an originating consent at execution. Older pending approvals retain
their original decision id as operation identity; older queue handles without a
recorded admission snapshot require fresh preparation.

The shared `runAgentDoorConformance` journey can take an optional
`invoke(name,args,who)` callback wired to the same trusted worker door. Its
existing consent checks remain unchanged. Base's public-door fixture additionally
proves native queue persistence, one-effect replay, execution-time revocation,
immutable identity, scope narrowing and named approver continuity. These module
proofs do not establish a seed's integrated queue behavior. Client-data custody and erasure require the native map and transaction integration described below, plus the adopting seed's own public-door proof. The ordinary conformance journey alone does not prove that integration or supply seed-side
`BASE-AGENT-010` contract citations.

The CLI connects this boundary when `agent-surface.json` declares
`verification.invoke: {module:'tests/agent-invoke.mjs', entrypoint:'NativeJobs'}`.
The contained module default-exports an async driver receiving
`{name,args,who,worker}`. `await worker('NativeJobs')` returns an RPC reference to
that named entrypoint in the real built application Worker. It is available only
to the verifier, through a private service binding; no HTTP invocation route is
added. Other entrypoints are refused. The driver must serialize the supplied
original identity and consent through the seed's native queue, wait for native
completion and return the real `door.invoke` result. Preserve the originating
scope, client and operation identity where present. Built Wrangler queue
producers and consumers both run in the disposable installation, using its
declared batch, retry and dead-letter settings. Driver failures fail conformance
with a redacted diagnostic. A missing declaration does not claim queue coverage.

## Keep runtime and CLI evidence separate

BASE-AGENT-003 acceptance 4 requires a record-writing fixture when the door
offers resources and has mutating tools. Add `resource` to a create or update
journey step, naming a declared native template and a nonempty JSON state subset:

```json
{
  "id": "create",
  "tool": "base.people.create",
  "args": { "name": "Synthetic Base 1", "email": "synthetic-base-1@example.com" },
  "expect": [{ "class": "standard" }],
  "resource": {
    "uriTemplate": "base://person/{id}",
    "state": {
      "id": { "$from": "create", "pointer": "/id" },
      "name": "Synthetic Base 1",
      "email": "synthetic-base-1@example.com"
    }
  }
}
```

Use native written fields as well as the returned identifier, with more fixtures
for other record writes. State references may use the current step's output or
earlier outputs. `BASE-AGENT-003.4.fixture` fails an omitted fixture;
`BASE-AGENT-003.4.links.<phase>.<step>` requires a returned link matching its
template, scheme and authority (HTTP resources must use the installation origin).
`BASE-AGENT-003.4.state.<phase>.<step>` reads that link through this door using
the step's client and compares JSON content bearing the same URI with the expected
state subset. Missing, stale, malformed and unrelated state fails. The existing
resource policy checks still run for every returned link. Approval-gated reads
remain withheld in the held phase; the autonomous phase proves their state.
Deletion and tools without record effects need no invented resource fixture.
These points prove the declared fixtures, not every possible record or write.

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
long jobs, Business delivery of grant narrowing, outside mail, standalone policy forms and token
issuance, self-host delivery and stranger-specialist completion. Platform adoption
of the shared policy source is also separate from copying it into an edition.

Validate the integrated edition through its public doors: current sponsor and
scope checks, all exposed tool effects, policy and review decisions, migrations,
resources, audit, subscriptions and retained outcomes. Keep successful and
failed outcome evidence for at least 24 hours. Verified native subject erasure overrides this floor for personal payload only; the value-free existence and outcome remain. The fixed `REPLAY_WINDOW_MS` in `erasure.ts` bounds replay to 30 days after completion; erasure does not extend an existing horizon. Report the exact
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
      "bindings": {
        "RER_MANAGEMENT_ORIGIN": "issuer",
        "RER_INSTALLATION_ID": "installationId"
      },
      "initializer": "tests/initialize-agent-owner.mjs"
    }
  }
}
```

For a native setup-token binding, set `verification.owner.tokenField` to its
environment binding name, for example `H2H_SETUP_TOKEN`.

All keys are optional. Email defaults to `synthetic-base-1@example.com`;

All four keys are optional. Email defaults to `synthetic-base-1@example.com`;
the manifest's email and token fields are always bound too. The initializer is
a contained seed module default-exporting an async function receiving
`{request, origin, email, sub, displayName, token, claim, returnTo}`. `claim` is
`{mode, path, token}` with the signed credential when signed mode is declared;
`token` is the private per-run setup token. Use `request(absoluteURL, init)` to
drive the seed's real project/password, owner and member-linking lifecycle.
It permits the fresh hosted origin and explicitly declared public hosts below. Return the native final 303 `Response`
with its session cookies; then the runner posts the signed Business settings
document and runs the journey. Never create an owner with direct SQL, substitute
an auth adapter, or add a verification-only production route. Initializer code
runs as trusted test tooling in Node; it must use the supplied request function
and must not contact providers or read real credentials.

`bindings` maps native environment binding names to the verifier's per-run
values: `issuer` (the issuer origin), `installationId`, `appOrigin`, `publicKeys`
(the JSON public key ring), `email`, `sub` (the owner's Business person id),
`token` (the setup token), or `sessionSecret` (a fresh session signing secret).
Only named native bindings are added, for that disposable runtime only; existing
Base verifier bindings and manifest email/token fields remain available. Nothing
is written to the seed's environment files. Tokens and sessions are never printed.
These aliases configure the seed's existing admission and do not bypass signed
claim verification. For a signed seed needing just its native issuer and
installation names, declare the two `bindings` above without an initializer.

A binding needing native JSON or PEM can instead name a contained test generator:

```json
{"bindings":{"GITHUB_CONNECTION":{"module":"tests/github-binding.mjs"}}}
```

The module default-exports an async function receiving the same per-run values
listed above. Return one nonempty string, at most 64 KiB. For Spool's native
GitHub App connection, generate a fresh RSA key with Node crypto and return
`JSON.stringify({appId:'42',installationId:'7',privateKey})`, where `privateKey`
is its real PKCS8 PEM export. These numeric GitHub identifiers are distinct from
the verifier's installation UUID. The native GitHub parser, key import and App
JWT signing still run. Generators execute once per named binding per run, before
owner bootstrap, and configure only the disposable Worker. Keep them outside
production imports, never read real credentials, and never print or persist their
output. Invalid output, escaping paths and generator exceptions fail with a
fixed diagnostic. Signed owner claim verification remains required.

## Verification RPC provider edges

For a production service binding such as `PENNY_EGRESS.send`, declare:

```json
{"verification":{"rpc":{"PENNY_EGRESS":{"module":"tests/egress-rpc.mjs","entrypoint":"Egress"}}}}
```

The binding must already appear in the built Worker's `services` declaration.
Its contained `.mjs` or `.js` module exports the named class extending
`WorkerEntrypoint` from `cloudflare:workers`. Implement only the provider's real
RPC interface in that test edge. The application's native adapters, authority,
privacy, signatures, receipts and persistence still execute. Each declared edge
runs in a separate Worker in the disposable runtime, without application
bindings, Node compatibility or outbound network access; undeclared network
requests return 502. Relative helper imports are snapshotted and contained,
including symlink targets. Only `cloudflare:workers` is allowed as a runtime
builtin. This is test tooling and is never added to the production build.

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
The verifier renews before requests when less than 60 seconds remain, with the same 300-second lifetime.
An equal-sequence refresh may change only `iat`/`exp`; all authority and the exact revision signature stay unchanged.

## Event visibility and native revisions

Retained event replay, listing and subscription delivery re-read each event's
current native resource with `ResourceDefinition.read`. A sponsor, actor or
Business role cannot override that reader's refusal or null result. Readers
must authorize on every call, including after grants narrow. Unknown resources
and refused reads produce no event, notification or new cursor. Base approval
resources use their current approval reader rules.

Tool names use `<seed>.<segment>(.<segment>)*`: each segment is lowercase
`[a-z][a-z0-9_]*`. The existing seed-id grammar allows hyphens in the seed
prefix. Names have at most 128 ASCII characters, within MCP's allowed character
set. Duplicate, foreign-seed and malformed names fail the existing
`BASE-AGENT-013.surface.<name>.name` declaration check and runtime registration.

Native `revision(args,ctx)` returns an opaque string or number, or null when no
record exists. Declare `revisionType: 'string'` for UUIDs or other string tokens,
`'number'` for numeric tokens, or retain the default `'integer'`. The generated
`expected_revision` input schema uses that type. Tokens are compared strictly
and saved unchanged with pending approvals. A stale initial token returns
`revision_conflict`; a token changed before approved execution also returns
`revision_conflict` without running the tool. Native services
still own atomic revision checks at their effect boundary.

## MCP version compatibility

The negotiated versions are `2026-07-28`, `2025-11-25` and `2025-06-18`. All
initialize and list the same registry; unsupported negotiation returns
`UnsupportedProtocolVersion` (-32022), with a plain-language message and the
supported versions in error data. Authenticate initialize and later calls with
a bearer token; a 401 resource-metadata challenge precedes protocol validation.
Initialize accepts its body version without transport headers; subsequent
stateless calls without the version header use `2025-06-18`. June and November
use the legacy `approval_required` result rather than modern `input_required`.
March `2025-03-26` is deliberately not
advertised: its Streamable HTTP transport permits batched requests, which this
door's single-message parser rejects, and its pre-June schema lacks structured
results, output schemas, resource links and elicitation. March also predates the
protocol-version HTTP header and modern method/name metadata. Supporting it
would require a batch dispatcher and a separate legacy result/approval shape,
not merely adding a version string. Seed contracts should use a supported
version until that transport work is implemented.

## Captured native email in verification

The owner initializer and optional `verification.journey` test module receive
`mail.read({limit, maxAgeMs, after})`. This reads only accepted Resend, SendGrid
or Cloudflare sending submissions for this run's configured synthetic owner
mailbox. Results contain `{id, at, subject, text, html}`; provider headers,
credentials and other recipients are never returned. Defaults are ten messages
and five minutes. Hard limits are twenty retained/read messages, 64 KiB per
submission and five minutes of age. `after` is an optional millisecond timestamp.
Capture exists only in verifier memory and is cleared when the run closes.
There is no HTTP outbox, application binding or production reader.

Each additional `verification.sponsors` initializer receives the same `mail.read`
interface and limits, scoped only to its own declared synthetic email. Capture
starts before Business roster delivery so the initializer can consume its native
invitation. It cannot select or read the owner's or another principal's mailbox.
The owner and journey readers retain their owner-mailbox scope.

Drive the native email request through `request`, read the captured code or
link, and submit it to the seed's real confirmation handler. Preserve native
one-use, expiry, session and step-up checks. Never print the message or proof.
Return the final native 303 response with its confirmed session cookie from the
initializer. The reference verifier fixture uses the real operator-auth email
lifecycle and production mail sender, with only the paid sending edge replaced.

`verification.journey: "tests/native-agent-journey.mjs"` optionally names a
contained module default-exporting an async function. It receives
`{request, origin, email, cookie, mail, fixtures, tool}` after the standard
policy/authentication phases and before the final audit. `tool(name,args)` uses
the run's real agent credential and records calls for that audit; no signer or
credential is passed to the module. The standard phases still run, and a failed
native journey fails verification. Errors are redacted to a fixed diagnostic.
Keep these modules in test tooling outside the production dependency graph.

For a seed with another public hostname, declare its deployment variable in
`agent-surface.json`, for example:

```json
{"verification":{"publicHosts":["STATUS_HOST"]}}
```

The deployment declaration selected by the command adapter must contain that
variable in `vars`, for example `"STATUS_HOST":"status.rer-hosted-check.invalid"`.
Each value must be a canonical lowercase hostname without a scheme, port, path
or wildcard. Duplicate variable names and missing or malformed values refuse
before installation. Hosts are admitted only by this explicit list; other
deployment variables do not grant admission. With no list, only the original
host is admitted. The supplied `request` keeps the admitted HTTPS URL and Host
when forwarding to the same disposable production Worker. It never contacts
the public network or grants the host access to the outbound provider adapter.

The same journey module may export async `beforeStep` and `afterStep` functions.
They run around each completed mandatory journey step in both `autonomous` and
`held` phases, and around autonomous preparation in `blocked:<class>` phases.
Along with the usual native context they receive
`{phase,step,args,outputs,tool}`; `afterStep` also receives the completed
`structuredContent` as `result`. These are detached copies. `beforeStep` runs
before the effect/approval witnesses; `afterStep` runs after output, resources,
narrowing, injection and replay checks. Use the native HTTP/person door to
record repository consent or prepare queued work between dependent steps.
Hooks cannot skip mandatory steps or alter the runner's arguments and outputs.
Failed hooks fail the current phase with the same redacted diagnostic. A step
that fails or yields no structured output does not receive `afterStep`.

## Disposable native preparation

Phase fixtures and native `beforeStep`/`afterStep` hooks receive
`database(binding)`, `now` (verifier Unix milliseconds),
`scheduled({scheduledTime})`, and `queues.hold()`/`queues.release()`.
The database supports SELECT and single native-table UPDATE, INSERT INTO and
DELETE FROM statements through `prepare(sql).bind(...).run()/all()/first()`.
Create real records through the app's doors; use writes only to age their
native history. For example, after obtaining `db` and a real delivery ID:

```js
await db.prepare('UPDATE native_deliveries SET completed_at=? WHERE id=?').bind(now - 7_200_000, deliveryId).run();
await scheduled({ scheduledTime: now });
```

`scheduled` runs the app Worker's own scheduled handler and waits for its
work, without overriding its runtime clock. A queue hold delays entry into
the app's real queue handler; release it in `afterStep` after native approval
and the tested dispatch. Phase preparation releases any preceding hold;
installation disposal also releases waiting deliveries. This allows a due
approved step without rewriting approved content or approval evidence.

To exercise a native failed-producer path, call `await queues.fail('JOBS')` before
dispatch, then `await queues.restore('JOBS')` to clear it. Both `send` and
`sendBatch` reject before any message reaches the real queue. The name must
be a producer binding declared in the built Wrangler configuration; undeclared
bindings are refused, and other bindings keep working. `await queues.restore()`
clears all producer faults. Phase fixture preparation also clears previous
faults. Consumer `hold()`/`release()` remain independent: a hold delays
consumption while normal producer sends still succeed. Fault controls exist
only in this disposable harness and never modify the production build.

Every write uses a disposable D1 transaction guarded against INSERT, UPDATE
and DELETE on **all** `agent_door_*` tables, including native triggers and
cascades. Schema, transaction and multiple statements are refused. Refusals
fail the phase with `agent_fixtures_database_unavailable`; values, records
and SQL are never included in diagnostics. Each policy phase prepares fresh
values. These powers exist only in conformance tooling; the owner initializer
retains its SELECT-only handle, and production, `rer dev` and `rer demo` do
not receive them. `timedLifecycle` and `queuedLifecycle` remain **unscoped**
capability names; this preparation boundary does not add lifecycle coverage.

## Isolated declared native history

A seed that needs pre-service history may separately declare a test-only
`verification.history` module. It runs just before the named mandatory journey
steps, under both `autonomous` and `held`, before native hooks and effect witnesses:

```json
{"verification":{"history":{
  "module":"tests/history.mjs",
  "steps":["learning"],
  "statements":{"observation":{
    "binding":"DB",
    "sql":"INSERT INTO native_history(id,observed_at,value) VALUES (?,?,?)"
  }}
}}}
```

The Worker-compatible module default-exports `{async fetch(request) {...}}`.
Its JSON request contains detached `{phase,step,args,outputs,now}`; it receives
no cookies, credentials, database client or application bindings. For example:

```js
export default { async fetch(request) {
 const { phase, now } = await request.json();
 return Response.json([{statement:'observation',
  values:[phase, now - 7 * 86_400_000, 12]}]);
} };
```

Use the seed's native calculation code to construct genuine dated source rows,
including the native forecast's pre-service timestamps, inputs and digest.
Do not invent protocol receipts or successful proposal results. Declare steps
before their history-dependent reads so the normal native digest, proposal,
authority, policy and audit paths still run. The verifier never changes time.
The seed's regular phase/step hooks may use the native person door to decide a
previous round's open proposal; history tooling has no HTTP/person authority.

Only `checkAgentDoor` (used by `rer verify` and focused conformance) starts this
module. Like the network edge it runs in isolated workerd: contained `.mjs`/`.js`
relative helpers, no Node imports, filesystem, application bindings or external
network. The entry must live under `tests/`. Production commands (`build`, `dev`,
`preview`, `deploy`) and conformance refuse runtime imports of its test modules
from production source, including literal re-exports, TS path aliases, symlinks and literal Worker URL dependencies.
Keep computed imports and custom loaders out of the production dependency graph.
Shared native calculation helpers may still be used by production.

Output is an array of `{statement,values}`, at most 1,000 rows / 2 MiB per call.
Statements are named in the declaration, never supplied by module output. The
only allowed SQL is `INSERT INTO table(columns) VALUES (...)`, with positional
`?` parameters or fixed simple string/integer literals. No UPDATE, DELETE,
upsert, query, expression, schema qualifier, comment or DDL is accepted. The
verifier applies them only to declared bindings in its fresh, nonpersistent
Miniflare database; no provider or existing installation database is opened.
`agent_door_*`, `oa_*` and SQLite tables, views, virtual tables and every table
with a trigger are refused, including triggers that could indirectly forge
agent-door evidence. Rows are batched per database. Keep declarations narrow to
native history, never account, session, policy, approval, audit or receipt state.
Invalid declarations, output and writes fail with `agent_history_invalid` and
redact SQL, rows and values. Owner initialization retains its SELECT-only `database(binding)` handle.
Both preparation APIs use the same guarded disposable host writer; the isolated
history declaration retains the stricter insert-only, trigger-free rules above.
No declaration means no fixture Worker, writes or extra conformance points.

## Native clients and fresh phase fixtures

Declare `verification.fixtures: {"module":"tests/agent-phase-fixtures.mjs"}`
when a journey needs a real native API client, an operation receipt, or state
consumed by a previous policy round. Its default async function receives
`{phase, request, origin, email, cookie, mail, fixtures, tool}`. The request
function is restricted to the disposable installation; use the native owner
session to issue clients, then their real credentials to create native records
and retained operation receipts. No signer or production fixture route is supplied; native writes use the
guarded disposable preparation boundary above.

Return `{values, clients, sponsors}` (each member is optional). `values` is an object of named phase-local JSON
values. `clients` maps names to `{token, clientId, agent:{id,name,specialist}}`
returned by the native credential lifecycle. The specialist must match the
surface. Credentials and identities must belong to the signed-in owner and
retain their actual native scope checks. Generate secret-shaped values at
runtime and never log them.

During `negative`, optionally return
`sponsors: {inactive: {sub, email}, excluded: {sub, email}}`. Either kind may be
omitted. These are Business subjects and their native email addresses, prepared
through the seed's own person lifecycle: suspend the inactive person, and keep
the excluded person outside the seed's allow-list. Return only those two identity
fields; no token, signing key or token minter is passed to the fixture. Sponsor
handles are replaced on every preparation, just like values and clients.

If the Business subject must be registered before preparation, add that person
to `verification.sponsors` with `negativeOnly: true` and its normal native
initializer. The initializer receives the verifier-assigned `sub` and can retain
`{sub,email}` for the phase fixture. These additional persons complete the same
native bootstrap and Business binding, but do not run the successful
cross-sponsor journey after suspension or exclusion. The first owner cannot be
negative-only. Regular sponsors keep their cross-sponsor checks.

The verifier itself signs otherwise valid access tokens for each declared
person, using an unused agent identity for each probe so an earlier sponsor
binding cannot supply the refusal. It also always probes an unknown subject and the current subject with
a changed email. `BASE-AGENT-004.sponsor.unknown`, `.changed-email`, `.inactive`
and `.excluded` require HTTP 401 or 403 with a typed door error and an unchanged
native witness before and after each call. Undeclared optional states are
reported as undeclared and run no point; they never count as a pass. Diagnostics
name only the state and HTTP status, never fixture values, subjects or emails.

Resolving a Business subject to a native person is only part of admission. The
token's email must also match that person's current native email. A valid
signature and a known subject do not establish that match. An implementation
that accepts the changed-email probe fails this requirement even when its
unknown, inactive and excluded sponsor checks pass.

A journey step can select `client:"local"`; its MCP calls, proof challenges,
approval retries, replay, resource reads and post-write event snapshots then use
that native bearer. Event visibility remains limited to resources readable by
that client's authenticated identity. Steps without a selected client retain
the Business credential path.
Arguments and target IDs can reference prepared values, for example
`{"$fixture":"operation","pointer":"/key"}`. These references require the
fixture module and fail when their value or client is absent. Audit verification
checks each client's own agent, sponsor, client ID and null Business consent;
Business credential and consent negatives still use the Business credential.

The initial unanswered-policy round can return only clients: its refusal probes
use unresolved arguments just as they do for `$from` references. Successful
journeys require the real prepared values. Later preparation runs with the
autonomous policy in force, before adopting the policy under test, so native
REST mutations can enter the real agent door to establish receipt custody.
Their audit rows remain available and their client identity is checked. Only
rows created inside preparation are separated from the journey's exact audit
count; every tested call still requires its own matching audit row.

Preparation runs before `initial`, `removed`, `autonomous`, `held`, each
`blocked:<class>`, `paused`, `negative` and `consent` round, before no-effect
witnesses are taken. Optional replay, invocation, webhook and record-security
phases prepare as `replay`, `invocation`, `webhook` and `no-subject`. Every
preparation replaces the prior values and client handles. Create fresh state
through the native doors for each round; do not resurrect erased records or
write application tables directly. Failures remain conformance failures with
redacted diagnostics. Omitting fixture declarations never supplies missing
tool/class coverage, credentials or native state.

## Per-run provider fixture control

The same initializer and native journey receive
`fixtures.set(exactDeclaredOrigin, jsonValue)`. It permits at most 100 updates,
16 KiB of JSON per value and only origins in `verification.network.origins`.
Read challenges or other values through native HTTP or declared tools first,
then set the isolated edge's response fixture. No production state accessor,
route, credential or authorization bypass is supplied by the verifier.

The network module's default `fetch(request, {fixture})` receives the most
recent value for that request's declared origin, or null. The request retains
its original method, URL, headers and body. A private loopback transport carries
the fixture and strips its carrier headers before invoking the adapter; app
headers cannot override it. Fixture controls are host functions, never served
routes. Values are isolated to the run and cleared on close. Undeclared origins
still receive 502, and the adapter's own outbound fetch remains denied. Keep
native DNS/challenge, signature and receipt validation inside the application.

## Copy source without Base's upstream tests

Copy runtime source and declarations with the authoring export's `testSource`
filter (`composition/git-source.mjs`), then `record-base` the files actually
copied and `rer refresh-base` the exact selected revision. Do not bulk-copy the
upstream `tests/`, fixtures or test typings into a seed's application source.
Refresh preserves deliberately omitted upstream tests; the record's
`notCopied` result makes those omissions inspectable. Existing intentional test
copies remain their owner's choice and are not silently removed.

The door's operator-people adapter also needs [operator-auth](../operator-auth/); Business
settings needs the [foundation runtime](../../foundation/runtime/). Copy/record those dependencies at their
corresponding relative paths or retain the seed's supported native adapters.
The fresh-copy journey records and refreshes door, settings and prerequisites
through the exported authoring CLI, then typechecks the entire copy under strict
TypeScript without excluding any copied files.

## Current admission on replay

Idempotency keys retain outcomes, not authority. Every retry rechecks the current
credential, sponsor, agent and consent revocation, scope, pause and policy before
returning saved content. Read-only retries re-run native target, classification
and visibility checks. A completed mutation instead uses its retained native
target and effect facts: deletion, a consumed schedule/draft, changed risk or a
restore/grant/role that is now a no-op must not rerun preparation callbacks. A refusal has its own
audit row and never includes the saved result. A new approval or review
requirement returns `approval_required` or `review_required`; an old approval
cannot authorize a newer policy revision. Accepted mutation replay does not
execute or count the native effect again. Record revision preconditions guard first
execution; they do not reject a successful replay merely because that execution
advanced the record revision. Changing `expected_revision` changes the request
and still returns `idempotency_conflict`. Pending, rejected and refused outcomes
never become completed receipts, and approval execution still rechecks the native
revision, exact summary and classification before making its one effect.

Known limitation (A1, deferred): an approved native DELETE retried with its
original key can return `not_found` when its classifier reads the deleted target.
The classifier must still enforce current native authority; authority-preserving
replay for deleted targets follows.

The response decision and replay audit describe current policy admission against
the recorded effect facts. For approved calls, `_meta["com.runeditrun/receipt"].decision` retains the original
decision, including classes/facts, revision and approval/review disposition;
the existing review metadata retains the original review when present. The native output
retains its consumed version. Conformance checks original class evidence against
that receipt separately from current admission; refresh runtime and conformance
together. Receipt access still requires current scopes (including `currentScopes`
for native grants) and any required native proof. Do not put mutations into a
scope or proof resolver.

Completed read-only approval replays, including aggregate tools, execute the
native read again with the caller's current identity and grants. Target and
classification checks alone cannot establish aggregate row visibility. The
response carries only the current native payload, or the native refusal without
saved content; unchanged visible data returns the same result and approval
receipt. The original approval outcome remains recorded, and pending approvals
remain pending. Keep native read implementations free of mutations: once-only
effect replay applies to mutating tools, while read visibility is always current.

For an explicit current-authority proof, declare
`verification.replayAdmission: {prepare:['create']}`. Preparation names existing
journey steps and must end with an idempotent write. Its public-door phase
proves identical once-only replay, pause and changed-policy refusal, a newly
required approval, current scope and the refused replay's complete audit.

## Initialize each conformance agent

Declare `verification.agent: {"initializer":"tests/initialize-agent.mjs"}` when
native verification or a grant must bind to the conformance agent ID. The
contained module default-exports an async function receiving
`{agentId, request, origin, email, sub, mail, fixtures}`. After owner admission
and fixture setup, it runs exactly once for each chosen agent ID, before that
agent's first phase or MCP request, including each additional sponsor's agent.
`request(absoluteURL, init)` is restricted to the disposable origin and carries
that sponsor's native person session and Origin; use existing person doors to
create the binding. Native writes retain person attribution. No signing key,
token minter or setup token is supplied. Invalid declarations fail with
`agent_initializer_invalid` before installation; an initializer failure stops
the run with `BASE-AGENT-001.agent-initializer` and a fixed private-data-free
diagnostic. Without this declaration the existing flow and audit checks apply.

## Verify multiple sponsors

Keep `verification.owner` for the first owner's existing bindings and lifecycle.
Optionally declare `verification.sponsors` as a nonempty list of principals with
unique stable `label` values and distinct canonical emails:

```json
{
  "sponsors": [
    { "label": "owner" },
    { "label": "member", "email": "synthetic-member@example.com", "role": "member", "initializer": "tests/initialize-member.mjs" }
  ],
  "crossSponsor": {
    "prepare": ["create"],
    "read": { "tool": "example.records.read", "args": { "id": { "$from": "create", "pointer": "/id" } } },
    "change": { "tool": "example.records.update", "args": { "id": { "$from": "create", "pointer": "/id" }, "value": "Edited" } }
  }
}
```

These keys live under `verification`. The first principal inherits `owner` and
runs all existing phases. Each later principal requires its own contained
initializer and receives `{label,email,sub,displayName,claim,owner,request,
origin,database,returnTo,mail,fixtures}`. Its fresh signed claim uses the same disposable
installation ring; `owner` carries the first principal's native session for
normal invitations. A signed Business settings roster binds each subject with
its declared `admin` or `member` role (default `member`). Complete the seed's
native member lifecycle and return its final 303 session response. Never create
accounts or sessions through direct SQL.

`database(binding)` exposes read-only SELECT statements against declared
**disposable verification** D1 databases, for test-owned mailbox or native
installation state. It has no production bindings or served endpoint. All
account creation and record effects still go through production doors. A seed
with another identity lifecycle uses its initializer and supplied signed claim.

`crossSponsor.prepare` names journey steps that create private native records.
The `read` and `change` fixtures use those outputs. Each additional sponsor must
successfully act on its own records, fail to read or change the first sponsor's
records, and fail to read or approve the first sponsor's private approval using
both its session and agent credential. Audits must attribute both principals
correctly. An omitted list or one sponsor runs no extra phase or points.

## Provision verification webhook secrets

A seed that creates its own random installation HMAC keys can set the
`verification.network.secretSource` field to the path of a test-only module
(for example `tests/read-webhook-secrets.mjs`) alongside its existing network
module and origins. The contained test-only module
exports `async function ({database})`, reads the fresh installation's own state
and returns a nonempty map of uppercase binding names to string values. The
isolated receiver receives that map as `env.secrets` in its `fetch(request,env)`.
It still has no application bindings, Node capabilities or outbound network.
Provisioning occurs after native initialization and Business binding, before
journey effects. Values and accessor failures are never printed. No accessor
is bundled into the app or mounted as a production route.

For callbacks into the seed, also declare:

```json
{ "webhooks": { "module": "tests/inbound-webhook.mjs", "prepare": ["create"] } }
```

This is another key under `verification`. Its contained module default-exports
an async builder receiving `{origin,outputs,secrets}` and returns
`{valid: Request, invalid: Request}`. Sign the seed's exact native payload with
its per-run key and with a wrong key, respectively. Both requests must POST to
the disposable installation origin. The verifier requires a 401 or 403 with no
native change for the invalid signature, then a successful response and a
retained native effect for the valid signature. Native signature validation,
replay checks and state commits remain in the seed.

## Security changes with no authority subject

A security tool changing only a record may explicitly declare `authority:
'none'` instead of an authority callback. Declare the same `inputSchema` and
`effect: {kind:'record', justification:'...specific native record change...'}`
in its runtime definition and `agent-surface.json` tool. Validation requires a
mutating security tool, no access class, a nonempty justification, and a closed
recursive schema containing only typed record inputs. Open or opaque objects,
references and schema composition are refused. Person, user, owner, sponsor,
agent, role, scope, grant, credential, permission, consent and token fields,
including nested and camel-case variants, are refused.

The registry publishes this class and record effect; conformance matches them
to the runtime schema. Normal policy, approval, execution and audit still apply.
Undeclared arguments return `undeclared_arguments` instead of being ignored.
Every success, pending execution and refusal records `authority: 'none'` in its
audit row. The extra conformance phase probes widening arguments, unchanged
native state, audit attribution and a rejected authority-bearing declaration.
A tool that can change someone's authority retains its callback and
`self_escalation` fixture. Narrowing callbacks continue returning
`{subject, widens:false}`; this record class does not replace narrowing checks.
## Native independent reviewers in verification

An owner initializer that needs a second person during fixture preparation can
declare that person's native lifecycle separately:

```json
{
  "verification": {
    "owner": { "initializer": "tests/initialize-owner.mjs" },
    "reviewers": [
      { "label": "quality", "email": "synthetic-quality@example.invalid", "initializer": "tests/initialize-reviewer.mjs" }
    ]
  }
}
```

The owner initializer receives `reviewers.initialize(label, {cookie})`. Pass its
real native owner session. The declared reviewer initializer receives
`{request, origin, label, email, owner: {email,cookie}, returnTo, mail}`. Use the
same-origin `request` to invite the reviewer, consume their invitation through
the native confirmation handler, and return its final 200 or 303 `Response` with the
reviewer's session cookie. A native JSON 200 response is accepted alongside a
303 redirect; other statuses, followed redirects, absent cookies and the owner's
cookie refuse the lifecycle. The response body grants no authority. `initialize` returns `{email,cookie}` to the owner
initializer, which then performs the native independent review. No agent token,
signer, database writer or production test route is supplied. Native roles,
independence, expiry, one-use proofs and step-up checks remain authoritative.
This test session grants no authority to a queued agent job.

`mail.read({limit, maxAgeMs, after})` returns only this declared reviewer's
accepted Resend, SendGrid or Cloudflare mail submissions as
`{id,at,subject,text,html}`. The provider edge remains isolated. Rejected or
oversized submissions and undeclared recipients are unavailable. Capture is
limited to twenty messages, 64 KiB per submission and five minutes of age;
defaults are ten messages and five minutes. No headers or provider credentials
are exposed. Each initializer runs at most once, there are at most eight unique
reviewers distinct from the owner, and capture is destroyed when verification
closes. The harness requires every declared reviewer lifecycle to complete;
its fixed failure diagnostic never prints mail, proofs or initializer errors.
Keep lifecycle modules in test tooling outside the production graph.

This hook is already available in 0.2.86. To use the admitted second person for
an agent-door approval, require `person:<reviewer's Business person id>` in the
signed policy and submit the exact approval revision and summary hash with that
person's confirmed native session. The signed roster must bind that person to
the native account before admission; it deliberately refuses to adopt an
unrelated existing account. The sponsor cannot satisfy this named reference,
even when the sponsor has an owner or editor role. `sponsor` and broad role
references express different policies and do not guarantee independence.
The door records the approver's native id and name in the approval, supplies it
in `ctx.approvers`, and retains the approver id separately from the sponsor in
the execution audit. Completing the mail lifecycle never grants the sponsor
that person's authority.

## Client custody boundary

The door retains idempotent outcomes, pending approval arguments, review
summaries, trace text, audit and events. Native client erasure must account for
these stores; a native record deletion alone cannot remove retained content or
prevent replay. Use the native subject map and erasure transaction adapter below; each seed still owns its subject selection, native holds and public-door proof.
Keep a native custody exception closed when these stores contain client data.
An adoption must establish the native mapping from retained artifacts to
clients, the permitted redaction of retained decision evidence, and the atomic
fence against pending execution and concurrent capture before enabling it.
The existing evidence-retention requirement still applies.

## Resolve native targets for audit and approval

A record tool declares `target(args, ctx)` alongside `classify`, `summary` and
`revision`. Return `{ kind: 'invoice', id: nativeRecord.id }`, or `null` if the
call has no native record target. Resolve through the native service; arguments
and returned resource links do not establish identity. The resolver receives the
current sponsor, agent/client and narrowed scopes. It must enforce native
visibility and return only audit-safe, policy-redacted identifiers. Do not put
credentials, private record content or unauthorized existence signals in them.
The door validates an exact nonempty string `kind`/`id` pair and refuses malformed
answers as `target_invalid`; a resolver is attribution, never an authorization
grant. Keep native access checks inside classification and execution too.

Tool audit rows store that pair in `resource`; undeclared or absent targets stay
`null`. Resource reads retain their requested URI in `resource`. Pending approval
summaries also contain the server-resolved pair as `summary.nativeTarget`, bound
to `summary_sha256`. Approval execution resolves again under the current native
principal; a changed target refuses `approval_evidence_changed` before effects.
Read-only record tools may declare the same resolver.

A journey step may declare `target: {kind, id}` to check the native identity in
its audit, pending summary and execution audit. The `id` may use a prior-result
`$from` reference. Supply the expected redacted native identity independently of
the proposed arguments; a wrong pair must fail conformance.

## Keep refusal attribution and classification

For schema-valid, resolvable calls, policy-unset, unavailable and paused refusals
retain the native target and computed classes/facts. Their rules use a null rule
id and the stopping disposition (`unset`, `unavailable` or `paused`): no policy
rule authorized an effect. Classification and target hooks are read-only and
must work without an adopted policy. If native authorization or missing state
causes a `ToolRefusal`, the audit retains `classification_refusal` with that
code, without inventing facts or bypassing the policy refusal. Invalid arguments
and principals lacking the tool scope do not resolve native targets.

## Return resource refusal machine codes

Every resource refusal carries its named code in JSON-RPC `error.data.code`,
including `resource_unavailable`, `tool_not_found`, `insufficient_scope`, policy
refusals and `approval_required`. Missing and hidden native records both return
`resource_unavailable` with no content or distinct existence signal. The code is
the same one produced by the tool pipeline; no seed response hook is needed.

## Declare sponsor escalation per native surface

An access/security surface tool may declare `sponsorEscalation: false` only when
its native authority resolver cannot widen the admitted sponsor. Examples are
record visibility changes with no standing authority subject, and admin-only
teammate edits whose sponsor already has full native authority. This declaration
replaces only an inapplicable sponsor-escalation fixture. Every declared class
still needs ordinary journey coverage, including real native widening/narrowing
changes where supported, with policy, approval, audit and native guards intact.
A missing or true declaration still requires the escalation fixture. It never
disables the runtime's self-widening refusal. Checked `widens: false` tools still
need their narrowing schema and grant-subset witness; this flag cannot waive
those checks. Owner-to-admin is a native demotion, never a widening operation.

## Runtime audit rows beyond harness calls

Conformance records approval executions that return either `executed` or
`refused`, checking their own audit link, approval id, outcome and code. An
honestly refused execution does not satisfy its journey's completion or receipt
checks. Native continuations are checked separately from ordered harness calls:
an `embedded` row must carry a nonempty `continuation_item_id` and the
`operation_id` of an earlier harness row with the same agent, sponsor, consent
and client. It must retain a recorded policy decision, matching rules, a `done`,
linked `replayed` or coded `refused` outcome, and zero `differs_from_policy`.
A completed replay must link an earlier completed original with the same agent,
sponsor, consent, client, operation, tool, native item, public key, classes/facts
and target. Its current policy is checked independently; it records no new
resource-effect list or count. Erased evidence still requires the verifier's
pre-erasure snapshot; a tombstone alone cannot establish a replay link. Other extra rows
still fail the audit count; a continuation marker alone cannot hide one.
Harness rows match their recorded decision identities in native order, so an
unexpected row remains a distinct failure without shifting later comparisons.

## Contract clauses

[`CLAUSES.md`](CLAUSES.md) is the single canonical source for
`BASE-AGENT-001` through `BASE-AGENT-013`: transport, tools, resources,
identity, authority, classes, policy, attribution, audit, events, limits and
Pause, idempotency, and the manifest and conformance journey. Its requirement
text and numbered acceptance points preserve the shared duties previously
printed in `export/BASELINE.md`. Copying a duty never proves its implementation.
The baseline keeps the implementation coverage and outstanding gaps separately.

The static surface validator checks every clause ID named by tools and
`notTools` against the seed contract. The built-in `events.list` tool cites
`BASE-AGENT-010`; conformance point prefixes cover all thirteen shared duties.
There is no fixed shared set of `AGENT-*` or `SURFACE-*` IDs: those remain the
seed's own specialist jobs and deltas. The sync never creates or changes them.

A directory copy of `modules/agent-door/` delivers `CLAUSES.md` automatically
through the existing `record-base` and `refresh-base` workflow above, including
its digest in `base-copies.json`. If the edition instead records individual
module files, copy and record this additional file from the same immutable
commit (replace the destination with the edition's actual module path):

```sh
git -C /absolute/base-checkout archive FULL_BASE_COMMIT modules/agent-door/CLAUSES.md | tar -x -C src/base
node node_modules/@runeditrun/rer/edition-authoring/cli.mjs record-base src/base/modules/agent-door/CLAUSES.md modules/agent-door/CLAUSES.md FULL_BASE_COMMIT --base /absolute/base-checkout
```

Do not add a singleton record under an existing directory record. The CLI also
ships this canonical file in its portable source inventory for editions that
have not copied the runtime yet. When a module copy is recorded, the command
uses that copy and verifies its recorded digest. An older runtime record
without the clause file uses the CLI-delivered source, so a contract sync does
not require moving the runtime ahead of its own adoption work. The CLI and runtime remain separate pins.

From the runnable seed root, using a CLI containing this command:

```sh
rer door clauses --check
rer door clauses --write
rer door clauses --check
```

If the seed's pinned CLI predates the command, use the selected Base checkout
directly, without changing that pin or the runtime copy:

```sh
node /absolute/base-checkout/bin/rer.mjs door clauses --write --cwd /absolute/seed
node /absolute/base-checkout/bin/rer.mjs door clauses --check --cwd /absolute/seed
```

`--cwd DIR` selects a different seed root. `--check` is read-only, exits 1 and
names every missing or stale shared clause, and checks the generated documents
when all clauses are current. `--write` inserts missing clauses in
`### Agent surface (Base-delivered)` under Target clauses, before the seed's
last `### Agent surface` area, and updates existing shared definitions in place.
Writing requires a `## Shared duties (Base)` table with a `Base duty` column.
Duties listed in that column are inherited and skipped, so listing all thirteen
leaves the contract byte-identical. An unlisted duty is still synchronized as a
clause. A missing table refuses before any files or generated views are written.
The read-only `--check` continues to inspect clause definitions, including for
duties listed in the table.
It preserves all other contract bytes except the generator-owned summary rows.
Existing shared Status, Evidence and Gap cells stay verbatim; canonical title
updates change only the Title cell. New clauses have status `missing`, with a
gap requiring judgment through this seed's own doors. The judged revision and
date stay unchanged, and a second write produces no diff.

The command runs the seed's `Lander-Regenerate` contract-docs `write` command
from `AGENTS.md`, followed by the corresponding `check`, retaining any declared
arguments. Without that declaration it uses
`node src/base/contract-docs.mjs write`, then `check`. Restore or copy the real
contract generator before syncing; legacy contracts must first be converted to
the standard level-four clause and Status table shape. Review the contract,
`ACCEPTANCE.md` and `docs/CLAIMS.md` together, run touched seed checks, then run
the edition's documented source-lock command **last**, followed by its source
check. Locking and committing remain explicit edition-authoring steps.

If the coverage source has no historical Homepage claims, refresh the recorded
`foundation/runtime/contract-docs.mjs` copy before syncing. The generator accepts
distinct current claims in that case; it still refuses duplicate current claims
and requires every claim from a non-empty historical list to remain unchanged.

## Conformance probes with native revisions

Injection checks re-read each read-only `$from` prerequisite before resolving the
probe arguments. Reference native revision reads in `step.args` so every probe
uses the current revision after the preceding write. Write prerequisites retain
their original outputs and are never executed again to refresh a probe. The
additional arguments must still leave computed classes, facts and disposition
unchanged, and the probe must complete successfully.

Native target checks follow the audit API's `{rows,cursor,differs_from_policy}`
pagination using `after`, including pages containing no rows for this agent.
Both pending and execution targets must match the independent fixture identity;
a target beyond the first page receives the same check.

Base source archives expose their one supplied revision when matching current
workflow bytes during refresh. Unknown older workflow bytes remain seed-owned;
the archive provides no historical versions or migration ancestry. Archive
refresh still refuses legacy records lacking prior source membership and
migrations whose applicability requires unavailable Git history.

## Native-client receipts and consumed preparation

A native-client receipt reader may require both a retained operation key and a
real native client. Its journey fixture must obtain those through the seed's
contained native lifecycle. Empty receipt arguments and the verifier's default
Business credential do not establish that client or operation. The final native
journey hook runs after the standard phases; it cannot prepare a mandatory step
that has already run. Keep native receipt ownership and service-grant checks.

An idempotent native creation can consume its own preparation precondition
(for example, an unused schedule identity or revision zero). Completed mutation
retries use the retained effect facts for current policy and the original native
target for audit. Fresh and pending calls still execute target, classification,
authority and revision checks. Use `currentScopes` for current native grants and
native proof for a required recent human authentication: these admission checks
run on completed retries as well. A retained receipt never executes the mutation
again. See [current admission on replay](#current-admission-on-replay).

## Declare a door subset

The declaration lives in the existing `agent-surface.json` door descriptor:

```json
{
  "capabilities": ["tools", "policy", "pause", "audit", "idempotency"]
}
```

Pass that same array as `capabilities` to `createAgentDoor`. A descriptor alone
cannot change a deployed runtime: conformance checks discovery against the
array and fails a mismatch. Omit the field in both places to retain the legacy
full-door requirements and checks. An empty array, unknown names, duplicates,
a boolean map or an array missing any CORE name is rejected when loaded.

The mandatory CORE names are **tools, policy, pause, audit and idempotency**.
Principal authorization, owner-bound tokens, current scopes, native proofs,
self-escalation refusal, policy refusal, approval controls and consent revocation
remain unconditional. These security duties have no off switch. Native tools
retain their complete declared journeys, classification, output, injection,
replay and audit checks. Core is not permission to omit a native tool's security.

The currently scopeable optional names are:

| Name | Offered when declared | Refused when omitted |
| --- | --- | --- |
| `events` | Built-in `<seed>.events.list`, full retained-event, attribution and cursor checks | Absent from tools/list; typed tool refusal |
| `resources` | Native resource templates and complete policy-controlled reads of returned links | Empty template list; no resource discovery or resource links; typed read refusal |
| `prompts` | Specialist prompts and retrieval checks; at least one must exist | Empty prompt list; no prompt discovery; typed get refusal |
| `subscriptions` | Streaming notification acknowledgement and live pause termination checks; requires `events` | No subscription advertisement; typed listen refusal |

Refusals carry `code: "capability_not_declared"` and the capability name in the
usual tool error metadata or JSON-RPC `error.data`. Authenticated refused tool
and resource calls still receive audit rows. Internal event collection and
native resource visibility adapters may remain in place for audit and event
visibility; they do not expose an undeclared public resource door.

Discovery metadata `_meta["com.runeditrun/capabilities"]` and the conformance report
contain `mode`, `declared`, `refused` and `unscoped`. A declared optional
capability runs its full applicable checks; it is not credited merely for being
listed. Missing declared resources or prompts reject runtime creation; missing
built-in events fails catalogue and event checks. Conformance replaces only the
scopeable omitted families with explicit discovery, listing, typed refusal and
no-effect checks. Existing event definitions and journey steps in the descriptor
are excluded from the effective surface when events are omitted. References to
excluded steps must still validate; dependent native steps are never silently
removed. Native resource links are withheld when resources are omitted.

This first subset does **not** scope multi-sponsor, mail edges, resource refresh,
timed lifecycle, dual host, queued lifecycle or owner-native administration.
They appear under `unscoped`, cannot be selected as capability names, and are
not claimed as refused or proved by this declaration. Existing extra-sponsor,
provider, native journey, replay-admission, durable invocation and webhook
checks continue unchanged wherever supplied. In particular, owner bootstrap,
owner binding, native approvals and audit APIs cannot be switched off: they
carry CORE security. A seed-native journey that mixes these duties with a timed
or second-host scenario must be separated before that family can be scoped.
Keep the corresponding seed contract clauses partial until independently proved;
a subset declaration never promotes contract statuses.

## Native subject erasure custody

Verified native erasure wins over personal payload retention. Reuse the seed's
BASE-DATA-003 operation, authorization, legal holds, transaction and restore
checkpoint. The agent module creates no erasure journal or second subject lock.
Non-person agent identities are not data subjects.

Apply `schema/replay-aliases.sql` in a new numbered migration, add nullable
`expires_at INTEGER` and its index to `agent_door_calls`, and add nullable
`tombstone TEXT` to `agent_door_agents` (the fresh schema has that column).
Never alter an applied migration. Adopt the matching portability runtime:
`agent_door_replay_aliases` is mandatory installation bookkeeping, excluded even
when an archive policy explicitly includes it. Seeds with their own archive
inventory must classify it as installation-private and reject imported alias
rows; never copy aliases or the installation secret into exports.

Declare an `AgentArtifactMap` in product source. Every installed `agent_door_*`
table must appear once, with its complete `columns` inventory and either a bound
`match: {sql, params}` for this subject or an explicit `unrelated` reason.
`params` names properties of the supplied native `subject` object.
`checkAgentArtifacts(db, map)` is the adoption check: an undeclared table,
missing table or unaccounted column refuses adoption and erasure. Run it in the
seed's adoption/upgrade checks. SQL comes only from trusted product source.

```ts
const map: AgentArtifactMap = { artifacts: [
  // Complete every other agent table too; see the reference's exact declaration.
  { table: 'agent_door_calls',
    columns: ['agent','key','digest','decision_id','created_at','state','outcome','expires_at'],
    match: { sql: "decision_id IN (SELECT id FROM agent_door_audit WHERE json_extract(row,'$.resource.id')=?)",
      params: ['id'] } },
] }
```

`default-seed/src/agent-door/erasure.ts` supplies the complete reference map.
It declares personal custody in calls (`key`, `digest`, `outcome`), approvals
(`saved`, `approvals`, `result`), audit (`row`, `evidence`), reviews (`saved`,
`marked_by`), events (`uri`, `event`) and usage's open text facts in `classes`.
Usage retains numeric measures, currency, counterparty/direction categories and
non-personal agent scope dimensions so erasure does not reset policy allowances.
A native erasure notification keeps its event type and time without reintroducing
the subject identifier after the transactional hook.
Native subject IDs, exact addresses and the imported `sourceUserId` select their
linked decision, approval, review and event rows. Do not select by a common
name alone. Resolve native target IDs before admitting pending execution,
including tools that return only a child row ID.

**Operator subjects.** Select the operator's own rows by native id and exact
contacts, never by a policy reference or Business id: those appear in every
decision's policy evidence. Boundary-checked mentions must skip `person:`
references. Map sponsor identity columns separately, and declare
`agent_door_state` with `retire: { refs: 'policyRefs' }`, supplying
`subject.policyRefs = JSON.stringify(await operatorPolicyRefs(db, operatorId))`.
Import `operatorPolicyRefs` from the module's `index.ts`; it returns native and
mapped Business references, excluding the owner's Business identity. Owner
erasure is outside this recipe. Put `agentErasureStatements` inside the same
native erasure batch, including its portability checkpoint even for retirement
alone. Retirement replaces exact references in unsigned local policy and stored
copies with `person:erased:<erasure_id>`, which matches nobody. Required approvals
stay pending until expiry; retirement never drops an approver or changes the
local revision. Later writes apply the same suppression.

Report two retained items under BASE-DATA-006: the verbatim signed envelope,
which the seed cannot edit or re-sign, until the Business delivers a policy
without the reference; and the value-free, domain-separated SHA-256 suppression
digest and erasure marker, retained to honour erasure across later delivery and
archive restore. Never store a raw retired reference outside
`agent_door_state.envelope`. Equal-sequence refreshes and later revisions can
still name the retired person without darkening the door. The state field
`policy.pending_retirement` counts distinct retired approver/reviewer references;
the Agents page links to Business policy when paired, or the local editor.
The count clears when policy no longer names the reference or marker. In local
policy the marker remains until the owner chooses a replacement.

Append `await agentErasureStatements({db,map,subject,secret,tombstone,checkpoint})`
inside the existing erasure transaction. `tombstone` is
`{erasure_id: nativeOperation.id, at: nativeOperation.requestedAt}`.
`secret` is the installation's existing SESSION_SECRET-class private setting,
outside the data store; supply the same setting to
`createAgentDoor({erasure:{secret,fenced}, ...})`. Preserve its lookup lifecycle
for the replay associations it protects. No secret store is added.
`checkpoint()` returns the existing native portability redaction-checkpoint SQL.
The outer erasure already invalidates transfers; include its normal invalidation
exactly once. Selection and row snapshots are checked atomically before redaction
or alias publication. A raced selection refuses the batch and requires a fresh
native erasure step.

The existing erasure `beforeStatements` hook now receives `operation: {id,at}`
in both bounded execution and `nativeStatements`. This is the same native
operation. Keep native holds before opening it. Selected rows are redacted in
place. Arguments, results, subject IDs, names, contact details, free text, traces
and confirming payload digests, including approval summary digests, are removed.
What remains: row ID/sequence, pseudonymous agent ID, existing role/organisation
IDs, tool/class enums, outcome/error/approval enums, approver roles, existing
timestamps and `{erasure_id,at}`. Empty structural fields support existing readers.
Audit integrity is its existing sequence and tombstone; no hash chain is added.

The personal replay key is replaced by an opaque key derived from the call's
decision ID. For replay custody, the retention exception is an installation-private
HMAC-SHA-256 alias of the legacy key, scoped to its agent, under that existing
private setting. `REPLAY_WINDOW_MS` in `erasure.ts` fixes one replay window of
30 days after call completion, with no knob or per-seed override. `expires_at`
is set once at completion; preserve any existing call replay/retention horizon.
Erasure never extends it. Incomplete calls complete as tombstones at erasure time.
For legacy completed calls without a completion time, backfill from `created_at`
(as in reference migration `0039_agent_replay_window.sql`) without extending
retention at upgrade. Install the alias-delete trigger from the schema.
`expireReplayCalls(rt)` purges expired calls on door admission; adopters also
invoke it from their native scheduled cleanup for idle installations. The trigger
deletes each call's aliases in the same transaction, including native cleanup.
At the horizon a matching alias ceases to apply. An old key is a NEW request
under current authorization, never a re-execution of the erased call or recovery
of its value. In-window replay returns only `subject_erased` and the tombstone,
never executes and never echoes payload. Current sponsor, scope, revocation and
Pause admission still apply. Aliases are never exported/restored. The existing
checkpoint refuses older archives that could resurrect original keys or payload.

`erasure.fenced(name,args,ctx)` reads the existing native subject/installation
fence and refuses concurrent capture with HTTP 409
`subject_erasure_in_progress`. Enforce that fence in every native effect
transaction too. Cancel/hold pending work and approvals there. The reference uses
its pending request/operation and numbered native note/file write triggers.
Late audit, approval/review and event completion cannot overwrite a tombstone.
After commit, native missing-record rules supply no erased payload.

Retire deprecated `agent_retained_evidence_requires_review` functions, call sites
and triggers in a new seed migration once custody is integrated; do not disable
them with flags. Preserve independent legal/regulator holds, identity protections
and restore checks. Prove each subject type through its public erasure/restore
doors, scan every mapped column, replay the old key at now, 24 hours plus 1 ms
and the replay horizon plus 1 ms (a new request), and compare a peer's records byte for byte except references retired to the erasure's marker. Generic module tests
alone do not qualify an adopting seed.
