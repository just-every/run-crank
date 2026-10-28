# Crank Agent surface (draft)

Draft Agent surface for Crank, written by ct on 28 October 2026 to the contract standard's section 13. It maps every Core clause of `CONTRACT.md` at main `48406ba0e7dd40decc377adce31933dc9665e7c9` (86 Core clauses). It is not part of CONTRACT.md yet: the seed's contract cleanup folds the `### Agent surface` area below into CONTRACT.md as the last area under Target clauses, and the rows under "Status rows" into its Status table. Old clauses whose text fixes what happens to an agent's step: TEAM-002, TEAM-003, TEAM-004, CONN-003, CONN-007, CONN-008, CONN-011, CONN-019, CONN-020, EXEC-006, EXEC-007, WORK-006, WORK-008, WORK-014, AI-002, AI-003, AGENT-001, AGENT-002, AGENT-003, AGENT-004, PLATFORM-001, PLATFORM-002; the cleanup rewords them as the class the step carries.

### Agent surface

**Specialist: Automation operations lead.** It builds and operates the business's cross-app workflows, follows unfinished obligations, reconciles remote effects and repairs mappings without confusing successful requests with completed business work.

Inherits BASE-AGENT-001 to BASE-AGENT-013. The company's policy decides every call.

**How Crank computes each class.** The server uses typed native operation descriptors, resolved arguments, current recipients, account bindings and record revisions. Graph, custom-connector, HTTP and client-tool wrappers carry the union of the effects they actually dispatch, including nested subflows; deferred effects are classified again at dispatch. An unknown operation descriptor returns `unclassified_operation` without a provider effect. Agent-supplied labels, confirmation booleans, imported schemas and record text cannot supply trusted classification facts. Reversible work remains standard only while it stays inside the business; another class is never reduced by adding standard.

- *standard:* native metadata reads, reversible drafts, mapping previews, table edits and internal inbox messages; facts are item counts and revisions. Provider reads and irreversible effects do not become standard merely because a workflow calls them.
- *external:* any request to an outside provider, delivery to an outside recipient, or exposure through a public form, file link or webhook sink. Facts are actual expanded recipients (duplicates counted), provider and counterparty: known for a recorded customer/vendor or trusted business domain, new otherwise, public for an open link. Native-only work and internal native inbox contact do not carry external.
- *money:* a charge, refund, capture, payment, gift-card value, invoice/price/subscription change affecting what the business charges, or a billed model, executor or communications request. Facts are exact currency, amount and payee/counterparty; unknown billed amounts remain unknown. Reading prices, recording a forecast and quoting an estimate alone do not carry money.
- *commitment:* accepting an offer, recording a relied-on sign-off, finalizing an order/quote or sending an envelope that binds the business; facts are exact version, value where stated and counterparty. A reversible unsent proposal does not carry commitment.
- *accounts:* provisioning an outside identity or paid resource, including a provider subscription; facts are provider, resource kind and target. A Crank connection reference or a CRM contact without login or paid-resource provisioning is not an outside account.
- *gated:* an outside provider returns a consent, hosted card-entry, identity/business-verification or personal terms step; facts are provider and step. The provider keeps that step for a person at its own interactive screen; ordinary API continuation without such a response does not carry gated.
- *access:* staff invitations, membership/roles, service credentials, connection-use scopes, gateway grants and app/agent/client grants; facts are affected people/principals and direction, widens or narrows, from current authority and the native target.
- *security:* handling connection or webhook credentials, rotating encryption keys, changing protection/retention controls or exporting a backup; facts name the credential/protective setting without its value. Reading credential-free metadata is not security.
- *destructive:* permanent run/subject/operator/file/table erasure, permanent provider deletion, discarded unrecoverable held events or cancellation of an irreversible effect; facts are item counts and retained receipt identities. Undo, draft changes and canceling future dispatch without erasing history do not carry destructive.
- *sensitive:* actual health, identity, bank, card or payroll numbers in returned, retained or transmitted content; facts are record count and protected kind. A private customer name, a workflow's broad data-class label or a masked number alone does not establish sensitive.
- *live:* publication, rollback, trigger/notice/sink changes and other changes to behavior of an active workflow or service; facts name the affected service/version. Inert drafts and unactivated definitions do not carry live.

Crank uses all eleven fleet classes; there are no unused classes. `·` joins classes always carried together; `or` selects per call, and each `(+ class)` adds that class when its test holds. Today names existing native actions, not conformance of those actions to this draft; `none` means the typed job is not built. Paths below `/api/crank` name the existing API prefix, and step names identify native engine actions.

