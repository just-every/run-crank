# Crank target contract

Target approved scope: **16 October 2026**. Category: **workflow automation (iPaaS)**. Crank is an owned Zapier/Make/Workato replacement: a connector library with managed OAuth credentials, webhooks/app events/polling/schedules, visual multi-step branching workflows with durable execution, AI agent steps and optional human approval where the action warrants it. It also targets the control and agent capabilities buyers seek in n8n, Gumloop and Pipedream.

The buyer connects the business’s applications so recurring work completes without copying data or supervising every step. Approval and idempotent HTTP delivery are one useful part of this whole job. This target replaces the old first-release exclusions of connectors, credential custody, schedules and live SaaS calls; it does not claim they already exist. No homepage, UI, manifest, code, test or workflow changes are authorized by this document.

Core records are workspaces, members/roles, connections and grants, workflows and immutable versions, steps/subflows/templates, trigger subscriptions/cursors, queues/runs/attempts, mapped inputs/outputs, remote effects, approvals, obligations, usage, import provenance, audit and erasure journals. All future capabilities below remain in scope even when marked missing. Each sibling remains its own product; Crank owns cross-app orchestration and integrates neighboring systems.

Acceptance journeys are repeated in [ACCEPTANCE.md](ACCEPTANCE.md). They run through UI, HTTP/CLI/SDK/MCP or provider doors, using fakes only at the network/paid edge in automated tests. A local edge test does not establish real provider consent, hosted operation, migration compatibility or customer acceptance. Live sandbox/provider journeys are required before a connector or migration can be called complete.

Status starts from the category code audit at `11db081906aa18bfb1c89e261d910196cffd3660`, also current main when this target was authored. No product source changed between the audit and this base. **done** means the entire stated bounded clause is implemented with cited code/test evidence; **partial** identifies the implemented subset and what is absent; **missing** has no product implementation. Vendored generic modules alone do not prove product adoption. The table at the end is a gap map, not a release certification.

## Build the automation

### WORK-001 — Visual multi-step workspace.

An operations lead creates, names, folders, searches, duplicates and connects workflows in a visual node-and-edge editor without code. Each workflow has an owner, description, trigger, typed steps and enabled state; its graph shows branches, data lineage and validation errors. Draft edits and sample tests cannot send production actions unless explicitly authorized.

**Acceptance evidence:** From the builder, connect a new lead trigger to a filter, CRM lookup, invoice draft and notification; inspect sample data at every edge, correct a missing required field, save and reopen the same graph, then publish it deliberately.

### WORK-002 — Mapping, formatting and conditional routes.

Builders map nested fields and files between steps, validate against connector schemas, format US dates, timezones, USD amounts and decimals, transform text/JSON, and choose filters and exclusive or parallel branches. Missing, null and empty values stay distinct; invalid mappings name the field and prevent an unintended write.

**Acceptance evidence:** Use the builder with a US lead containing nested addresses, a missing optional field and a USD amount; test both qualifying and filtered branches, a null value and invalid currency input, then inspect the exact mapped destination payload.

### WORK-003 — Loops, joins and batch processing.

Workflows paginate source datasets, iterate records with bounded concurrency, aggregate results and merge streams by explicit keys and join policy. Per-item success and failure remain inspectable; resumption preserves completed items and does not repeat their effects. Ordering and empty-input behavior are declared.

**Acceptance evidence:** Run a paginated order batch through a loop and two branches, join by order ID, interrupt after some invoices are created and resume; inspect unmatched records and confirm each completed order retains one invoice.

### WORK-004 — Durable delay and event waits.

Delay-until, interval waits and callback/event waits persist across restarts and deployments without holding a browser open. The owner sets timezone, expiry, business calendar and cancellation policy; late or duplicate callbacks do not resume a step twice.

**Acceptance evidence:** Publish a two-business-day follow-up, stop the executor while waiting, resume after a timezone/DST boundary and deliver the same callback twice; observe one continuation, or the configured timeout branch if the deadline passes.

### WORK-005 — Isolated code steps and external executors.

Technical builders run JavaScript/TypeScript and Python transformations with declared inputs, outputs, dependency versions, time/memory limits and allowed egress. Heavy ETL, browser and long-lived jobs use authenticated owner-deployed executors with durable task identity, cancellation and results. Code cannot read unrelated connections, host secrets or another run.

**Acceptance evidence:** From a published workflow run a code transformation and a remote Python job; exceed a limit, attempt unauthorized egress and cancel a long job; inspect explicit failures and verify a restart reconciles the remote task without launching a duplicate.

### WORK-006 — Reusable subflows and recipes.

Teams create versioned subflows with typed inputs/outputs and reusable API/data-pipeline recipes, install reviewed community templates, and choose explicit update versions. Templates include connector requirements and sample tests but no credentials or production authority. Parent runs link to child histories and cancellation.

**Acceptance evidence:** Install a lead-to-invoice recipe, bind the buyer’s own accounts, call a shared address-normalization subflow from two flows, upgrade one caller and roll back; verify the other caller and production permissions stay unchanged.

### WORK-007 — Workflow tables and intake forms.

Builders store workflow lookup/state tables with keyed upserts and scoped forms for intake or human tasks. Forms validate fields, file access and submitter authority; records have retention and export controls. These are workflow components; the separate Cradle product owns the general relational workspace.

**Acceptance evidence:** Publish an authenticated intake form, submit the same business key twice, use its stored lookup in a workflow, reject an unauthorized record read and export then erase the collected record.

### WORK-008 — Versions, testing and controlled deployment.

Draft, test and production versions have immutable graphs, connector schema versions, parameters and grants. Builders compare changes, run selected authorized samples against test accounts, promote with a change record and roll back. In-flight runs retain their original version; environment promotion requires explicit connection binding and cannot inherit broader authority.

**Acceptance evidence:** Start a production run, edit and test its mapping in a draft, promote the draft and roll back; verify the in-flight run uses its original graph, tests use test accounts and all three deployments remain attributable.

## Connections and triggers

### CONN-001 — Discoverable connector library.

The catalog describes each app’s supported triggers/actions, searchable objects and custom fields, authentication, scopes, pagination, attachments, API version, limits and known restrictions. Builders select reusable personal or team connections and test access before activation. Unsupported actions are explicit and have a custom-connector path; a generic HTTP form is not a native app connector.

