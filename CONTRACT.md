# Crank target contract

Target approved scope: **16 October 2026**. Category: **workflow automation (iPaaS)**. Crank is an owned Zapier/Make/Workato replacement: a connector library with managed OAuth credentials, webhooks/app events/polling/schedules, visual multi-step branching workflows with durable execution, AI agent steps and optional human approval where the action warrants it. It also targets the control and agent capabilities buyers seek in n8n, Gumloop and Pipedream.

The buyer connects the business’s applications so recurring work completes without copying data or supervising every step. Approval and idempotent HTTP delivery are one useful part of this whole job. This target replaces the old first-release exclusions of connectors, credential custody, schedules and live SaaS calls; it does not claim they already exist. No homepage, UI, manifest, code, test or workflow changes are authorized by this document.

Core records are workspaces, members/roles, connections and grants, workflows and immutable versions, steps/subflows/templates, trigger subscriptions/cursors, queues/runs/attempts, mapped inputs/outputs, remote effects, approvals, obligations, usage, import provenance, audit and erasure journals. All future capabilities below remain in scope even when marked missing. Each sibling remains its own product; Crank owns cross-app orchestration and integrates neighboring systems.

Acceptance journeys are repeated in [ACCEPTANCE.md](ACCEPTANCE.md). They run through UI, HTTP/CLI/SDK/MCP or provider doors, using fakes only at the network/paid edge in automated tests. A local edge test does not establish real provider consent, hosted operation, migration compatibility or customer acceptance. Live sandbox/provider journeys are required before a connector or migration can be called complete.

Status starts from the category code audit at `11db081906aa18bfb1c89e261d910196cffd3660`, also current main when this target was authored. No product source changed between the audit and this base. **done** means the entire stated bounded clause is implemented with cited code/test evidence; **partial** identifies the implemented subset and what is absent; **missing** has no product implementation. Vendored generic modules alone do not prove product adoption. The table at the end is a gap map, not a release certification. After the first switching-buyer review (16 October 2026), TRIG-001 widened to third-party webhook senders and moved from done to partial; sixteen clauses were added for the named everyday-app connectors, general HTTP requests, trigger latency, flood holds, hosted email, built-in mail/SMS, publish authority, reviewer edits, collect-data steps and MCP tools. After the second review (16 October 2026), TRIG-007 (feed and URL polling triggers) and WORK-010 (digest steps) were added, and WORK-002 now commits line-item arrays and a line-itemizer with per-line USD reconciliation, tested through CONN-006, CONN-007, CONN-008 and CONN-018. After the third review (16 October 2026), WORK-011 (search-step outcomes and find-or-create) and WORK-012 (built-in no-code transforms at Formatter breadth) were added; CONN-001, CONN-006, CONN-011, CONN-015, WORK-002, WORK-007, EXEC-006 and MIG-001–003 now cite them, WORK-004 adds named delay queues and EXEC-003 adds automatic pause on a sustained error rate.

## Build the automation

### WORK-001 — Visual multi-step workspace.

An operations lead creates, names, folders, searches, duplicates and connects workflows in a visual node-and-edge editor without code. Each workflow has an owner, description, trigger, typed steps and enabled state; its graph shows branches, data lineage and validation errors. Draft edits and sample tests cannot send production actions unless explicitly authorized. Publishing a version is itself the authorization for that version’s declared steps on its bound connections (TEAM-004); limits and approval steps are opt-in.

**Acceptance evidence:** From the builder, connect a new lead trigger to a filter, CRM lookup, invoice draft and notification; inspect sample data at every edge, correct a missing required field, save and reopen the same graph, then publish it deliberately and observe its next triggered run complete with no further authorization step.

### WORK-002 — Mapping, formatting and conditional routes.

Builders map nested fields and files between steps, validate against connector schemas, format US dates, timezones, USD amounts and decimals, transform text, numbers, dates and JSON with the WORK-012 built-in transforms, and choose filters and exclusive or parallel branches. Missing, null and empty values stay distinct; invalid mappings name the field and prevent an unintended write.

**Line items.** Connector schemas mark line-item arrays (deal line items, order lines, invoice and bill lines, cart items), and an array maps to an array: one source with N lines produces one destination record with N lines, never only the first line and never one record per line unless the builder chooses a loop (WORK-003). Each line maps its own description, product/item reference, quantity, unit price, amount, discount, tax code or taxable flag and class/location where the destination has them. A **line-itemizer** transform builds line-item arrays when a source has none: from comma-separated or mapped values, by splitting a delimited field, or by zipping parallel lists (names, quantities, prices) into line objects, with unequal list lengths a named error. USD line amounts are exact decimal cents: line totals, discounts, tax and shipping reconcile to the source total to the cent, and a mismatch, a zero-line source or a line missing a required field routes to a named validation failure instead of writing a partial or empty record.

**Acceptance evidence:** Use the builder with a US lead containing nested addresses, a missing optional field and a USD amount; test both qualifying and filtered branches, a null value and invalid currency input, then inspect the exact mapped destination payload. Map a HubSpot deal with 3 line items (one discounted, one non-taxable) and a Square order with 4 lines into QuickBooks Online sandbox draft invoices: readback shows 3 and 4 lines with matching quantities, amounts and tax codes, and each invoice total equals its source total to the cent; build a 2-line invoice with a line-itemizer step from comma-separated sheet values; zip parallel lists of unequal length and verify a named error; send a zero-line source and verify a named validation failure and no invoice created.

### WORK-003 — Loops, joins and batch processing.

Workflows paginate source datasets, iterate records with bounded concurrency, aggregate results and merge streams by explicit keys and join policy. Per-item success and failure remain inspectable; resumption preserves completed items and does not repeat their effects. Ordering and empty-input behavior are declared.

**Acceptance evidence:** Run a paginated order batch through a loop and two branches, join by order ID, interrupt after some invoices are created and resume; inspect unmatched records and confirm each completed order retains one invoice.

### WORK-004 — Durable delay and event waits.

Delay-until, interval waits and callback/event waits persist across restarts and deployments without holding a browser open. The owner sets timezone, expiry, business calendar and cancellation policy; late or duplicate callbacks do not resume a step twice. A **delay queue** step serializes runs through a named queue that any workflow in the workspace can share: each run waits until the queue’s previous item has been released plus a declared spacing, items release once each in arrival order, the queue survives restarts and deployments, and its depth, oldest item and next release time are visible.

**Acceptance evidence:** Publish a two-business-day follow-up, stop the executor while waiting, resume after a timezone/DST boundary and deliver the same callback twice; observe one continuation, or the configured timeout branch if the deadline passes. Send 5 runs from two workflows into one named delay queue with 1-minute spacing and restart the service mid-queue; verify each releases once, in arrival order, at least 60 seconds after the previous.

### WORK-005 — Isolated code steps and external executors.

Technical builders run JavaScript/TypeScript and Python transformations with declared inputs, outputs, dependency versions, time/memory limits and allowed egress. Heavy ETL, browser and long-lived jobs use authenticated owner-deployed executors with durable task identity, cancellation and results. Code cannot read unrelated connections, host secrets or another run.

**Acceptance evidence:** From a published workflow run a code transformation and a remote Python job; exceed a limit, attempt unauthorized egress and cancel a long job; inspect explicit failures and verify a restart reconciles the remote task without launching a duplicate.

### WORK-006 — Reusable subflows and recipes.

Teams create versioned subflows with typed inputs/outputs and reusable API/data-pipeline recipes, install reviewed community templates, and choose explicit update versions. Templates include connector requirements and sample tests but no credentials or production authority. Parent runs link to child histories and cancellation.

**Acceptance evidence:** Install a lead-to-invoice recipe, bind the buyer’s own accounts, call a shared address-normalization subflow from two flows, upgrade one caller and roll back; verify the other caller and production permissions stay unchanged.

### WORK-007 — Workflow tables and intake forms.

Builders store workflow lookup/state tables with keyed upserts, table lookups that are WORK-011 searches with the same create-if-not-found, no-match and multi-match settings, and forms for intake or human tasks. Each form has an access mode: authenticated (workspace members or named people, with submitter authority checked), or public, either link-only or embedded on the buyer’s website through a copyable iframe/script snippet with an allowed-origins list. Public forms carry a bot challenge (Cloudflare Turnstile by default, hCaptcha selectable), a hidden honeypot field, per-source (IP, origin and form) submission rate limits, and a stored spam score with its signals that filters and branches can route on. Challenged, throttled or spam-routed submissions are retained as inspectable records and cause no business effects unless a builder explicitly routes them. Forms validate fields, file type/size and access; records have retention and export controls. These are workflow components; the separate Cradle product owns the general relational workspace.

**Acceptance evidence:** Publish an authenticated intake form, submit the same business key twice, use its stored lookup in a workflow, reject an unauthorized record read and export then erase the collected record. Publish a public link-only quote-request form and embed it on a test page: one anonymous submission that passes the challenge starts exactly one run; a scripted burst of 200 submissions from one source is challenged or throttled, its accepted-but-spam-scored items route to the spam branch, and no CRM record, email or other business effect results from the burst; an embed from a non-allowed origin is refused.

### WORK-008 — Versions, testing and controlled deployment.

Draft, test and production versions have immutable graphs, connector schema versions, parameters and grants. Builders compare changes, run selected authorized samples against test accounts, promote with a change record and roll back. In-flight runs retain their original version; environment promotion requires explicit connection binding and cannot inherit broader authority.