| Tool | Does | Core clauses | Risk class | Today |
| --- | --- | --- | --- | --- |
| `crank.workflows.list` | Find workflows by name, folder and owner | WORK-001 | standard (+ sensitive) | `list_workflows` |
| `crank.workflows.get` | Read a workflow and immutable version history | WORK-001, WORK-008 | standard (+ sensitive) | `get_workflow` |
| `crank.workflows.create` | Create an inert typed workflow draft | WORK-001, WORK-002, WORK-003, WORK-004, WORK-013 | standard (+ sensitive) | `create_draft` |
| `crank.workflows.update` | Save draft metadata, graph, mappings, loops, waits, paths and error routes | WORK-001, WORK-002, WORK-003, WORK-004, WORK-008, WORK-013, EXEC-003 | standard (+ sensitive) | `update_draft` |
| `crank.workflows.duplicate` | Copy a workflow into a new inert draft | WORK-001 | standard (+ sensitive) | `duplicate_workflow` |
| `crank.workflows.validate` | Validate graph types, schemas and branch limits | WORK-002, WORK-003, WORK-013 | standard (+ sensitive) | `validate_draft` |
| `crank.workflows.compare` | Compare retained version graphs and changed fields | WORK-008 | standard (+ sensitive) | `GET /api/crank/workflows/:id/compare` |
| `crank.samples.list` | Read retained samples with source and schema freshness | WORK-014 | standard (+ sensitive) | `GET /api/crank/workflows/:id/samples` |
| `crank.samples.save` | Retain an explicitly manual or permitted historical sample | WORK-014 | standard (+ sensitive) | `saveSample` |
| `crank.samples.select` | Choose the sample for downstream mapping | WORK-014 | standard (+ sensitive) | `sampleAction` (select) |
| `crank.mappings.preview` | Preview typed mappings, transforms, filters and path outcomes | WORK-002, WORK-012, WORK-013 | standard (+ sensitive) | `POST /api/crank/workflows/:id/preview` |
| `crank.subflows.list` | Read immutable subflows and recipe requirements | WORK-006 | standard (+ sensitive) | `GET /api/crank/subflows` |
| `crank.subflows.create` | Create an inert typed subflow version | WORK-006 | standard (+ sensitive) | `createVersion` in `workflows/subflows.ts` |
| `crank.recipes.install` | Install a versioned recipe as an inert definition with sample results | WORK-006 | standard (+ sensitive) | `POST /api/crank/subflows/install` |
| `crank.tables.list` | Read scoped table definitions and records | WORK-007 | standard (+ sensitive) | `tableApi` (integer state only) |
| `crank.tables.create` | Create an operational or lookup table | WORK-007 | standard (+ sensitive) | `tableApi` (integer state only) |
| `crank.tables.find` | Search a typed table without its create branch | WORK-007, WORK-011 | standard (+ sensitive) | `table.lookup` (integer state only) |
| `crank.tables.upsert` | Upsert a keyed record with an operation receipt | WORK-007, WORK-011 | standard (+ sensitive) | `table.atomic` (integer state only) |
| `crank.tables.increment` | Change an exact numeric counter atomically | WORK-007 | standard (+ sensitive) | `table.atomic` |
| `crank.tables.append` | Append typed values atomically | WORK-007 | standard (+ sensitive) | `table.atomic` (integer lists only) |
| `crank.tables.pop` | Pop a first or last value atomically | WORK-007 | standard (+ sensitive) | `table.atomic` (integer lists only) |
| `crank.forms.create` | Create an inert typed intake form definition | WORK-007 | standard (+ sensitive) | none |
| `crank.forms.submit` | Submit typed answers and files into the native intake records | WORK-007, WORK-009 | standard (+ sensitive) | none |
| `crank.digests.get` | Read entries, source runs and release history | WORK-010 | standard (+ sensitive) | `GET /api/crank/digests/:id` |
| `crank.digests.append` | Add an entry to a named digest | WORK-010 | standard (+ sensitive) | `digest.append` |
| `crank.digests.release` | Release one durable digest result, clearing or keeping entries | WORK-010 | standard (+ sensitive) | `digest.release` |
| `crank.catalog.list` | Read connector schemas, scopes, named operations and restrictions | CONN-001 | standard | `GET /api/crank/catalog` |
| `crank.coverage.report` | Report native, buildable and unavailable inventory operations | CONN-001 | standard | `coverageReport` |
| `crank.connections.list` | Read account bindings and credential-free lifecycle history | CONN-002 | standard | `list_connections`; `GET /api/crank/connections/:id/history` |
| `crank.runs.list` | Search and page retained run metadata | EXEC-005 | standard (+ sensitive) | `list_runs` |
| `crank.runs.get` | Read retained inputs, outputs, attempts and checkpoints | EXEC-005 | standard (+ sensitive) | `get_run` |
| `crank.runs.preview_replay` | Preview selected failed paths, corrections and prior effects | EXEC-004 | standard (+ sensitive) | `previewReplay` |
| `crank.effects.preview` | Read uncertainty and current reconciliation candidates | EXEC-006 | standard (+ sensitive) | `previewReconciliation` |
| `crank.queues.list` | Inspect live queues, priorities, depth and next release | EXEC-001, WORK-004 | standard | `GET /api/crank/queues`; `executionQueue` |
| `crank.holds.get` | Read a flood hold with count, source, samples and estimate | TRIG-005 | standard (+ sensitive) | `GET /api/crank/holds/:id` |
| `crank.holds.estimate` | Record explicit source-labelled component estimates | TRIG-005, OPS-002 | standard (+ sensitive) | `quoteHold` |
| `crank.historical.preview` | Capture source selection, count, samples and estimated cost | TRIG-002 | standard or external (+ sensitive) (+ gated) (+ money) | `previewHistorical` (bounded HTTP source) |
| `crank.historical.get` | Inspect retained source selection and per-item outcomes | TRIG-002 | standard (+ sensitive) | `readHistorical` |
| `crank.triggers.get` | Read schedules, watched fields, cursors and last/next poll | TRIG-002, TRIG-003, TRIG-004, TRIG-007, TRIG-008 | standard (+ sensitive) | `triggerState`; `watchedFields` |
| `crank.reports.operations` | Read operational counts, outcome evidence and CSV | OPS-001 | standard (+ sensitive) | `operationsReport`; `operationsCsv` |
| `crank.reports.latency` | Read measured trigger/start latency and lateness causes | TRIG-004 | standard | `latencyReport` |
| `crank.reports.usage` | Read estimates, forecasts and source-reported charges | OPS-002 | standard | `usageReport` |
| `crank.estimates.save` | Record graph-bound per-run cost assumptions | OPS-002 | standard | `quoteWorkflow` |
| `crank.budgets.update` | Change internal budget/allowance records without making a charge | OPS-002 | standard | `setBudget`; `allowOverage` |
| `crank.audit.list` | Read the append-only scoped action chronology | SEC-003 | standard | `readAudit` |
| `crank.audit.export` | Export value-free attributable audit records | SEC-003 | standard | `exportAudit` |
| `crank.health.get` | Inspect dependencies, recovery transfers and measured capacity | BASE-003 | standard | `health.ts`; `ops/recovery.ts` |
| `crank.disclosures.list` | Read outgoing recipient, purpose, field and provider-term inventory | BASE-001 | standard | `GET /api/crank/data/flows` |
| `crank.retention.preview` | Preview expiry and held/unfinished records without deletion | DATA-003 | standard (+ sensitive) | `previewRetention` |
| `crank.erasure.preview` | Preview a subject or run erasure with its digest | DATA-002 | standard (+ sensitive) | `previewSubject` |
| `crank.inbox.list` | Read native questions, deadlines and contact history | AGENT-004 | standard (+ sensitive) | `GET /api/crank/inbox` |
| `crank.followups.create` | Create an internal due obligation with native contacts and calendar | AGENT-004 | standard (+ sensitive) | `createFollowup` |
| `crank.followups.revoke` | End further contacts while preserving history | AGENT-004 | standard (+ sensitive) | `revokeFollowup` |
| `crank.calendars.update` | Save a native employee business calendar and contact cadence | AGENT-004 | standard (+ sensitive) | `savePersonCalendar` |
| `crank.skills.list` | Read versioned skills, cases and measured outcomes | AI-003, AGENT-003 | standard (+ sensitive) | `listSkills`; `/api/crank/recurring-skills` |
| `crank.skills.create` | Create an inert skill/instruction version from retained cases | AI-003, AGENT-003 | standard (+ sensitive) | `proposeSkill`; `publishRecurringSkill` |
| `crank.authoring.get` | Inspect a generated graph, samples and unanswered choices | AI-002 | standard (+ sensitive) | `readAuthoring` |
| `crank.authoring.revise` | Edit the inert generated graph and its source samples | AI-002 | standard (+ sensitive) | `reviseAuthoring` |
| `crank.drift.list` | Read field/permission incidents, repair diffs and results | AGENT-002 | standard (+ sensitive) | `listDrift`; `readDrift` |
| `crank.drift.propose` | Prepare a minimal mapping or connector repair | AGENT-002, CONN-020 | standard (+ sensitive) | `proposeDrift` (mapping only) |
| `crank.exceptions.propose` | Evaluate a normalization proposal on failures and counterexamples | AGENT-003 | standard (+ sensitive) | `proposeSkill` |
| `crank.exceptions.stage` | Stage an exact evaluated improvement in an inert draft | AGENT-003 | standard (+ sensitive) | `approveSkill` |
| `crank.objectives.get` | Read pinned recurring objective, progress and remaining obligations | AI-003, AGENT-001 | standard (+ sensitive) | `readRecurringWithRuns` |
| `crank.objectives.create` | Create an inert versioned recurring objective | AI-003 | standard (+ sensitive) | `createRecurringTask` |
| `crank.members.list` | Read current members and role/scope assignments | TEAM-001 | standard | `GET /api/crank/team` |
| `crank.sessions.list` | Read current native session metadata in scope | SEC-001 | standard | native Base session action |
| `crank.sessions.end` | End a native session without widening authority | SEC-001 | security | native Base session action |
| `crank.grants.list` | Read app, agent and connection authority without credential values | TEAM-002, TEAM-003 | standard | `readGrants` |
| `crank.clients.list` | Read selected client tools and credential-free call history | PLATFORM-002 | standard | `src/crank/mcp/client-api.ts` |
| `crank.events.list` | Read the replayable typed change feed | PLATFORM-001 | standard | none |
| `crank.workflows.test` | Execute a retained sample against explicit bindings | WORK-008, WORK-014 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `testWorkflow` |
| `crank.samples.load` | Load fresh provider, webhook or history samples without production admission | WORK-014 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `listenForSample`; provider sample loading none |
| `crank.runs.start` | Start an on-demand workflow on the selected immutable version | TRIG-002, EXEC-001 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `startRun` |
| `crank.runs.resume` | Continue retained checkpoints without repeating completed effects | EXEC-001, EXEC-002 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `resumeRun` |
| `crank.runs.replay` | Replay selected failed paths with digest-bound corrections | EXEC-004 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `replaySteps` |
| `crank.effects.reconcile` | Read back an uncertain remote effect and retain the selected evidence | EXEC-006 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `reconcileEffect` |
| `crank.effects.compensate` | Run a distinct declared compensating operation | EXEC-006 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `quickbooks.void_invoice` (bounded compensation only) |
| `crank.holds.release` | Release selected retained source identities once | TRIG-005 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `decideHold` (release) |
| `crank.historical.release` | Run selected retained historical source records once | TRIG-002 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `releaseHistorical` |
| `crank.executors.start` | Start a typed isolated code or remote executor task | WORK-005 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `code` (no network, standard library only) |
| `crank.subflows.call` | Invoke an exact subflow version with linked child history | WORK-006 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `subflow` |
| `crank.custom.test` | Run an exact custom definition against its declared sandbox fixtures | CONN-011, CONN-020 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `acceptSandbox` |
| `crank.authoring.test` | Test the exact generated draft with selected bindings | AI-002 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `testAuthoring` |
| `crank.drift.test` | Run a proposed repair over retained cases and sandbox readback | AGENT-002 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `testDrift` |
| `crank.objectives.dispatch` | Execute the due pinned specialist objective | AI-003, AGENT-001 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `dispatchRecurring` (invoice check only) |
| `crank.tasks.start` | Start a typed subset of declared task steps | TEAM-002, PLATFORM-001 | standard or external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `start_task` |
| `crank.workflows.publish` | Publish an exact immutable graph and bindings | WORK-008, TEAM-004 | live (+ external) (+ access) (+ security) (+ gated) | `publish_workflow` |
| `crank.workflows.rollback` | Publish a selected earlier graph as a new version | WORK-008 | live (+ external) (+ access) (+ security) (+ gated) | `rollbackWorkflow` |
| `crank.workflows.pause` | Stop workflow intake and dispatch under its continuation semantics | EXEC-001, TEAM-004 | live (+ external) (+ access) (+ security) (+ gated) | `setWorkflowState` |
| `crank.workflows.resume` | Re-enable an existing publication without changing its graph | EXEC-001, TEAM-004 | live (+ external) (+ access) (+ security) (+ gated) | `setWorkflowState` |
| `crank.workflows.unpublish` | Retire a version and end its dispatch authority | TEAM-004 | live (+ external) (+ access) (+ security) (+ gated) | `unpublishWorkflow` |
| `crank.triggers.update` | Set schedules, polling intervals, watched fields, subscriptions or inbound alias | TRIG-001, TRIG-002, TRIG-003, TRIG-004, TRIG-006, TRIG-007, TRIG-008 | live (+ external) (+ access) (+ security) (+ gated) | `updateDraft`; `saveWatchedFields` (alias none) |
| `crank.forms.publish` | Activate an authenticated, link-only or embedded intake form | WORK-007 | live (+ external) (+ access) (+ security) (+ gated) | none |
| `crank.notices.update` | Change native and provider notice routing and escalation | EXEC-003, TEAM-005 | live (+ external) (+ access) (+ security) (+ gated) | `configureNoticeRoute` |
| `crank.sinks.update` | Configure a typed signed event or redacted log destination | OPS-001, PLATFORM-001 | live (+ external) (+ access) (+ security) (+ gated) | `configureLogSink` (logs only) |
| `crank.objectives.adopt` | Adopt explicit skill/objective versions for the next run | AI-003 | live (+ external) (+ access) (+ security) (+ gated) | `adoptRecurringTask` |
| `crank.objectives.pause` | Stop further recurring objective dispatch | AI-003 | live (+ external) (+ access) (+ security) (+ gated) | `controlRecurringTask` (pause) |
| `crank.objectives.takeover` | Record sponsor takeover of the recurring work | AI-003, AGENT-004 | live (+ external) (+ access) (+ security) (+ gated) | `controlRecurringTask` (takeover) |
| `crank.drift.deploy` | Deploy an exact tested repair and release eligible checkpoints | AGENT-002 | live (+ external) (+ access) (+ security) (+ gated) | `approveDrift` |
| `crank.runs.cancel` | Cancel future dispatch, preserving already-started effect uncertainty | EXEC-001 | standard | `cancelRun` |
| `crank.holds.discard` | Permanently discard unrecoverable held events with receipts | TRIG-005 | destructive | `decideHold` (discard) |
| `crank.connections.bind` | Bind an existing outside account and its declared scopes | CONN-002 | access · security (+ external) (+ gated) | `createConnection`; `startOauth` (provider screen separate) |
| `crank.connections.test` | Check a bound connection without disclosing credentials | CONN-002 | external (+ sensitive) (+ gated) | `testConnection` |
| `crank.connections.rotate` | Replace connection credential authority | CONN-002 | security · access | `rotateConnection` |
| `crank.connections.revoke` | Revoke connection-use authority | CONN-002 | access · security (+ live) | `revokeConnection` |
| `crank.custom.propose` | Propose typed operations and scopes from supplied API documentation | CONN-020 | standard | `propose_connector` |
| `crank.custom.install` | Store an inert immutable custom connector definition | CONN-011 | standard | `installCustom` |
| `crank.custom.activate` | Activate a sandbox-validated definition without granting new scopes | CONN-011, CONN-020 | live | `reviewCustom` |
| `crank.custom.read` | Call an exact typed read/search operation | CONN-011, WORK-011 | external (+ sensitive) (+ gated) (+ money) | `custom.request` (bounded reads/searches) |
| `crank.custom.write` | Call an exact typed mutation with native classified effect metadata | CONN-011, WORK-011 | external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `custom.request` (bounded private POST only) |
| `crank.gateways.grant` | Change version, operation and destination grants on an enrolled gateway | CONN-011 | access · security | `grantGateway` |
| `crank.gateways.revoke` | Revoke an enrolled gateway or its grant | CONN-011 | access · security (+ live) | `revokeGateway`; `revokeGatewayGrant` |
| `crank.members.invite` | Invite a staff principal into bounded native membership | TEAM-001 | access (+ external) (+ gated) | native Base people action |
| `crank.members.update` | Change roles, scopes or membership state | TEAM-001 | access | `POST /api/crank/team/:id`; native Base people action |
| `crank.workflows.transfer` | Change the accountable workflow owner | TEAM-001 | access | `POST /api/crank/team/transfer` |
| `crank.grants.issue` | Issue bounded app, agent or service authority | TEAM-002, TEAM-003 | access · security | `issueGrant`; `mintToken`; `serviceAccountApi` |
| `crank.grants.revoke` | Revoke app, agent or service authority | TEAM-002, TEAM-003 | access · security | `revokeGrant`; `revokeToken`; `serviceAccountApi` |
| `crank.clients.create` | Create bounded client bindings on this same tool registry | PLATFORM-002 | access · security | `src/crank/mcp/client-api.ts` (selected native leaves only) |
| `crank.clients.revoke` | Revoke a client binding and its secret | PLATFORM-002 | access · security | `src/crank/mcp/client-api.ts` |
| `crank.protections.update` | Change native protective/egress settings without granting self-authority | SEC-002, DATA-003 | security (+ access) (+ live) | `updateSettings`; `setDataClass` (bounded settings only) |
| `crank.keys.rotate` | Rotate a data-class encryption key | DATA-003 | security | `rotateKey` |
| `crank.retention.update` | Save retention periods against the current dry-run digest | DATA-003 | security | `setRetention` |
| `crank.legalholds.place` | Place an exact subject or workflow preservation hold | DATA-003 | security (+ sensitive) | `placeHold` |
| `crank.legalholds.release` | Release a preservation hold with attributable reason | DATA-003 | security (+ sensitive) | `legal-holds.ts` |
| `crank.backups.export` | Create a portable archive excluding installation authority | DATA-001 | security (+ sensitive) | `POST /api/crank/data/export`; archive transfers |
| `crank.erasure.run` | Erase terminal run/subject/operator/file data and retain fences | DATA-002 | destructive (+ sensitive) | `POST /api/crank/data/erase`; subject/operator erasure |
| `crank.tables.erase` | Erase a paused table record and retain operation tombstones | WORK-007, DATA-002 | destructive (+ sensitive) | `tableApi` (integer state only) |
| `crank.digests.erase` | Erase digest entries and linked operations | WORK-010, DATA-002 | destructive (+ sensitive) | `POST /api/crank/digests/:id/erase` |
| `crank.decisions.revise` | Revise only declared proposal fields and retain the old revision | TEAM-005 | standard (+ sensitive) | `reviseProposal`; `decideApproval` (native decision form) |
| `crank.decisions.record` | Record an exact relied-on sign-off or rejection with its own actor | TEAM-005 | commitment (+ sensitive) | `decideApproval` (native decision form) |
| `crank.questions.create` | Create a typed missing-fact request with native/external assignment | WORK-009, AGENT-004 | standard or external (+ sensitive) (+ gated) | `collect` (native owner answers only) |
| `crank.questions.answer` | Record an answer as the actual answering actor | WORK-009 | standard (+ sensitive) | `decideApproval` (collect fields) |
| `crank.resources.list` | Resolve live provider pickers and dependent inputs | CONN-019 | external (+ sensitive) (+ gated) (+ money) | `loadPicker`; `readPicker` (custom only) |
| `crank.resources.refresh` | Reload current provider field definitions without changing grants | CONN-019 | external (+ sensitive) (+ gated) (+ money) | `loadPicker`; `sampleAction` (expected fields only) |
| `crank.http.read` | Perform bounded GET/HEAD and declared readback with managed auth | HTTP-002 | external (+ sensitive) (+ gated) (+ money) | `http` |
| `crank.http.write` | Perform a typed mapped HTTP mutation with an exact effect descriptor | HTTP-001, HTTP-002 | external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | `http`; legacy `deliverRun` |
| `crank.files.fetch` | Fetch a bounded URL into a typed file reference | WORK-002 | external (+ sensitive) (+ gated) | `file.fetch` |
| `crank.regulated.get` | Read provider prerequisites and exact company/operation consent facts | BOUND-001 | standard | `readRegulatedOperations` |
| `crank.regulated.consent` | Record attributed agreement references and operation consent facts | BOUND-001 | access (+ commitment) (+ gated) | `consentRegulatedOperation` |
| `crank.payroll.handoff` | Transfer W-2/1099 worker data without filing or onboarding invitations | BOUND-001 | external · sensitive (+ accounts) (+ gated) | `gusto.employee_w2_handoff`; `gusto.contractor_1099_handoff` |
| `crank.payroll.pay` | Create a company-bound ACH contractor payment | BOUND-001 | external · money · sensitive (+ gated) | `gusto.contractor_payment` |
| `crank.payroll.read` | Read worker forms or a payment receipt | BOUND-001 | external (+ sensitive) (+ gated) | `gusto.contractor_forms`; `gusto.employee_forms`; `gusto.payment_readback` |
| `crank.mail.search` | Find threads, messages, labels and attachments without sending | CONN-003 | external (+ sensitive) (+ gated) | none |
| `crank.mail.draft` | Save an unsent provider message or reply | CONN-003 | external (+ sensitive) (+ gated) | none |
| `crank.mail.send` | Send a message or reply with actual To/CC/BCC and files | CONN-003, EXEC-007 | external (+ sensitive) (+ money) (+ gated) | none |
| `crank.mail.label` | Apply a provider label or folder move | CONN-003 | external (+ sensitive) (+ gated) | none |
| `crank.chat.find` | Find channels, users and messages | CONN-004, WORK-011 | external (+ sensitive) (+ gated) | native `slack.find_*` |
| `crank.chat.send` | Send a channel/direct message or thread reply | CONN-004 | external (+ sensitive) (+ money) (+ gated) | native Slack send/reply; `nook.send_message` |
| `crank.chat.update` | Update a previously posted message | CONN-004 | external (+ sensitive) (+ gated) | `slack.update_message` |
| `crank.chat.delete` | Permanently remove a provider message | CONN-004 | external · destructive (+ gated) | `slack.delete_message` |
| `crank.chat.react` | Add a reaction to a provider message | CONN-004 | external (+ gated) | `slack.add_reaction` |
| `crank.sheets.find` | Find rows or list items under named provider fields | CONN-005, WORK-011 | external (+ sensitive) (+ gated) | none |
| `crank.sheets.append` | Append one or many ordered rows with readback | CONN-005 | external (+ sensitive) (+ gated) | none |
| `crank.sheets.upsert` | Upsert a row/list item by business key | CONN-005 | external (+ sensitive) (+ gated) | none |
| `crank.storage.find` | Find or read files and folders | CONN-005, CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.storage.upload` | Upload original bytes or a generated file | CONN-005, CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.storage.move` | Move a file into a resolved destination | CONN-005, CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.storage.copy` | Copy a file into a resolved destination | CONN-005, CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.storage.share` | Change a file link or item sharing audience | CONN-005, CONN-016 | external · access (+ sensitive) (+ gated) | none |
| `crank.crm.find` | Search contacts, companies, deals, associations and custom fields | CONN-006, CONN-015, WORK-011 | external (+ sensitive) (+ gated) | `orbit.find_deal`; `orbit.read_deal` (bounded sibling only) |
| `crank.crm.create` | Create a contact/company/deal/task without provisioning a login | CONN-006, CONN-015 | external (+ sensitive) (+ gated) | none |
| `crank.crm.update` | Update a deal, contact, company, stage or task with current revision | CONN-006, CONN-015 | external (+ sensitive) (+ gated) | `orbit.update_deal` (bounded sibling only) |
| `crank.invoices.find` | Read invoices, customers, products, vendors and payment references | CONN-007, WORK-011 | external (+ sensitive) (+ gated) | `quickbooks.followup_invoice`; QuickBooks readback (bounded sandbox only) |
| `crank.invoices.create` | Create draft/final invoice lines and amounts in the provider books | CONN-007, CONN-018 | external · money (+ commitment) (+ sensitive) (+ gated) | `quickbooks.create_invoice` (sandbox only) |
| `crank.invoices.update` | Change invoice amounts, tax, terms or status at current revision | CONN-007 | external · money (+ commitment) (+ sensitive) (+ gated) | invoice-outcome repair (bounded QuickBooks only) |
| `crank.invoices.send` | Send an invoice or estimate through its provider | CONN-007 | external (+ commitment) (+ sensitive) (+ gated) | none |
| `crank.invoices.void` | Void one invoice as a distinct operation | CONN-007 | external · money · destructive (+ gated) | `quickbooks.void_invoice` (sandbox only) |
| `crank.quotes.create` | Create an unsent accounting estimate/quote | CONN-007 | external (+ sensitive) (+ gated) | none |
| `crank.payments.record` | Record a payment/receipt/credit allocation in the provider books | CONN-007 | external · money (+ sensitive) (+ gated) | `quickbooks.create_refund_receipt` (bounded sandbox only) |
| `crank.accounting.upsert` | Upsert a customer/vendor/item/bill with typed accounting fields | CONN-007 | external (+ money) (+ sensitive) (+ gated) | none |
| `crank.accounting.attach` | Attach a bounded file reference to a provider transaction | CONN-007 | external (+ sensitive) (+ gated) | none |
| `crank.commerce.find` | Find orders, customers, products, variants, prices and subscriptions | CONN-008, CONN-018, WORK-011 | external (+ sensitive) (+ gated) | none |
| `crank.commerce.create` | Create a typed customer, product, variant or draft order | CONN-008, CONN-018 | external (+ money) (+ commitment) (+ sensitive) (+ gated) | none |
| `crank.commerce.update` | Update catalog price, tags, stock, order fields or paid status | CONN-008, CONN-018 | external (+ money) (+ commitment) (+ sensitive) (+ gated) | none |
| `crank.orders.complete` | Finalize a draft order into a committed order | CONN-008 | external · money · commitment (+ sensitive) (+ gated) | none |
| `crank.orders.fulfill` | Record fulfillment with tracking and optional customer notice | CONN-008 | external · commitment (+ sensitive) (+ gated) | none |
| `crank.orders.cancel` | Cancel an order and retain its financial outcome | CONN-008, CONN-018 | external · money · destructive (+ sensitive) (+ gated) | none |
| `crank.payments.capture` | Capture an authorized payment intent | CONN-008 | external · money (+ sensitive) (+ gated) | none |
| `crank.payments.refund` | Refund selected lines or an exact amount | CONN-008, CONN-018 | external · money (+ sensitive) (+ gated) | none |
| `crank.giftcards.create` | Issue a gift card with initial value and expiry | CONN-008 | external · money (+ sensitive) (+ gated) | none |
| `crank.subscriptions.create` | Create an outside paid subscription resource | CONN-008 | external · accounts · money · commitment (+ gated) | none |
| `crank.subscriptions.update` | Change a subscription price or quantity | CONN-008 | external · money · commitment (+ gated) | none |
| `crank.subscriptions.cancel` | Cancel an outside subscription and retain the provider receipt | CONN-008 | external · money · destructive (+ gated) | none |
| `crank.paymentlinks.create` | Create a provider-hosted payment link for an exact offer | CONN-008 | external · money · commitment (+ gated) | none |
| `crank.tickets.find` | Search tickets, issues, agents, users, organizations or projects | CONN-009, WORK-011 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.create` | Create an issue or support ticket | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.update` | Update typed ticket/issue fields | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.transition` | Transition an issue at its current state | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.solve` | Solve a support ticket | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.link` | Link two issues | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.watch` | Add a watcher to an issue | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.log_work` | Record work against an issue | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.tickets.comment` | Add a public or internal comment/attachment | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.support.upsert` | Upsert a requester/user or organization without login provisioning | CONN-009 | external (+ sensitive) (+ gated) | none |
| `crank.leads.read` | Read form definitions and lead/submission records with files | CONN-012 | external (+ sensitive) (+ gated) | app-poll projections only; submission job none |
| `crank.calendar.find` | Read calendars, free/busy, events, invitees or meetings | CONN-013 | external (+ sensitive) (+ gated) | none |
| `crank.calendar.create` | Create a calendar event, meeting or registrant | CONN-013 | external (+ commitment) (+ money) (+ sensitive) (+ gated) | `google_calendar.create_event` (bounded Calendar only) |
| `crank.calendar.update` | Reschedule an event or meeting and its attendee information | CONN-013 | external (+ commitment) (+ money) (+ sensitive) (+ gated) | none |
| `crank.calendar.cancel` | Cancel an event or meeting at the provider | CONN-013 | external · destructive (+ commitment) (+ money) (+ gated) | none |
| `crank.workitems.find` | Find scoped work items, documents and custom fields | CONN-014 | external (+ sensitive) (+ gated) | none |
| `crank.workitems.create` | Create a task, page, card, project item or template document | CONN-014 | external (+ sensitive) (+ gated) | none |
| `crank.workitems.update` | Change work fields, assignment, position or completion | CONN-014 | external (+ sensitive) (+ gated) | none |
| `crank.workitems.comment` | Append a work comment or document text | CONN-014 | external (+ sensitive) (+ gated) | none |
| `crank.marketing.subscribe` | Set a subscriber/tag without reversing an opt-out | CONN-015 | external (+ sensitive) (+ gated) | none |
| `crank.social.publish` | Post text, links and images to a chosen social account | CONN-015 | external (+ sensitive) (+ money) (+ gated) | none |
| `crank.envelopes.create` | Prepare an unsent typed document/envelope | CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.envelopes.send` | Send an exact envelope/offer for signature | CONN-016 | external · commitment (+ sensitive) (+ gated) | none |
| `crank.envelopes.read` | Read status or download the completed certificate and document | CONN-016 | external (+ sensitive) (+ gated) | none |
| `crank.sms.send` | Send SMS/MMS under provider opt-out and registration state | CONN-017, EXEC-007 | external · money (+ sensitive) (+ gated) | none |
| `crank.sms.read` | Read inbound messages and delivery status | CONN-017 | external (+ sensitive) (+ gated) | none |
| `crank.outcomes.check` | Independently read back business success criteria and retained evidence | AGENT-001 | external (+ sensitive) (+ gated) | `quickbooks.invoice_outcome` (bounded invoice only) |
| `crank.outcomes.repair` | Repair a missing/wrong business record at its observed revision | AGENT-001 | external (+ money) (+ commitment) (+ accounts) (+ gated) (+ access) (+ security) (+ destructive) (+ sensitive) (+ live) | invoice-outcome repair (bounded QuickBooks only) |
| `crank.followups.send` | Send the next due contact using current invoice state and billing contact | AI-003, AGENT-004 | standard or external (+ money) (+ sensitive) (+ gated) | native inbox scheduler only; customer transport none |
| `crank.models.classify` | Classify text or supported files into typed categories | AI-001 | external · money (+ sensitive) (+ gated) | `ai.classify` (text only) |
| `crank.models.generate` | Generate text or conversation turns with declared files | AI-001 | external · money (+ sensitive) (+ gated) | none |
| `crank.models.extract` | Extract typed fields/line items with page provenance | AI-001 | external · money (+ sensitive) (+ gated) | none |
| `crank.models.transcribe` | Transcribe bounded audio/video with continuous timestamps | AI-001 | external · money (+ sensitive) (+ gated) | none |
| `crank.models.translate` | Translate text or audio into a chosen language | AI-001 | external · money (+ sensitive) (+ gated) | none |
| `crank.models.fetch` | Extract literal content from an egress-checked URL | AI-001 | external (+ money) (+ sensitive) (+ gated) | none |
| `crank.models.search` | Answer from bounded URLs with per-statement provenance | AI-001 | external (+ money) (+ sensitive) (+ gated) | none |
| `crank.models.image` | Generate an image as a typed file reference | AI-001 | external · money (+ sensitive) (+ gated) | none |
| `crank.modelfiles.find` | Find a provider-stored model file | AI-001, WORK-011 | external (+ sensitive) (+ gated) | none |
| `crank.modelfiles.upload` | Upload a model file using provider idempotency/readback | AI-001 | external (+ money) (+ sensitive) (+ gated) | none |
| `crank.authoring.generate` | Generate an inert workflow proposal from selected schemas and samples | AI-002 | external · money (+ sensitive) (+ gated) | `generateAuthoring` |