**Acceptance evidence:** Find a CRM connector by a business action, connect a test account, discover custom fields, test a paginated lookup and inspect the exact action scope and unsupported-operation message before publishing.

### CONN-002 — Managed OAuth, keys and connection lifecycle.

Owners authorize multiple accounts through provider OAuth or scoped API keys; Crank encrypts credentials under installation-controlled custody, refreshes tokens, rotates keys, tracks consent and permits team ownership transfer. Revocation stops new work, records in-flight uncertainty and tells affected workflow owners how to reconnect. Secrets never appear in graphs, logs, prompts, exports or browser reads; new scopes need fresh consent.

**Acceptance evidence:** Connect two accounts, select one per step, expire and refresh OAuth, rotate an API key, revoke the connection during a run and reconnect with a narrower grant; verify dependent workflows pause visibly and no secret appears in API state, exports or agent context.

### CONN-003 — Gmail and Microsoft Outlook.

Gmail and Microsoft Outlook/Microsoft 365 connections trigger on new or changed mail and calendar events, search threads/events and draft or send messages, replies and calendar updates with attachments. Labels/folders, mailbox selection and stable thread/event IDs survive mapping; sending and reading scopes are separately visible.

**Acceptance evidence:** In each provider’s authorized test account, trigger from an incoming message, find its thread, draft and authorize a reply with an attachment, create a calendar follow-up and verify both by provider readback; duplicate notifications create no duplicate reply.

### CONN-004 — Slack, Nook and Microsoft Teams.

Slack, Nook and Microsoft Teams connectors receive authorized channel/message events and post, reply, update and route messages in the correct thread. They deliver actionable failure/approval notices with authenticated links and record provider acknowledgments separately from a person’s response.

**Acceptance evidence:** For each service, connect a workspace, start a workflow from an authorized thread, post its result back to that thread, handle a human decision and revoke access; verify no delivery to a different workspace and no repeated ping after completion.

### CONN-005 — Sheets, Airtable and Google Drive.

Google Sheets and Airtable connectors watch record changes, read/query and upsert rows by business key, preserve typed values and paginate. Google Drive watches, finds, reads, creates and transfers authorized files with size/type bounds and access checks. Binary/file references carry provenance and expiry rather than leaking bearer URLs.

**Acceptance evidence:** Run a changed spreadsheet row into an Airtable upsert, attach a permitted Drive document and archive a generated file; repeat the event and deny access to a private file, verifying one record and a visible file-permission error.

### CONN-006 — HubSpot, Orbit and Salesforce.

HubSpot, Orbit and Salesforce connections trigger on lead/contact/company/deal changes, search associations and custom fields, create/update records and tasks, and prevent synchronization loops. Buyers choose the authoritative system and conflict policy per mapped field; ambiguous merges enter an exception queue.

**Acceptance evidence:** For each CRM, ingest a changed lead, match an existing company, update a custom deal field and create a task; send the reflected event back and a conflicting edit, verifying no infinite loop or silent overwrite.

### CONN-007 — QuickBooks Online, Xero and NetSuite.

Accounting/ERP connectors read and create/update authorized customers, items, draft invoices, bills and payment references, handle pagination, tax codes, USD precision and provider accounting periods. QuickBooks Online, Xero and NetSuite remain the books of record. Posting, voiding and other consequential writes obey the buyer’s grants or approval steps and retain source object IDs.

**Acceptance evidence:** For each provider’s sandbox, map a customer and sales-tax line into a draft invoice, read it back, handle a locked period and revoked scope, and reconcile a payment reference without inventing a ledger posting or rounding cents away.

### CONN-008 — Stripe and Shopify commerce workflows.

Stripe and Shopify connectors accept verified payment, subscription, checkout and order events; look up related objects, update authorized records and orchestrate fulfillment/refunds within explicit limits. They preserve provider event IDs and idempotency, reconcile delayed events and leave funds, card handling, tax calculation and merchant liability with the authorized providers.

**Acceptance evidence:** Use Stripe test mode and a Shopify test store to process duplicate/out-of-order paid-order events, read back payment and order state, create one fulfillment handoff and require the configured authorization for a refund; an uncertain refund is reconciled before another attempt.

### CONN-009 — Jira Software Cloud and Zendesk.

Jira Software Cloud and Zendesk triggers/actions create, search, update and comment on issues/tickets with custom fields, attachments, assignees and status mapping. Workflows preserve external IDs and conversation links and prevent update loops, with access and rate-limit failures routed to their owner.

**Acceptance evidence:** For each provider, create an exception from a failed workflow, update it from the run’s resolution and observe a reply/status event without producing duplicate issues or a synchronization loop.

### CONN-010 — Every Run Edit Run product connects.