**Acceptance evidence:** Start a production run, edit and test its mapping in a draft, promote the draft and roll back; verify the in-flight run uses its original graph, tests use test accounts and all three deployments remain attributable.

### WORK-009 — Collect-data human steps.

A collect-data step pauses a run to ask a person for typed fields (text, number, USD amount, date, choice, checkbox, file) before later steps continue. The builder sets the form, assignees (workspace members, a role, or an external recipient by email link that grants access to that one request only), a due time on a business calendar, reminders and an escalation target. Assignees are notified by email, Slack, Microsoft Teams or Nook and mobile push, each with an authenticated link. Answers are validated, recorded with the answering person and time, and map into later steps by field; the run resumes the exact paused step once. Unanswered requests remind, then escalate, then follow the configured timeout branch; late or duplicate answers after resolution are recorded and ignored.

**Acceptance evidence:** Publish a workflow with a collect-data step requesting a PO number and a USD amount from a sales role; trigger it late on a Friday, restart the service over the weekend and observe the Monday reminder and then the escalation to the configured manager; answer through the emailed link, verify the run resumes the exact step and the provider readback shows the answered values; submit the same link again and verify one continuation; let a second request pass its deadline and verify the timeout branch runs.

### WORK-010 — Digest steps that collect across runs.

A digest step accumulates entries across many runs and releases them together. Each digest has a name, an entry template (text, or structured fields kept as a list) and a release rule: daily, weekly or monthly at a chosen time and day in an IANA timezone, when a count threshold is reached, or manual only. Steps can **append entry**, **find digest** (read the current entries and count without releasing) and **release now**; release either clears the digest or keeps its entries. Each release is one durable run with a stable occurrence identity, so a restart, redeploy or DST change neither drops nor double-releases a digest, and an entry appended during a release lands in exactly one release. The released text or list maps into later steps (a Slack post, an EXEC-007 email, a sheet row); entries keep their source run links, an empty digest follows a builder-chosen skip or send-empty policy, and digests have retention and erasure under DATA-002/DATA-003.

**Acceptance evidence:** Publish a “new lead → append to Today’s leads” workflow with a daily 5 p.m. America/Chicago release to Slack; append 7 lead entries through the day, restart the service before 5 p.m. and verify one Slack message lists all 7 and a find-digest step then shows it empty; append during a release and verify the entry appears in exactly one release; cross a DST change with a daily digest and verify one release per day; release a manual-only digest on demand and verify a keep-entries release leaves its entries; migrate a Zap whose Digest by Zapier step uses a weekly schedule and verify the coverage report calls it native and its parity test passes.

### WORK-011 — Search steps: found, not found, several found, and find or create.

Every search operation, in every native connector, every CONN-011 custom connector and every WORK-007 workflow table, has three declared settings that a builder sets without code and that run history records on each run:

- **Create if not found:** an optional write on the same connection with its own mapped fields (WORK-002 and WORK-012), which turns the search into a find-or-create step. The step outputs the record plus an outcome of `found` or `created` that later steps, filters and paths can test, and run history shows which one happened.
- **No-match outcome:** either *halt*, which ends the run with the non-error status `stopped by search` (shown and filterable in EXEC-005 run history, counted apart from failures in OPS-001, and sending no EXEC-003 failure notice), or *continue*, which passes an explicit empty result with the outcome `not found` that WORK-002 filters and paths can branch on. A provider error, denied scope, rate limit or timeout is never reported as no match; it is a failure under EXEC-002 and EXEC-003.
- **Multi-match outcome:** *first*, by a declared sort field and direction (for example most recently updated); *stop*, with the named outcome `multiple matches`, which halts or routes to a branch as the builder chooses; or *all*, which returns every match up to a declared bound (paginating the provider) as an array for WORK-003 loops or WORK-002 line items, with the match count as an output and a named outcome when the bound truncates results.

Search keys are typed. Exact or case-insensitive matching is declared per field, emails compare case-insensitively after trimming, and a search whose key resolves to an empty value is a named validation error, never a match-all. A find-or-create is a mutating step under EXEC-006: its create carries a stable operation identity and the provider’s idempotency or unique key where one exists; if a create’s response is lost, Crank reads back by the search key before any retry; and concurrent runs for the same connection and normalized key are serialized, so they produce one record, with one run reporting `created` and the others `found`. A create the provider refuses as a duplicate (for example HubSpot’s existing-contact conflict) is resolved by readback to `found`, not raised as a failure. MIG-001, MIG-002 and MIG-003 carry these settings across from n8n, Zapier and Make search steps.

**Acceptance evidence:** Using a HubSpot sandbox, publish a workflow with a “Find or create contact by email” step: a new email creates the contact, run history shows `created` and readback shows one contact; the same email in a second run reports `found` and creates nothing; two concurrent runs for a third new email produce exactly one contact, one reporting `created` and one `found`; lose the create response on a fourth email and verify readback by email before any retry and one contact. Set a no-match search to halt and verify the run ends as `stopped by search` with no EXEC-003 failure notice; set the same search to continue and verify it routes to a “not found” path. Search for a company name matching 3 companies: it returns the first by the declared sort when set to first, stops with the named `multiple matches` outcome when set to stop, and drives a 3-iteration WORK-003 loop when set to all. Make the provider return 500 during a search and verify a failure, not `not found`; map an empty email as the key and verify a named validation error and no search. Repeat the halt and continue settings on a WORK-007 table lookup and a CONN-011 custom connector search with the same outcomes. Migrate a Zap whose HubSpot search uses “create if it doesn’t exist” and verify the coverage report calls it native and its parity test passes.

### WORK-012 — Built-in no-code transforms.

Transform steps, and the same functions inline in any field mapping, provide without code at least the operations of Zapier Formatter’s four families:

- **Text:** split by a separator or by a name rule (first word and the rest, or last word and the rest) with a segment choice of first, last, by index or all as a list; extract email, URL, phone number (normalized to E.164, US default region), number and regular expression with capture groups (first match or all); find and replace, literal or by pattern; case (upper, lower, title, sentence); trim and collapse whitespace; truncate with an optional ellipsis; strip HTML to plain text, keeping line breaks and link text; Markdown to HTML and HTML to Markdown; default value when empty; URL-encode and URL-decode; length and word count.
- **Numbers:** arithmetic (add, subtract, multiply, divide, negate) and spreadsheet-style formulas (SUM, ROUND, ROUNDUP, ROUNDDOWN, MIN, MAX, ABS, IF) over mapped values in exact decimal arithmetic with a declared scale and rounding mode (half-up by default for USD, half-even selectable); parse a number or amount from formatted text such as `$1,234.50`; format a number (separators, decimals) and a currency (USD by default, any ISO 4217 code).
- **Date/Time:** parse from ISO 8601, Unix time and common US formats with a declared input timezone; format to a chosen pattern in an IANA timezone; add or subtract years, months, weeks, days, hours and minutes, and business days on the WORK-004 business calendar (weekends and that calendar’s holidays skipped); compare two dates for earlier, later or equal and their difference in a chosen unit.
- **Utilities:** lookup table with a default value, either static in the step or backed by a WORK-007 table; pick from list (first, last, by index, random); text to list and list to text with a chosen separator; count items; remove duplicates; and the WORK-002 line-itemizer.

Every transform is typed: its inputs and output have declared types, the builder previews its output on the step’s sample data before saving, and a value that cannot be parsed (a date, number, amount or phone number) raises a named validation error that halts or routes under EXEC-003, instead of writing an empty string, zero or the raw input downstream. Transforms are deterministic and run in the workflow engine with no code step, model call or external request. MIG-002 maps each Zapier Formatter transform and option to one of these or names it as a manual conversion in the coverage report; MIG-003 and MIG-001 do the same for Make’s built-in functions and n8n’s built-in transformation nodes.

**Acceptance evidence:** Build one workflow from a web form sample with no WORK-005 code step and no AI step that splits “Mary Ann O’Neil” into first name “Mary Ann” and last name “O’Neil” by the last-word rule; extracts the email and phone from a free-text message, the phone normalized to E.164; maps “TX” to its sales rep through a lookup table and an unknown state to the default rep; computes a due date of close date + 30 days (20 November 2026 → 20 December 2026) and close + 10 business days on a US federal holiday calendar across Thanksgiving (→ 7 December 2026) in America/Chicago; computes 3 × $19.99 × 1.0825 = $64.92 exactly; and strips HTML from an email body. Preview each step on the sample before saving, run the published workflow and verify each output by readback of the destination record. Send an unparseable date and verify a named validation failure and no write. Migrate a Zap using Formatter split, lookup table, add/subtract time and perform math and verify the coverage report calls each step native and its parity test passes.

## Connections and triggers

### CONN-001 — Discoverable connector library.

The catalog describes each app’s supported triggers/actions, searchable objects and custom fields, authentication, scopes, pagination, attachments, API version, limits and known restrictions. Builders select reusable personal or team connections and test access before activation. Unsupported actions are explicit and have a custom-connector path; a generic HTTP form is not a native app connector. Every search operation in the catalog follows WORK-011: it offers create-if-not-found where the app has a matching create action, and declares its no-match and multi-match outcomes.