**Resources.** `crank://workspace/{id}`, `crank://member/{id}`, `crank://connection/{id}`, `crank://grant/{id}`, `crank://workflow/{id}`, `crank://version/{id}`, `crank://subflow/{id}`, `crank://recipe/{id}`, `crank://sample/{id}`, `crank://table/{id}`, `crank://record/{id}`, `crank://form/{id}`, `crank://trigger/{id}`, `crank://queue/{id}`, `crank://run/{id}`, `crank://attempt/{id}`, `crank://effect/{id}`, `crank://decision/{id}`, `crank://question/{id}`, `crank://hold/{id}`, `crank://historical/{id}`, `crank://digest/{id}`, `crank://obligation/{id}`, `crank://skill/{id}`, `crank://objective/{id}`, `crank://repair/{id}`, `crank://usage/{id}`, `crank://import/{id}`, `crank://audit/{id}`, `crank://erasure/{id}`, `crank://transfer/{id}`, `crank://gateway/{id}`, `crank://client/{id}`, `crank://file/{id}`. Native visibility and field projections apply to each primary record; external, customer, import, log, prompt and provider text is untrusted. Cross-provider records retain their provider/account/object references instead of becoming a second CRM, ledger or file system.

**Events.** `workflow.drafted`, `workflow.published`, `workflow.paused`, `trigger.received`, `trigger.changed`, `run.queued`, `run.waiting`, `run.failed`, `run.completed`, `effect.uncertain`, `effect.reconciled`, `hold.created`, `hold.released`, `decision.recorded`, `question.answered`, `digest.released`, `obligation.due`, `obligation.satisfied`, `repair.proposed`, `repair.deployed`, `connection.revoked`, `authority.changed`, `usage.recorded`, `import.progress`, `erasure.completed`. The feed and outgoing signed deliveries use the same event identities; `import.progress` observes the import door.

