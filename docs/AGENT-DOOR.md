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

The explicit capability declaration contains the indivisible CORE duties
`tools`, `policy`, `pause`, `audit` and `idempotency`, plus bounded `prompts`.
Optional `resources`, `events` and `subscriptions` are undeclared and typed-refused. Their
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

## Generated on-site reference

Open `/docs/agents` on the installed application for the current registry reference.
The public page groups admitted tools by job and shows their exact names, scopes,
classes, classification case references and enriched input and output schemas.
It also states the current resource-template boundary, capacity limits, typed
errors and specialist preparation guidance. The same route accepts an explicit
JSON Accept header for its machine-readable reference representation.

The local development server admits the public `agent-surface.json` declaration
explicitly, so the same reference and registry load through `rer dev` as in the
emitted Worker. Private settings, archives and installer state retain their
existing exclusions.

The edition wrapper uses the shared registry enrichment and descriptors for both
this reference and MCP lists. Discovery and initialization instructions are built
from that registry and link to the page. Public documentation contains declarations
only: no workflow names, customer payloads, credentials or current policy answers.
Live discovery lists remain subject to authentication and company policy.

`agent-surface.json` holds the per-tool job and classification references. Each
reference names `checkClasses` in `src/modules/agent-door/conformance/journey.mjs`
and its actual autonomous and held fixture case IDs. The shared conformance
journey compares actual server classifications with those fixture expectations.
The reference is documentation of that proof, never a new classification rule.

`tests/agent-door/journey.mjs`, `documentationJourney`, compares the native HTTP
page and its schemas against discovery, initialization and lists on both MCP
paths. The existing PLATFORM-001 sanity journey and hosted CORE native journey
invoke it. `tests/agent-door/documentation-browser.mjs`, `documentationBrowser`,
is registered through the existing MCP browser journey in push Verify. It uses
the emitted Worker, checks keyboard navigation and readable schemas, proves
literal hostile labels through the production renderer, and captures the page
at 1440 and 390. Existing client-server browser assertions remain in that journey.
This extension adds no test registration or independently invoked script.

The page supplies no resource, prompt, event or subscription capability. Full
specialist jobs, native and provider parity, stranger-specialist completion and
remaining conformance families stay unfinished.

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

## Bounded specialist prompts

`prompts/list` deterministically lists `crank.runs.inspect` and
`crank.workflows.prepare`, with `ttlMs` and private cache scope. `prompts/get`
returns static text guidance for the Automation operations lead. Both protocol
versions receive the same guidance. These prompts take no arguments; string
arguments cannot alter or inject their messages. Malformed argument values and
unknown names are refused by the existing transport.

The draft guide explains current metadata, digest and revision fencing,
idempotency, inert creation and editing, saved-graph validation and native person
readback. The run guide explains scoped filters, bounded pagination and the
closed status, timing and count projection. Tool names, scopes and descriptions
come only from the admitted registry. Prompts neither invoke those tools nor
read records, reveal payloads, supply credentials, decide approvals or grant
publication, execution, provider or connector authority. Missing jobs remain
missing; names and imported content remain untrusted data.

Authentication, current policy, Pause and credential revocation still gate
retrieval. Unanswered policy and Pause hide the listing and refuse retrieval.
The existing Origin, protocol, header consistency and body bounds apply.
`tests/agent-door/prompts-journey.mjs`, invoked by the existing native journey and
fixture preparation, retrieves the guidance and completes draft preparation and
populated run inspection through production MCP under autonomous and held
policies. Native person readback verifies inert draft state and redaction; held
review marks use the real person door. It also exercises unknown and malformed
requests and the authentication, unset-policy, Pause, revocation and transport
refusals without changing workflows.

This slice keeps BASE-AGENT-001 partial. The publication-bound client connector
MCP remains separate; resources belong to BASE-AGENT-003. Broader specialist and
provider jobs, optional events and subscriptions, full hosted and self-hosted
compatibility and complete specialist acceptance remain owed. Existing owner,
account, ct, enforcing-egress and device holds remain unchanged. No provider,
Business, IdP or queued-clause prerequisite is released.

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
Local policy admission resolves every named approver and reviewer through the
current native people adapter. Each `person:` reference must identify an active
native person; an unknown, invited-but-unaccepted or inactive person returns
`policy_refs_unresolved` without replacing the last valid document or advancing
its revision. Business policy admission retains its separate signed subject
binding. Neither path turns a local person ID into a Business subject.

For the existing inert workflow tools, an explicit standard approval policy may
name two independent native people. Both must decide from their own signed-in
sessions before the effect can occur. Sponsor, unrelated, agent and device
requests cannot stand in for those named decisions. Previously recorded approvals
are rechecked against current active identity, policy revision, native draft
revision and the exact saved server summary at execution. Keyed concurrent and
restarted retries return the original result and receipt without another effect.
Rejection, expiry or stale evidence leaves the held effect unapplied. Explicit
autonomous and standard review policies retain their existing behavior.

`tests/agent-door/named-approvals-journey.mjs` exercises these native public doors;
`tests/agent-door/named-approvals-browser.mjs` uses independent signed-in browser
sessions and records pending, first-approved, executed, rejected, expired and
refused pages at 1440 and 390. This local inert slice stays PARTIAL: it grants no
provider execution, Business propagation, tenant interoperability, additional
class coverage or adoption parity through omitted agent doors. Existing scope,
consent, recovery, attribution, activity, usage, custody and egress holds remain.

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