Breadth is a stated commitment, not an aspiration. Every app on Zapier’s popular-apps list ([zapier.com/apps](https://zapier.com/apps)) as of 16 October 2026 has a named native connector with at least one trigger, one search and one action: Google Sheets, Google Drive (CONN-005); Gmail, Microsoft Outlook (CONN-003); Slack (CONN-004); HubSpot, Salesforce (CONN-006); Stripe (CONN-008); Facebook Lead Ads, Google Forms, Typeform, Jotform, Gravity Forms (CONN-012); Google Calendar, Calendly (CONN-013); Notion, Trello, monday.com, Google Docs (CONN-014); Mailchimp, LeadConnector (CONN-015); Airtable (CONN-005). Everyday SMB apps beyond that list are also named: Microsoft Excel, OneDrive and SharePoint (CONN-005), Zoom (CONN-013), Asana and ClickUp (CONN-014), Pipedrive (CONN-015), Dropbox, Box, DocuSign and PandaDoc (CONN-016), Twilio SMS (CONN-017), and Square, PayPal and WooCommerce (CONN-018). Zapier’s built-in tools map to named clauses: Webhooks catch hooks and requests (TRIG-001, HTTP-002), Webhooks Retrieve Poll and RSS (TRIG-007), Email (TRIG-006, EXEC-007), Formatter text, numbers, date/time and utilities (WORK-012), Filter/Paths (WORK-002), Formatter Line-itemizer and line-item fields (WORK-002), search steps with “create if it doesn’t exist” and their no-match and multiple-result settings (WORK-011), Digest (WORK-010), Delay (WORK-004), Schedule (TRIG-002), Transfer (TRIG-002 historical runs), Code (WORK-005), Looping (WORK-003), Sub-Zaps (WORK-006), Storage/Tables/Forms/Interfaces (WORK-007), AI by Zapier (AI-001), Human in the Loop (TEAM-005, WORK-009) and MCP (PLATFORM-002). For the long tail, an agent builds a connector on demand from the provider’s public API documentation or OpenAPI description under CONN-011, with the same sandbox acceptance as a native connector.

A coverage report reads a buyer’s automation inventory (a Zapier JSON export, the itemized MIG-002 inventory, a Make/Workato/n8n/Pipedream export, or a typed list of apps and events) and reports for each app and each trigger/action used: **native** (named connector and operation exist), **agent-buildable** (public API and supported auth exist; CONN-011 build with its estimated scope), or **blocked** (with the reason; a search used with a create-if-not-found or outcome setting, or a Formatter transform, reports native only when WORK-011 or WORK-012 supports that exact setting, such as partner-only API or no public API, and the buyer’s workaround through HTTP-002 or a provider partner).

**Acceptance evidence:** Find a CRM connector by a business action, connect a test account, discover custom fields, test a paginated lookup and inspect the exact action scope and unsupported-operation message before publishing. Feed the coverage report a 60-Zap SMB inventory built only from Zapier’s 22 popular apps, using a fixed operation list committed with the test: for each app, every trigger, search and action used by that app’s ten most-used Zapier templates as captured on 16 October 2026, plus the built-in tools mapped above (including RSS, Retrieve Poll, Digest, Line-itemizer, every Formatter transform those templates use and every search with “create if it doesn’t exist” or a no-match or multiple-result setting): every app, operation and setting reports native. Add three long-tail apps (one with a public OpenAPI description, one with documented REST but no OpenAPI, one with a partner-only API) and verify agent-buildable, agent-buildable and blocked-with-reason respectively.

### CONN-002 — Managed OAuth, keys and connection lifecycle.

Owners authorize multiple accounts through provider OAuth or scoped API keys; Crank encrypts credentials under installation-controlled custody, refreshes tokens, rotates keys, tracks consent and permits team ownership transfer. Revocation stops new work, records in-flight uncertainty and tells affected workflow owners how to reconnect. Secrets never appear in graphs, logs, prompts, exports or browser reads; new scopes need fresh consent.

**Acceptance evidence:** Connect two accounts, select one per step, expire and refresh OAuth, rotate an API key, revoke the connection during a run and reconnect with a narrower grant; verify dependent workflows pause visibly and no secret appears in API state, exports or agent context.

### CONN-003 — Gmail and Microsoft Outlook.

Gmail and Microsoft Outlook/Microsoft 365 connections trigger on new or changed mail and calendar events, search threads/events and draft or send messages, replies and calendar updates with attachments. Labels/folders, mailbox selection and stable thread/event IDs survive mapping; sending and reading scopes are separately visible.

**Acceptance evidence:** In each provider’s authorized test account, trigger from an incoming message, find its thread, draft and authorize a reply with an attachment, create a calendar follow-up and verify both by provider readback; duplicate notifications create no duplicate reply.

### CONN-004 — Slack, Nook and Microsoft Teams.

Slack, Nook and Microsoft Teams connectors receive authorized channel/message events and post, reply, update and route messages in the correct thread. They deliver actionable failure/approval notices with authenticated links and record provider acknowledgments separately from a person’s response.

**Acceptance evidence:** For each service, connect a workspace, start a workflow from an authorized thread, post its result back to that thread, handle a human decision and revoke access; verify no delivery to a different workspace and no repeated ping after completion.

### CONN-005 — Sheets, Airtable, Google Drive and Microsoft 365 files.

Google Sheets, Airtable and Microsoft Excel (workbooks on OneDrive or SharePoint) connectors watch new and updated rows (Excel worksheet rows and Excel tables), read/query and upsert rows by business key, preserve typed values and paginate. Google Drive, OneDrive and SharePoint watch, find, read, create, move and transfer authorized files and folders with size/type bounds and access checks; SharePoint also triggers on new or changed list items and creates/updates list items in a chosen site. Microsoft 365 connections use Microsoft Entra ID consent with the delegated or application scopes shown before connection. Binary/file references carry provenance and expiry rather than leaking bearer URLs.

**Acceptance evidence:** Run a changed spreadsheet row into an Airtable upsert, attach a permitted Drive document and archive a generated file; repeat the event and deny access to a private file, verifying one record and a visible file-permission error. In a Microsoft 365 test tenant, run the same journey with an Excel table row on OneDrive upserted by business key, a SharePoint list item created from it and a generated file saved to a SharePoint document library: verify each by provider readback, repeat the triggering event with no duplicate row, item or file, and deny a file in a library the connection cannot read with a visible permission error.

### CONN-006 — HubSpot, Orbit and Salesforce.

HubSpot, Orbit and Salesforce connections trigger on lead/contact/company/deal changes, search associations and custom fields with WORK-011 find-or-create and match outcomes, read and write deal/opportunity line items and products as WORK-002 line-item arrays, create/update records and tasks, and prevent synchronization loops. Buyers choose the authoritative system and conflict policy per mapped field; ambiguous merges enter an exception queue.

**Acceptance evidence:** For each CRM, ingest a changed lead, match an existing company, update a custom deal field, read a deal’s three line items with their products, quantities and discounts as one line-item array, and create a task; run a WORK-011 “find or create contact by email” step twice for one new email and verify `created`, then `found`, and one contact by readback; send the reflected event back and a conflicting edit, verifying no infinite loop or silent overwrite.

### CONN-007 — QuickBooks Online, Xero and NetSuite.

Accounting/ERP connectors read and create/update authorized customers, items, draft invoices, bills and payment references, handle pagination, tax codes, USD precision and provider accounting periods. QuickBooks Online, Xero and NetSuite remain the books of record. Posting, voiding and other consequential writes obey the buyer’s grants or approval steps and retain source object IDs.

**Acceptance evidence:** For each provider’s sandbox, map a customer and a source with five lines (mixed tax codes, one discount line and one non-taxable line) into a draft invoice, read it back with five lines whose per-line amounts and total match the source to the cent, handle a locked period and revoked scope, and reconcile a payment reference without inventing a ledger posting or rounding cents away.

### CONN-008 — Stripe and Shopify commerce workflows.

Stripe and Shopify connectors accept verified payment, subscription, checkout and order events; look up related objects, update authorized records and orchestrate fulfillment/refunds within explicit limits. They preserve provider event IDs and idempotency, reconcile delayed events and leave funds, card handling, tax calculation and merchant liability with the authorized providers.

**Acceptance evidence:** Use Stripe test mode and a Shopify test store to process duplicate/out-of-order paid-order events (the Shopify order carrying three products with a discount and shipping, mapped as three lines whose total reconciles to the order total), read back payment and order state, create one fulfillment handoff and require the configured authorization for a refund; an uncertain refund is reconciled before another attempt.

### CONN-009 — Jira Software Cloud and Zendesk.

Jira Software Cloud and Zendesk triggers/actions create, search, update and comment on issues/tickets with custom fields, attachments, assignees and status mapping. Workflows preserve external IDs and conversation links and prevent update loops, with access and rate-limit failures routed to their owner.

**Acceptance evidence:** For each provider, create an exception from a failed workflow, update it from the run’s resolution and observe a reply/status event without producing duplicate issues or a synchronization loop.

### CONN-010 — Every Run Edit Run product connects.

Every sibling seed has a named connector using its public events/API and app-specific authority, with useful domain triggers, lookups and actions rather than a placeholder webhook. Current coverage includes [Vector](https://github.com/just-every/run-vector), [Spool](https://github.com/just-every/run-spool), [Uptime](https://github.com/just-every/run-uptime), [Lamp](https://github.com/just-every/run-lamp), [Oncall](https://github.com/just-every/run-oncall), [Linen](https://github.com/just-every/run-linen), [Auth](https://github.com/just-every/run-auth), [Vane](https://github.com/just-every/run-vane), [Slate](https://github.com/just-every/run-slate), [Nook](https://github.com/just-every/run-nook), [Chest](https://github.com/just-every/run-chest), [Pencil](https://github.com/just-every/run-pencil), [Penny](https://github.com/just-every/run-penny), [Cradle](https://github.com/just-every/run-cradle), [Evidence](https://github.com/just-every/run-evidence), [Pane](https://github.com/just-every/run-pane), [Orbit](https://github.com/just-every/run-orbit), [Buoy](https://github.com/just-every/run-buoy), [HappyToHelp](https://github.com/just-every/run-happytohelp), [Mango](https://github.com/just-every/run-mango), [Dial](https://github.com/just-every/run-dial), [Stall](https://github.com/just-every/run-stall), [Platter](https://github.com/just-every/run-platter), [Nectar](https://github.com/just-every/run-nectar), [Pantry](https://github.com/just-every/run-pantry), [Easel](https://github.com/just-every/run-easel), [Coaster](https://github.com/just-every/run-coaster), [Purse](https://github.com/just-every/run-purse), [Inkwell](https://github.com/just-every/run-inkwell), [Locket](https://github.com/just-every/run-locket), [Blotter](https://github.com/just-every/run-blotter), [Coffer](https://github.com/just-every/run-coffer), [Willow](https://github.com/just-every/run-willow), [Lodge](https://github.com/just-every/run-lodge), [Lanyard](https://github.com/just-every/run-lanyard), [Beam](https://github.com/just-every/run-beam), [Gauge](https://github.com/just-every/run-gauge), [Satchel](https://github.com/just-every/run-satchel), [Balm](https://github.com/just-every/run-balm), [Pier](https://github.com/just-every/run-pier), [Larder](https://github.com/just-every/run-larder), [Barrow](https://github.com/just-every/run-barrow), [Gasket](https://github.com/just-every/run-gasket), [Glove](https://github.com/just-every/run-glove), [Mallet](https://github.com/just-every/run-mallet), [Plinth](https://github.com/just-every/run-plinth), [Terrace](https://github.com/just-every/run-terrace), [Cabin](https://github.com/just-every/run-cabin), [Placemat](https://github.com/just-every/run-placemat), [Strap](https://github.com/just-every/run-strap). Crank’s own workflow/run API supports automation of Crank. The catalog expands as seeds are added. Each sibling retains its product: Orbit CRM, HappyToHelp support, Vector issues, Penny feedback, Nook chat, Cradle records, Chest files, Coaster expenses and Pier stock are linked, not rebuilt or folded into Crank.

**Acceptance evidence:** For each listed sibling, connect an authorized installation, receive a real domain event, read the originating record, perform an allowed domain action and observe its outcome in that sibling; duplicate events, revoked grants and foreign-tenant IDs must fail safely. Demonstrate a CRM-to-accounting-to-chat business journey across sibling connectors.

### CONN-011 — Custom, enterprise and private app connections.

Technical teams build versioned custom connectors from documented APIs/OpenAPI with typed inputs, pagination, OAuth/key declarations, webhook verification and reusable tests. When a buyer needs an app with no native connector, an agent builds one on request from the provider’s public API documentation or OpenAPI description: it proposes the triggers, searches (each with WORK-011 create-if-not-found, no-match and multi-match settings) and actions the buyer’s workflows use, their auth and scopes, and test cases; a person reviews scopes before first consent; the connector passes the same sandbox acceptance as a native connector (readback, duplicate event, revoked scope) before any production run, and is versioned and repairable under AGENT-002. PostgreSQL, MySQL, SQL Server, SFTP and S3-compatible data-pipeline recipes, plus enterprise applications such as ServiceNow and SAP, use typed connectors or reviewed custom connectors, authenticated customer-controlled private gateways and incremental checkpoints; large files stream with explicit bounds. Workato-class deployment includes SSO through Auth or the buyer’s IdP, environment separation and scoped service accounts.

**Acceptance evidence:** Install a custom connector, call a private test database through an enrolled gateway, checkpoint and resume a paginated file pipeline, then revoke the gateway and attempt a cross-environment secret read; inspect the failed run and SSO access decisions. Ask the agent for a connector to an app with a public OpenAPI description and no native connector: review its proposed operations and scopes, refuse one scope and verify the connector omits the dependent operation, then pass its sandbox readback, duplicate-event and revoked-scope tests and use it in a published workflow.

### CONN-012 — Lead capture and form apps.

Facebook Lead Ads, Google Forms, Typeform, Jotform and Gravity Forms (WordPress) connectors trigger on new submissions/leads: Facebook Lead Ads instantly through Meta’s lead webhooks for a chosen Page and form, Typeform, Jotform and Gravity Forms through provider webhooks registered by the connector, and Google Forms through response polling. Each exposes the form’s current fields (including hidden fields, UTM parameters and file uploads) as typed mappable data, finds forms and responses, and keeps the provider’s response/lead ID as the deduplication key. Connectors register, verify and remove their own webhooks so the buyer never pastes a URL, and a field added or renamed in the form is detected as schema drift (AGENT-002).

**Acceptance evidence:** For each provider’s test account, connect, pick a form, submit a response with a hidden UTM field and a file, and verify one run whose mapped fields match the response by provider readback; resend the same provider delivery and verify no second run; add a form field and verify drift is reported before the next run maps it; disconnect and verify the connector removed its provider webhook.

### CONN-013 — Calendars, scheduling and meetings.

Google Calendar is its own connector: triggers on new, updated, cancelled and starting-soon events on chosen calendars, searches events and free/busy, and creates, updates and cancels events with attendees, conferencing and reminders. Calendly triggers on invitee created and invitee cancelled (with rescheduling linked), exposes event type, questions/answers, UTM and payment fields, and looks up scheduled events and invitees. Zoom triggers on meeting/webinar registration, meeting ended and recording completed, and creates meetings, registrants and recording links. Time zones stay explicit IANA zones end to end.

**Acceptance evidence:** Book a Calendly test event with answered questions and verify one run that creates a Google Calendar event with a Zoom meeting for the invitee, each read back from its provider; reschedule the booking and verify the same calendar event and meeting are updated rather than duplicated; cancel it and verify both are cancelled; deliver the Calendly webhook twice with no duplicate effect.

### CONN-014 — Work management and documents.

Notion (databases and pages), Trello (boards, lists, cards), monday.com (boards, items, subitems, updates), Asana (projects, tasks, sections), ClickUp (spaces, lists, tasks) and Google Docs (documents, templates) connectors trigger on new and updated items, find items by field, and create, update, move, comment on and complete them with custom fields, assignees, due dates and attachments. Google Docs creates documents from a template with mapped placeholders and appends text. Item IDs and URLs remain stable mapped outputs, and each sibling project/issue product stays separate (Vector issues are reached through CONN-010).

**Acceptance evidence:** For each provider’s test workspace, trigger on a new item, update a custom field, move it to a done status and comment, reading each change back; create a Google Doc from a template with mapped USD and date fields and verify its text by readback; repeat the triggering event and verify no duplicate item, comment or document.

### CONN-015 — Marketing and sales pipelines.

Mailchimp (audiences, tags, campaigns), LeadConnector/HighLevel (contacts, opportunities, pipelines, appointments, workflows) and Pipedrive (persons, organizations, deals, activities, pipelines) connectors trigger on new or updated subscribers, contacts, opportunities and deals, search them with custom fields and WORK-011 find-or-create and match outcomes, and add/update subscribers and tags, create/update contacts, deals and opportunities, move pipeline stages and create activities. Mailchimp subscription consent status and unsubscribes are preserved, never overwritten to subscribed, in line with CAN-SPAM norms.

**Acceptance evidence:** For each provider’s test account, route a new lead into a contact/subscriber with a tag and a deal/opportunity in a chosen stage, read each back, move the stage and observe the change trigger; attempt to resubscribe an unsubscribed Mailchimp member and verify the status stays unsubscribed with a named refusal; repeat the lead through WORK-011 find-or-create steps on the contact/subscriber and the deal/opportunity and verify run history reports `found` for both and readback shows one contact and one deal.

### CONN-016 — File storage and e-signature.

Dropbox and Box connectors watch folders for new/changed files and find, upload, copy, move and share files with size/type bounds; Box metadata templates and Dropbox shared links are mappable. DocuSign and PandaDoc connectors create envelopes/documents from templates with mapped recipients and fields, send them for signature, trigger on sent, viewed, completed and declined, and download the completed document and certificate into a chosen storage connector. Signature legal validity stays with the e-signature provider.

**Acceptance evidence:** In sandbox accounts, generate a PandaDoc document and a DocuSign envelope from templates with mapped recipient and USD fields, complete each as the test signer, verify the completed trigger fires once, and file the signed PDF and certificate into Box and Dropbox folders verified by readback; decline a second envelope and verify the declined branch; deliver the completion event twice with one filed copy.

### CONN-017 — Twilio SMS.

A Twilio connection, using the buyer’s own account SID and API key under CONN-002 custody, triggers on inbound SMS/MMS to a chosen number, and sends SMS/MMS from a chosen number or Messaging Service with delivery-status callbacks mapped to the run. US norms apply: STOP/HELP opt-outs recorded by Twilio are honored and shown, A2P 10DLC or toll-free verification status is displayed before production sends, and quiet hours in the recipient’s timezone can be enforced by policy.

**Acceptance evidence:** With a Twilio test number, send an SMS from a workflow and see its delivered status in the run; reply from a handset and verify one inbound-triggered run; send STOP and verify the next send to that number is refused with a named opt-out reason and no Twilio charge; verify an unregistered sender shows its registration requirement before publish.

### CONN-018 — Square, PayPal and WooCommerce.

Square (payments, orders, customers, invoices, catalog), PayPal (captured payments, refunds, invoices, disputes) and WooCommerce (orders, customers, products, coupons, through the store’s REST API and signed webhooks) connectors trigger on new and updated orders/payments/disputes, look up related customers and products, and create customers, invoices and order notes; refunds obey TEAM-002 limits and EXEC-006 reconciliation. Provider event IDs deduplicate, and funds, card data and tax calculation stay with the provider.

**Acceptance evidence:** In Square sandbox, PayPal sandbox and a WooCommerce test store, process a paid order with four lines into one QuickBooks Online draft invoice with four lines (readback quantities, amounts and total matching the order to the cent) and a Slack notice, verify the order and payment by provider readback, replay the provider event with no duplicate invoice, and request a refund above the configured USD limit to verify it pauses for approval, then reconcile a lost refund response before any second attempt.

### HTTP-001 — Authorized HTTP dispatch.

The existing custom HTTP connector delivers the immutable approved JSON body to the deployment-authorized exact origin, adds the run’s stable idempotency key, refuses redirects and binds success to the receiver’s returned effect ID and matching key. Failure or lost acknowledgment remains visible. One owner-controlled replay uses the same bytes/key; a compliant receiver records one effect. This connector’s manual mode remains available beside future standing-grant and app steps.

**Acceptance evidence:** Create and activate a flow through the HTTP API, prepare an event without sending, concurrently approve twice, lose the receiver acknowledgment, replay once and inspect one receiver effect; reject another run and refuse a foreign or credential-bearing destination.

### HTTP-002 — General HTTP and connector API request steps.

A general HTTP request step calls any API that does not follow Crank’s receiver contract: methods GET, POST, PUT, PATCH, DELETE and HEAD; mapped headers and query parameters; JSON, form-encoded, multipart, XML or raw bodies; a bounded timeout; and authentication from a stored connection (basic, bearer, API key in header or query, OAuth 2.0 authorization code or client credentials, or HMAC request signing), never from inline secrets in the graph. Response status, headers and parsed body (JSON, XML, form or text) are mappable into later steps; builders define success and failure by status ranges and body conditions, and can follow cursor, page or link-header pagination. Every native connector also offers a raw API request action that reuses that connection’s managed auth and is limited to the connection’s declared API domains. Mutating requests follow EXEC-006 (provider idempotency header when the API supports one, otherwise readback by a declared business key, otherwise no automatic retry after an uncertain response) and SEC-002 egress rules. HTTP-001 remains available as the receiver-contract mode.

**Acceptance evidence:** Against a sandbox vendor API that returns a plain 200 with JSON and no Crank effect ID, PATCH a record with a bearer connection and a custom header, map a response field into the next step and verify the change by a GET readback; send a form-encoded POST and a multipart upload; define 409 as a business failure and route it to the error branch; lose one PATCH response and verify readback before any retry; through a HubSpot connection’s raw API request action call a supported endpoint with the managed OAuth token, then attempt a domain outside that connection and a private-network address and verify both are refused with no request sent and no secret in run history.

### TRIG-001 — Scoped, deduplicated webhook admission.

Every workflow can receive webhooks from senders that cannot add custom headers or wrap their payload. Each flow has one or more inbound URLs with an embedded random secret that the owner can revoke and rotate (old and new URLs overlap for a chosen window), plus optional header credentials (the existing scoped bearer trigger credential). Builders can require provider signature verification: HMAC-SHA256/SHA1 over the raw body or a signed timestamped payload with replay tolerance, with presets for Stripe, Shopify, Calendly, GitHub, Typeform and Twilio. The URL accepts POST, PUT and GET with JSON, form-encoded, multipart (with files) or raw bodies; a raw mode exposes the body text, headers and query string to mapping alongside the parsed fields. Deduplication uses a builder-chosen key path (for example `data.id` or a header) or, when the payload has no ID, a SHA-256 digest of the normalized body within a stated window (default 24 hours, configurable from 1 minute to 30 days). The response is configurable: an immediate status/body/headers, or a synchronous response produced by the workflow within a bounded timeout. Crank’s `{event_id,input}` envelope remains one supported mode: stable source event identity deduplicates equal payloads, rejects changed payloads under the same ID and respects an erased-event fence. No inbound credential can read workspace data, approve or activate work, and revocation takes effect at the server.

**Acceptance evidence:** Call the public trigger endpoint with an active flow key, resend the same event, change its payload, send to another flow and revoke the key; verify a single pending run, conflicts/refusals and no unauthorized reads. Send a form-encoded POST with no auth header and no event ID to a flow’s secret URL and verify exactly one run with the fields mapped; resend it inside the dedup window and verify no run; send it after the window and verify a new run; send a Stripe-signed event with a valid and then a tampered signature and verify one run and one refusal; send a GET with query parameters and a multipart POST with a file in raw mode and inspect headers, query and file as mapped data; configure a synchronous JSON response and verify the sender receives it; rotate the URL and verify the old URL stops after the overlap.

### TRIG-002 — Schedules and on-demand runs.

Owners start a run on demand or schedule intervals, daily/weekly business times and calendar-aware recurrence in an IANA timezone. A historical run applies a published workflow to existing source records the owner selects by filter or date range (for example last quarter’s closed deals), with a preview of the count, sample records and estimated USD cost before any effect (as in TRIG-005), runs selected or all items once each by source ID, and reports per-item outcomes. DST behavior, missed-run catch-up/skip policy and concurrent-run policy are inspectable. Due occurrences have stable identities, continue unattended and do not duplicate after restart or clock movement.

**Acceptance evidence:** Configure weekday 9 a.m. America/New_York execution, an interval and an on-demand run; cross both DST changes and restart during a due occurrence, then inspect the planned and actual times and exactly one admitted run per due occurrence. Start a historical run over last quarter’s 40 closed test deals: verify the preview shows 40 items and an estimated USD cost with no effects, run 10 selected items and then the rest, and verify exactly 40 runs, one per deal, with per-item outcomes.

### TRIG-003 — App, polling and email triggers.

Native event subscriptions and polling discover new/changed app records and incoming email automatically. Verified signatures, renewable subscriptions, paginated cursors, overlap windows, source IDs and deduplication handle delayed/out-of-order deliveries and outages. The owner chooses initial backfill and can see the last successful poll and next due action. Polling frequency and trigger latency are committed in TRIG-004, burst holds in TRIG-005, mailbox-free email triggers in TRIG-006, and feed and arbitrary-URL polling in TRIG-007.

**Acceptance evidence:** Activate an email and CRM polling workflow, return overlapping pages and out-of-order webhook events, expire a subscription and restart polling after an outage; verify no lost admitted records, duplicate business actions or silent subscription failure.

### TRIG-004 — Polling frequency and trigger latency.

Each polling workflow has its own interval, chosen from 1, 2, 5, 15, 30 and 60 minutes or a longer schedule; the 1-minute floor is available on every installation with no plan gate, and a provider whose rate limit cannot sustain the chosen interval shows the slowest safe interval before publish. With a healthy executor each poll starts within 30 seconds of its due time. Instant triggers (webhooks, app subscriptions, form submissions and inbound email) admit an event and start its run within 10 seconds of receipt at the 95th percentile. Every run records its trigger-to-start latency (source event time where the provider supplies one, receipt time and run start), and OPS-001 reports latency percentiles per workflow against the configured interval, flagging late polls with their cause (provider rate limit, executor backlog, outage).

**Acceptance evidence:** Publish a “new HubSpot deal → Slack” workflow at a 1-minute interval and an instant Typeform workflow; create 30 deals and 30 submissions spread over an hour; verify every deal run starts no later than 1 minute 30 seconds after the deal’s creation, every form run starts within 10 seconds of receipt at p95, and each run’s history shows its measured latency; throttle the HubSpot test edge with 429s and verify the late polls are flagged with “provider rate limit” in OPS-001; choose an interval faster than a provider allows and verify the pre-publish warning.

### TRIG-005 — Flood protection for bursts of trigger events.

Each workflow has a burst threshold (default 100 new records in one poll, or 100 instant events in one minute; configurable from 1 to 10,000). When a poll or burst exceeds it, Crank creates no business effects for the excess: it holds the whole burst as one reviewable batch, notifies the workflow owner (EXEC-003 channels), and shows the count, source, sample records and estimated USD cost. The owner can run all, run selected items, or discard; held events stay deduplicated by source ID and retained until decided, with reminders and an optional owner-chosen expiry. Releases are attributable and partial releases leave the rest held. Activation backfill (TRIG-003) remains a separate explicit choice.

**Acceptance evidence:** With a threshold of 100, return 500 new contacts from one poll of a CRM test edge to a welcome-email workflow; verify zero emails and zero downstream writes, one held batch with 500 deduplicated items and an owner notice; release 20 selected items and verify exactly 20 runs and emails; return the same 500 records on the next poll and verify no new hold or duplicate items; discard the remainder and verify they never run; send 150 instant webhooks in one minute and verify the same hold.

### TRIG-006 — Hosted inbound email addresses.

Each workflow can have its own inbound email address on the installation’s inbound domain (Cloudflare Email Routing to the Worker, or MX records the buyer points at Crank on a subdomain), so staff can forward or CC messages and vendors that can only email can start a run without mailbox OAuth. Addresses use a revocable, rotatable alias; an optional sender allowlist (addresses or domains) and SPF/DKIM/DMARC results gate admission; messages over the stated size limit (25 MB including attachments) are refused with a bounce. The parsed sender, recipients, subject, plain and HTML body, headers, forwarded-original fields and attachments (as file references under CONN-005 rules) are mappable. The Message-ID deduplicates within the TRIG-001 window, and each received message is visible in run history with its admission decision.

**Acceptance evidence:** Forward a vendor email with a PDF attachment to a workflow’s alias; extract the PO number from the body with a mapping or AI-001 node, attach the PDF to a HubSpot test record and verify one run and the record by readback; resend the same message and verify no second run; send from a non-allowlisted domain and an oversized message and verify both are refused and visible; revoke the alias and verify mail to it bounces.

### TRIG-007 — Feed and URL polling triggers.

Two built-in triggers start runs when something new appears at a URL with no app connector. The **feed trigger** watches one or several RSS 2.0, Atom or JSON Feed URLs and starts one run per new item, deduplicated by GUID/id, falling back to the link, then to a digest of title and date; a re-published or edited item with the same identity starts no run, and an item’s title, link, summary, content, author, categories, dates and enclosures are mappable, with the source feed named when several feeds share a trigger. The **URL poll trigger** sends a GET (with mapped headers and query parameters, and authentication from a stored connection under HTTP-002 rules) to any endpoint and reads a JSON array at a chosen path, or XML/HTML items selected by XPath; the builder chooses the dedup key path (`id` by default, or any path such as `data.ref`, or a digest of the whole item), and cursor, page or link-header pagination is followed. Both triggers use TRIG-004 intervals (1-minute floor) and latency reporting, TRIG-003 activation backfill (start from now, or process existing items) and TRIG-005 flood holds; requests obey SEC-002 egress rules, so private-network, link-local and metadata addresses and redirects into them are refused, response size and parse time are bounded, and fetch, parse and auth failures are visible on the trigger with EXEC-003 notices rather than silent skips.

**Acceptance evidence:** Publish a feed trigger on an RSS fixture at a 1-minute interval: verify the first activation follows the chosen TRIG-003 backfill option, two new items start exactly two runs, and a re-published item with the same GUID starts none; add an Atom and a JSON Feed URL to the same trigger and verify each new item names its source feed. Publish a URL poll trigger on a JSON endpoint whose records have no `id` field, deduplicated on `data.ref`, with a bearer connection and two pages: verify one run per new record across both pages and none on the next unchanged poll; poll an XML endpoint selected by XPath and verify one run per new item; point the trigger at a private-network address and at a URL that redirects to one and verify both are refused with no request sent past the refusal; return malformed JSON and verify a visible trigger error and owner notice.

## Operate recurring work

### EXEC-001 — Durable queues and execution checkpoints.

Activated workflows execute without a person per run under their grants. Durable queues show queued/running/waiting/dead-letter states, depth, oldest age, priority and owner. Atomic claims, per-step checkpoints, concurrency limits and cancellation survive executor loss and deployment; lease expiry records uncertainty before recovery. Pausing states whether it stops intake, dispatch or both, and cancellation identifies already-started effects.

**Acceptance evidence:** Queue a multi-step batch, stop the executor before and after a remote write, restart and inspect its checkpoints and oldest pending work; verify safe continuation, cancellation and no duplicate completed effect.

### EXEC-002 — Rate limits, backoff and exhaustion.

Connector-specific retry policy distinguishes proven-not-sent/transient failures from uncertain effects and permanent errors. Retries honor Retry-After, exponential backoff with jitter, provider/account rate limits, concurrency and attempt/time budgets. Exhausted work stays durable with its next owner action; throttling one account does not starve another.

**Acceptance evidence:** Run two accounts while one returns 429, then transient 503 and a permanent auth error; inspect spaced retry times, bounded attempts and a dead-letter outcome. Lose a mutating response and verify no blind retry before reconciliation.

### EXEC-003 — Error routes, alerts and escalation.

Builders choose per-step stop, continue, fallback business branch, compensate or resume behavior without hiding the original error. Error workflows deliver deduplicated email, Slack, Nook or Teams notices containing a safe run link, failure category, accountable owner and due action. Unresolved failures escalate on a business calendar; restored work resolves the alert and stops reminders. An **auto-pause policy**, on by default with owner-set thresholds, pauses a workflow whose failure rate passes a threshold over a window (default: at least 20 runs and 95 % failed within 24 hours); runs ended by a WORK-011 `stopped by search` halt or a filter do not count as failures. The pause stops dispatch, holds new trigger events as a TRIG-005 batch, notifies the workflow owner once with the failure categories, and on re-enable lets the owner run or discard the held events.

**Acceptance evidence:** Cause validation, credential and provider failures in a published workflow, exercise stop/continue/error branches, fail the alert provider and restore it, then resolve the business exception; inspect the durable error, alert delivery history and end of escalation. Fail 20 consecutive runs of one workflow and verify it auto-pauses, the owner is notified once, new trigger events are held with no effect, and re-enabling runs the selected held events once; verify 20 `stopped by search` halts do not pause a workflow.

### EXEC-004 — Replay any eligible step safely.

Operators retry/resume any eligible failed or incomplete step or selected batch items using retained versioned input and scoped authority. Preview shows what would run, prior effects and idempotency/reconciliation status. A corrected payload creates an attributable new revision; successful side effects are not silently repeated. Bulk replay has selection preview and limits.

**Acceptance evidence:** Fail the fourth step after three committed effects, restart, preview and resume that step, then replay selected failed items with corrected data; verify the first three effects persist once and the original and corrected inputs remain distinguishable.

### EXEC-005 — Searchable run history and debugging.

Run history retains workflow/version, trigger provenance, original inputs, each step’s mapped inputs/outputs, timings, decisions, grants, attempts and remote object IDs under redaction and retention rules. Builders search/filter by workflow, business key, date, status and error, paginate beyond the latest page and compare prior runs. Incomplete executions remain available; UI distinguishes queued, rejected, failed, uncertain and business-complete.

**Acceptance evidence:** Find an older failed invoice by customer key, inspect its exact mapping and decisions, compare a passing run and follow the remote record link; deny a reader access to a restricted payload while retaining safe status/timing.

### EXEC-006 — Effect reconciliation and compensation.

Every mutating step records intent, stable operation identity and known/unknown remote effects. Crank uses provider idempotency when supported, otherwise reads back by business key before retrying. Ambiguous matches stop for an accountable decision. WORK-011 find-or-create steps are mutating steps under this clause: a lost create is read back by its search key before any retry. Partial workflows can run explicitly authorized compensating actions; compensation has its own audit/outcome and never promises distributed exactly-once effects or reversal of an irreversible action.

**Acceptance evidence:** Lose the response after an invoice/refund is created, restart and reconcile it by provider readback; simulate zero, one and multiple matches, then fail a downstream step and inspect an authorized compensation without duplicating the initial write.

### EXEC-007 — Built-in email and SMS steps.

A send-email step works without connecting a mail provider: it sends from the installation’s own sending identity on a domain the owner verifies, through the installation’s configured transactional mail transport. Setup shows the exact SPF include, DKIM selector/key and DMARC records to publish and checks them before the first production send. The step supports mapped To/CC/BCC (bounded recipient count), reply-to, subject, plain and HTML body, and attachments by file reference; delivery, bounce and complaint events are recorded on the run, and hard-bounced or complained addresses are suppressed for later sends. A send-SMS step sends through the buyer’s Twilio connection (CONN-017) with its opt-out and registration rules; internal alerts to the workflow owner or team need no SMS account, through EXEC-007 email, Slack/Teams/Nook (CONN-004) or UX-001 mobile push. Both steps feed EXEC-003 notices and obey TEAM-004/TEAM-002 recipient and rate limits.

**Acceptance evidence:** Verify a test sending domain’s SPF, DKIM and DMARC records in setup, then send a mapped email with a PDF attachment from a published workflow with no mail connection and verify receipt, a passing DKIM signature and the delivered event on the run; send to a hard-bouncing address and verify the bounce is recorded and the next send is suppressed; attempt a production send before the records verify and see a named setup requirement; send an SMS step through a Twilio test number and see its delivery status; route a failure alert to the workflow owner with no Twilio connection and verify it arrives by email and mobile push.

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

Approval is a configurable step or policy boundary, not a requirement for every run. A published workflow needs no grant to run: publishing authorizes exactly its declared steps on its bound connections (TEAM-004). Standing grants are opt-in limits layered on top, and they are the authority for agents, MCP clients and other work that is not a fixed published graph; they name workflow/version, app/account, tools/actions, fields, recipients, amount/rate limits and expiry. Routine actions proceed unattended within the publish authority and any grant. High-impact or out-of-policy actions show the exact proposed effect to an authorized human; rejection sends nothing, a change to the proposed action made by anyone but the reviewer invalidates the decision, and timeout/escalation/delegation are durable. Reviewers may correct a proposal before approving and choose where rejection leads under TEAM-005. Revocation stops new authority immediately.

**Acceptance evidence:** Publish a routine lead workflow with no grant and observe unattended completion; give an agent task a limited grant and observe it complete within the grant; exceed a USD refund limit, inspect and reject one proposed action, approve another, then alter its body and revoke the grant mid-run, verifying reapproval/refusal and recorded in-flight uncertainty.

### TEAM-003 — Scoped preparation and trigger credentials.

Owners issue one-time agent preparation/read credentials and one-flow trigger credentials stored only as hashes. Preparation authority cannot activate, approve, replay, manage data or escalate its own permissions. Revocation and owner identity/version changes invalidate credentials at the HTTP and transaction boundaries. Future execution tools receive separate explicit grants under TEAM-002.

**Acceptance evidence:** Issue both credential kinds through Access, prepare/read with an agent, submit with a trigger, try every owner-only route and another flow, then revoke; inspect state and archive for absence of bearer values.

### TEAM-004 — Publishing authorizes a workflow’s declared steps.

When a member with publish rights publishes a workflow version, that version is authorized to run exactly its declared steps, with their mapped fields, on the connections bound to it, for every triggered run, with no expiry, no per-run approval and no separate grant to author. The authority is recorded on the version (publisher, time, steps, connections) and ends when the version is unpublished, replaced, or a bound connection is revoked. It does not extend to steps added later, other connections, or anything an AI/agent node decides beyond its declared tools (AI-001). Limits are opt-in: builders add approval steps (TEAM-005) or per-step caps, and owners may set optional workspace default caps (for example a USD refund ceiling or a maximum recipients per email) that pause only actions outside the cap for approval while in-cap actions continue unattended.

**Acceptance evidence:** Build or import 10 ordinary workflows (lead to CRM, Slack notice, Sheets row, draft invoice and similar), publish each, and observe their triggered runs complete unattended with no grant authoring, approval or other step beyond publish; verify each run’s audit names the publishing member and version. Add a workspace USD refund cap of $200 and trigger refunds of $150 and $350: verify only the $350 action pauses for approval while the $150 one completes. Add a step to a draft and verify the published version cannot run it until republished; revoke a bound connection and verify new runs pause with a reconnect notice.

### TEAM-005 — Approve with edits, rejection routes and reviewer notices.

An approval step can mark fields the reviewer may edit (for example refund amount or email body). The reviewer sees the exact proposed action, edits allowed fields and approves the edited version; the edit is recorded as an attributable revision beside the original, re-validated against the mapping schema and any TEAM-004/TEAM-002 caps, and only the approved revision is sent. Builders choose whether rejection stops the run or continues down a named rejection branch carrying the reviewer’s reason. Reviewers are notified by email, Slack, Microsoft Teams or Nook and mobile push, each with an authenticated link; reminders and timeout routes follow the business calendar.

**Acceptance evidence:** Publish a refund workflow with an approval step whose amount is editable and capped at $500; change a $120 proposed refund to $95 and approve, then verify the Stripe test-mode readback shows $95, the run history shows both values, the reviewer and the reason; try to approve an edited amount of $600 and verify refusal; reject a second refund on a workflow whose rejection branch emails the customer and verify the branch runs with no refund; reject a third on a stop-on-rejection workflow and verify nothing further runs; verify each reviewer received the Slack notice and the mobile push with a working authenticated link.

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

Import n8n workflow exports including graph/layout, triggers, mappings, branches, loops, subflows, delays, code and credential references into paused Crank drafts; search/lookup settings (Always Output Data, Return All, limits) map to WORK-011 and built-in transformation nodes to WORK-012. A preview maps every node/setting or names a blocking/manual conversion; it never silently drops work, imports authority or executes source expressions during parsing. Reviewed fingerprints, source identities, originals and a restartable journal support idempotent apply and safe undo of unused, unchanged imports.

**Acceptance evidence:** Preview a multi-step n8n export with a subflow and unsupported/custom node, resolve each named gap, apply the exact reviewed plan twice, reopen the journal after restart, bind fresh accounts and compare runs before cutover; undo an unused import and refuse undo after drift or use.

### MIG-002 — Zapier migration and cutover.

Buyers migrate Zaps, folders, schedules, paths, filters, every Formatter transform and option to its WORK-012 equivalent or a named manual conversion (including Line-itemizer), search steps with their “create if it doesn’t exist” fields, success-when-nothing-found and multiple-result settings (WORK-011), line-item mappings, loops, sub-Zaps, tables/forms, RSS and Webhooks Retrieve Poll triggers (TRIG-007), Digest steps with their name, frequency, release time, template and release-and-clear setting (WORK-010), and agent tool declarations. Crank accepts documented Zap JSON exports (available on Zapier Team and Enterprise, where non-admins export only their own Zaps; these prerequisites are explained) and uses a guided, itemized reconstruction for assets a source plan cannot export.

**No-export path (Free and Professional plans, or Zaps a member cannot export).** The defined input is the buyer’s Zap list (the Zaps page as a pasted list or screenshot: name, folder, apps, on/off, owner) plus, for each Zap, its step details as shown in the Zap editor (app, event, account, field mappings, filter/path rules, formatter settings, delay, schedule) and up to 10 recent Zap history runs with their step data, captured by the buyer from the editor and Zap history pages by paste or screenshots. An agent turns this into the itemized inventory, asks only for details it cannot read, rebuilds each Zap as a paused draft through AI-002, and runs the coverage report (CONN-001). Every Zap gets a mapped/manual/blocked disposition, fresh connection consent and a parity test that replays its captured history samples against the draft in test mode and compares mapped outputs.

**Hook cutover.** The inventory lists every Catch Hook / Catch Raw Hook URL and the sender it is pasted into (Typeform, Stripe, the website, vendor dashboards). Each sender gets a repoint checklist with its new Crank secret URL (TRIG-001) and the exact provider setting to change. Until Crank verifies the first real event received on a sender’s new URL, the source Zap stays the only writer and Crank receives in shadow mode, recording events without business writes. At cutover Crank becomes the writer from a recorded watermark, the buyer turns the source Zap off, and the overlap is reconciled by source event ID and destination readback (EXEC-006) so each event is written exactly once. Rollback restores the source Zap as sole writer from a new watermark without two active writers.

**Acceptance evidence:** Migrate an authorized multi-path Zap with formatter and delayed action from a Team-plan JSON export, account for every source setting, compare mapped results on authorized samples, stop the source at a watermark and switch triggers; roll back without two active writers or duplicate effects. Migrate a Zapier Professional account with no export file from its Zap list, editor details and Zap history captures: verify every Zap receives a disposition and a passing or explicitly failing parity test. Migrate an RSS → Slack Zap, a Retrieve Poll Zap deduplicated on a custom key, a weekly Digest Zap, a HubSpot deal → QuickBooks invoice Zap with a Line-itemizer step, a lead Zap whose HubSpot “Find contact” uses “create if it doesn’t exist” with a no-match path, and a Formatter Zap using split, lookup table, add/subtract time and perform math: verify each reports native with a passing parity test, including the digest’s name, schedule, release time and template and the invoice’s full line count. Cut over a Typeform → Catch Hook → HubSpot Zap while test leads are submitted continuously before, during and after the switch: verify the repoint checklist, Crank’s first-event verification, and that HubSpot holds exactly one contact per submitted lead with zero lost or duplicate leads.

### MIG-003 — Make blueprint migration.

Make scenarios/blueprints migrate modules, routers, filters, mappings, search modules with their limits and empty-result handling (WORK-011), built-in functions (WORK-012), iterators/aggregators, scheduling, error routes and dependencies into reviewed paused drafts with explicit unsupported dispositions. Connections/webhook URLs are rebound and data stores transferred under consent. Source operations/credits are not misrepresented as Crank cost; source history remains labeled historical.

**Acceptance evidence:** Import a Make blueprint with a router, iterator and error handler, inspect the complete mapping/exception report, rebind accounts and test both branches, then perform a watermark cutover and demonstrate unused-import undo.

### MIG-004 — Workato recipe and project migration.

Authorized Workato RLCM ZIP packages and accessible API definitions migrate recipes, recipe functions/callable recipes, custom connectors, lookup/data tables, shared schemas, message templates, API endpoints/collections, event topics, skills/genies/MCP declarations, properties, test cases, schedules, environments and error handling with source IDs/provenance and a complete dependency report. Dependency coverage includes workflow-app configuration where present; unavailable package assets receive explicit reconstruction tasks. Enterprise connection, on-prem gateway and role policies are deliberately rebound. Items unavailable to export receive a guided reconstruction and acceptance case, never a false compatibility claim.

**Acceptance evidence:** Preview an authorized Workato package with callable recipes and environment properties, account for dependencies and unsupported actions, compare sandbox outcomes, approve production account/gateway binding and cut over with a documented rollback checkpoint.

### MIG-005 — Gumloop and Pipedream move-in.

Crank accepts Pipedream project ZIP exports, including manifest dispositions, workflow/source/code definitions, configured properties, component versions and control-flow branches. It reports skipped/truncated workflows and explicitly requests excluded environment values, stores/files and private component source through secure setup. Gumloop flows/agents migrate through verified authorized exports/APIs where available and guided reconstruction otherwise; no portable Gumloop format is assumed. Model prompts, tool grants, branches, code dependencies, schedules and persisted source cursors receive explicit dispositions and tests. Imported prompts/tools cannot authorize themselves; no source secrets are copied into graphs or run history.

**Acceptance evidence:** For each product, inventory an authorized workflow containing an AI or code step, rebuild/import its complete graph, reauthorize tools, test both a safe and prohibited action and cut over its source cursor without losing or duplicating business events.

## AI steps and push further

### AI-001 — Inspectable AI and agent nodes.

Builders add LLM classification/extraction/generation and tool-using agent nodes using buyer-selected OpenAI, Anthropic, Google Gemini or authorized model endpoints, or with no model key at all through the installation’s default model (Cloudflare Workers AI on the installation’s own account, which the owner can replace with any configured endpoint), whose usage is metered in USD under OPS-002. Each node declares typed outputs, model/version, allowed data, tools, MCP servers, iteration/time/USD budgets and failure policy. Prompts and external documents are untrusted data; agents cannot acquire new scopes, change grants, send out-of-policy messages or hide tool calls. Invalid structured output is a visible step failure.

**Acceptance evidence:** Run an invoice-extraction node on the installation’s default model with no model key configured and see its USD usage in OPS-002, then run a tool-using agent on a buyer-selected endpoint against authorized documents and MCP tools; inspect model/tool/cost provenance, inject a hostile instruction and exceed a tool/spend limit, verifying schema failure or escalation without an unauthorized write.

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

The product exposes documented, versioned APIs, paginated reads, outgoing signed run/outcome webhooks, SDKs and an MCP server for authorized workflow/run/connection operations. Idempotent writes, scoped service accounts, event retries, subscription rotation and public error contracts support app and agent integrations. Remote clients have the same grants and audit trail as UI operators and cannot bypass approval. Connected-app actions exposed to the buyer’s own AI clients are covered by PLATFORM-002.

**Acceptance evidence:** Use an SDK and MCP client to create a draft, start granted work, inspect progress and subscribe to signed completion events; duplicate writes, rotate a webhook secret and attempt an out-of-grant action, verifying stable IDs, delivery history and denial.

### PLATFORM-002 — Connector actions as MCP tools for the buyer’s AI clients.

Owners create per-client MCP servers (for example one for a person’s Claude, ChatGPT, Cursor or VS Code) that expose selected connector actions and searches as typed tools, such as “Send Slack channel message”, “Create Google Calendar event” or “Find HubSpot contact”, on the same managed connections that workflows use. Each server has its own URL and authentication (OAuth 2.1 with the person’s Crank sign-in, or a revocable per-client secret), a chosen set of enabled tools, optional fixed or limited parameters, and a TEAM-002 grant setting recipients, amounts, rate limits and expiry. Every tool call appears in run history and the audit with the client, person, tool, inputs, outputs and remote object IDs; calls outside the enabled tools or the grant are refused and audited, and approval-required actions pause under TEAM-005 rather than executing.

**Acceptance evidence:** Create an MCP server with Slack “send channel message” and Google Calendar “create event” enabled; from an MCP client (Claude Desktop or the MCP Inspector) create a calendar event and post to a Slack channel, verifying both by provider readback and as audited calls in run history; call a HubSpot action that is not enabled and a Slack post to a channel outside the grant, verifying both are refused, audited and produce no provider effect; revoke the client and verify its next call fails.

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

Scope authority is the owner-approved Crank entry in the 16 October category list, supplemented by the category inventory and code audit. Product documentation used as capability/migration context: [Zapier app directory](https://zapier.com/apps), [Make webhook processing](https://help.make.com/webhooks), [Make error handling](https://help.make.com/error-handling), [Workato recipes](https://docs.workato.com/recipes.html), [n8n flow logic](https://docs.n8n.io/flow-logic/), [n8n export/import](https://docs.n8n.io/workflows/export-import/), [Gumloop agents](https://docs.gumloop.com/core-concepts/agents), and [Pipedream project export](https://pipedream.com/docs/workflows/export-workflows), [Workato RLCM packages](https://docs.workato.com/en/recipe-development-lifecycle), [Zapier JSON exports](https://help.zapier.com/hc/en-us/articles/8496308481933-Import-and-export-Zap-workflows-in-your-Team-or-Enterprise-account), [Make blueprints](https://help.make.com/blueprints), and Zapier’s own documentation for the day-one parity bar: [Webhooks by Zapier](https://zapier.com/apps/webhook/integrations), [API request actions](https://help.zapier.com/hc/en-us/articles/12899607716493-Set-up-an-API-request-action-Beta), [polling intervals](https://help.zapier.com/hc/en-us/articles/8495924437005), [flood protection](https://help.zapier.com/hc/en-us/articles/14230420160269-Choose-your-Zaps-flood-protection-limit), [Human in the Loop](https://help.zapier.com/hc/en-us/articles/38733184458765), [Email by Zapier](https://help.zapier.com/hc/en-us/articles/8496293328141), [Zapier MCP](https://docs.zapier.com/mcp/get-started/your-first-mcp-workflow), [Microsoft Excel](https://zapier.com/apps/excel/integrations), [SharePoint](https://zapier.com/apps/sharepoint/integrations), [RSS by Zapier](https://zapier.com/apps/rss/integrations), [polling webhooks (Retrieve Poll)](https://help.zapier.com/hc/en-us/articles/8496274719757), [Digest by Zapier](https://zapier.com/apps/digest/integrations), [line items in Zaps](https://help.zapier.com/hc/en-us/articles/8496277737997), [Zapier search steps](https://zapier.com/blog/zapier-search-step-guide/), [Formatter by Zapier](https://zapier.com/apps/formatter/integrations), [lookup tables](https://help.zapier.com/hc/en-us/articles/8496305146765) and [Delay by Zapier](https://zapier.com/apps/delay/integrations). These are design inputs, not assertions that every vendor supports every target clause or export path. Source access and migration restrictions must be checked for the buyer’s edition; unavailable exports require itemized reconstruction, not silent scope reduction.

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
| WORK-009 | missing | — |
| WORK-010 | missing | — |
| WORK-011 | missing | — |
| WORK-012 | missing | — |
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
| CONN-012 | missing | — |
| CONN-013 | missing | — |
| CONN-014 | missing | — |
| CONN-015 | missing | — |
| CONN-016 | missing | — |
| CONN-017 | missing | — |
| CONN-018 | missing | — |
| HTTP-001 | done | `src/crank/flows.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `tests/crank.test.mjs` |
| HTTP-002 | missing | — |
| TRIG-001 | partial | `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/tokens.ts`; `tests/crank.test.mjs` — Scoped bearer trigger credentials, the `{event_id,input}` envelope with equal-payload dedup, changed-payload conflict, erased-event fence and server-side revocation ship; secret URLs, signature verification, non-JSON bodies, raw headers/query, builder-chosen dedup keys/digest windows and configurable responses do not. |
| TRIG-002 | partial | `src/crank/ui/flows.ts`; `src/crank/runs.ts` — On-demand preparation works; there is no schedule engine or historical run. |
| TRIG-003 | missing | — |
| TRIG-004 | missing | — |
| TRIG-005 | missing | — |
| TRIG-006 | missing | — |
| TRIG-007 | missing | — |
| EXEC-001 | partial | `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/flows.ts`; `tests/crank.test.mjs` — Pending runs, conditional delivery claims and interrupted-attempt state exist; background queue processing and multi-step checkpoints do not. |
| EXEC-002 | missing | — |
| EXEC-003 | partial | `src/crank/delivery.ts`; `src/crank/ui/run.ts` — Failures are recorded and displayed; custom error workflows, notifications and escalation are missing. |
| EXEC-004 | partial | `src/crank/delivery.ts`; `tests/crank.test.mjs` — Only one manual replay of the single HTTP action exists. |
| EXEC-005 | partial | `src/crank/api.ts`; `src/crank/runs.ts`; `src/crank/delivery.ts`; `src/crank/ui/run.ts`; `tests/crank.test.mjs` — Exact single-action history and incomplete attempts persist; the state route returns the latest 200 runs without general search, pagination or step history. |
| EXEC-006 | partial | `src/crank/delivery.ts`; `tests/crank.test.mjs` — The compliant HTTP receiver returns an effect ID/key and one replay is safe under that receiver contract; general provider readback and compensation are absent. |
| EXEC-007 | missing | — |
| OPS-001 | missing | — |
| OPS-002 | missing | — |
| TEAM-001 | partial | `src/crank/access.ts`; `src/crank/ui/settings.ts`; `tests/crank.test.mjs` — Owner/admin/member roles and deactivation exist; workspace sharing scopes, approver/operator roles and team connection ownership do not. |
| TEAM-002 | partial | `src/crank/delivery.ts`; `src/crank/access.ts`; `tests/crank.test.mjs` — Exact owner approval/rejection ships; optional approval nodes and standing grants are absent. |
| TEAM-003 | done | `src/crank/tokens.ts`; `src/crank/access.ts`; `src/crank/api.ts`; `tests/crank.test.mjs` |
| TEAM-004 | missing | — |
| TEAM-005 | partial | `src/crank/delivery.ts`; `tests/crank.test.mjs` — Exact owner approval or rejection of the immutable proposed action ships, and rejection records the decision and stops the run with no delivery; reviewer edits, editable-field caps, rejection branches and reviewer notifications do not. |
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
| PLATFORM-002 | missing | — |
| BASE-001 | partial | `AGENTS.md`; `SEED-COMMAND-CONTRACT.md`; `src/crank/archive-policy.mjs`; `src/crank/delivery.ts`; `tests/crank.test.mjs` — Native owned workflow/archives exist; complete egress independence and expanded provider/data-lifecycle guarantees are not established. |
| BASE-002 | done | `src/site/pages.tsx`; `src/site/docs/build/site.ts`; `tests/site.test.mjs`; `tests/runtime.mjs` |
| BASE-003 | partial | `src/base/deployment-health.ts`; `src/crank/delivery.ts`; `src/crank/api.ts`; `tests/runtime.mjs`; `tests/crank.test.mjs` — Basic runtime health and read-triggered delivery-lease expiry exist; the complete future execution classes and operational guarantees are not proven. |
| BOUND-001 | missing | — |

**78 clauses: 3 done, 25 partial, 50 missing.**