**Prompts.** The automation operations lead offers lead-to-invoice construction (WORK-001, WORK-002, CONN-006, CONN-007, AI-002), daily exception triage (EXEC-003, EXEC-004, EXEC-006), paid-order reconciliation (CONN-008, CONN-007, AGENT-001), mapping-drift repair (AGENT-002, CONN-020), weekly normalization improvements (AGENT-003) and overdue-invoice follow-up (AI-003, AGENT-004). Each prompt names its clauses and consumes this registry.

**Not tools, and why.** Each id below occurs in this list once and in no tool row.

- *The import door:* MIG-001, MIG-002, MIG-003, MIG-004, MIG-005, MIG-006. Complete restore, source move-in, captured inventories, parity/shadow comparison, cutover and undo stay Base import tasks, including agent-assisted reconstruction. `crank.backups.export` produces their input; `crank://import/{id}` and `import.progress` expose progress. Creating an inert native recipe from this registry does not replace the import door.
- *A connector:* CONN-010. Each sibling owns its domain surface and provider events; Crank binds that connector to the sibling rather than inventing a parallel domain API. Workflow/run automation itself uses the registry above.
- *A person's interactive screen:* UX-001. Native sign-in, personal password/2FA and interactive accessibility/mobile behavior belong to that person's browser/device; the business operations those screens expose are tools above. Provider-hosted consent, card entry and verification screens are likewise not tools; connection/regulated continuations still declare gated when the provider returns that step.
- *An operation or installation fact:* BASE-002, BASE-004, BASE-005. The runnable site/Lobby, MIT/no-tier distribution and computer/server/Cloudflare installation paths describe delivery and hosting facts, not business actions.

