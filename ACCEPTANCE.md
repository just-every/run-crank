# First release

This acceptance backlog now follows the complete [Crank target contract](CONTRACT.md), approved scope dated **16 October 2026**. The title and person-facing journey form are retained from the existing document; “first release” no longer excludes connectors, scheduling, credential custody or live provider acceptance. Status describes current implementation, not a reduced target.

Each item below is one clause’s acceptance evidence. The named journey must be exercised through its public product door. Existing evidence uses real Worker/D1/auth with fakes only at the external receiver/mail edge; future native connectors require authorized real provider sandbox acceptance as well as edge tests. No existing automated check is weakened or removed. Current implementation guides remain linked from [CONTRACT.md](CONTRACT.md) and the docs site.

## Build the automation

- **WORK-001 — Visual multi-step workspace. Status: partial.** From the builder, connect a new lead trigger to a filter, CRM lookup, invoice draft and notification; inspect sample data at every edge, correct a missing required field, save and reopen the same graph, then publish it deliberately.
  Current evidence: `src/crank/ui/flows.ts`; `src/crank/flows.ts`; `tests/crank.test.mjs`. Remaining: The current form creates one webhook-to-HTTP flow; no visual graph, folders, editing or multi-step engine exists.

- **WORK-002 — Mapping, formatting and conditional routes. Status: missing.** Use the builder with a US lead containing nested addresses, a missing optional field and a USD amount; test both qualifying and filtered branches, a null value and invalid currency input, then inspect the exact mapped destination payload.
  Current evidence: none; this is build work.

- **WORK-003 — Loops, joins and batch processing. Status: missing.** Run a paginated order batch through a loop and two branches, join by order ID, interrupt after some invoices are created and resume; inspect unmatched records and confirm each completed order retains one invoice.
  Current evidence: none; this is build work.

- **WORK-004 — Durable delay and event waits. Status: missing.** Publish a two-business-day follow-up, stop the executor while waiting, resume after a timezone/DST boundary and deliver the same callback twice; observe one continuation, or the configured timeout branch if the deadline passes.
  Current evidence: none; this is build work.

- **WORK-005 — Isolated code steps and external executors. Status: missing.** From a published workflow run a code transformation and a remote Python job; exceed a limit, attempt unauthorized egress and cancel a long job; inspect explicit failures and verify a restart reconciles the remote task without launching a duplicate.
  Current evidence: none; this is build work.

- **WORK-006 — Reusable subflows and recipes. Status: missing.** Install a lead-to-invoice recipe, bind the buyer’s own accounts, call a shared address-normalization subflow from two flows, upgrade one caller and roll back; verify the other caller and production permissions stay unchanged.
  Current evidence: none; this is build work.

- **WORK-007 — Workflow tables and intake forms. Status: missing.** Publish an authenticated intake form, submit the same business key twice, use its stored lookup in a workflow, reject an unauthorized record read and export then erase the collected record.
  Current evidence: none; this is build work.

- **WORK-008 — Versions, testing and controlled deployment. Status: partial.** Start a production run, edit and test its mapping in a draft, promote the draft and roll back; verify the in-flight run uses its original graph, tests use test accounts and all three deployments remain attributable.
  Current evidence: `src/crank/runs.ts`; `src/crank/flows.ts`; `tests/crank.test.mjs`. Remaining: Runs freeze a flow revision and exact action; editable versions, test environments and rollback are absent.

## Connections and triggers

- **CONN-001 — Discoverable connector library. Status: missing.** Find a CRM connector by a business action, connect a test account, discover custom fields, test a paginated lookup and inspect the exact action scope and unsupported-operation message before publishing.
  Current evidence: none; this is build work.

- **CONN-002 — Managed OAuth, keys and connection lifecycle. Status: partial.** Connect two accounts, select one per step, expire and refresh OAuth, rotate an API key, revoke the connection during a run and reconnect with a narrower grant; verify dependent workflows pause visibly and no secret appears in API state, exports or agent context.
  Current evidence: `src/crank/flows.ts`; `src/crank/delivery.ts`; `src/crank/tokens.ts`; `tests/crank.test.mjs`. Remaining: A deployment-selected origin/server token and hashed preparation/trigger tokens exist; managed OAuth and reusable third-party accounts do not.