Every sibling seed has a named connector using its public events/API and app-specific authority, with useful domain triggers, lookups and actions rather than a placeholder webhook. Current coverage includes [Vector](https://github.com/just-every/run-vector), [Spool](https://github.com/just-every/run-spool), [Uptime](https://github.com/just-every/run-uptime), [Lamp](https://github.com/just-every/run-lamp), [Oncall](https://github.com/just-every/run-oncall), [Linen](https://github.com/just-every/run-linen), [Auth](https://github.com/just-every/run-auth), [Vane](https://github.com/just-every/run-vane), [Slate](https://github.com/just-every/run-slate), [Nook](https://github.com/just-every/run-nook), [Chest](https://github.com/just-every/run-chest), [Pencil](https://github.com/just-every/run-pencil), [Penny](https://github.com/just-every/run-penny), [Cradle](https://github.com/just-every/run-cradle), [Evidence](https://github.com/just-every/run-evidence), [Pane](https://github.com/just-every/run-pane), [Orbit](https://github.com/just-every/run-orbit), [Buoy](https://github.com/just-every/run-buoy), [HappyToHelp](https://github.com/just-every/run-happytohelp), [Mango](https://github.com/just-every/run-mango), [Dial](https://github.com/just-every/run-dial), [Stall](https://github.com/just-every/run-stall), [Platter](https://github.com/just-every/run-platter), [Nectar](https://github.com/just-every/run-nectar), [Pantry](https://github.com/just-every/run-pantry), [Easel](https://github.com/just-every/run-easel), [Coaster](https://github.com/just-every/run-coaster), [Purse](https://github.com/just-every/run-purse), [Inkwell](https://github.com/just-every/run-inkwell), [Locket](https://github.com/just-every/run-locket), [Blotter](https://github.com/just-every/run-blotter), [Coffer](https://github.com/just-every/run-coffer), [Willow](https://github.com/just-every/run-willow), [Lodge](https://github.com/just-every/run-lodge), [Lanyard](https://github.com/just-every/run-lanyard), [Beam](https://github.com/just-every/run-beam), [Gauge](https://github.com/just-every/run-gauge), [Satchel](https://github.com/just-every/run-satchel), [Balm](https://github.com/just-every/run-balm), [Pier](https://github.com/just-every/run-pier), [Larder](https://github.com/just-every/run-larder), [Barrow](https://github.com/just-every/run-barrow), [Gasket](https://github.com/just-every/run-gasket), [Glove](https://github.com/just-every/run-glove), [Mallet](https://github.com/just-every/run-mallet), [Plinth](https://github.com/just-every/run-plinth), [Terrace](https://github.com/just-every/run-terrace), [Cabin](https://github.com/just-every/run-cabin), [Placemat](https://github.com/just-every/run-placemat), [Strap](https://github.com/just-every/run-strap). Crank’s own workflow/run API supports automation of Crank. The catalog expands as seeds are added. Each sibling retains its product: Orbit CRM, HappyToHelp support, Vector issues, Penny feedback, Nook chat, Cradle records, Chest files, Coaster expenses and Pier stock are linked, not rebuilt or folded into Crank.

**Acceptance evidence:** For each listed sibling, connect an authorized installation, receive a real domain event, read the originating record, perform an allowed domain action and observe its outcome in that sibling; duplicate events, revoked grants and foreign-tenant IDs must fail safely. Demonstrate a CRM-to-accounting-to-chat business journey across sibling connectors.

### CONN-011 — Custom, enterprise and private app connections.

Technical teams build versioned custom connectors from documented APIs/OpenAPI with typed inputs, pagination, OAuth/key declarations, webhook verification and reusable tests. PostgreSQL, MySQL, SQL Server, SFTP and S3-compatible data-pipeline recipes, plus enterprise applications such as ServiceNow and SAP, use typed connectors or reviewed custom connectors, authenticated customer-controlled private gateways and incremental checkpoints; large files stream with explicit bounds. Workato-class deployment includes SSO through Auth or the buyer’s IdP, environment separation and scoped service accounts.

**Acceptance evidence:** Install a custom connector, call a private test database through an enrolled gateway, checkpoint and resume a paginated file pipeline, then revoke the gateway and attempt a cross-environment secret read; inspect the failed run and SSO access decisions.

### HTTP-001 — Authorized HTTP dispatch.

The existing custom HTTP connector delivers the immutable approved JSON body to the deployment-authorized exact origin, adds the run’s stable idempotency key, refuses redirects and binds success to the receiver’s returned effect ID and matching key. Failure or lost acknowledgment remains visible. One owner-controlled replay uses the same bytes/key; a compliant receiver records one effect. This connector’s manual mode remains available beside future standing-grant and app steps.

**Acceptance evidence:** Create and activate a flow through the HTTP API, prepare an event without sending, concurrently approve twice, lose the receiver acknowledgment, replay once and inspect one receiver effect; reject another run and refuse a foreign or credential-bearing destination.

### TRIG-001 — Scoped, deduplicated webhook admission.

A scoped trigger credential admits events only to its active flow. Stable source event identity deduplicates equal payloads, rejects changed payloads under the same ID and respects an erased-event fence. Trigger credentials cannot read workspace data, approve or activate work, and revocation takes effect at the server.

**Acceptance evidence:** Call the public trigger endpoint with an active flow key, resend the same event, change its payload, send to another flow and revoke the key; verify a single pending run, conflicts/refusals and no unauthorized reads.

### TRIG-002 — Schedules and on-demand runs.

Owners start a run on demand or schedule intervals, daily/weekly business times and calendar-aware recurrence in an IANA timezone. DST behavior, missed-run catch-up/skip policy and concurrent-run policy are inspectable. Due occurrences have stable identities, continue unattended and do not duplicate after restart or clock movement.

**Acceptance evidence:** Configure weekday 9 a.m. America/New_York execution, an interval and an on-demand run; cross both DST changes and restart during a due occurrence, then inspect the planned and actual times and exactly one admitted run per due occurrence.

### TRIG-003 — App, polling and email triggers.

Native event subscriptions and polling discover new/changed app records and incoming email automatically. Verified signatures, renewable subscriptions, paginated cursors, overlap windows, source IDs and deduplication handle delayed/out-of-order deliveries and outages. The owner chooses initial backfill and can see the last successful poll and next due action.

**Acceptance evidence:** Activate an email and CRM polling workflow, return overlapping pages and out-of-order webhook events, expire a subscription and restart polling after an outage; verify no lost admitted records, duplicate business actions or silent subscription failure.

## Operate recurring work

### EXEC-001 — Durable queues and execution checkpoints.

Activated workflows execute without a person per run under their grants. Durable queues show queued/running/waiting/dead-letter states, depth, oldest age, priority and owner. Atomic claims, per-step checkpoints, concurrency limits and cancellation survive executor loss and deployment; lease expiry records uncertainty before recovery. Pausing states whether it stops intake, dispatch or both, and cancellation identifies already-started effects.

**Acceptance evidence:** Queue a multi-step batch, stop the executor before and after a remote write, restart and inspect its checkpoints and oldest pending work; verify safe continuation, cancellation and no duplicate completed effect.

### EXEC-002 — Rate limits, backoff and exhaustion.

Connector-specific retry policy distinguishes proven-not-sent/transient failures from uncertain effects and permanent errors. Retries honor Retry-After, exponential backoff with jitter, provider/account rate limits, concurrency and attempt/time budgets. Exhausted work stays durable with its next owner action; throttling one account does not starve another.

**Acceptance evidence:** Run two accounts while one returns 429, then transient 503 and a permanent auth error; inspect spaced retry times, bounded attempts and a dead-letter outcome. Lose a mutating response and verify no blind retry before reconciliation.

### EXEC-003 — Error routes, alerts and escalation.

Builders choose per-step stop, continue, fallback business branch, compensate or resume behavior without hiding the original error. Error workflows deliver deduplicated email, Slack, Nook or Teams notices containing a safe run link, failure category, accountable owner and due action. Unresolved failures escalate on a business calendar; restored work resolves the alert and stops reminders.

**Acceptance evidence:** Cause validation, credential and provider failures in a published workflow, exercise stop/continue/error branches, fail the alert provider and restore it, then resolve the business exception; inspect the durable error, alert delivery history and end of escalation.

### EXEC-004 — Replay any eligible step safely.

Operators retry/resume any eligible failed or incomplete step or selected batch items using retained versioned input and scoped authority. Preview shows what would run, prior effects and idempotency/reconciliation status. A corrected payload creates an attributable new revision; successful side effects are not silently repeated. Bulk replay has selection preview and limits.

**Acceptance evidence:** Fail the fourth step after three committed effects, restart, preview and resume that step, then replay selected failed items with corrected data; verify the first three effects persist once and the original and corrected inputs remain distinguishable.

### EXEC-005 — Searchable run history and debugging.

Run history retains workflow/version, trigger provenance, original inputs, each step’s mapped inputs/outputs, timings, decisions, grants, attempts and remote object IDs under redaction and retention rules. Builders search/filter by workflow, business key, date, status and error, paginate beyond the latest page and compare prior runs. Incomplete executions remain available; UI distinguishes queued, rejected, failed, uncertain and business-complete.

**Acceptance evidence:** Find an older failed invoice by customer key, inspect its exact mapping and decisions, compare a passing run and follow the remote record link; deny a reader access to a restricted payload while retaining safe status/timing.

### EXEC-006 — Effect reconciliation and compensation.

Every mutating step records intent, stable operation identity and known/unknown remote effects. Crank uses provider idempotency when supported, otherwise reads back by business key before retrying. Ambiguous matches stop for an accountable decision. Partial workflows can run explicitly authorized compensating actions; compensation has its own audit/outcome and never promises distributed exactly-once effects or reversal of an irreversible action.

**Acceptance evidence:** Lose the response after an invoice/refund is created, restart and reconcile it by provider readback; simulate zero, one and multiple matches, then fail a downstream step and inspect an authorized compensation without duplicating the initial write.

### OPS-001 — Operations reporting and external logs.

Owners see workflow throughput, queue age, latency, success/failure/uncertainty, outstanding business obligations and connector health by workflow/team/time. Reports export CSV and stream redacted operational/audit events to buyer-selected Datadog, Splunk, S3-compatible storage or authorized HTTP sinks with delivery lag and failure visibility. A successful HTTP response cannot inflate the business-completion metric.

**Acceptance evidence:** Generate passing, failed, waiting and uncertain runs; filter an operations report, export it and stream events to an unavailable then restored sink; reconcile counts to run history and show incomplete business outcomes separately.

### OPS-002 — USD usage, forecasts and spending controls.

Before activation the buyer sees estimated per-run/workflow USD costs and assumptions for orchestration, connectors, models and external executors; actual usage remains labeled measured or estimated by source. Account/team/workflow budgets, task/credit exhaustion notices and authorized overage policies pause or resume predictably, retaining due work and preventing runaway loops or agent spending.

**Acceptance evidence:** Estimate a batch, run it against metered provider test edges, approach and exhaust a budget and replenish it; verify timely notices, no unauthorized overage, preserved backlog and a report separating estimates, observed usage and provider charges.

## People, authority and data

### TEAM-001 — Team workspaces and permissions.

Owners invite/deactivate members and assign owner, administrator/builder, operator, approver and viewer roles, with workflow/folder/environment and connection-use scopes. Team-owned flows survive employee departure. Enterprise group/SCIM provisioning through Auth or the buyer’s IdP applies the same environment/project policy and revokes sessions and service access when membership ends. Server-side access limits sensitive payloads and production writes; audit readers and billing administrators need not receive credentials or customer data.

**Acceptance evidence:** Invite each role, share a restricted workflow and connection, attempt direct cross-scope reads/writes, transfer a departing builder’s flows and deactivate them during an active session; verify continuity without retained personal access.

### TEAM-002 — Optional approvals and standing grants.

Approval is a configurable step or policy boundary, not a requirement for every run. Standing grants name workflow/version, app/account, tools/actions, fields, recipients, amount/rate limits and expiry. Routine actions proceed unattended within the grant. High-impact or out-of-policy actions show the exact proposed effect to an authorized human; rejection sends nothing, approval changes invalidate the decision and timeout/escalation/delegation are durable. Revocation stops new authority immediately.

**Acceptance evidence:** Publish a routine lead workflow under a limited grant and observe unattended completion; exceed a USD refund limit, inspect and reject one proposed action, approve another, then alter its body and revoke the grant mid-run, verifying reapproval/refusal and recorded in-flight uncertainty.

### TEAM-003 — Scoped preparation and trigger credentials.

Owners issue one-time agent preparation/read credentials and one-flow trigger credentials stored only as hashes. Preparation authority cannot activate, approve, replay, manage data or escalate its own permissions. Revocation and owner identity/version changes invalidate credentials at the HTTP and transaction boundaries. Future execution tools receive separate explicit grants under TEAM-002.

**Acceptance evidence:** Issue both credential kinds through Access, prepare/read with an agent, submit with a trigger, try every owner-only route and another flow, then revoke; inspect state and archive for absence of bearer values.

### SEC-001 — Native authentication and origin-bound writes.

Private product routes require a current native operator session or a specifically scoped machine credential. Authorization is enforced in handlers and durable write predicates; browser mutations require the configured exact Origin. Owner-only data/access/import decisions cannot be obtained by an admin, member, trigger or preparation agent. Local development identity remains local and is excluded from deployed assets.

**Acceptance evidence:** Sign in through the ordinary email-link journey, call private HTTP doors signed out and with each lower role, send a foreign-Origin mutation and revoke a session/credential before a guarded write; verify denial without product effects and the build’s dev-identity exclusion.

### SEC-002 — Bounded network and untrusted content.

HTTP/custom connectors, callbacks, code, files and agent tools validate authorized egress destinations on every redirect/resolution, refuse private/metadata targets unless an explicit private gateway grant applies, bound bytes/time and keep secrets server-side. Input text, imported graphs and tool results cannot execute HTML/scripts or override agent policy. File types and access are checked before forwarding.

**Acceptance evidence:** Through workflow and import doors submit hostile HTML, credential-bearing URLs, redirect and DNS-rebinding targets, oversized payloads and prompt-injection text; verify literal display or named refusal, no unintended network requests and no secret in stored output.

### SEC-003 — Permanent attributable audit.

An exportable, append-only audit records connection consent/rotation, grant changes, deployments, approvals, executions, replays, imports, exports, erasures and administrative actions with actor, time, version and value-free subject identity. Agents and automated work identify the policy authorizing them. Erasure anonymizes actors and removes sensitive payload copies without rewriting action history; external log delivery is observable.

**Acceptance evidence:** Change a grant, publish, execute, approve, replay and erase a run; read/export the audit as an authorized auditor, deny a builder’s audit mutation and verify anonymized records retain chronology without erased payloads or secrets.

### DATA-001 — Complete portable archives and inactive restore.

Owners export all portable workflow versions/graphs, recipes, tables/forms, run/step histories, decisions, obligations, import provenance, usage, audit and erasure journals in documented versioned data. Integrity/schema/semantic checks precede atomic restore into empty product data. Flows restore paused with interrupted work visible and no dispatch; account bindings, credential secrets, sessions and grants remain installation-local and must be reauthorized. Unknown data is refused rather than silently omitted.

**Acceptance evidence:** Export a populated installation, restore to an empty installation, compare all portable records and verify paused workflows, no network effects and no receiving authority; refuse corruption and a nonempty destination, then export the restored history again.

### DATA-002 — Erasure, receipts and restoration fences.

Owners erase completed run data and related sensitive inputs, decisions, outputs, files, indexes and agent memory after stopping affected execution. Durable value-free receipts and event digests prevent local restoration/readmission; a later source journal fences older archives on another installation. Subject/operator erasure traverses owned records and anonymizes the separate audit. External effects and previously downloaded offline copies are disclosed and handled in the buyer’s provider/copy policy.

**Acceptance evidence:** Pause work and erase a terminal run/subject through Data; inspect histories, files, search and agent memory, attempt duplicate source readmission and restore its old archive with the later journal, then verify only value-free receipts/audit survive.

### DATA-003 — Explicit retention and sensitive-data policy.

Owners choose payload, attachment, model-context and history retention with dry-run deletion scope and legal holds. Defaults and automatic cleanup are disclosed; limits on displayed pages never masquerade as deletion policy. Durable outcomes, audit and value-free receipts outlive expiring payloads, and incomplete obligations are not silently erased. Health/financial/customer data use scoped encryption, regional/provider controls and required agreements before production processing.

**Acceptance evidence:** Configure short payload retention and a held subject, run the maintenance job across its boundary and restart; verify only eligible sensitive data expires, held records remain, unfinished work is visible and pre-erasure snapshots respect fences.

## Move existing automations

### MIG-001 — n8n migration with preview and undo.

Import n8n workflow exports including graph/layout, triggers, mappings, branches, loops, subflows, delays, code and credential references into paused Crank drafts. A preview maps every node/setting or names a blocking/manual conversion; it never silently drops work, imports authority or executes source expressions during parsing. Reviewed fingerprints, source identities, originals and a restartable journal support idempotent apply and safe undo of unused, unchanged imports.

**Acceptance evidence:** Preview a multi-step n8n export with a subflow and unsupported/custom node, resolve each named gap, apply the exact reviewed plan twice, reopen the journal after restart, bind fresh accounts and compare runs before cutover; undo an unused import and refuse undo after drift or use.

### MIG-002 — Zapier migration and cutover.

Buyers migrate Zaps, folders, schedules, paths, filters, formatter steps, loops, sub-Zaps, tables/forms and agent tool declarations. Crank accepts documented Zap JSON exports (with source plan/access prerequisites explained) and uses a guided, itemized reconstruction for assets a source plan cannot export. Every source item has a mapped/manual/blocked disposition, fresh connection consent and a parity test. Cutover fences source events, records the handoff watermark and permits rollback without double-firing writes.

**Acceptance evidence:** Migrate an authorized multi-path Zap with formatter and delayed action, account for every source setting and unavailable export, compare mapped results on authorized samples, stop the source at a watermark and switch triggers; roll back without two active writers or duplicate effects.

### MIG-003 — Make blueprint migration.

Make scenarios/blueprints migrate modules, routers, filters, mappings, iterators/aggregators, scheduling, error routes and dependencies into reviewed paused drafts with explicit unsupported dispositions. Connections/webhook URLs are rebound and data stores transferred under consent. Source operations/credits are not misrepresented as Crank cost; source history remains labeled historical.

**Acceptance evidence:** Import a Make blueprint with a router, iterator and error handler, inspect the complete mapping/exception report, rebind accounts and test both branches, then perform a watermark cutover and demonstrate unused-import undo.

### MIG-004 — Workato recipe and project migration.

Authorized Workato RLCM ZIP packages and accessible API definitions migrate recipes, recipe functions/callable recipes, custom connectors, lookup/data tables, shared schemas, message templates, API endpoints/collections, event topics, skills/genies/MCP declarations, properties, test cases, schedules, environments and error handling with source IDs/provenance and a complete dependency report. Dependency coverage includes workflow-app configuration where present; unavailable package assets receive explicit reconstruction tasks. Enterprise connection, on-prem gateway and role policies are deliberately rebound. Items unavailable to export receive a guided reconstruction and acceptance case, never a false compatibility claim.

**Acceptance evidence:** Preview an authorized Workato package with callable recipes and environment properties, account for dependencies and unsupported actions, compare sandbox outcomes, approve production account/gateway binding and cut over with a documented rollback checkpoint.

### MIG-005 — Gumloop and Pipedream move-in.

Crank accepts Pipedream project ZIP exports, including manifest dispositions, workflow/source/code definitions, configured properties, component versions and control-flow branches. It reports skipped/truncated workflows and explicitly requests excluded environment values, stores/files and private component source through secure setup. Gumloop flows/agents migrate through verified authorized exports/APIs where available and guided reconstruction otherwise; no portable Gumloop format is assumed. Model prompts, tool grants, branches, code dependencies, schedules and persisted source cursors receive explicit dispositions and tests. Imported prompts/tools cannot authorize themselves; no source secrets are copied into graphs or run history.

**Acceptance evidence:** For each product, inventory an authorized workflow containing an AI or code step, rebuild/import its complete graph, reauthorize tools, test both a safe and prohibited action and cut over its source cursor without losing or duplicating business events.

## AI steps and push further

### AI-001 — Inspectable AI and agent nodes.

Builders add LLM classification/extraction/generation and tool-using agent nodes using buyer-selected OpenAI, Anthropic, Google Gemini or authorized model endpoints. Each node declares typed outputs, model/version, allowed data, tools, MCP servers, iteration/time/USD budgets and failure policy. Prompts and external documents are untrusted data; agents cannot acquire new scopes, change grants, send out-of-policy messages or hide tool calls. Invalid structured output is a visible step failure.

**Acceptance evidence:** Run an invoice-extraction node and a tool-using agent against authorized documents and MCP tools; inspect model/tool/cost provenance, inject a hostile instruction and exceed a tool/spend limit, verifying schema failure or escalation without an unauthorized write.

### AI-002 — Natural-language workflow creation.

A builder describes a business result; an agent inspects only authorized app schemas/sample data and proposes an editable workflow, mappings, triggers, grants, test cases, costs and unresolved business questions. It validates the proposal against real connector schemas and test accounts. Human promotion or a previously approved bounded deployment policy controls activation; natural language alone does not silently grant production access.

**Acceptance evidence:** Ask for a US lead-to-invoice workflow, inspect and edit the generated graph and samples, refuse a requested new scope and then approve a tested version; verify no production sends occur during authoring and unresolved choices remain explicit.

### AI-003 — Reusable agent skills and recurring tasks.

Teams version reusable agent instructions, tools and evaluation cases as skills and schedule recurring tasks against scoped business data. Skill updates cannot broaden grants. Runs expose progress, remaining obligations, cost and human takeover/cancellation; recurring tasks stop when their objective is satisfied, authority expires or the owner pauses them.

**Acceptance evidence:** Publish a recurring overdue-invoice follow-up skill, run it across several due dates, update its version and revoke one tool; verify bounded contact cadence, visible stopped/blocked work, prior run provenance and human takeover.

### AGENT-001 — Own and verify the business outcome.

An outcome agent turns an owner-defined recurring objective into durable obligations across authorized CRM, accounting and communication records. It reads back downstream objects and checks explicit success criteria, not merely HTTP/tool success. It records satisfied, due, blocked and uncertain obligations with evidence and remaining cost; amounts, recipients, data access and changes stay within standing grants, and ambiguous remote effects await reconciliation.

**Acceptance evidence:** Run a lead-to-draft-invoice-and-notify objective where all requests return success but the invoice is missing or linked to the wrong customer; observe that the obligation stays open, reconcile provider records, repair only within the grant and close it only after correct readback.

### AGENT-002 — Detect, repair and test API drift.

An agent compares authorized run inputs/outputs, connector schemas, API changelogs and permission errors to detect source/API drift before or during failures. It pauses affected writes, prepares a minimal versioned connector/mapping repair, tests retained authorized cases and target sandbox APIs, reports changed fields/scopes and restores service only under human approval or a bounded preapproved repair policy. New scopes and business meaning changes always require human choice; rollback remains available.

**Acceptance evidence:** Rename a provider field and revoke a permission in a running workflow; inspect the detected drift, proposed diff and sandbox tests, reject the new scope, approve a mapping-only repair and resume from the durable checkpoint without duplicate effects.

### AGENT-003 — Turn recurring exceptions into tested capabilities.

An agent clusters recurring errors and manual corrections using only retained, authorized cases, proposes a transformation/subflow/connector improvement and evaluates it on both passing and failing cases. The owner controls sample retention, deployment policy and semantic changes. It measures exception reduction and business correctness after deployment; it cannot simply suppress failures, add blind retries or substitute fabricated application results.

**Acceptance evidence:** Accumulate recurring address-format failures and successful counterexamples, inspect a proposed reusable normalization skill and its cases, approve it, then verify later outcomes and roll back if valid addresses regress; confirm original failures remain in history.

### AGENT-004 — Follow up across days and ask for real decisions.

An agent maintains due obligations, next actions, business calendars, accountable employees and evidence while work spans days. It asks the right person only for missing facts or unresolved business choices, chases stalled approvals under agreed cadence and escalates when authority or deadlines require it. It resumes the exact durable step after the answer, stops contact on completion/revocation and exposes takeover, cancellation and an audit of every communication.

**Acceptance evidence:** Leave a customer tax fact unresolved over a weekend, restart the service, answer from the authorized employee and finish the obligation; test unanswered escalation, a late duplicate answer and revoked contact authority, verifying one continuation and no further reminders after completion.

## Product delivery and boundaries

### UX-001 — Accessible mobile operation.

Builders and operators use responsive web interfaces and iOS/Android mobile access for run search, notifications, approvals, pause, safe replay and takeover; full workflow editing remains usable on desktop and accessible on small screens. Keyboard/screen-reader labels, textual states, focus and action errors meet the WCAG 2.2 AA target. Notifications never expose secrets; poor connectivity shows stale state and reconciles a decision before permitting another.

**Acceptance evidence:** At 1440px and 390px with realistic long names/payloads, create and inspect work, approve/reject, pause and resolve a failure using keyboard and touch; interrupt connectivity during approval and verify one decision and clear stale/error state. Exercise the same notification-to-resolution journey on iOS and Android.

### PLATFORM-001 — Public API, webhooks, SDK and MCP.

The product exposes documented, versioned APIs, paginated reads, outgoing signed run/outcome webhooks, SDKs and an MCP server for authorized workflow/run/connection operations. Idempotent writes, scoped service accounts, event retries, subscription rotation and public error contracts support app and agent integrations. Remote clients have the same grants and audit trail as UI operators and cannot bypass approval.

**Acceptance evidence:** Use an SDK and MCP client to create a draft, start granted work, inspect progress and subscribe to signed completion events; duplicate writes, rotate a webhook secret and attempt an out-of-grant action, verifying stable IDs, delivery history and denial.

### BASE-001 — Owned operation and explicit Base replacements.

Crank remains a standalone owned product with native sign-in, local data and editable source; core operation needs no author telemetry, license check or kill switch. The RER command contract remains in force. DATA-001 explicitly excludes installation authority and credentials from archives instead of claiming full BASE-DATA-001 equivalence. Structured JSON/graph inputs and literal text replace arbitrary owner HTML under BASE-INPUT-002; future attachments must satisfy explicit type/size/access/erasure rules rather than inheriting a no-upload exception. Authorized provider/LLM/executor data flows disclose recipient, purpose, fields, region, retention and required credentials; no blanket zero-egress or completed compliance claim is made.

**Acceptance evidence:** With optional providers disconnected, run native sign-in, local HTTP automation, history and export without author traffic; inspect every enabled external destination/data category, then restore elsewhere with fresh authority and verify a removed provider cannot receive data.

### BASE-002 — Runnable site and unchanged installed home.

The static run site leads from Run Crank to runnable commands and publishes repository owner guides at /docs. The installed home stays the shared Lobby. Target clauses describe future product behavior; current guides/API documentation remain implementation-specific until their corresponding capabilities ship.

**Acceptance evidence:** Build the static site and follow homepage → /run and /docs without JavaScript; traverse local guide links and anchors through HTTP, and verify the installed homepage through its emitted Worker.

### BASE-003 — Observable operation and recovery.

Configuration errors identify the binding name without its secret. Health reflects required storage/executor dependencies; unavailable state is labeled unavailable, never success. Jobs, connector subscriptions, maintenance, archive transfer and agent tasks have durable terminal outcomes and crash reconciliation. The owner can inspect capacity, backups, queue lag and provider outages; scale and availability claims require measurements, not plan limits.

**Acceptance evidence:** Run the emitted service, remove a required dependency, crash each active execution class and restart; observe bounded health failure, durable interrupted/uncertain outcomes, safe recovery and no silent loss or fabricated completed work.

### BOUND-001 — US-first product and provider responsibilities.

The first buyer is a US operations lead at a 5–100 person business replacing Zapier, Make or Workato. USD estimates, cents, US sales-tax fields, ACH/payment references, 1099/W-2 data handoffs and US business calendars/timezones are preserved. Crank orchestrates approved business operations; it does not itself become a bank, card network, payroll/tax filer, phone/911 carrier, clinical system or general logs/APM platform. Buyers use Stripe/ACH banking partners, QuickBooks/Xero/NetSuite, Gusto/ADP, their licensed communications/health providers and the appropriate separate sibling products. Needed provider app reviews, native clients, payment permissions, health-data agreements and secure executors are engineering deliverables, never exclusions from automation scope.

**Acceptance evidence:** Configure a US business workflow with USD sales-tax lines and an ACH/1099 handoff, inspect provider responsibilities and consent, and attempt a regulated operation without the required agreement/scope; verify a named setup requirement and retained obligation, then complete it through an authorized sandbox/provider connection.

## Honest boundaries and sources

Crank does not replace its connected apps’ systems of record, provider licenses, network reach or agreements. It does provide the connectors, managed authorization, execution, human controls and follow-up needed to automate them. Private/heavy work runs on enrolled executors; provider quotas and permission failures are explicit operational states. A confirmed provider request proves its recorded effect only to the extent of the provider’s contract; general business completion requires independent readback. Offline copies and effects in another app require that app’s retention or compensating process. These boundaries do not reduce the category job or absorb unowned payroll, horizontal project management, business telephony, password management or general observability categories.

Scope authority is the owner-approved Crank entry in the 16 October category list, supplemented by the category inventory and code audit. Product documentation used as capability/migration context: [Zapier app directory](https://zapier.com/apps), [Make webhook processing](https://help.make.com/webhooks), [Make error handling](https://help.make.com/error-handling), [Workato recipes](https://docs.workato.com/recipes.html), [n8n flow logic](https://docs.n8n.io/flow-logic/), [n8n export/import](https://docs.n8n.io/workflows/export-import/), [Gumloop agents](https://docs.gumloop.com/core-concepts/agents), and [Pipedream project export](https://pipedream.com/docs/workflows/export-workflows), [Workato RLCM packages](https://docs.workato.com/en/recipe-development-lifecycle), [Zapier JSON exports](https://help.zapier.com/hc/en-us/articles/8496308481933-Import-and-export-Zap-workflows-in-your-Team-or-Enterprise-account), and [Make blueprints](https://help.make.com/blueprints). These are design inputs, not assertions that every vendor supports every target clause or export path. Source access and migration restrictions must be checked for the buyer’s edition; unavailable exports require itemized reconstruction, not silent scope reduction.

## Status by clause

Evidence paths are relative to this repository at the audited base above. They identify current implementations/tests; each partial row states its remaining gap.

| Clause | Status | Evidence path and current limit |
| --- | --- | --- |
| WORK-001 | partial | `src/crank/ui/flows.ts`; `src/crank/flows.ts`; `tests/crank.test.mjs` — The current form creates one webhook-to-HTTP flow; no visual graph, folders, editing or multi-step engine exists. |
| WORK-002 | missing | — |
| WORK-003 | missing | — |
| WORK-004 | missing | — |
| WORK-005 | missing | — |
| WORK-006 | missing | — |
| WORK-007 | missing | — |
| WORK-008 | partial | `src/crank/runs.ts`; `src/crank/flows.ts`; `tests/crank.test.mjs` — Runs freeze a flow revision and exact action; editable versions, test environments and rollback are absent. |
| CONN-001 | missing | — |
| CONN-002 | partial | `src/crank/flows.ts`; `src/crank/delivery.ts`; `src/crank/tokens.ts`; `tests/crank.test.mjs` — A deployment-selected origin/server token and hashed preparation/trigger tokens exist; managed OAuth and reusable third-party accounts do not. |
| CONN-003 | missing | — |
| CONN-004 | missing | — |
| CONN-005 | missing | — |
| CONN-006 | missing | — |
| CONN-007 | missing | — |
| CONN-008 | missing | — |
| CONN-009 | missing | — |
| CONN-010 | missing | — |
| CONN-011 | missing | — |
| HTTP-001 | done | `src/crank/flows.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `tests/crank.test.mjs` |
| TRIG-001 | done | `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/tokens.ts`; `tests/crank.test.mjs` |
| TRIG-002 | partial | `src/crank/ui/flows.ts`; `src/crank/runs.ts` — On-demand preparation works; there is no schedule engine. |
| TRIG-003 | missing | — |
| EXEC-001 | partial | `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/flows.ts`; `tests/crank.test.mjs` — Pending runs, conditional delivery claims and interrupted-attempt state exist; background queue processing and multi-step checkpoints do not. |
| EXEC-002 | missing | — |
| EXEC-003 | partial | `src/crank/delivery.ts`; `src/crank/ui/run.ts` — Failures are recorded and displayed; custom error workflows, notifications and escalation are missing. |
| EXEC-004 | partial | `src/crank/delivery.ts`; `tests/crank.test.mjs` — Only one manual replay of the single HTTP action exists. |
| EXEC-005 | partial | `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/run.ts`; `tests/crank.test.mjs` — Exact single-action history and incomplete attempts persist; the state route returns the latest 200 runs without general search, pagination or step history. |
| EXEC-006 | partial | `src/crank/delivery.ts`; `tests/crank.test.mjs` — The compliant HTTP receiver returns an effect ID/key and one replay is safe under that receiver contract; general provider readback and compensation are absent. |
| OPS-001 | missing | — |
| OPS-002 | missing | — |
| TEAM-001 | partial | `src/crank/access.ts`; `src/crank/ui/settings.ts`; `tests/crank.test.mjs` — Owner/admin/member roles and deactivation exist; workspace sharing scopes, approver/operator roles and team connection ownership do not. |
| TEAM-002 | partial | `src/crank/delivery.ts`; `src/crank/access.ts`; `tests/crank.test.mjs` — Exact owner approval/rejection ships; optional approval nodes and standing grants are absent. |
| TEAM-003 | done | `src/crank/tokens.ts`; `src/crank/access.ts`; `src/crank/api.ts`; `tests/crank.test.mjs` |
| SEC-001 | partial | `src/crank/access.ts`; `src/crank/api.ts`; `tests/crank.test.mjs`; `tests/email-link.mjs`; `SEED-COMMAND-CONTRACT.md` — HTTP role/origin boundaries are tested; commit-time session revocation and every private door/dev-layer exclusion are not all established by the cited product tests. |
| SEC-002 | partial | `src/crank/flows.ts`; `src/crank/delivery.ts`; `src/crank/model.ts`; `src/crank/ui/document.ts`; `tests/crank.test.mjs` — Exact-origin checks, escaping, bounded JSON/receiver responses and redirect refusal exist; general DNS/egress, file and agent-injection protections are not established. |
| SEC-003 | partial | `src/crank/delivery.ts`; `src/crank/imports.ts`; `src/crank/data.ts`; `tests/crank.test.mjs` — Immutable decisions, delivery attempts, import approvals and erasure records exist; no complete product-wide action audit is proven. |
| DATA-001 | partial | `src/crank/data.ts`; `src/crank/archive-policy.mjs`; `tests/crank.test.mjs`; `docs/BACKUP-RESTORE.md` — Current flow/run/decision/attempt/import archives and inactive restore are tested; the expanded product records, whole inventory and interrupted multi-step restore are unimplemented. |
| DATA-002 | partial | `src/crank/data.ts`; `src/crank/runs.ts`; `tests/crank.test.mjs`; `docs/BACKUP-RESTORE.md` — Terminal run/approval/attempt erasure, event fence and later-journal refusal ship; subject/operator traversal and future file/index/agent data are not proven. |
| DATA-003 | missing | — |
| MIG-001 | partial | `src/crank/n8n.ts`; `src/crank/imports.ts`; `src/crank/import-api.ts`; `src/crank/import-target.ts`; `tests/crank.test.mjs`; `docs/IMPORTING.md` — Only POST Webhook → whole-body HTTP Request is supported and tested with constructed documented-format data; no live customer export or broad graph compatibility is established. |
| MIG-002 | missing | — |
| MIG-003 | missing | — |
| MIG-004 | missing | — |
| MIG-005 | missing | — |
| AI-001 | missing | — |
| AI-002 | missing | — |
| AI-003 | missing | — |
| AGENT-001 | partial | `src/crank/delivery.ts`; `src/crank/ui/run.ts`; `tests/crank.test.mjs` — Receiver effect ID/key binding exists and the UI disclaims later business completion; cross-app obligations and independent readback do not. |
| AGENT-002 | missing | — |
| AGENT-003 | missing | — |
| AGENT-004 | partial | `src/crank/runs.ts`; `src/crank/delivery.ts`; `tests/crank.test.mjs` — Pending human decisions persist; due obligations, reminders, routing and calendar-aware follow-up are absent. |
| UX-001 | partial | `src/crank/ui/document.ts`; `src/crank/ui/flows.ts`; `src/crank/ui/run.ts`; `public/crank.css` — Responsive HTML forms and state text exist; mobile apps/push, offline decision reconciliation and accessibility conformance are unproven. |
| PLATFORM-001 | partial | `src/crank/api.ts`; `scripts/crank.mjs`; `docs/API.md`; `tests/crank.test.mjs` — Native scoped HTTP preparation/trigger/read API and CLI exist; SDK, MCP, outgoing events and execution grants are missing. |
| BASE-001 | partial | `AGENTS.md`; `SEED-COMMAND-CONTRACT.md`; `src/crank/archive-policy.mjs`; `src/crank/delivery.ts`; `tests/crank.test.mjs` — Native owned workflow/archives exist; complete egress independence and expanded provider/data-lifecycle guarantees are not established. |
| BASE-002 | done | `src/site/pages.tsx`; `src/site/docs/build/site.ts`; `tests/site.test.mjs`; `tests/runtime.mjs` |
| BASE-003 | partial | `src/base/deployment-health.ts`; `src/crank/delivery.ts`; `src/crank/api.ts`; `tests/runtime.mjs`; `tests/crank.test.mjs` — Basic runtime health and read-triggered delivery-lease expiry exist; the complete future execution classes and operational guarantees are not proven. |
| BOUND-001 | missing | — |

**58 clauses: 4 done, 23 partial, 31 missing.**