**Limits.** Capacity follows native declared schemas: pages at most 100 records; graphs at most 10,000 expanded paths per run; historical source capture at most 1,000 records/50 pages/4 MiB retained payload; the bounded native subflow slice at most 20 declared steps, four nesting levels, 50 loop items and 2,000 expanded invocations. Provider/file/model bounds are returned with the operation's supported types and actual limit; a smaller shipped slice is disclosed, never represented as full target coverage. Business limits and spend caps are the company's policy; this surface promises no spend-cap enforcement by Base's door.

**Handoffs.** Listen for verified provider payment/order, invoice-status, deal-stage, inbound-message and watched-field changes through the named connectors; sibling event names remain provider-owned until that sibling defines them. An Orbit deal transition feeds invoice construction; a Stripe/Shopify payment feeds provider-book reconciliation; a paid/closed/void invoice ends its recurring contact obligation; native identity deactivation ends authority. Emit typed progress, uncertainty, business-evidence and repair events to the requesting specialist and the company's overview. Duplicate provider events retain the same operation identity; a handoff never equates a provider acknowledgement with independent business readback.

#### SURFACE-001 — The registry equals Crank's Agent surface

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-013

**Requirement.** Crank's registry describes exactly this table, its resource templates, events, prompts and non-tool reasons. Workflow nodes, native actions, direct HTTP, client bindings and Crank's own specialist use the same typed jobs; the existing `/api/crank/v1/mcp` is an alias of the inherited door, not a second authority scheme.