A call that completes native classification but cannot acquire policy admission
returns `decision_busy`. Its audit retains the exact computed classes and facts,
current scopes, sponsor and policy revision. The unevaluated call has no policy
decision, winning rule, approval or review receipt, call claim or usage
reservation, and performs no native mutation. Invalid arguments, unknown tools
and inaccessible targets refused before classification retain no invented
classes. The existing native journey exercises real concurrent metadata and
inert-draft calls using the public fixture doors, compares the audit facts,
checks ordinary success and early refusals, and reads the same rows after
restart. This audit correction keeps BASE-AGENT-006 PARTIAL: provider leaf
classification, sensitive record content, omitted risk combinations and facts,
and the existing Business, IdP, provider, egress and device obligations remain
held. It changes no policy-reference or named-human approval scope.

The shared conformance assertion requires nonempty completed classification on
an undecided `decision_busy` refusal; empty classes remain valid only for calls
refused before classification. The native contention journey also checks that
refused draft names never appear, existing workflows stay unchanged, and native
run counts and usage accounting remain unchanged. Complete native workflow and
usage reports, including admitted inert drafts, survive restart unchanged.

Native create, update and duplicate preparation audits retain the door's verified
`ctx.approvers` as separate identity snapshots. The sponsor remains the sponsor;
an agent argument cannot select an approver. The native workflow response's
`prepared_by` and `preparations` retain those snapshots across restart and inactive
archive restoration. The editor shows the preparer, sponsor and actual human
approver for each preparation. Autonomous and older records without approval
evidence show no human approval; preparation approval grants no publication or
execution authority. Historical names render as escaped text. Native admission
also binds each verified reviewer's current operator generation. The same native
transaction fence checks that generation and active status before committing a
preparation, so revocation during an in-flight decision changes no draft or
native preparation audit. This does not change retained historical attribution.

The installed native editor journey in
`tests/agent-door/attribution-browser.mjs` keeps the existing construction proof
and exercises the separate-session approval and refusal paths through
`tests/agent-door/attribution-journey.mjs`. The shared hosted CORE journey also
uses the same native preparation projection assertions. This proves the inert
draft boundary only: provider actions, outside messages, signatures, certificates,
Undo attribution and broader specialist acts remain unproved.

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
| Specialist guidance | Six specialist prompts, typed events and handoffs | Two bounded native prompts; events and subscriptions remain undeclared. |
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
specialist week remain acceptance work. Only the bounded prompt capability is promoted.

Ordinary health, setup and application requests do not construct Business or
agent adapters. On door paths, native classification refusals use the shared
`ToolRefusal` type; policy-unset and Pause preserve their machine codes while
the native authority fence still prevents reads or effects.


## Recovery of interrupted inert draft writes

The create, update and duplicate workflow tools freeze their exact closed
metadata result in the native idempotency receipt, in the same guarded D1
transaction as the draft, snapshot and native audit. The normal response uses
that projection too. A retained door claim without an outcome can recover it
without executing the tool again, even after later edits and after 24 hours.
Old receipts that contain only identifiers cannot reconstruct an outcome.
An unexpected failure during an autonomous recoverable execution leaves its
door claim uncertain. In particular, a transient failure saving the outcome
must not let the catch path replace a committed native success with an
execution failure. A retry still requires matching durable evidence; absent
evidence remains refused without repeating the mutation.

The receipt binds the original agent, sponsoring person, consent, client,
tool, full declared argument digest, admission decision, operation and hashed
native key and scope. The existing native authority fence protects the write.
Recovery checks the binding, current native preparation and workflow access,
then the door applies its current Pause, revocation, classification and policy
checks. A changed client or consent cannot reuse a completed recovery. A newly
required review or approval is refused; recovery never creates either lifecycle
from a draft receipt. Only original autonomous inert writes are recoverable.
No receipt proves a provider effect, starts a job or grants execution authority. Recovery and completed
replay select the same current complete preparation grant as the native write
route, including workspace creation authority. A read grant on the target and
a builder grant on another workflow cannot be combined. Explicitly restoring
the complete grant permits recovery of the original result without another
write. Deactivated or erased sponsors cannot recover pending or completed
results, and person erasure removes their native recovery receipts.

The seed adapts the shared door types with an optional evidence-only recovery
callback, and the pipeline with claim-bound recovery before ordinary completed
replay. The callback never invokes a mutation. A receipt-backed recovery can
also correct an original audit marked failed by interrupted outcome storage;
ordinary cached replay retains the existing audit recovery behavior. These
narrow adaptations do not change runtime or package pins, declare queued
lifecycle support or widen the native tool registry.

Native receipts, door claims, policy, agent bindings and pending actions are
installation-local authority and do not travel in archives. Passive audit and
usage history remain portable. Restored drafts retain the DATA-001 owner
adoption fence and remain inactive; a fresh preparation credential does not
reconstruct old execution authority. The public-door recovery journey extends
the existing SDK and CORE draft lifecycle test and the declared hosted journey,
without adding a test registration or changing the test budget. The remaining
BASE-AGENT-012 obligations stay in its Status Gap.