- **CONN-003 — Gmail and Microsoft Outlook. Status: missing.** In each provider’s authorized test account, trigger from an incoming message, find its thread, draft and authorize a reply with an attachment, create a calendar follow-up and verify both by provider readback; duplicate notifications create no duplicate reply.
  Current evidence: none; this is build work.

- **CONN-004 — Slack, Nook and Microsoft Teams. Status: missing.** For each service, connect a workspace, start a workflow from an authorized thread, post its result back to that thread, handle a human decision and revoke access; verify no delivery to a different workspace and no repeated ping after completion.
  Current evidence: none; this is build work.

- **CONN-005 — Sheets, Airtable and Google Drive. Status: missing.** Run a changed spreadsheet row into an Airtable upsert, attach a permitted Drive document and archive a generated file; repeat the event and deny access to a private file, verifying one record and a visible file-permission error.
  Current evidence: none; this is build work.

- **CONN-006 — HubSpot, Orbit and Salesforce. Status: missing.** For each CRM, ingest a changed lead, match an existing company, update a custom deal field and create a task; send the reflected event back and a conflicting edit, verifying no infinite loop or silent overwrite.
  Current evidence: none; this is build work.

- **CONN-007 — QuickBooks Online, Xero and NetSuite. Status: missing.** For each provider’s sandbox, map a customer and sales-tax line into a draft invoice, read it back, handle a locked period and revoked scope, and reconcile a payment reference without inventing a ledger posting or rounding cents away.
  Current evidence: none; this is build work.

- **CONN-008 — Stripe and Shopify commerce workflows. Status: missing.** Use Stripe test mode and a Shopify test store to process duplicate/out-of-order paid-order events, read back payment and order state, create one fulfillment handoff and require the configured authorization for a refund; an uncertain refund is reconciled before another attempt.
  Current evidence: none; this is build work.

- **CONN-009 — Jira Software Cloud and Zendesk. Status: missing.** For each provider, create an exception from a failed workflow, update it from the run’s resolution and observe a reply/status event without producing duplicate issues or a synchronization loop.
  Current evidence: none; this is build work.

- **CONN-010 — Every Run Edit Run product connects. Status: missing.** For each listed sibling, connect an authorized installation, receive a real domain event, read the originating record, perform an allowed domain action and observe its outcome in that sibling; duplicate events, revoked grants and foreign-tenant IDs must fail safely. Demonstrate a CRM-to-accounting-to-chat business journey across sibling connectors.
  Current evidence: none; this is build work.

- **CONN-011 — Custom, enterprise and private app connections. Status: missing.** Install a custom connector, call a private test database through an enrolled gateway, checkpoint and resume a paginated file pipeline, then revoke the gateway and attempt a cross-environment secret read; inspect the failed run and SSO access decisions.
  Current evidence: none; this is build work.