**Acceptance.**
1. Discovery lists exactly the table's tool names, clauses and possible classes, plus exactly the resource templates, event types and prompts above.
2. Core ids in tool metadata and discoverable non-tool reasons cover the cloned contract exactly, without overlapping categories or invented ids.
3. Every row's fixed class or fixed class combination is declared on a fixture call; no wrapper omits a class its dispatched leaf carries.
4. Native and MCP draft creation, publication, table increment, invoice creation and replay produce identical domain state and action types on equivalent fixtures.
5. The Base harness passes on Crank's fixtures under the named All-autonomous company policy and Held company policy defined in SURFACE-013, including every computed-class pair below.

#### SURFACE-002 — Read the right workflow and provider evidence

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-010

**Requirement.** Read tools project the sponsor's native workflow, connection, run and provider visibility, retaining source identity and distinguishing masked fields, expired payloads, uncertain effects and independently checked outcomes. Crank's data-class label is a custody fact, not proof that the returned content carries sensitive.

**Acceptance.**
1. On one retained payroll-run fixture, reading masked bank/ID fields declares standard only; returning its full bank/ID numbers declares standard and sensitive with record count and kind. The corresponding provider read declares external in both cases and adds sensitive only for the full values.
2. A viewer's run result contains status/timing without the builder's restricted payload; missing and inaccessible resource ids have indistinguishable missing results.
3. Paginated workflow and run searches preserve native ordering, filters and retained-source provenance beyond the first page.
4. Provider ids and source records remain links to their systems of record; provider acknowledgement, owner attestation and independent readback remain distinguishable.
5. The same private ordinary customer-name record carries no sensitive class until protected content is actually returned or sent; untrusted text cannot change that result.
6. Credential-free connection, audit, health and usage results expose no bearer value or inferred provider charge.

#### SURFACE-003 — Versioned graphs change a named running service

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-012

**Requirement.** The specialist authors typed graphs, mappings, paths, loops and waits as inert drafts, then changes an exact published service through distinct publication/control jobs. Immutable version and account bindings remain inspectable through tests, rollback and in-flight continuation.

**Acceptance.**
1. A draft change returns standard; publishing it declares live with workflow and version, and leaves already-admitted work pinned to its prior version.
2. On the same configuration fixture, saving an inactive notice/trigger definition through its typed wrapper carries no live class; applying it to an active service adds live. The live control tools always declare live, including pause, resume, unpublish and rollback.
3. On one active-notice fixture, keeping a native destination adds no external, access or security; changing it to a provider destination adds external, assigning connection-use authority adds access with direction, and rotating its signing secret adds security.
4. Graph validation names missing mappings, retyped fields, unequal line arrays and conflicting shared-delay spacing before an effect.
5. Concurrent keyed publication/rollback returns one immutable version and change record; a stale expected revision changes nothing.
6. Canceling future dispatch preserves completed checkpoints and marks an already-started unresolved write uncertain, without claiming the remote effect was undone.

