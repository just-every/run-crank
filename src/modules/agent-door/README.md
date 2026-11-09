# Agent door

Server-only source for a seed's MCP door, local company policy, signed Business
policy adoption, pending approvals, review feed, audit and retained events. The
runtime entry is `index.ts`; [ADOPTING.md](ADOPTING.md) describes edition wiring.
The module ships no company dispositions and does not issue OAuth credentials.

`createAgentDoor(options)` returns `handle(request)`, `invoke(name,args,who)` for
embedded agents, and `emit(event)` for native person actions. `handle` returns
`null` outside its routes; the edition keeps its existing router. Public exports
also include `defineTool`, `ToolRefusal`, `operatorAuthPeople` and runtime types.
Keep this code out of browser bundles. Apply `schema/agent-door.sql` through a
new numbered edition migration before using the database-backed runtime. The policy singleton is
created only by an adopted policy or a person changing a setting, so a fresh
or reset installation remains empty for archive restore.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /mcp` | Discovery, tools, resources, prompts and subscription streams. `paths` can add aliases; the token audience remains the canonical `/mcp` URI. |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | Canonical MCP resource, trusted authorization server and scopes. |
| `POST /api/rer/agent-decisions` | Signed Business pull of public decision projections; see the relay wire below. |
| `POST /api/rer/agent-policy` | Signed Business policy envelope; body `{"policy":"<JWS>"}`. |
| `GET /agents` and `GET /agents/approvals/:id` | Signed-in Agents page and exact pending action. |
| `GET /agents/api/state`, `/agents/api/audit`, `/agents/api/agents` | Private person-session state, audit and agent inventory reads. |
| `POST /agents/api/agents/:id/revoke` | Owner revocation of a recorded agent. |
| `GET` / `PUT /agents/api/policy` | Standalone owner policy read and complete-document confirmation; PUT body `{"document":{...}}`. Paired policy is managed by Business. |
| `POST /agents/api/pause` | Owner local Pause; body `{"paused":true}` or `false`. |
| `GET /agents/api/approvals[/:id]`, `POST /agents/api/approvals/:id/approve` or `/reject` | Pending reads and named-person decisions; POST body includes the exact saved `revision` and `summary_sha256`. |
| `GET /agents/api/reviews`, `POST /agents/api/reviews/:id/reviewed`, `/flag` or `/undo` | Review list, person marks and native reversal where supported. |

Person API mutations require the application Origin and native person session;
an Authorization header cannot stand in for that session. The edition supplies
its native sign-in and specialist prompts. The module does not create a second
application sign-in system.

## Wire and authority

The door serves MCP `2026-07-28`, `2025-11-25` and `2025-06-18`. Modern
requests carry `params._meta` protocol version and client capabilities, plus
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for named calls. Encoded
names use the UTF-8 Base64 sentinel `=?base64?...?=`. Lists have deterministic
ordering, `ttlMs` and private cache scope. Roots, Sampling and Logging are not
served. [MCP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
defines these wire fields.

Every MCP POST, including initialize and discovery, requires a valid bearer
token. Missing or invalid credentials return 401 with the resource-metadata
challenge before protocol/header validation. Initialize can carry its version
in `params.protocolVersion` without transport metadata. Later stateless calls
without `MCP-Protocol-Version` use `2025-06-18`; clients using the modern wire
format must send its version and metadata. Supplied method/name and protocol
metadata must agree with the request. Unsupported-version errors retain their
stable code and include a plain-language message listing the supported versions.

Tools declare input and output schemas, scope, possible classes, contract clauses,
server classification and their native action. Every mutating tool also declares a
server-computed `summary`; access and security tools require `authority`. Tools
with a `cost` member are rejected until provider spend is enforced. Resource
readers declare catalogue `classes` and classify the record they read; their
reads pass through policy, review, approval and audit. They enforce current
native visibility; unknown and invisible records share the unavailable result.
The reference raw people read tools conservatively carry `sensitive` because
they expose native detail fields; its workspace witness returns fingerprints.
External content can carry untrusted result metadata:

```json
{"_meta":{"com.runeditrun/untrusted":true}}
```
Embedded calls supply explicit principal scopes and use the same execution
pipeline and audit attribution. Resource authorization, events and subscriptions
retain the originating agent/client and scopes; `currentScopes` can intersect
these with current native grants, including at approval execution.

Access/security tools may declare a checked target-only `widens: false` contract
with a native grant-subset journey instead of sponsor escalation. Tools declaring
`proof: 'native'` require the seed's named proof verifier and human handoff, even
under autonomous policy or after approval. See [adoption](ADOPTING.md) for the
runtime hooks, wire reference and test module declarations.

Business access tokens are ES256 `at+jwt` credentials verified against existing
owner-claim trust, with the canonical MCP audience, sponsor, agent, scopes and
at most 15 minutes' lifetime and a required `consent` id. Resolve `sub` only
through the durable Business-person mapping, never the token's email. Business
must send settings `owner_id` and team `id` values equal to token `sub` before
minting access tokens. `operatorAuthPeople` uses the module-owned settings
mapping and re-reads each native operator with the same admission predicate as
native sessions, including `AUTH_ALLOW_LIST`. Later reads use `people.person(id)`;
changes of email cannot transfer an agent or pending approval. Local credentials require an explicit edition adapter; a rejected
recognizable Business credential cannot fall through to it. Local credential
issuance remains adopter work. When Business is stopped (a signed `detached:true` document or the owner's stop)
the door ends everything it derived from Business: no Business token is admitted for any subject (every method
answers 401 with its resource-metadata challenge and open subscriptions close on their next tick), a call admitted
with a Business token (`Principal.source: 'business'`) that was held for approval or waiting for admission is refused
as `sponsor_unavailable` without a native effect, and `person:` and `role:` approver and reviewer refs match nobody.
`sponsor` refs, seed credentials, native sessions and embedded invocations are unchanged, and the subject mapping
stays, so a validly signed envelope that names Business people is still adopted and its Pause and revoked lists apply.
`PeopleAdapter.businessStopped()` is required; `operatorAuthPeople` reads `bs_settings.stopped`,
including in Base's maintained seed. Business token admission, `person:`/`role:` reference resolution,
held Business calls and signed decision-relay pulls require this reader to positively return `false`.
A missing or non-function method, thrown or rejected read, `true`, `undefined` or any nonboolean answer
uses the same refusal as a stopped Business: token admission returns 401, references match nobody,
held calls refuse `sponsor_unavailable`, and the relay returns empty 404. Adoption conformance checks
all four paths after signed detachment with the old policy and trust retained. This runtime correction
needs no migration and leaves the default seed adapter's behavior unchanged. A signed envelope may include
`revoked: { agents: string[], consents: string[] }`; these refuse the next call
and expire affected pending approvals. Business delivery of those lists remains
platform work.

The policy catalogue, validator and decision function derive from platform
commit `72aa71c03d943b53ed43dc73cac17d412c00d8fb`, paths
`src/business/agent-policy/{catalogue,document,decide}.ts`; see
[policy provenance](policy/PROVENANCE.md). Named class rules beat wildcard
rules; scope-field count, stricter disposition and document order break ties.
Every carried class needs a catch-all answer. Across classes, unset refuses;
otherwise blocked, approval, review, autonomous is the order of strictness.

Signed policy adoption verifies the existing owner-claim issuer, app audience,
installation subject, ring and revision signature. A greater sequence replaces
the envelope; equal sequence with later issue time may change only `iat`/`exp`,
retaining all authority and the exact revision signature. Before requests the
verifier renews an envelope with less than 60 seconds left, keeping its 300-second lifetime. The closed
answer is `{"adopted":{"seq":n,"revision":r},"door":{"classes":[{"class":"standard","tools":["seed.area.verb"]}]}}`,
where `revision` can be null. Resources also contribute declared classes. A
Business rule with `max_per_day` must name a `seed`; unscoped daily limits are
refused as `policy_document_invalid` with the rule's `.seed` path, because this
installation cannot reserve company-wide usage. A named `person:` ref must
resolve to an active mapped Business person at adoption or have a recorded retirement.
Retired references match nobody and never remove a required approval. The signed
envelope remains verbatim until Business delivers a policy without the reference;
only the value-free suppression digest/marker persists across archive restore.
Unsigned local policy and stored copies use the erasure marker, including late
writes. Operator erasure uses `retire: { refs }` and `operatorPolicyRefs` in the
native batch; see ADOPTING.md for selectors and retention reporting.
`GET /agents/api/state` reports `policy.pending_retirement`, the number of
distinct retired approver/reviewer references still in force. The Agents page
shows a replacement notice with the Business policy link or local editor. Paired approver and
reviewer refs use Business member ids and roles, independent of native roles. Invalid input leaves the last valid state intact.
Expired adopted policy refuses agent work; unpairing uses the retained local
document, or leaves policy unset. Adoption delivery and the paired computer's
self-host transport are outside this module.

## Business decision relay (W-R1–W-R5)

The Business pulls the seed's audit; the seed never calls Business, holds no
signing key and has no outbox. This route is dark until Business starts pulling.
Only MCP calls with Business consent and an adopted envelope enter the feed.
Local credentials and embedded calls stay in the seed's own audit.

- **W-R1:** `POST /api/rer/agent-decisions` takes exactly
  `{"pull":"<compact JWS>"}`, at most 8 KiB. Authorization, cookies and Origin
  are not used. Other methods return 405.
- **W-R2:** the platform ring signs the exact ES256 header
  `{alg:"ES256",typ:"rer-agent-decisions+jwt",kid}` and closed claims
  `{v:1,iss,aud,sub,business,after,limit,iat,exp,jti}`. Issuer, app origin and
  installation subject match trust. `after` is an integer ≥0, `limit` is 1–200,
  `exp-iat` is at most 60 seconds, `iat` is at most 30 seconds ahead and `exp`
  is still in the future.
- **W-R3:** check body shape (400 `relay_invalid`), trust (empty 404), signature
  and closed claims (401 `relay_unauthenticated`), Business stop (empty 404),
  then the adopted Business (empty 404 for a different Business). Other
  refusals contain only `{code}`. Pause still relays its refused decisions.
- **W-R4:** a 200 answer is exactly `{decisions,cursor,head,more}`. Decisions
  ascend by feed sequence; the cursor is the last returned sequence, or
  `after` for an empty page, and `more` is `cursor < head`. Pages hold at most
  `limit` entries and 65,536 UTF-8 bytes. One indexed D1 range query joins the
  audit and current approval/review state. Repeating a pull is byte-identical
  while that state remains unchanged.
- **W-R5:** the Business must reject unknown or missing keys at every level,
  secret-shaped data, nonascending sequences, duplicate ids and sequences at
  or before `after`. It keys projections by Business, installation and audit
  id, replacing a whole row only for a higher sequence.

Live projections have exactly `id`, `seq`, `at`, `tool`, `disposition`,
`outcome`, `code`, `revision`, `classes`, `agent`, `consent`, `execution_of`,
`replay_of`, `approval`, `review`, `resources`, `resource_count`. Classes are
ids only; approval holds only `{state,expires_at}` and review only `{state}`.
Resources are up to eight URIs of at most 512 characters; `resource_count`
keeps the full link count. Completed writes retain only their result link URIs
in the audit, never link names or record bodies. No arguments, sponsor identity,
agent names, facts, evidence, keys, digests, rules or traces are projected.
Approval executions and door replays have their own linked audit ids.

The trigger-maintained `agent_door_relay` holds one row per decision, capturing
its first Business. Audit, approval and review changes replace its sequence,
including native erasure. Erased projections contain exactly
`{id,seq,at,erased:true,tool,classes,disposition,agent}`. The feed retains no
subject payload. Re-pairing cannot expose an old Business's feed to a new one.
The Business holds only the public projection for each relayed decision: the
17 keys above, including raw resource URIs for records the decision touched.
Only the owner of the Business can read this external copy. Record erasure
purges the live projection through a tombstone pull, replacing its whole row
with the erased form. Unpairing, re-pairing or stopping the seed, authority loss,
an unsupported route, a rewind or 30 days without a successful pull purge that
installation's Business copy. The seed keeps no additional copy beyond its own
audit and the bounded relay feed (one row per decision). The feed is never
trimmed and can rebuild the Business copy from cursor zero. This is seed-side
support for BASE-AGENT-009; platform readers and seed adoption need their own
evidence.

Approval produces `resultType:"input_required"`, opaque `requestState`, and,
when the client advertises URL elicitation, an `inputRequests` map whose
`approval` entry is `{"method":"elicitation/create","params":{"mode":"url","message":"...","url":"..."}}`.
Retry the original call with a new JSON-RPC ID and unchanged state; URL or form
`accept` is not a person's approval. The legacy path returns
`approval_required` with the pending URL instead. Actual named-person approval
is checked through the person door. The saved summary and its canonical JSON
SHA-256 identify exactly what the person decides. Missing or stale hashes get
`approval_summary_mismatch`. The final approval state is `executed` or `refused`
(with its code), alongside `pending`, `rejected` and `expired`; completion has its
own audit row linked by `decision_id`. Approved runs expose `ctx.approvers`.
Undo is a reviewer act with `UndoContext.agent: null` and a person actor.

Mutating tools require `idempotency_key`; `expected_revision` is optional for
tools with native revision lookup. Same agent and key and arguments return the
recorded outcome; changed arguments conflict. `REPLAY_WINDOW_MS` in `erasure.ts`
is one fixed window of 30 days after completion, with no configuration or
seed override. The call's `expires_at` is set once at completion and is never
extended by replay or erasure. A call with a recorded horizon keeps that horizon.
Incomplete erased calls complete as tombstones at erasure time. Upgraded legacy
completed calls use their recorded start because no completion time was stored.
Expired calls are purged on the next door call (or `expireReplayCalls` from the
native scheduled cleanup); the database trigger deletes their private aliases
in the same transaction. Expiry is enforced even before physical cleanup.
After expiry an old key is a new request under current authorization, and can
never recover the erased value. Within the window it returns only the value-free
`subject_erased` tombstone, with no effect. Aliases and their secret never enter
archives, exports or restore. Completed mutation retries still run the native classifier for current
sponsor authority. Its optional third argument carries the original effect's
classes and facts, so it can classify consumed preparation state after enforcing
current access. Current policy admission uses the recorded effect, and the
approval receipt retains its original decision separately. A `running` audit row,
usage reservation and idempotency claim commit in one D1 batch before execution. The recorded outcome precedes finalising that row.
A replay completes a non-final audit from the durable outcome; without an outcome
it returns `call_in_progress` and runs nothing. Every attempt captures its key,
traceparent and ignored argument names before early policy refusals. Native
actions still own their transaction guards and recovery.
Admission reservations prevent concurrent calls from exceeding daily policy sums; an admission lease cannot execute after it loses its fence. Contending calls wait at most five seconds for policy admission, then recheck current authority and policy before reserving usage or executing. `decision_busy` refuses exhausted admission and `call_in_progress` refuses an already claimed call without an effect. Only lock acquisition is retried; native actions are never retried. An unexpected execution failure keeps the key claimed because the native action may have committed; the edition must reconcile that action before recovery. The module does not supply a generic long-job executor.

## Errors and capacity

| Response | Meaning |
| --- | --- |
| 400 `HeaderMismatch` (`-32020`) | Required transport header is missing or disagrees with the body. |
| 400 `UnsupportedProtocolVersion` (`-32022`) | Error data lists `supported` and `requested` versions. |
| 401 with Bearer `resource_metadata` challenge | Missing, invalid, expired or revoked agent authority. |
| 403 `insufficient_scope` | Challenge identifies the needed scope. |
| 403 for foreign Origin | Request cannot cross the application's Origin boundary. |
| 413 | MCP body exceeds the configured byte capacity. |
| 429 `rate_limited`, with `Retry-After` | Per-agent request capacity exceeded. |
| Tool result `isError:true` | Stable business code in the result error metadata; for example `policy_unset`, `policy_unavailable`, `agents_paused`, `policy_blocked`, `self_escalation`, `approval_rejected`, `approval_expired`, `idempotency_conflict` or `revision_conflict`. |

The CLI conformance installation intercepts supported mail-provider requests only at the paid network edge; native invitation authorization and database effects still run. Other outbound effects are refused unless the adopter supplies its network adapter.

The tool error metadata has this shape:

```json
{"_meta":{"com.runeditrun/error":{"code":"policy_unset"}}}
```

Stable tool refusal codes are `policy_unset` (with `unanswered` and `setup_url`), `policy_unavailable`, `policy_blocked` (class, rule and revision), `approval_required` (legacy clients), `approval_rejected`, `approval_expired`, `approval_evidence_changed`, `self_escalation`, `agents_paused`, `idempotency_key_required`, `idempotency_conflict`, `revision_conflict` (with `current_revision`), `invalid_arguments` and `output_invalid`. Native `ToolRefusal` codes pass through unchanged. Person, local policy and adoption JSON refusals use `{ "code": "..." }`.
Local policy returns `policy_document_invalid` with `path`, `policy_incomplete` with `problems`, or `policy_managed_by_business`.

Provider spend caps are **not enforced**. Standalone saves containing
`spend.caps` return 409 `spend_caps_not_enforced`; `{ none: true }` works.
Business documents retain their contract and can carry caps, but state reports
`policy.spend_caps: "not_enforced"` and the Agents page displays that gap.
The state is `"none"` for an explicit no-cap answer and null without a spend answer.
Estimates, reservations and `budget_exhausted` remain follow-up work.

Default MCP capacity is **600 requests per minute per agent** and
**1,048,576 body bytes**, configurable through `limits`. These protect request
rate and size; they are not daily business-volume policy. Subscriptions poll
retained events every **one second** and close after at most **120 seconds**;
reopen the subscription and use the cursor-based events tool for replay. The
first SSE message acknowledges the honored notification filter; subsequent
resource and tool-list notifications carry the originating subscription ID. Access,
Pause and policy are rechecked while streaming. SSE has no transport replay.

## Verification boundary

`conformance/index.mjs` exports `runAgentDoorConformance` and
`validateAgentSurface` for real installations. It drives the HTTP door with a
test-only signer and signed-in person, declared native witnesses and an Agent
surface, under autonomous, held, blocked, unset and paused policy phases.
Stable `BASE-AGENT-xxx.n` point prefixes identify the checks it implements.
They are not evidence that every clause or every adopting edition has passed.
Module tests under `tests/`, this reusable journey and an edition's integrated
browser and native journey are separate evidence.

Remaining work includes full clause and tier and role and UI parity, Business delivery of grant narrowing,
Business revocation delivery, provider-spend caps and byte budgets, long jobs,
outside-mail attribution, standalone credential issuance,
self-host delivery, stranger-specialist completion, generated agent docs, and
adoption of this shared policy source by the platform. Editions must report
these gaps rather than infer them from passing module checks.
