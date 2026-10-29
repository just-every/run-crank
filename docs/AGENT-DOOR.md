# Crank Agent door: partial CORE adoption

Crank exposes a bounded preparation and redacted metadata surface for the
**Automation operations lead**. This is a **PARTIAL** adoption of Crank's full
Agent surface. The declared CORE journey passes integrated conformance; full contract
coverage remains partial. The declared registry is [agent-surface.json](../agent-surface.json);
the implementation is [src/crank/agent-door](../src/crank/agent-door/index.ts).

The shared runtime source is adopted from Base commit
`2135c394939f4a737adabdc8003b0e667b31ac5a`; the corresponding released CLI is
`0.2.91`. The released runner passes 1,021/1,021 hosted CORE points, including the
seed native journey. This proves only the declared preparation boundary.

## Routes and capability boundary

`POST /mcp` is the canonical MCP door. `POST /api/crank/v1/mcp` is its alias,
served by the same registry, principal resolution and policy pipeline. Business
tokens retain the canonical `/mcp` audience. Protected-resource discovery is at
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`.

The explicit capability declaration contains only the indivisible CORE duties:
`tools`, `policy`, `pause`, `audit` and `idempotency`. Optional `resources`,
`prompts`, `events` and `subscriptions` are undeclared and typed-refused. Their
discovery lists are empty where the protocol supplies a list; they are not
advertised as working families. No event-list tool is injected and tool replies
emit no MCP resource links. A person's approval URL remains part of the policy
handoff; it does not imply record-resource support.

The surface declares `resources: []`, `escalations: []` and
`spend: { "none": true }`. No paid or provider call is reachable from these
twelve declared tools. This no-spend boundary comes from the admitted native
operations; it does not claim provider-spend-cap enforcement. Other native
Crank routes, execution paths and connectors have broader purposes outside this
registry.

## The twelve declared tools

Every tool declares only `standard`, with server-computed item-count facts.
Eight are read-only and four prepare inert work. Clauses below are the actual
registry metadata, not a statement that each cited clause is fully implemented
through this door.

| Exact tool name | Scope | Native behavior and returned projection | Clauses |
| --- | --- | --- | --- |
| `crank.workflows.list` | `workflows:read` | Find workflow metadata by name or folder. | WORK-001 |
| `crank.workflows.get` | `workflows:read` | Read status, draft digest, revision and step count; withhold graph values and settings. | WORK-001, WORK-008 |
| `crank.workflows.create` | `workflows:prepare` | Create a natively validated inert draft. | WORK-001, WORK-002, WORK-003, WORK-004, WORK-013 |
| `crank.workflows.update` | `workflows:prepare` | Save an inert draft with its native `draft_digest`; support `expected_revision` for a reviewed edit. | WORK-001, WORK-002, WORK-003, WORK-004, WORK-008, WORK-013, EXEC-003 |
| `crank.workflows.duplicate` | `workflows:prepare` | Copy the current native draft into a new inert workflow. | WORK-001 |
| `crank.workflows.validate` | `workflows:prepare` | Validate the saved graph without execution; return validity and warning, step and connection counts. | WORK-002, WORK-003, WORK-013 |
| `crank.runs.list` | `runs:read` | Page scoped run status, timing and version metadata with native filters. | EXEC-005 |
| `crank.runs.get` | `runs:read` | Read run metadata and step, wait and attempt counts. | EXEC-005 |
| `crank.connections.list` | `connections:read` | Read credential-free account binding and lifecycle metadata within native scope. | CONN-002 |
| `crank.catalog.list` | `catalog:read` | Read the installed connector operation catalogue and restrictions. | CONN-001 |
| `crank.coverage.report` | `catalog:read` | Compare a supplied app/operation inventory with the local catalogue; fetch no schema. | CONN-001, CONN-011 |
| `crank.custom.propose` | `workflows:prepare` | Convert a supplied OpenAPI document into an uninstalled native connector proposal requiring owner review. | CONN-011, CONN-020 |

Only create, update, duplicate and connector proposal have `readOnly: false`.
Validation is read-only even though its native adapter uses a POST.
Draft creation, editing and duplication grant no execution, publication,
connection or provider authority. A stored graph can describe provider work
without dispatching that work.

Workflow responses expose a closed metadata projection, including native names
and descriptions, status, owner identity, trigger type, digests and counts.
They do not return the full graph, hook URLs or credentials. Run responses omit
inputs, outputs, payloads, business keys, source IDs, error text and provider
request details. Connection responses omit secret values and encrypted material.
Catalogue presence is inventory, not dispatch authority or a claim that a planned
connector is built. Names, descriptions and imported declarations remain
untrusted content; every tool marks its results accordingly.

## Native people and authority

Signed Business settings enter through `POST /api/rer/business-settings`, using
`RER_BUSINESS_TRUST`. Crank adopts `display_name` and maps Business team roles
`admin` and `member` to the corresponding native non-owner roles through
`operatorAuth(env).businessTeam`.

Business access-token `sub` resolves through durable settings bindings:
`bs_settings.owner_id` binds the Business owner to the installation's native
owner recorded by `oa_bootstrap.claim_id`, reread in `oa_operators`;
native owner-role transfers cannot move this Business binding; `bs_team.business_id` binds a teammate to its retained
`operator_id`, with the signed `business_role` retained separately. Business
must send the signed owner/team identifiers before using them as token subjects.
Email is not the token-subject lookup key. Established bindings survive email
changes; conflicts and reassignment cannot silently transfer an agent's sponsor
or a pending person's decision.

The shared adapter rereads the native operator and active status. The Crank
adapter then resolves the current product team grants and binds an internal
Request object to that actor using server-only object identity. It fabricates
neither a browser session nor an authorization header. The native route rechecks
the operator's status, version and role, current complete product grant, and
workflow/connection scope. A Business role or policy disposition alone cannot
grant a native action. Preparation requires the current native preparation
authority; a teammate without the necessary product grant is refused.

Native mutations repeat agent and policy authority fences inside their database
transaction: local Pause, adopted policy expiry/Pause, agent/consent revocation
and continued Business attachment can prevent the write. Native transaction
guards remain responsible for their own product scope and revision constraints.

Existing owner-issued `crk_` preparation credentials also use this door. They
must be active `scope='agent'` tokens without a flow binding, issued for the
current active owner's operator version and a native session (or a dev session
only in local mode). The agent identity is `crank-token:<token id>`. Execution
grants and flow-bound trigger credentials keep their separate native purposes;
they do not qualify as preparation credentials. A rejected recognizable
Business token cannot fall through to local credential admission.

## First owner and person controls

First-owner setup uses the native setup-token bootstrap. Provision independent
server secrets `SESSION_SECRET` and `SETUP_TOKEN`, then submit
`POST /auth/bootstrap` with `{token, displayName, returnTo?}` from the configured
application origin. It atomically creates the configured `OWNER_EMAIL` owner
and native session only in an empty auth store, returning a session cookie and
safe redirect. It needs no email round trip. Keep the setup token server-side
and remove it after bootstrap; changing it does not reset the bootstrap ledger.
Ordinary owner and teammate sign-in continues through native auth.

Signed-in people use `/agents` and `/agents/approvals/:id`. Private person APIs
provide state, policy, audit, agent revocation, review and approval actions.
Mutations require the native person session and application Origin; an agent's
Bearer token is not a person's decision. The local owner controls
`POST /agents/api/pause` with `{ "paused": true }` or `false`.

## Policy, Pause, audit and idempotency

The runtime ships no company dispositions. A fresh installation with no answer
for `standard` returns `policy_unset` and a setup URL. A standalone owner saves
the complete policy at `/agents/api/policy`; paired policy arrives as a signed
envelope at `POST /api/rer/agent-policy` and remains Business-managed. Signature,
installation, audience, revision and sequence checks precede adoption; invalid
input does not replace the last valid state. Expired adopted policy refuses work.

The server classifies the declared operation. Agent-provided confirmation,
policy-class labels or instructions supply no authority. Policy can select
autonomous execution, execution with review, named-person approval, or blocking
for the same `standard` operation. Unanswered classes refuse. Across carried
classes the strictest result wins; this slice carries only `standard`.

Approval retains the exact server summary and SHA-256, target and revision.
The named person decides through the person door with the saved revision and
summary hash. A changed target/revision invalidates stale approval evidence.
An MCP elicitation response is a handoff to that decision, not the decision
itself. Pause and revocation are checked again before execution; Crank repeats
the relevant authority fence at native mutation time. Agent-door Pause controls
this preparation surface; the omitted workflow publication/control jobs are
separate native operations.

The durable audit records agent and sponsoring person separately, operation and
client/consent identity, scope, target, actual classes/facts, policy revision and
winning rules, outcome/refusal, idempotency key, trace, ignored argument names,
and approval/review attribution. Native product audit receives the same
invocation attribution through a cloned environment. Reading the audit does not
turn an agent into the approving person or expose credentials.

All four mutating tools require `idempotency_key`. The same agent/key and
unchanged declared arguments return the retained outcome; changed arguments
return `idempotency_conflict`. The runtime durably claims the call before
execution. An unresolved claim returns `call_in_progress` without repeating the
action; an unexpected failure is not permission to retry with a new identity.
Native draft writes additionally use their own keyed receipts and transaction
guards. Update uses `draft_digest`; update and duplicate expose a server revision
over current graph digest and metadata, so rename, status or publication changes
also invalidate an old `expected_revision`.

## Delta from ct's full draft

The comparison source is ct's 28 October 2026 draft at
`f1b0f7e6cfd80ca4db931be3234e3fc91afbd056:docs/contract/AGENT-SURFACE.md`, read
without merging it. That draft maps 86 Core clauses and proposes SURFACE-001
through SURFACE-013. It is a target, not evidence of implemented behavior.

| Area | ct draft | This declared slice |
| --- | --- | --- |
| Tools | 224 exact tool names | 12 exact-name overlaps; 212 draft names absent. |
| Proposal mapping | `crank.custom.propose`, citing CONN-020 | Same name; native OpenAPI preparation cites CONN-011 and CONN-020. |
| Record resources | 34 URI templates | 0; no record-resource links. |
| Classes | All 11 fleet classes, including computed combinations | Only `standard`; ten class families and the draft's computed-class pairs remain outside this declaration. |
| Specialist guidance | Six specialist prompts, typed events and handoffs | No prompt/event/subscription capability. |
| Journey | SURFACE-013's seeded business week under All-autonomous and Held policies | 13 declared steps covering these 12 tools, with a second workflow read; preparation and metadata only. |

The current journey creates, lists, reads, updates, rereads, duplicates and
validates a draft, reads run/connection/catalogue metadata, reports coverage and
prepares a connector proposal. It includes hostile instruction/confirmation
injections, workflow/run targets and a fixture run read. It does not construct,
test and publish the full lead-to-invoice service, dispatch paid provider work,
reconcile a lost external response, repair a live mapping or complete recurring
overdue-invoice contact. This bounded journey passes under autonomous and held policy, with the native
attribution, changed-key conflict, stale revision and local Pause checks.

Full native provider dispatch, publications and active-service controls, grants
and authority changes, client MCP administration and the other native tools
remain omitted. The draft's full graph/version reads and run inputs/outputs are
also broader than these redacted tools. The twelve tools cite twelve distinct
Core clause IDs; those citations do not cover all 86 Core clauses. The current
non-tool declarations are PLATFORM-002 (`connector`), DATA-001 (`import-door`)
and BASE-002 (`installation`); they are not the draft's complete non-tool map.
No missing native business operation is reclassified as a non-tool merely to
close coverage.

The existing publication-bound connector MCP retains its separate native
purpose: selected client tools execute against a separately issued grant and
published workflow version. Its continued existence is a remaining one-surface
gap against SURFACE-001's shared-registry requirement. Aliasing the old generic
`/api/crank/v1/mcp` path to this door does not close that gap or establish
native/provider classification parity through every wrapper.

This document records the implemented boundary. Integrated CORE conformance passes 1,021/1,021 points on rer 0.2.91. Native
Agents and pending/executed approval pages have browser proof at 1440 and 390.
The complete ct registry, native UI parity for its omitted jobs and the seeded
specialist week remain acceptance work. No optional capability is promoted.

Ordinary health, setup and application requests do not construct Business or
agent adapters. On door paths, native classification refusals use the shared
`ToolRefusal` type; policy-unset and Pause preserve their machine codes while
the native authority fence still prevents reads or effects.