#### SURFACE-004 — Dispatch and recovery preserve each leaf's classes

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** Run, task, hold-release, historical-release, test, subflow, executor, repair and HTTP/custom wrappers classify the actual typed leaf and current records. Selecting another wrapper, a test binding or a replay does not turn an external or irreversible operation into standard. Unknown effects stay unclassified without dispatch.

**Acceptance.**
1. The same native-only reversible mapping fixture declares standard through each applicable wrapper; replacing its leaf with a provider call declares external with the resolved provider/counterparty, without standard masking it.
2. Each computed-class fixture in SURFACE-002, SURFACE-003, SURFACE-005, SURFACE-006, SURFACE-007 and SURFACE-010 produces the same class/facts through direct HTTP/custom calls, a nested subflow and a selected client tool as through its native action.
3. A provider write with no trusted effect descriptor returns `unclassified_operation`; method names, imported text and `confirmed: true` cannot make a descriptor or reduce a class.
4. Lost invoice acknowledgement followed by restart retains the original operation key; readback closes one exact match without another create, while zero/multiple matches remain unresolved evidence.
5. Selected failed-item replay retains successful checkpoints and original versus corrected inputs; concurrent selection claims a path once, including after repair-history erasure.
6. A delayed retry rechecks current account, version and authority before each physical request, retains Retry-After and never resumes a completed write blindly.

#### SURFACE-005 — Authority and secrets have explicit native targets

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-004, BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-008

**Requirement.** Authority and protection jobs name native targets and compute direction from current scopes; provider continuations remain separate from personal screens.

**Acceptance.**
1. Member, transfer, credential, client and gateway jobs declare access with principals/direction; credential handling also declares security with a value-free setting.
2. On one connection fixture, metadata reads have neither access nor security; scope binding adds access and credential handling adds security, identically through wrappers.
3. On the same protection fixture, changing an ordinary reversible display preference adds no security; changing encryption/egress protection adds security, and changing who can administer it adds access.
4. Every access/security family, including connection/regulated consent, grants, members, sessions, transfers, clients, gateways, protections, keys, retention, legal holds, backups and credential-bearing wrappers, refuses a call widening the sponsor's or agent's own authority under every company policy, including All-autonomous.
5. Revoking an unrelated client's grant declares narrowing access and security; its next call loses authority without exposing its secret in history or archives.
6. With the same provider connection continuation, an ordinary API response adds no gated; a returned hosted consent requirement adds gated with provider and step, and supplies a resource link to the provider's personal screen.
7. A person-recorded consent or confirmation retains that actual person; an agent-prepared proposal cannot fabricate their act or submit their password, CAPTCHA or personal 2FA code.

#### SURFACE-006 — Contact is classified from the resolved audience

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-010

**Requirement.** Contact/exposure tools resolve audience and protected content before dispatch. Delivery, acknowledgement and a person's answer remain separate; recurring contact uses the live invoice's billing contact.

**Acceptance.**
1. On one question fixture, native colleague-inbox contact declares standard; vendor contact declares external, known, one recipient; unrelated outsiders are new and open links public. Provider transport remains external for colleague recipients.
2. The same reminder with a masked bank number has no sensitive addition; including its full bank number adds sensitive with kind and record count. Expanded To/CC/BCC duplicates remain in recipient counts.
3. The same message through an unbilled native inbox has no money class; its billed SMS/provider dispatch adds money with actual amount or explicit unknown, provider and counterparty.
4. Existing provider opt-outs and invalid sender registration yield their native errors; retries retain one contact operation identity and never claim delivery from an acknowledgement alone.
5. Updating an invoice to paid/closed/void immediately before a due contact suppresses the send; an open invoice uses its current billing contact and configured cadence, with one active recurring run.
6. After the test person has recorded a decision, history identifies that person as decider and the agent as preparer; a provider callback is never presented as that person's answer.

#### SURFACE-007 — Money, commitments and outside resources remain distinct

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-008, BASE-AGENT-012

**Requirement.** Financial/provider jobs preserve exact cents, line items, company, accounting periods and prerequisites; money, identity, commitment and provider-gate facts remain distinct.

**Acceptance.**
1. On one commerce fixture, a forecast adds no money; a charge/refund/invoice-price change adds money with amount/counterparty. Fixed money tools declare money, including accepted zero-value operations; unknown costs stay unknown.
2. On one quote fixture, a reversible draft adds no commitment; finalization adds commitment with version/value/counterparty. Order completion, envelope sending and relied-on decisions declare fixed commitment.
3. On one customer fixture, a non-login contact adds no accounts; outside identity/paid-resource provisioning adds accounts with provider/target. Subscription creation declares accounts, money and commitment.
4. On one payment fixture, ordinary continuation adds no gated; hosted card entry, personal terms or bank/business verification adds gated with provider/step. Missing prerequisites retain unfinished obligations.
5. Worker handoff declares external/sensitive with payroll/ID facts, adding accounts for outside identity creation. Receipt reading moves no money; ACH dispatch declares money.
6. Line items, tax and discount reconcile exactly; lost refund responses retain the original idempotency/readback identity.
7. Under the named Held company policy, money waits for approval, changes nothing before the test person's decision and runs once afterward with separate preparer/decider attribution.

#### SURFACE-008 — Custom definitions and provider schemas retain their boundaries

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-005, BASE-AGENT-006, BASE-AGENT-012

**Requirement.** Connector-building, resource selection and executor jobs use versioned typed operations and native bounds rather than a catch-all instruction interpreter. Provider data informs mappings without supplying authority, destination trust or a person's interactive identity.

**Acceptance.**
1. Proposing and storing an inert connector declares standard, activates no scope and sends no credential; activation declares live, while separate gateway/version/operation grant changes declare access and security.
2. An executor job confined to reversible native computation has standard; the same typed task with provider egress adds external and, when billed, money. Credential handling, irreversible effects and active-service changes retain their additional classes through the wrapper.
3. On one picker fixture, schema-only metadata declares external; full protected fields add sensitive. The same query on an unmetered endpoint adds no money, while its metered provider endpoint adds money with a source-labelled charge. Parent changes invalidate dependent selections and revoked provider fields cannot authorize a write.
4. A gateway call cannot cross its installation/environment, named destination or exact definition version; a new version alone gains no grant and repeated job receipts retain one effect.
5. Oversized files, unsupported model input and executor output-schema mismatches return named native failures before downstream writes, preserving source and task identity.
6. A custom proposal, hostile changelog or tool result asking to widen the sponsor's/agent's authority fails through every wrapper under both named company policies.

#### SURFACE-009 — Native state and model work keep honest provenance

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** Tables, forms, digest entries, collected facts, sample tests and model results retain typed source records and the same data custody as their owning runs. A model response or manual sample is never relabelled as provider evidence.

**Acceptance.**
1. Ten concurrent counter changes and three list pops retain one receipt per operation and the expected final values; replaying a key returns the prior receipt rather than another mutation.
2. A digest append racing a release appears in exactly one release, and an America/Chicago DST change produces one occurrence with retained source links.
3. A captured, historical, provider and manual sample each retains its source label; loading one changes no production deduplication cursor or trigger state.
4. A native reversible table value without protected content declares standard; the same record containing an ID/bank/health value adds sensitive. External form assignment or provider model disclosure adds external without lowering sensitive.
5. Each billed model operation declares money and external; actual protected input/output also adds sensitive. A local content-only transform has no money class, and estimated costs stay estimates.
6. Model/file transcription and extraction retain model/version, source pages or timestamps, exact line totals and measured/reported/unknown usage, without inventing a provider charge.
7. A collected answer resolves the exact retained question once, identifies its actual answering actor and preserves the native timeout/duplicate outcomes.

