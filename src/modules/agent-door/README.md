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

The door serves MCP `2026-07-28` and the `2025-11-25` initialize path. Modern
requests carry `params._meta` protocol version and client capabilities, plus
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for named calls. Encoded
names use the UTF-8 Base64 sentinel `=?base64?...?=`. Lists have deterministic
ordering, `ttlMs` and private cache scope. Roots, Sampling and Logging are not
served. [MCP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
defines these wire fields.

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
 Embedded calls
use the same execution pipeline and audit attribution.

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
issuance remains adopter work. A signed envelope may include
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
the envelope; equal sequence with later issue time refreshes it. The closed
answer is `{"adopted":{"seq":n,"revision":r},"door":{"classes":[{"class":"standard","tools":["seed.area.verb"]}]}}`,
where `revision` can be null. Resources also contribute declared classes. A
Business rule with `max_per_day` must name a `seed`; unscoped daily limits are
refused as `policy_document_invalid` with the rule's `.seed` path, because this
installation cannot reserve company-wide usage. A named `person:` ref must
resolve to an active mapped Business person at adoption. Paired approver and
reviewer refs use Business member ids and roles, independent of native roles. Invalid input leaves the last valid state intact.
Expired adopted policy refuses agent work; unpairing uses the retained local
document, or leaves policy unset. Adoption delivery and the paired computer's
self-host transport are outside this module.

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
recorded outcome; changed arguments conflict. Recorded outcomes are retained
indefinitely. A `running` audit row, usage reservation and idempotency claim commit in one
D1 batch before execution. The recorded outcome precedes finalising that row.
A replay completes a non-final audit from the durable outcome; without an outcome
it returns `call_in_progress` and runs nothing. Every attempt captures its key,
traceparent and ignored argument names before early policy refusals. Native
actions still own their transaction guards and recovery.
Admission reservations prevent concurrent calls from exceeding daily policy sums; an admission lease cannot execute after it loses its fence. `decision_busy` and `call_in_progress` refuse overlapping admissions without an effect. An unexpected execution failure keeps the key claimed because the native action may have committed; the edition must reconcile that action before recovery. The module does not supply a generic long-job executor.

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

Remaining work includes full clause and tier and role and UI parity, grant narrowing,
Business revocation delivery, provider-spend caps and byte budgets, long jobs,
outside-mail attribution, standalone credential issuance,
self-host delivery, stranger-specialist completion, generated agent docs, and
adoption of this shared policy source by the platform. Editions must report
these gaps rather than infer them from passing module checks.