- **HTTP-001 — Authorized HTTP dispatch. Status: done.** Create and activate a flow through the HTTP API, prepare an event without sending, concurrently approve twice, lose the receiver acknowledgment, replay once and inspect one receiver effect; reject another run and refuse a foreign or credential-bearing destination.
  Current evidence: `src/crank/flows.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `tests/crank.test.mjs`.

- **TRIG-001 — Scoped, deduplicated webhook admission. Status: done.** Call the public trigger endpoint with an active flow key, resend the same event, change its payload, send to another flow and revoke the key; verify a single pending run, conflicts/refusals and no unauthorized reads.
  Current evidence: `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/tokens.ts`; `tests/crank.test.mjs`.

- **TRIG-002 — Schedules and on-demand runs. Status: partial.** Configure weekday 9 a.m. America/New_York execution, an interval and an on-demand run; cross both DST changes and restart during a due occurrence, then inspect the planned and actual times and exactly one admitted run per due occurrence.
  Current evidence: `src/crank/ui/flows.ts`; `src/crank/runs.ts`. Remaining: On-demand preparation works; there is no schedule engine.

- **TRIG-003 — App, polling and email triggers. Status: missing.** Activate an email and CRM polling workflow, return overlapping pages and out-of-order webhook events, expire a subscription and restart polling after an outage; verify no lost admitted records, duplicate business actions or silent subscription failure.
  Current evidence: none; this is build work.

## Operate recurring work

- **EXEC-001 — Durable queues and execution checkpoints. Status: partial.** Queue a multi-step batch, stop the executor before and after a remote write, restart and inspect its checkpoints and oldest pending work; verify safe continuation, cancellation and no duplicate completed effect.
  Current evidence: `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/flows.ts`; `tests/crank.test.mjs`. Remaining: Pending runs, conditional delivery claims and interrupted-attempt state exist; background queue processing and multi-step checkpoints do not.

- **EXEC-002 — Rate limits, backoff and exhaustion. Status: missing.** Run two accounts while one returns 429, then transient 503 and a permanent auth error; inspect spaced retry times, bounded attempts and a dead-letter outcome. Lose a mutating response and verify no blind retry before reconciliation.
  Current evidence: none; this is build work.

- **EXEC-003 — Error routes, alerts and escalation. Status: partial.** Cause validation, credential and provider failures in a published workflow, exercise stop/continue/error branches, fail the alert provider and restore it, then resolve the business exception; inspect the durable error, alert delivery history and end of escalation.
  Current evidence: `src/crank/delivery.ts`; `src/crank/ui/run.ts`. Remaining: Failures are recorded and displayed; custom error workflows, notifications and escalation are missing.

- **EXEC-004 — Replay any eligible step safely. Status: partial.** Fail the fourth step after three committed effects, restart, preview and resume that step, then replay selected failed items with corrected data; verify the first three effects persist once and the original and corrected inputs remain distinguishable.
  Current evidence: `src/crank/delivery.ts`; `tests/crank.test.mjs`. Remaining: Only one manual replay of the single HTTP action exists.

- **EXEC-005 — Searchable run history and debugging. Status: partial.** Find an older failed invoice by customer key, inspect its exact mapping and decisions, compare a passing run and follow the remote record link; deny a reader access to a restricted payload while retaining safe status/timing.
  Current evidence: `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/run.ts`; `tests/crank.test.mjs`. Remaining: Exact single-action history and incomplete attempts persist; the state route returns the latest 200 runs without general search, pagination or step history.

- **EXEC-006 — Effect reconciliation and compensation. Status: partial.** Lose the response after an invoice/refund is created, restart and reconcile it by provider readback; simulate zero, one and multiple matches, then fail a downstream step and inspect an authorized compensation without duplicating the initial write.
  Current evidence: `src/crank/delivery.ts`; `tests/crank.test.mjs`. Remaining: The compliant HTTP receiver returns an effect ID/key and one replay is safe under that receiver contract; general provider readback and compensation are absent.

- **OPS-001 — Operations reporting and external logs. Status: missing.** Generate passing, failed, waiting and uncertain runs; filter an operations report, export it and stream events to an unavailable then restored sink; reconcile counts to run history and show incomplete business outcomes separately.
  Current evidence: none; this is build work.

- **OPS-002 — USD usage, forecasts and spending controls. Status: missing.** Estimate a batch, run it against metered provider test edges, approach and exhaust a budget and replenish it; verify timely notices, no unauthorized overage, preserved backlog and a report separating estimates, observed usage and provider charges.
  Current evidence: none; this is build work.

## People, authority and data

- **TEAM-001 — Team workspaces and permissions. Status: partial.** Invite each role, share a restricted workflow and connection, attempt direct cross-scope reads/writes, transfer a departing builder’s flows and deactivate them during an active session; verify continuity without retained personal access.
  Current evidence: `src/crank/access.ts`; `src/crank/ui/settings.ts`; `tests/crank.test.mjs`. Remaining: Owner/admin/member roles and deactivation exist; workspace sharing scopes, approver/operator roles and team connection ownership do not.

- **TEAM-002 — Optional approvals and standing grants. Status: partial.** Publish a routine lead workflow under a limited grant and observe unattended completion; exceed a USD refund limit, inspect and reject one proposed action, approve another, then alter its body and revoke the grant mid-run, verifying reapproval/refusal and recorded in-flight uncertainty.
  Current evidence: `src/crank/delivery.ts`; `src/crank/access.ts`; `tests/crank.test.mjs`. Remaining: Exact owner approval/rejection ships; optional approval nodes and standing grants are absent.

- **TEAM-003 — Scoped preparation and trigger credentials. Status: done.** Issue both credential kinds through Access, prepare/read with an agent, submit with a trigger, try every owner-only route and another flow, then revoke; inspect state and archive for absence of bearer values.
  Current evidence: `src/crank/tokens.ts`; `src/crank/access.ts`; `src/crank/api.ts`; `tests/crank.test.mjs`.

- **SEC-001 — Native authentication and origin-bound writes. Status: partial.** Sign in through the ordinary email-link journey, call private HTTP doors signed out and with each lower role, send a foreign-Origin mutation and revoke a session/credential before a guarded write; verify denial without product effects and the build’s dev-identity exclusion.
  Current evidence: `src/crank/access.ts`; `src/crank/api.ts`; `tests/crank.test.mjs`; `tests/email-link.mjs`; `SEED-COMMAND-CONTRACT.md`. Remaining: HTTP role/origin boundaries are tested; commit-time session revocation and every private door/dev-layer exclusion are not all established by the cited product tests.

- **SEC-002 — Bounded network and untrusted content. Status: partial.** Through workflow and import doors submit hostile HTML, credential-bearing URLs, redirect and DNS-rebinding targets, oversized payloads and prompt-injection text; verify literal display or named refusal, no unintended network requests and no secret in stored output.
  Current evidence: `src/crank/flows.ts`; `src/crank/delivery.ts`; `src/crank/model.ts`; `src/crank/ui/document.ts`; `tests/crank.test.mjs`. Remaining: Exact-origin checks, escaping, bounded JSON/receiver responses and redirect refusal exist; general DNS/egress, file and agent-injection protections are not established.

- **SEC-003 — Permanent attributable audit. Status: partial.** Change a grant, publish, execute, approve, replay and erase a run; read/export the audit as an authorized auditor, deny a builder’s audit mutation and verify anonymized records retain chronology without erased payloads or secrets.
  Current evidence: `src/crank/delivery.ts`; `src/crank/imports.ts`; `src/crank/data.ts`; `tests/crank.test.mjs`. Remaining: Immutable decisions, delivery attempts, import approvals and erasure records exist; no complete product-wide action audit is proven.

- **DATA-001 — Complete portable archives and inactive restore. Status: partial.** Export a populated installation, restore to an empty installation, compare all portable records and verify paused workflows, no network effects and no receiving authority; refuse corruption and a nonempty destination, then export the restored history again.
  Current evidence: `src/crank/data.ts`; `src/crank/archive-policy.mjs`; `tests/crank.test.mjs`; `docs/BACKUP-RESTORE.md`. Remaining: Current flow/run/decision/attempt/import archives and inactive restore are tested; the expanded product records, whole inventory and interrupted multi-step restore are unimplemented.

- **DATA-002 — Erasure, receipts and restoration fences. Status: partial.** Pause work and erase a terminal run/subject through Data; inspect histories, files, search and agent memory, attempt duplicate source readmission and restore its old archive with the later journal, then verify only value-free receipts/audit survive.
  Current evidence: `src/crank/data.ts`; `src/crank/runs.ts`; `tests/crank.test.mjs`; `docs/BACKUP-RESTORE.md`. Remaining: Terminal run/approval/attempt erasure, event fence and later-journal refusal ship; subject/operator traversal and future file/index/agent data are not proven.

- **DATA-003 — Explicit retention and sensitive-data policy. Status: missing.** Configure short payload retention and a held subject, run the maintenance job across its boundary and restart; verify only eligible sensitive data expires, held records remain, unfinished work is visible and pre-erasure snapshots respect fences.
  Current evidence: none; this is build work.

## Move existing automations

- **MIG-001 — n8n migration with preview and undo. Status: partial.** Preview a multi-step n8n export with a subflow and unsupported/custom node, resolve each named gap, apply the exact reviewed plan twice, reopen the journal after restart, bind fresh accounts and compare runs before cutover; undo an unused import and refuse undo after drift or use.
  Current evidence: `src/crank/n8n.ts`; `src/crank/imports.ts`; `src/crank/import-api.ts`; `src/crank/import-target.ts`; `tests/crank.test.mjs`; `docs/IMPORTING.md`. Remaining: Only POST Webhook → whole-body HTTP Request is supported and tested with constructed documented-format data; no live customer export or broad graph compatibility is established.

- **MIG-002 — Zapier migration and cutover. Status: missing.** Migrate an authorized multi-path Zap with formatter and delayed action, account for every source setting and unavailable export, compare mapped results on authorized samples, stop the source at a watermark and switch triggers; roll back without two active writers or duplicate effects.
  Current evidence: none; this is build work.

- **MIG-003 — Make blueprint migration. Status: missing.** Import a Make blueprint with a router, iterator and error handler, inspect the complete mapping/exception report, rebind accounts and test both branches, then perform a watermark cutover and demonstrate unused-import undo.
  Current evidence: none; this is build work.

- **MIG-004 — Workato recipe and project migration. Status: missing.** Preview an authorized Workato package with callable recipes and environment properties, account for dependencies and unsupported actions, compare sandbox outcomes, approve production account/gateway binding and cut over with a documented rollback checkpoint.
  Current evidence: none; this is build work.

- **MIG-005 — Gumloop and Pipedream move-in. Status: missing.** For each product, inventory an authorized workflow containing an AI or code step, rebuild/import its complete graph, reauthorize tools, test both a safe and prohibited action and cut over its source cursor without losing or duplicating business events.
  Current evidence: none; this is build work.

## AI steps and push further

- **AI-001 — Inspectable AI and agent nodes. Status: missing.** Run an invoice-extraction node and a tool-using agent against authorized documents and MCP tools; inspect model/tool/cost provenance, inject a hostile instruction and exceed a tool/spend limit, verifying schema failure or escalation without an unauthorized write.
  Current evidence: none; this is build work.

- **AI-002 — Natural-language workflow creation. Status: missing.** Ask for a US lead-to-invoice workflow, inspect and edit the generated graph and samples, refuse a requested new scope and then approve a tested version; verify no production sends occur during authoring and unresolved choices remain explicit.
  Current evidence: none; this is build work.

- **AI-003 — Reusable agent skills and recurring tasks. Status: missing.** Publish a recurring overdue-invoice follow-up skill, run it across several due dates, update its version and revoke one tool; verify bounded contact cadence, visible stopped/blocked work, prior run provenance and human takeover.
  Current evidence: none; this is build work.

- **AGENT-001 — Own and verify the business outcome. Status: partial.** Run a lead-to-draft-invoice-and-notify objective where all requests return success but the invoice is missing or linked to the wrong customer; observe that the obligation stays open, reconcile provider records, repair only within the grant and close it only after correct readback.
  Current evidence: `src/crank/delivery.ts`; `src/crank/ui/run.ts`; `tests/crank.test.mjs`. Remaining: Receiver effect ID/key binding exists and the UI disclaims later business completion; cross-app obligations and independent readback do not.

- **AGENT-002 — Detect, repair and test API drift. Status: missing.** Rename a provider field and revoke a permission in a running workflow; inspect the detected drift, proposed diff and sandbox tests, reject the new scope, approve a mapping-only repair and resume from the durable checkpoint without duplicate effects.
  Current evidence: none; this is build work.

- **AGENT-003 — Turn recurring exceptions into tested capabilities. Status: missing.** Accumulate recurring address-format failures and successful counterexamples, inspect a proposed reusable normalization skill and its cases, approve it, then verify later outcomes and roll back if valid addresses regress; confirm original failures remain in history.
  Current evidence: none; this is build work.

- **AGENT-004 — Follow up across days and ask for real decisions. Status: partial.** Leave a customer tax fact unresolved over a weekend, restart the service, answer from the authorized employee and finish the obligation; test unanswered escalation, a late duplicate answer and revoked contact authority, verifying one continuation and no further reminders after completion.
  Current evidence: `src/crank/runs.ts`; `src/crank/delivery.ts`; `tests/crank.test.mjs`. Remaining: Pending human decisions persist; due obligations, reminders, routing and calendar-aware follow-up are absent.

## Product delivery and boundaries

- **UX-001 — Accessible mobile operation. Status: partial.** At 1440px and 390px with realistic long names/payloads, create and inspect work, approve/reject, pause and resolve a failure using keyboard and touch; interrupt connectivity during approval and verify one decision and clear stale/error state. Exercise the same notification-to-resolution journey on iOS and Android.
  Current evidence: `src/crank/ui/document.ts`; `src/crank/ui/flows.ts`; `src/crank/ui/run.ts`; `public/crank.css`. Remaining: Responsive HTML forms and state text exist; mobile apps/push, offline decision reconciliation and accessibility conformance are unproven.

- **PLATFORM-001 — Public API, webhooks, SDK and MCP. Status: partial.** Use an SDK and MCP client to create a draft, start granted work, inspect progress and subscribe to signed completion events; duplicate writes, rotate a webhook secret and attempt an out-of-grant action, verifying stable IDs, delivery history and denial.
  Current evidence: `src/crank/api.ts`; `scripts/crank.mjs`; `docs/API.md`; `tests/crank.test.mjs`. Remaining: Native scoped HTTP preparation/trigger/read API and CLI exist; SDK, MCP, outgoing events and execution grants are missing.

- **BASE-001 — Owned operation and explicit Base replacements. Status: partial.** With optional providers disconnected, run native sign-in, local HTTP automation, history and export without author traffic; inspect every enabled external destination/data category, then restore elsewhere with fresh authority and verify a removed provider cannot receive data.
  Current evidence: `AGENTS.md`; `SEED-COMMAND-CONTRACT.md`; `src/crank/archive-policy.mjs`; `src/crank/delivery.ts`; `tests/crank.test.mjs`. Remaining: Native owned workflow/archives exist; complete egress independence and expanded provider/data-lifecycle guarantees are not established.

- **BASE-002 — Runnable site and unchanged installed home. Status: done.** Build the static site and follow homepage → /run and /docs without JavaScript; traverse local guide links and anchors through HTTP, and verify the installed homepage through its emitted Worker.
  Current evidence: `src/site/pages.tsx`; `src/site/docs/build/site.ts`; `tests/site.test.mjs`; `tests/runtime.mjs`.

- **BASE-003 — Observable operation and recovery. Status: partial.** Run the emitted service, remove a required dependency, crash each active execution class and restart; observe bounded health failure, durable interrupted/uncertain outcomes, safe recovery and no silent loss or fabricated completed work.
  Current evidence: `src/base/deployment-health.ts`; `src/crank/delivery.ts`; `src/crank/api.ts`; `tests/runtime.mjs`; `tests/crank.test.mjs`. Remaining: Basic runtime health and read-triggered delivery-lease expiry exist; the complete future execution classes and operational guarantees are not proven.

- **BOUND-001 — US-first product and provider responsibilities. Status: missing.** Configure a US business workflow with USD sales-tax lines and an ACH/1099 handoff, inspect provider responsibilities and consent, and attempt a regulated operation without the required agreement/scope; verify a named setup requirement and retained obligation, then complete it through an authorized sandbox/provider connection.
  Current evidence: none; this is build work.

**58 clauses: 4 done, 23 partial, 31 missing.** Status details and product behavior are in the contract’s final table. Completion requires the whole journey, including negative cases and observable end states; a cited partial implementation alone cannot promote an item.