#### SURFACE-010 — Erasure and backup facts remain visible

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** Erasure tools retain value-free fences and distinguish product deletion from provider/offline copies. Backup generation exports data without receiving authority; restore and source migration remain import tasks. Custody changes never claim that an external effect has been undone.

**Acceptance.**
1. On the same file fixture through a typed HTTP/custom wrapper, reversible internal trash declares standard (provider trash declares external); permanent purge adds destructive with item count. Erasure, table/digest erasure, provider message deletion, invoice void and unrecoverable hold discard declare their fixed destructive class.
2. The same backup with ordinary metadata declares security only; including protected health/ID/bank/payroll values adds sensitive with kinds/counts, without exporting credential authority.
3. A legal-hold change declares security; a value-free workflow identifier adds no sensitive, while an actual protected subject identifier adds sensitive. An unfinished or legally held record retains its native erasure refusal under every policy.
4. An erasure's completed receipt removes linked run inputs, samples, files and agent-memory references and fences old-archive replay without presenting the retained audit as payload data.
5. A backup transfer resumes with the same parts after interruption and reports generation separately from off-installation receipt; an import resource reports inactive restored work without becoming a restore tool.
6. Retention/key/protection calls cannot widen the sponsor's or agent's own data access even under All-autonomous; restricted values remain absent from reads after custody changes.

#### SURFACE-011 — Reconciliation and repair serve business outcomes

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-002, BASE-AGENT-006, BASE-AGENT-009, BASE-AGENT-012

**Requirement.** The specialist closes obligations from independent provider records, retains repair diffs and evaluates failures/counterexamples. Recurring work pins skill/objective versions; adoption changes subsequent runs only.

**Acceptance.**
1. A successful invoice request with missing/wrong-customer readback leaves an open obligation; correct independent readback closes it, separately from owner-attested operational completion.
2. A read-only outcome check declares external, adding sensitive only for actual protected content; the same fixture's invoice-price repair adds money, a provider identity repair adds accounts, and active mapping deployment adds live.
3. A drift proposal is standard and preserves original business meaning; testing carries the actual dispatched leaf's classes, and deployment declares live for the exact tested mapping.
4. Twenty retained authorized cases and a passing counterexample expose changed outputs before a normalization proposal can replace its draft; original failure history and post-change measurements remain inspectable after rollback.
5. A recurring open run retains its old skill/objective pins; an adopted update changes only the next run, and current paid/closed/void, takeover, cancellation and authority loss stop further contact.
6. A repair, task adoption or outcome action that would widen the sponsor's or agent's own tools, fields, recipients or connection authority is refused under every policy, including All-autonomous.
7. Renamed fields, provider text and a claimed confirmation never substitute for current schema, classification, readback or truthful attribution.

#### SURFACE-012 — Events and specialist handoffs carry native evidence

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-003, BASE-AGENT-010, BASE-AGENT-013

**Requirement.** The automation operations lead follows native and provider changes through record resources, the typed event feed and the prompts above. Handoffs carry the originating provider/event/run identities and explicit uncertainty rather than interpreting narrative text as business completion.

**Acceptance.**
1. `crank.events.list` returns standard, value-free event envelopes with stable replay cursors and the same ids as signed outgoing deliveries; referenced protected content is fetched separately under its own class.
2. Losing access removes the record, its event and its resource fields from subsequent reads; a provider or log message remains visibly untrusted.
3. Each primary record template resolves to the same visible fields as its native read, including version, decision, obligation, erasure and import progress.
4. An Orbit transition, duplicated Stripe payment and changed invoice-status fixture each produce one originating event identity and an attributable linked workflow outcome.
5. A sibling handoff emits no claim that Crank owns the sibling's ledger, payroll, documents or identity service, and signed sink delivery reports uncertainty/retry independently from the business result.
6. Discovery and `/docs/agents` expose the specialist prompts and every computed-class example from this area from the same registry.

#### SURFACE-013 — The automation operations lead completes a seeded week

*Tier:* Agent surface · *From:* new · *Cites:* BASE-AGENT-007, BASE-AGENT-009, BASE-AGENT-013

**Requirement.** A stranger agent runs a seeded business week through MCP. People configure named company test policies: All-autonomous assigns autonomous to every class; Held assigns standard review and every other class approval. Sandbox providers start connected with personal onboarding complete; separate fixtures cover provider gates.

**Acceptance.**
1. Given only the URL and named sponsor, discovery supplies the week's jobs, schemas, records and prompt clauses.
2. Under All-autonomous it builds/tests/publishes lead-to-invoice, processes leads/a paid order, posts a digest, reconciles a lost invoice response and repairs field drift; the week completes with no person.
3. Under All-autonomous overdue-invoice work pins versions, observes cadence, rereads billing contact and stops when paid, without duplicate effects.
4. Under Held standard work enters review; every other class used by the week waits for the test person's approval and runs once afterward.
5. Under Held one rejected refund sends nothing; another revised proposal invalidates its old approval and binds the test person's new decision.
6. Computed-class pairs run under both policies; gated continuations name the provider's personal screen without fabricating completion.
7. Both runs distinguish workflow success, uncertainty, readback and business completion, with zero decisions inconsistent with the policy revision.
8. Forged personal decisions and self-widening fail in both runs; a person's Pause stops dispatch and preserves readable progress.

## Status rows

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `SURFACE-001` | The registry equals Crank's Agent surface | target | missing | | The exact Crank registry and inherited door conformance are not implemented. |
| `SURFACE-002` | Read the right workflow and provider evidence | target | missing | | Role-exact resource reads and protected-content classification are not exposed through this surface. |
| `SURFACE-003` | Versioned graphs change a named running service | target | missing | | Version/control tools do not yet compute the declared service and conditional classes. |
| `SURFACE-004` | Dispatch and recovery preserve each leaf's classes | target | missing | | Wrapper and leaf classification parity with conflict-safe dispatch is not implemented. |
| `SURFACE-005` | Authority and secrets have explicit native targets | target | missing | | Authority and secret tools lack this surface's class facts and universal self-widening fences. |
| `SURFACE-006` | Contact is classified from the resolved audience | target | missing | | The audience-classified contact surface and complete provider journeys are not implemented. |
| `SURFACE-007` | Money, commitments and outside resources remain distinct | target | missing | | The financial/commitment/resource classifier and its paired provider fixtures are not implemented. |
| `SURFACE-008` | Custom definitions and provider schemas retain their boundaries | target | missing | | Typed connector and executor jobs are not registered with this surface's complete effect metadata. |
| `SURFACE-009` | Native state and model work keep honest provenance | target | missing | | State/sample/model tools do not yet implement the complete provenance and class delta. |
| `SURFACE-010` | Erasure and backup facts remain visible | target | missing | | Erasure/backup tools lack the declared class facts and surface custody conformance. |
| `SURFACE-011` | Reconciliation and repair serve business outcomes | target | missing | | Outcome/repair/recurring tools do not yet satisfy this surface's policy-neutral delta. |
| `SURFACE-012` | Events and specialist handoffs carry native evidence | target | missing | | The complete resource/event/prompt registry and replayable handoffs are not implemented. |
| `SURFACE-013` | The automation operations lead completes a seeded week | target | missing | | The stranger-agent seeded week has not passed through this surface under both company policies. |
