# Crank HTTP and agent contract

All paths begin `/api/crank`. GET requests need a current session or agent
credential; trigger credentials cannot read. Cookie POSTs require the exact
configured Origin. Bearer requests use `Authorization: Bearer <credential>`.
Bodies are JSON objects. Core requests are limited to 64 KiB. Import requests
allow a 128 KiB source in a 256 KiB JSON envelope. Errors are JSON `{error}`.

| Method and path | Role | Meaning |
| --- | --- | --- |
| GET `/state` | Person or agent | Flows, last 200 runs, matching decisions and attempts; owners also see token metadata |
| GET `/flows/:id`, `/runs/:id` | Person or agent | Exact record |
| POST `/flows` | Owner, admin, agent | Draft with `name,source_app,destination_app,target_url` |
| POST `/flows/:id/activate`, `/pause` | Native/dev owner | Start/stop admitting new events |
| POST `/flows/:id/runs` | Owner, admin, agent | Prepare `{event_id,input}` for approval |
| POST `/flows/:id/trigger` | Scoped trigger key | Same event envelope; exactly one authorized flow |
| POST `/runs/:id/approve`, `/reject` | Native/dev owner | Immutable recorded decision; approve makes first delivery attempt |
| POST `/runs/:id/replay` | Native/dev owner | One further delivery for a failed/expired attempt, same bytes and key |
| POST `/tokens` | Native/dev owner | `{label,scope:"agent"}` or `{label,scope:"trigger",flow_id}`; one-time token |
| POST `/tokens/:id/revoke` | Native/dev owner | Immediately revoke |
| GET `/imports` | Native/dev owner | Import history: door plans with approval captions, then jobs from the earlier importer |
| POST `/imports/:id/undo` | Native/dev owner | Undo a job from the earlier importer, refusing target drift |
| POST `/data/export` | Native/dev owner | Download installation archive |
| GET `/data/transfers` | Native/dev owner | Latest 30 archive transfer IDs, kinds, phases and retained part counts |
| POST `/data/transfers` | Native/dev owner | Create a resumable `{kind:"export"}` snapshot |
| POST `/data/transfers/:id/advance` | Native/dev owner | Build the next `maxParts` (1–10); repeat after a restart on the same ID |
| GET `/data/transfers/:id/download` | Native/dev owner | Download a complete transfer; repeat returns identical bytes, receipt remains unverified |
| POST `/data/transfers/:id/abort` | Native/dev owner | Abort a retained transfer; records the owner decision in the audit |
| POST `/data/restore` | Native/dev owner | `{archive,confirm:"RESTORE",journal?}`; empty destination only |
| POST `/data/erase` | Native/dev owner | `{run_id,confirm:"ERASE"}` for a paused approval flow, or `{workflow_run_id,confirm:"ERASE"}` for a paused multi-step workflow; terminal run only |
| GET `/data/flows` | Native/dev owner | Read-only current destination/data-category inventory: recipient, purpose, field categories, region/retention uncertainty and credential kinds; no credential/graph values or provider requests |
| GET `/data/retention` | Native/dev owner | Retention periods, disclosed defaults and automatic cleanup, legal holds, the current dry run and sensitive-data attestations |
| POST `/data/retention/preview` | Native/dev owner | `{payload_days,attachment_days,history_days,at?}` (whole days 1–3650 or empty); returns what would expire and what is kept with reasons, plus `digest`; deletes nothing |
| POST `/data/retention` | Native/dev owner | The same periods with the current dry run's `digest` |
| POST `/data/holds` | Native/dev owner | `{kind:"subject",subject,reason}` or `{kind:"workflow",workflow_id,reason}`; held runs never expire and refuse erasure |
| POST `/data/holds/:id/release` | Native/dev owner | Releases a hold, keeping its record and digest |
| POST `/data/classes` | Native/dev owner | `{workflow_id,data_class}`: none, customer, financial or health |
| POST `/data/attestations` | Native/dev owner | `{data_class,agreements,data_location,confirm:"ATTEST"}`; owner-attested, never verified by Crank |
| POST `/data/attestations/:class/revoke` | Native/dev owner | Withdraws it and pauses that class's published workflows |

POSTs without other fields use `{}`. A failed HTTP attempt records a safe status
code, uncertainty and timing, never arbitrary destination response content.
An interrupted delivery lease becomes failed when state is next read; it never
automatically retries. Rejected and successful runs cannot replay. A replay
of an expired first attempt still uses the same receiver idempotency key.

Pause stops new admission. It does not cancel an already-approved network request.
Pending runs may still be deliberately approved or rejected by the owner.
Erasure does not undo destination effects or erase the source app's records.
Run IDs, event digests and value-free deletion records remain for deduplication
and restoration fences. Data archives contain sensitive workflow inputs.

## Import door

Imports use Base's shared door at `/api/operator/import/{uploads,plan,apply,status,reconcile,undo}` (POST JSON, `X-Import-Source: n8n`, the owner's native session and exact `Origin`). Bodies and results are Base's: see `src/modules/import-kit/src/door/README.md` and [Move n8n workflows](IMPORTING.md). GET/POST `/api/operator/import-settings` (`{enabled, revokedKids?}`, owner only) turns Run Edit Run Business grants at `/api/rer/import/*` on or off; those answer 404 without RER's owner-claim key ring.

## Workflows

Published workflows run unattended: publishing a version authorizes exactly its
declared steps on its bound connections, recorded on the version (publisher,
time, steps, connections). Approval steps and USD/recipient caps are opt-in. Drafts run
nothing. The per-minute Cron pass releases delays and queues, polls feeds and
URLs, admits schedules and runs queued work, so restarts resume from durable state.
A graph's `settings` set its `timezone`, `burst_threshold` (1 to 10,000, default
100) and `waiting_runs` policy: `continue`, `cancel_on_pause` or `cancel_on_new_version`.

| Method and path | Role | Meaning |
| --- | --- | --- |
| GET/POST `/workflows` | Person or agent / owner, admin, agent | List (`q`, `folder`) or create a draft `{name,graph,description?,folder?}` |
| GET `/workflows/:id` | Person or agent | Draft, versions with their recorded authority, webhook URLs (no secrets) |
| POST `/workflows/:id/draft`, `/validate`, `/duplicate` | Owner, admin, agent | Edit or check a draft; validation names the step |
| POST `/workflows/:id/publish`, `/pause`, `/resume` | Native/dev owner | Publish a new immutable version; pausing holds new events |
| POST `/workflows/:id/run` | Owner, admin, agent | On-demand run `{input}` of the published version |
| GET `/workflow-runs/:id/replay` | Native/dev owner | Digest-bound failed-step preview, retained input and prior effects; `linked_repair` mode for succeeded continue-on-error items |
| POST `/workflow-runs/:id/replay` | Native/dev owner | Selected `paths` (1–100), preview `digest`, optional input `corrections` keyed by path; returns resumed run or linked repair |
| GET `/workflows/:id/compare` | Signed-in reader | Exact graphs and JSON Pointer changes; `from`/`to` select `published`, `draft`, or a retained version number |
| GET `/workflows/:id/drafts/:draftId` | Signed-in reader | Immutable saved draft graph, metadata, author, time and base publication |
| POST `/workflows/:id/test` | Native/dev owner or scoped admin/builder | Freeze draft and sample as a test run; explicitly map every connection with `bindings`; production writes wait for exact live confirmation |
| POST `/connections/:id/purpose` | Native/dev owner | Audited owner declaration of `purpose: test` or `production`; not provider verification |
| POST `/workflows/:id/preview` | Owner, admin, agent | Run filters, paths and transforms on a manual sample; no effects |
| POST `/workflows/:id/hooks` | Native/dev owner | New secret webhook URL, shown once; `{rotate:HOOK_ID,overlap_minutes}` rotates |
| GET `/workflows/:id/trigger` | Person or agent | Poll state and log, schedule plan (`from`, `count`) and occurrences |
| GET `/workflow-runs` | Person or agent | Search `workflow,status,business_key,q,from,to,error`; page with `before=next` |
| GET `/workflow-runs/:id` | Person or agent | Steps with mapped inputs, outputs and rule traces; waits and decisions |
| POST `/workflow-runs/:id/approve`, `/reject` | Native/dev owner | `{path,digest,edits?,reason?}` for a waiting approval |
| POST `/workflow-runs/:id/resume`, `/cancel` | Native/dev owner | Resume a paused run from its checkpoint, or cancel it |
| GET `/holds/:id`; POST `/holds/:id/release`, `/discard` | Owner for decisions | Flood-held events: `{items:[keys]}` or `{all:true}` |
| POST `/workflows/:id/historical` | Native/dev owner | Snapshot a source and preview selected count, samples and USD estimate; no workflow effects |
| GET `/historical/:id` | Native/dev owner | Reviewed snapshot, remaining items and real per-item run outcomes |
| POST `/historical/:id/run` | Native/dev owner | `{fingerprint,items:[sourceIds]}` or `{fingerprint,all:true}`; once per source ID in this batch |
| GET `/queues` | Person or agent | Delay queues: depth, oldest item, next release |
| GET/POST `/connections`; POST `/connections/:id/rotate`, `/revoke`, `/test` | Native/dev owner for writes | Credentials are encrypted and never returned |
| POST `/oauth/apps/:app`, `/oauth/start`; GET `/oauth/callback` | Native/dev owner | Your provider OAuth app, consent start and redirect |
| GET `/catalog`; POST `/coverage` | Person or agent | Native operations; classify `{items}`, `{n8n}` or `{make}` inventories |
| GET/POST `/settings` | Owner for writes | Timezone, category USD/recipient caps, auto-pause policy |
| GET `/reports/latency`, `/audit`, `/notices` | Person or agent; audit and notices owner | Trigger latency, poll lag and causes; append-only audit; owner notices |

Inbound doors need no session and admit events only: `/hooks/w/SECRET` (POST,
PUT, GET; JSON, form, multipart, XML or raw; optional Stripe, Shopify, GitHub,
Calendly, Typeform, Twilio or custom HMAC signatures), `/hooks/resume/TOKEN`
for callback waits, and `/hooks/slack/CONNECTION_ID` for signed Slack events.

URL polling commits a successful watermark only after a complete page set. Cursor and Link-header sources must stop advertising a next page; page-number sources must return an empty terminal page, included in `pagination.max_pages` (1 to 10). Page numbers begin at `pagination.start` (default 1). Repeated pages, invalid cursors, exhausted page bounds and provider failures admit no items from that attempt, retain the previous successful watermark and produce a visible poll error with an owner notice. Narrow the query or increase the bound before retrying an oversized source. Overlapping source IDs are admitted once. These URL-source guarantees do not supply native email or CRM polling or renewable subscriptions.

Signed Slack events commit their source identity together with a queued run or held item. A failed transaction leaves no deduplication claim, so the provider can retry after an outage. Concurrent deliveries and older distinct source events retain one run per event identity; new receipts bind the source identity to canonical contents and refuse conflicting retries. Pre-upgrade event identities remain duplicate fences without claiming a historical contents comparison. Admission rechecks the published version, both managed connections and the signing credential revision. Paused events remain held with their source times. Existing run history and inactive archive rules apply.

## Historical runs (TRIG-002)

Publish a graph whose mappings use the source record at `trigger.<field>`.
POST `/workflows/:id/historical` with a real JSON source, a filter and/or
`date_range`, and explicit cost assumptions. For example:

```json
{
  "source": {"url":"https://crm.example/deals","connection_id":"YOUR_CONNECTION","items_path":"results","id_path":"id","pagination":{"kind":"cursor","cursor_path":"next","param":"cursor"}},
  "filter": [[{"field":"trigger.status","op":"text.equals","value":"closed"}]],
  "date_range": {"field":"closed_at","from":"2026-07-01","to":"2026-09-30"},
  "cost": {"components":[
    {"kind":"orchestration","usd_per_run":"0.000125","assumption":"Your infrastructure estimate per execution"},
    {"kind":"connectors","usd_per_run":"0.025","assumption":"Your estimate of the declared connector requests"},
    {"kind":"models","usd_per_run":"0","assumption":"No model step in this graph"},
    {"kind":"executors","usd_per_run":"0","assumption":"No external executor in this graph"}
  ]}
}
```

These are illustrative owner estimates, never provider-verified prices. All
four components and their assumptions are required, including quoted zeros.
USD totals sum the exact components, multiply by selected count, then round
half-up to cents. Filter rules use WORK-013 semantics and `timezone` (workspace
default), evaluated at the stored preview clock. Date-range bounds are inclusive
UTC instants; a date-only end includes its entire UTC day. Source dates without
a zone are read in UTC. Unparseable dates/type mismatches fail the preview.

Read the returned `count`, `sample`, `cost`, `fingerprint` and item IDs. Send
`{ "fingerprint":"RETURNED_FINGERPRINT", "items":["deal-1","deal-2"] }` to
`/historical/:id/run`, then `{ "fingerprint":"RETURNED_FINGERPRINT", "all":true }`
for the remainder. The selected source records are frozen; later source edits
cannot change an approved snapshot. Repeat or concurrent releases create one
run per source ID per batch. A new preview creates a new batch deliberately.
Each item links to a real run and its outcome, including failed/waiting work.
The reviewed workflow version must still be current and enabled. Replaced
versions require a new preview. Existing optional approval/cap steps still apply.

Sources support public HTTP(S) or stored connection auth, JSON lists at the
root or `items_path`, and cursor/page/Link pagination. Redirects, foreign-origin
pagination, inline credentials, conflicting duplicate IDs, missing IDs and
incomplete pagination fail visibly. Identical duplicate IDs collapse. Integer
IDs convert to decimal strings. No pagination means the supplied URL is a
complete-list door. Page pagination needs an empty terminal page; cursor/Link
pagination needs an absent next marker. Bounds are 1,000 source records including
page overlaps, 50 pages, 2 MiB per response and 4 MiB retained payload. Narrow
the source query when a bound is reached; Crank never previews a truncated count.
Snapshots are exported with domain data and do not start work on restore;
an owner must deliberately re-enable restored workflows and reconnect their
connections. Replacing a workflow version requires a fresh preview.

### Held bursts and USD estimates

`GET /api/crank/holds/:id` returns source, counts, retained items and `cost`.
Before releasing, an owner posts `{cost:{components:[...]}}` to
`/api/crank/holds/:id/estimate`. Supply exactly one `orchestration`, `connectors`,
`models` and `executors` component, each with decimal-string `usd_per_run` and
nonempty `assumption`. Explicit zero is allowed; absent prices never imply zero.
The response labels this an owner estimate, not provider-verified pricing, and
returns `estimate_fingerprint`.

Post `{all:true,estimate_fingerprint}` or `{items:[SOURCE_KEY],estimate_fingerprint}`
to `/api/crank/holds/:id/release`. New items, changed payloads, partial decisions
or replaced versions invalidate the estimate. The response includes `estimate`
for the selected count, `selected_count`, runs and the updated hold. Components
sum exactly and round half-up to cents after multiplication, as in historical
previews. `/discard` needs only `all:true` or selected `items`; no quote is needed.

### Publish authority and queue parameters

POST `/workflows/:id/unpublish` uses the existing owner publish authority. It retires the version, removes trigger schedules, cancels queued/waiting work and retains the draft and history. Running effects already started remain recorded; later dispatch stops. Republishing never revives withdrawn work.

Pause stops new/queued/running next-step dispatch. Only waits already present at pause continue when their frozen policy is `continue` (default) or `cancel_on_new_version`. Replacement allows only existing waits with `continue`. Live connection checks remain at every step/attempt; unpublish permits no exception.

Workspace caps are `{category,max_usd?,max_recipients?}`. Steps use `{cap:{max_usd?,amount?,max_recipients?,recipients?}}`, with mapped `amount`/`recipients`, and name their workspace `category`. The stricter bound applies inclusively. A recipient mapping resolves to one address or an array, counts duplicates and never parses delimiters; HTTP builders declare the same destination mapping used in the request. Excess actions wait for an exact-input decision; rejection sends nothing.

Graph settings `priority` is an integer -100..100 (default 0), higher first, then receipt time/run ID. `max_concurrency` is 1..100 (default 1). Each admission freezes its version parameters; each atomic claim counts all unexpired running leases across that workflow’s versions. Waiting/approval/paused runs free a slot. A saturated workflow does not hide other queue candidates.

### Live execution queue and cancellation (EXEC-001)

The existing owner-only `GET /reports/operations` includes `execution_queue` with
`states` (queued, running, waiting, dead_letter), complete depths and oldest
receipt/age, plus the first 100 `runs` ordered by published priority descending,
receipt and run ID. Each row names the owner, priority, concurrency limit,
lease and completed/uncertain checkpoint counts. Workflow/team filters apply;
historical date bounds do not hide live work. Terminal failed runs are retained
dead letters, including uncertain writes, and are never automatically redriven.

`POST /workflow-runs/:id/cancel` also accepts a running run. It fences its lease
and later dispatch; a started write may still finish remotely and is retained
as an uncertain checkpoint. Completed effects are never undone. Cron records
uncertainty before recovering an expired execution lease.

### Connector retry timing (EXEC-002)

HTTP, native Slack workflow requests and public file downloads share retained
attempts, connection/origin admission and durable retry waits. Attempts expose
`retry_number`, the original `budget_started_at`, `slice_started_at`, `retry_at`,
`retry_reason`, `retry_parked_at`, `retry_released_at` and `retry_resumed_at`.
The earliest permitted retry, Cron release and actual execution resume are
separate instants; none claims a provider effect.

Safe reads on newly published/tested versions default to 6 attempts with 60,000 ms × 2^(completed attempts − 1) plus uniform
0–250 ms jitter. A step's `retry_policy` can set `read_attempts` (1–10) and
`base_delay_ms` (1–3,600,000). The unconfigured default provides 1/2/4/8/16-minute outage backoff. Existing immutable versions retain their reviewed defaults; rollback retains the restored version’s policy. `version.retry_policy` exposes that frozen policy. Exponential waits saturate at one
hour. Retry-After delta seconds or HTTP dates are lower bounds; a provider wait
beyond an hour durably exhausts instead of sending early. 429/502/503/504 and
transient network failures retry safe reads; auth errors stop. Writes retry only
a lost response under an explicitly declared provider idempotency guarantee
(at most 2 attempts); Slack writes have one attempt. A lost write without that
guarantee resumes its declared readback or remains uncertain, never blind replay.

A wait over 30 seconds parks the step/run, preserving input, operation identity,
version and attempt budget, and frees its workflow execution slot. Cron releases
it on the first minute tick at or after due (up to one minute rounding, plus any
workflow-capacity delay), with current connection and publish-authority checks.
Shorter waits sleep in-request. Each request has 60 seconds of active wall-clock
time per execution slice; a recorded park starts a new slice on actual resume.
A restart without a park preserves that slice's deadline. Parked intervals,
including rounding/capacity delay, are bounded to one hour each and summed
across the run's requests with a 24-hour total bound. Crossing either bound
leaves a durable dead letter naming the exhausted budget and next owner action.

An unfinished step privately checkpoints completed responses to preserve earlier
pages and the readback phase. Credential headers and credential query URLs are
excluded; bodies keep the existing HTTP/file/Slack byte bounds. These records
are portable under DATA-001, restore inactive, participate in DATA-002 subject
review and disappear atomically when the step/run settles or is erased.

The catalog exposes `retry_policy` and `request_limit`: retries/pages/readback
share 100 requests per 10 seconds and concurrency 4 per connection; unconnected
calls share an origin bucket. A full window after response completion prevents
slow-call bursts. CONN-002 must share buckets by provider-verified account ID
before that identity capability ships. The real-time multi-minute journey is
`node --test tests/retry-backoff-journey.mjs` (nightly/manual CI).


### Owner usage and budgets (OPS-002)

Before `POST workflows/:id/publish` or `POST flows/:id/activate`, quote the exact
current graph with `POST workflows/:id/estimate` (or `flows/:id/estimate`):
`{"cost":{"components":[{"kind":"orchestration","usd_per_run":"0.002","assumption":"Owner infrastructure estimate"},{"kind":"connectors","usd_per_run":"0","assumption":"No billed connector use expected"},{"kind":"models","usd_per_run":"0","assumption":"No model step"},{"kind":"executors","usd_per_run":"0","assumption":"No external executor"}]}}`.
The owner must provide all four assumptions and amounts, including explicit zero.
GET the same path with `?count=25` to see the exact batch estimate. A changed graph
invalidates the quote; retained version GET responses include their immutable
estimate, reused on rollback. Quotes are owner estimates, not provider verification.

`GET /api/crank/reports/usage?month=2026-10&workflow=ID&team=NAME&count=25`
separates estimates/forecasts, observed production steps/requests and source-reported
charges. Each filter is optional. Months are UTC calendar months. Report absence is
unknown, never a zero-charge claim. An executing endpoint can report a nonnegative
USD decimal in `x-crank-usage-usd`; its origin/header is retained as self-reported
provenance. Invalid reports remain visible as unknown without discarding execution.

Owner-only `POST /api/crank/usage/budgets` takes `scope` (`workspace`, `workflow`,
`team`), `workflow_id` or `team` for the selected scope, and `monthly_usd` as an
exact decimal string (null removes a limit). An installation workspace is the
account scope; team assignments are managed by the existing operations settings.
`POST /api/crank/usage/allowance` adds `usd` and an attributable `reason` to one
scope for the current UTC month. Each mutation is audited. Neither action releases
held work. At 80%/100%, durable owner notices show delivery state. Admission reserves
its owner estimate atomically against all applicable limits; reported charges
replace a lower reservation without double debit. Extra reported spend stops the
next request at an exhausted limit until funded.

At exhaustion the event remains in the ordinary TRIG-005 hold. A held workflow
manual start responds with `held:true,hold_id`; public webhook holds also name
`hold_id`. A legacy prepared/triggered approval responds HTTP 202 with
`held:true,holdId`. Review `/app/holds/ID` or GET `/api/crank/holds/ID`, quote its
four components with POST `/estimate`, then POST `/release` with the returned
`estimate_fingerprint` and `all:true` or selected `items`. Release rechecks the
current budget and complete reviewed batch. A legacy release creates pending
approval runs and performs no external delivery. Budget holds never auto-expire.
`settings.max_steps` bounds distinct expanded execution paths per run (1–10,000;
default 10,000), retained across restarts. Production budgets exclude draft tests.

## Dependency health and recovery

`GET /health` is public and returns 503 with safe missing binding names or an
unavailable storage state when required auth/executor storage fails its two-second
probe. It never returns configuration values or database exception text. Optional
provider errors appear separately in the owner-only Operations report.

The report's `recovery` field shows timestamped Cron completion observations,
allocated database bytes (when reported by D1), retained operation/transfer status,
observed poll failures and archive generation. Provider capacity, current executor
availability and off-installation backup receipt remain unestablished. Attempts
without a terminal record after fifteen minutes become `interrupted` on the next
Cron/report read; this never authorizes an uncertain remote write to run again.

## Retained exception skills (AGENT-003)

The owner opens `/app/skills`, selects retained production run IDs from one
published workflow version, a step ID and a text input field (for example
`body.address`). Include corrected failures and successful counterexamples.
Crank groups corrections by error category/status/code and searches compositions
of existing pure text transforms against the original and corrected values.
Every chosen case must match exactly; an unsupported correction yields an
explicit refusal. No model, provider call, retry or synthetic result is involved.

`POST /api/crank/skills` takes `workflow_id`, `step_id`, `field` and `run_ids`.
`GET /api/crank/skills` lists proposals; `GET /api/crank/skills/:id` rechecks the
retained cases, shows the reusable mapping expression, and returns its digest.
`POST /api/crank/skills/:id/approve` with that digest stages the graph in a draft.
It refuses changed samples, a changed source version, and unrelated draft edits.
The owner reviews and publishes through the normal workflow editor. Approval
alone sends nothing. The version, account bindings, input/file safety, cost
checks and all normal runtime limits remain those of the existing workflow.

The proposal retains only run references and built-in operations. Selected
sample values remain in normal sealed run/replay history under the owner's
retention controls; expiry or erasure makes them unavailable to the proposal.
No extra sample copy, new outgoing recipient or installation credential is
created. Proposals and case references travel in the versioned archive; restored
workflows remain paused and require normal receiving-owner adoption. Proposed
operations never confer execution authority.

The detail screen compares selected baseline exceptions with production run
failures for the deployed graph, and counts outcomes independently read back
and attested through the existing Operations obligations. HTTP success alone
remains unverified. Measurements survive rollback; the owner can restore the
source version using the existing rollback door, while original failure and
correction history remains intact. The expression can be reused in other draft
mappings, subject to their normal review and publish controls.

## Standing grants and agent tasks (TEAM-002)

Preparation/trigger credentials keep their existing permissions. A native owner
uses Access or `POST /grants` to issue `{label,workflow_id,version_id,expires_at,policy}`
for the current published version; `expires_at` is an ISO UTC timestamp ending in
Z. `GET /grants` returns metadata only; `POST /grants/:id/revoke` stops new dispatch
and marks already-started writes uncertain. The separate execution credential is
shown once; only its hash is held. Agents cannot issue, extend or revoke grants.

`policy.rules` has one entry per existing leaf tool:
`{step_id,type,connection_id,app,fields,recipients,max_per_minute}`. Connection/app
must exactly match the published tool (null/`none` without a connection). `fields`
names permitted top-level inputs and their JSON subtrees. Optional
`recipient_field` and `amount_field` are exact dotted input paths, for example
`body.to` and `body.amount`; `recipients` lists exact values, and `max_usd` is a
nonnegative decimal string with an inclusive limit and no rounding. Every
recipient in an array must be listed. The per-tool rate window is the preceding
60 seconds, atomically admitted once per invocation; retries retain admission.
`policy.approval` supplies positive `timeout_seconds`, `delegate_ids` and
`escalate_to`, chosen by the owner from active native people. Timeout opens a
durable internal Approvals task; it never approves or claims an external notice.

With the execution bearer, `POST /agent-tasks` takes
`{task_id,actions:[{step_id,input}]}`. It selects and orders a subset of the owner's
tools, at most once each. Inputs are literal JSON; method, URL, headers,
connections and transport/retry/readback settings cannot change. The task keeps
an immutable version with value references; supplied values remain in the
sealable, erasable run payload. It conservatively reserves the source workflow's
full owner-estimated cost, even for a subset. `GET /agent-tasks/:runId` reads only
that credential's tasks. Other product doors refuse the execution credential.

Out-of-policy effects wait for exact review at the existing workflow-run
approve/reject doors. The owner or selected native reviewer decides; an
unassigned person cannot. `defer:true` records a grant-task approval for the next
Cron pass. Before dispatch, an agent can POST
`/agent-tasks/:runId/proposal` with `{path,digest,input}` to revise a held effect.
Its old approval is spent, its input revision is retained, and fresh review is
required. A stale digest refuses the decision. Started effects cannot be revised.
Revocation, expiry, owner identity/version changes or publication replacement
stop authority at subsequent steps and physical requests. Check history and
reconcile an already-started write; revocation cannot undo a remote effect.


## Version 1, SDK and MCP (PLATFORM-001)

The workflow and flow routes above also accept `/api/crank/v1` instead of
`/api/crank`. Existing routes remain available. V1 responses carry
`Crank-API-Version: 1`. Error JSON preserves `error` (a safe message) and adds
`api_version: "1"`, numeric `status` and stable `code`: `invalid_request`
(400/405/406/413/415), `unauthenticated` (401), `forbidden` (403), `not_found`
(404), `conflict` (409), `invalid_operation` (422), `unavailable` (502/503),
or `operation_failed` for another HTTP error. A workflow validation failure
can also report `ok:false` and an engine `category`. Never infer success from
an unavailable response: inspect retained progress before repeating a write.
Archive, import and authentication doors keep their existing URLs.

The dependency-free [JavaScript SDK](../sdk/README.md) supports native session
cookies (Node), same-origin browser sessions, preparation bearer credentials
and separate execution bearer credentials. It creates, saves, reads, validates
and publishes drafts, reads run pages and starts/inspects granted tasks. It
never retries a write automatically. Publish still requires a native owner and
the existing reviewed USD estimate; execution still requires an owner-issued
grant. The SDK and MCP add no external recipient or execution class: the same
published destinations, input/file limits, audit, sealing, erasure, recovery
and inactive archive rules apply.

Workflow create, draft save, duplication, publication, rollback and granted task starts support `Idempotency-Key`. The optional
header is 1–200 visible ASCII characters, scoped to the current credential
(session or token), operation and target workflow. Canonical JSON comparison
ignores object-key order; the same key/body yields one workflow/save, snapshot
and audit entry even concurrently or after restart. A changed body under that
key returns 409 `conflict`. A response includes
`idempotency:{replayed,workflow_id,draft_id}`. The original draft receipt remains
stable while the workflow representation reflects current edits; a replay
cannot revert newer edits. A new session/token is a separate key namespace.
Receipts retain only hashes and IDs, are installation-local, do not travel in
archives, and are removed during operator erasure. Other write endpoints keep
their documented existing behavior.

Task starts scope the key to the execution grant. Identical canonical JSON retries
create one immutable task version, run, estimate and audit record atomically; only
the winning start dispatches. A replay reads current progress without executing
again, including while awaiting approval or after rejection. The current grant
must still authorize the request. `task_id` is a source label, not a unique key.
Changed reuse returns 409. Task receipts follow the same hash/ID-only local custody
and operator erasure policy; history erasure leaves a receipt that refuses reuse
with 409, so a retry cannot resurrect effects. Archives omit task receipts and grants.
The SDK accepts `startTask(input, {idempotencyKey, signal})`; MCP `start_task`
accepts `idempotency_key`. Clients never retry automatically.

Publish and rollback use separate operation namespaces and the same credential,
workflow, key and canonical-body rules. They atomically retain the receipt with
one immutable version, activation, trigger setup and publish audit. Concurrent
and restarted retries return `idempotency:{replayed,workflow_id,version_id}`,
the original `version` and current `workflow`; they never republish a newer draft,
replace a later version, resume a pause, reset a schedule or repeat restore adoption.
Current publish authority and workflow scope still apply to every retry. Publication
receipts share the draft receipt's local hash/ID-only custody and operator erasure;
restoring an archive still requires the native owner's adoption review. The SDK
accepts `publishDraft(id, input, {idempotencyKey, signal})` and
`rollbackWorkflow(id, versionNumber, {idempotencyKey, signal})`. MCP
`publish_workflow` accepts `idempotency_key`. Other writes keep their existing
semantics; neither client retries automatically.

Duplication (`POST /workflows/:id/duplicate`, body `{}`) supports the same optional
key under a separate operation and the source workflow as target. The first
successful transaction saves one new inert workflow, draft snapshot, creation
audit and receipt. Concurrent calls or a retry after a lost response/restart
return the original destination's current workflow and original draft receipt.
They neither copy a newer source revision nor overwrite destination edits,
publish a version or start work. Existing preparation permissions and source
scope remain required, including for retries. Different source workflows or
credentials have separate key namespaces; changed canonical bodies conflict.
Without a key, each request continues to create a fresh draft. Receipt custody,
operator erasure and archive exclusion follow the rules above. Restored data
has no local receipts, and duplication there prepares a fresh inactive draft.
Use SDK `duplicateWorkflow(sourceId, {idempotencyKey, signal})` or MCP
`duplicate_workflow({workflow_id, idempotency_key})`. No client retries automatically.

### MCP client connection

Connect a Streamable HTTP MCP client to `/api/crank/v1/mcp`, using the same
native or bearer credential as the JSON API. The stateless server implements
protocol `2025-06-18` with JSON responses: `initialize`, `ping`, `tools/list`
and `tools/call`; initialized/cancelled notifications return 202. Send
`Accept: application/json, text/event-stream`, JSON-RPC 2.0 and, after
initialization, `MCP-Protocol-Version: 2025-06-18`. GET returns 405; the server
does not provide an SSE notification stream or retain MCP sessions. Origin
checks and authentication apply to every request. The transport follows the
[MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

Tools are `create_draft`, `update_draft`, `validate_draft`, `publish_workflow`,
`duplicate_workflow`, `get_workflow`, `list_workflows`, `list_runs`, `get_run`, `list_connections`,
`start_task` and `get_task`. Discover their argument schemas with `tools/list`.
Create/update/publish/start-task take `input` and optional `idempotency_key`; workflow tools take
`workflow_id`, run/task reads take `run_id`. `start_task` takes `input` containing
`task_id` and `actions`. `list_runs` returns the normal `{runs,next}` page;
pass `next` as `before` on the next call. Tool responses include text JSON and
`structuredContent:{status,value}`; native refusal sets `isError:true`.
Protocol/argument errors use JSON-RPC errors. Draft tools cannot execute work,
preparation credentials cannot publish or start tasks, and an execution
credential can only start/read its own tasks. Above-limit proposals wait for
normal exact human review, and unknown tools/transport changes are refused.
MCP tool metadata is descriptive; the native API enforces every permission.

Outgoing signed completion subscriptions, webhook retry history and secret
rotation are not shipped. PLATFORM-001 remains partial, including the Base
egress door requirement for owner-entered destinations. This MCP server does
not claim the connected-app MCP capabilities of PLATFORM-002.

### Scoped workflow teams (TEAM-001 partial slice)

Base membership stays owner/admin/member. The native owner may assign an
installation-local product policy with `POST /api/crank/team/:operator_id`:
`{role,workflow_ids,connection_ids}`. Roles are `admin`, `builder`, `operator`,
`approver` and `viewer`. An empty scope grants no access; `role:"none"` stores
a viewer policy with empty scopes. `GET /api/crank/team` lists these policies
for the owner. Changes and their resource IDs are audited and apply on the next
request; writes admitted under an old policy revision fail at commit.

Scoped builders/admins can edit and publish shared workflows using only shared
connections. They may also start draft tests at `/workflows/:id/test` with explicit
`bindings` for every declared connection. Both original and replacement connections
must be shared. The immutable test version records its initiating person and product
policy revision; every dispatch checks that person's current role/version and revision.
A role/scope change or deactivation stops later dispatch, even after regranting access.
Owner-created linked repairs retain that original test authority and separately record
the repairing owner; repair never refreshes revoked test authority. Tests never publish
or authorize production starts or approval. Production-account test effects still wait
for an owner's exact-effect confirmation. Test history and provenance travel in archives,
but receiving access and execution authority do not.

The owner still supplies the exact graph's cost estimate, and only
the owner adopts restored workflows. Scoped operators can start published runs only on shared bound connections;
named scoped approvers need the same connection-use scope and any grant's separate reviewer routing. They can decide shared workflows' exact proposals, but cannot
approve a run they started, including after changing roles. Viewers receive run
status/timing with restricted payloads. Lists, direct requests and the v1 adapter
enforce the same scopes. Other product doors remain unavailable to assigned
scoped roles. Connection credentials cannot be read by any role.

`POST /api/crank/team/transfer` with `{workflow_id,new_owner_id}` transfers a
workflow to an active person without retiring its published version or changing
sharing. Deactivation ends the departing person's sessions; published work and
its history survive. Policies never travel as authority in archives.

This slice does not complete TEAM-001: folder/environment policy, SCIM/group
provisioning, full operator recovery/admin powers and delegated creation remain. Existing people without a product policy retain their prior
Base-role behavior, including legacy approval-flow and owner approval semantics.

### Native decision follow-up (AGENT-004)

`GET /api/crank/followups` returns owner obligation/contact history and working calendars; a named person receives only their own reference/history rows. `GET /api/crank/inbox` is always the signed-in native person's own notices. A notice never authorizes workflow reads or decisions.

The native owner saves `POST /api/crank/followups/people/:personId` with `timezone` (IANA), `weekdays` (Monday=1 through Sunday=7), local `start`/`end` (HH:mm), optional `holiday_dates` (YYYY-MM-DD), `interval_minutes` (default 1440) and `daily_limit` (default 1). Bounds are start inclusive/end exclusive; overnight shifts belong to the starting weekday. Both current and shift-start holidays silence contacts. Daily limits use the person's local date across all obligations; intervals are elapsed minutes across DST.

`POST /api/crank/followups` accepts an unresolved production `run_id`, exact approval `path`, explicit-zone ISO `due_at`, `recipient_ids`, and optional paired `escalate_at`/`escalation_ids`. Each recipient must be an active native person with an explicit calendar. `POST /api/crank/followups/:id/revoke` immediately ends contact authority, leaving the human workflow wait untouched. Native deactivation permanently fences prior authorization. Contact records contain no question or answer copies, and no external messages are sent.

The owner uses `/app/followups`; people use `/app/inbox` and the original run's allowed-field approval form. Existing digest-bound approval, self-approval restrictions and run cancellation remain authoritative. Contacts, admissions and authorizing-owner audits commit atomically. Archives carry complete reference/history records in inactive state, excluding local calendars and grants. Run erasure removes their history; operator erasure anonymizes references. Value-free person-digest/day admission receipts remain local so erasure cannot grant another daily contact.

### Owner-deployed code jobs (WORK-005, partial)

The workflow API accepts `type: "code"` with a stored HTTP connection, a literal
`executor_url` origin, `language` (`python`, `javascript`, `typescript`), reviewed
`source`, mapped `input`, `timeout_ms`, `memory_mb` and explicit `allowed_egress: []`.
Python defines `main(input)`; JavaScript/TypeScript exports a default function.
See [the Linux executor](../executors/linux/README.md) for installation and the
public task protocol. Code source belongs to the immutable published graph;
execution inputs and outputs use the run's existing sealing, retention and erasure.

This slice supports standard libraries and exact installed `runtime_version`
declarations. Nonempty dependencies and egress declarations are refused before
publication. Wall time is in milliseconds (100–60000); memory is MiB of virtual
address space **per process** (Python 64–2048; JavaScript/TypeScript 512–2048),
not an aggregate RSS quota. Native Linux process/file bounds also apply.
Network-enabled jobs, versioned third-party dependencies, aggregate task memory
and heavier browser/ETL executors remain unfinished clause obligations.

An optional `output_schema` declares the returned JSON value, independently of the
task envelope. It supports exactly one `type`: `object`, `array`, `string`,
`number`, `integer`, `boolean` or `null`. Objects accept nested `properties`,
`required` (distinct declared properties) and boolean `additionalProperties`
(default true); arrays require an `items` schema. Integer means a safe integer;
numbers must be finite. No values are coerced. Other keywords/types are rejected
when creating, saving or publishing the graph. Declarations are bounded to 16,384
characters, 128 schema nodes and eight levels; results to 10,000 schema-visited
values. Missing required fields, wrong types and forbidden extra properties fail
the step with `reason: "output_schema_mismatch"` and no successful output. The
normal step error policy applies: the default stops later steps; an explicit
`on_error: "continue"` continues with the failed checkpoint.
Diagnostics name a JSON Pointer path and fixed reason, without returned values
or undeclared field names. Existing jobs without a declaration retain their
unconstrained JSON result. Readback after restart applies the original immutable
version's schema to the same durable task; no replacement task is submitted.
The step inspector exposes the declaration; history exposes any failure.

Every physical submission/read uses existing connection custody, account admission,
usage observations and bounded request retries. An ambiguous submission is read back
under the same durable task ID; it never starts a replacement task. Waiting jobs
release the workflow slot, and Cron checks the same ID at or after the next minute.
A missing previously submitted task or executor interruption is uncertain, never
successful and never automatically relaunched. Pause/revocation prevents the next
poll or continuation. Cancelling a run durably fences further workflow dispatch,
then asks the executor to stop; run history distinguishes `cancel_pending`,
`cancel_unconfirmed` and the executor's reported terminal state. A cancellation
before submission leaves an executor tombstone, so a late submission cannot start.
Cancellation uses the existing connection request/concurrency bucket and at most
two physical attempts, with the next attempt no earlier than the next minute;
an exhausted or revoked connection leaves cancellation explicitly unconfirmed.

Task references travel in archives with `active: 0`; restore/restart/Cron never
contact the source executor. Local run erasure deletes these references. The separate
owner-hosted executor retains output and value-free task identity after deleting its
source/input workspace; its independent output retention is the owner's responsibility.
Crank's Data inventory discloses the executor recipient and source/input field
categories. This slice inherits HTTP-002's unresolved private-DNS transport boundary;
it does not claim an enforcing Base egress service or hosted deployment qualification.

### Reviewed custom connectors and private gateways

The native owner installs and consents to custom versions. Preparation agents can
call `POST /api/crank/custom-connectors/propose` with `{openapi: <OpenAPI 3 object>}`
or `{definition: <typed declaration>}`; MCP's `propose_connector` takes `openapi`.
The result is inert `{definition,digest,requires_owner_review:true}`. It fetches
nothing and creates no credential or production authority. Unsupported schemas,
security alternatives and remote/recursive references fail visibly. The owner
can use **Connections → Propose a connector from OpenAPI** for the same review.

Install with `POST /api/crank/custom-connectors` and
`{definition,reviewed_digest,granted_scopes,disclosure_confirmed:true}`. Declining
any scope omits every dependent operation. ID/version pairs are immutable;
propose a higher integer version to change the definition. List versions with
`GET /api/crank/custom-connectors`. The disclosure names recipient, purpose,
field categories, region and retention; provider terms stay labelled unverified.
Do not put credentials in the description, URLs, input mappings or disclosure.
Use an ordinary stored connection for authenticated HTTPS requests.

A workflow step is `{id,type:"custom.request",connector_id,
connector_version,operation,input,connection_id?}`. The runtime validates all
inputs against the operation's flat primitive types and refuses undeclared
fields. Current public operations support GET/HEAD reads, bounded cursor
pagination and normal HTTP connection admission/retry checkpoints. Search
operations use the shared `no_match` and `multi_match` outcomes; find-or-create
and write requests are refused. A signed webhook uses the ordinary `webhook`
trigger with `custom_connector_id`, `custom_connector_version`,
`custom_operation`, `signing_connection_id` and `signature`. Custom workflow tests and publication require a current person session and the named workflow, connection and gateway-use scopes under TEAM-001 and TEAM-004. Connector installation, scope review, gateway enrollment and concrete grants remain owner-only; custom webhook installation remains owner-only.

A string input can declare `resource:{operation,items_path,value_path,label_path,parents?}`
(or OpenAPI parameter `x-crank-resource`). The source is a reviewed GET/HEAD
operation in the same immutable version; its scopes must be included in the
consumer, required source inputs bind to sibling typed fields, and dependency
cycles are refused. The editor offers **Load current Name** and an explicit
custom literal. Loading runs an audited owner draft test and does not edit the
draft or publish it. A failed lookup links its actual failed run; retry is an
explicit owner action.

`POST /custom-connectors/pickers` takes `{workflow_id,step_path,input_name}` and
returns its actual read run. `GET /custom-connectors/pickers/:runId` with the same
address checks the current draft, connection consent and original private grant
before returning at most 500 unique ID/name choices; it performs no network
request. `POST /custom-connectors/selection` takes that address, `draft_digest`,
`value` and optional `source_run_id`. It atomically saves a literal and clears
transitive dependent resource choices, refuses stale concurrent edits and never
publishes. Source-backed selection must still match the retained current
choices. A custom literal uses the same typed-input validation. Agents cannot
load or select owner resources.

Every installed version starts in `sandbox`. Run explicit workflow draft tests
through `POST /workflows/:id/test`. A test listener can use
`custom_sandbox:true`, but its graph may contain only map/filter/transform/respond
steps. It still requires a valid signature. Send its same event twice and retain
the one resulting run. Revoke a required scope with
`POST /custom-connectors/:id/versions/:n/revoke-scopes` and `{scopes:[...]}` and
retain the failed test: nothing is dispatched for that missing scope.

`POST /custom-connectors/:id/versions/:n/sandbox` takes
`{readbacks:[{run_id,step_id,path,equals}],duplicate_run_id,revoked_run_id}`.
Crank reads actual retained results; it does not accept a caller's pass flag.
Every currently executable read operation needs a successful explicit test
readback. Every installed trigger needs signed duplicate-delivery evidence.
A pipeline without triggers can instead prove an authenticated gateway completion
was repeated with the identical result and did not start another run. Unrelated
runs, mismatched expected data and unknown-operation errors cannot pass the suite.
Only then is production publication allowed for that exact version/current scopes.

Owner `POST /custom-connectors/:id/versions/:n/revoke` revokes a whole version
and its gateway grants. `POST .../review` with the exact `reviewed_digest`,
`granted_scopes` and `disclosure_confirmed:true` reviews a revoked or restored
version again; it starts in sandbox and restores no gateway grant. Archive
restoration carries definitions in `needs_review`, gateway metadata revoked and grants inactive. Codes, gateway keys, service accounts, local DB/storage credentials, tasks and sandbox authority do not travel.

For private operations, the owner first confirms an email link in a native browser session, then enrolls within five minutes under **Connections → Enroll a gateway**. Direct API, versioned API and MCP enrollment are refused; the owner form dispatches internally with `{label,environment}`. Local dev/provider sign-in and CLI proof cannot replace that email proof. The single-use 256-bit code is shown once, stored only as SHA-256, expires in fifteen minutes and binds the installation, environment and gateway name.

The customer's outbound-only HTTPS process generates its Ed25519 identity locally and redeems the code with its public key and signed possession proof. Crank holds only that public key/fingerprint. All later requests sign method, path, exact body digest, Unix timestamp (within 300 seconds) and a single-use nonce. The host pins the installation public key and accepts only signed, nonce-bound, current jobs; see [the gateway installation and local manifest](../gateways/node/README.md).

Owner `POST /gateways/:id/grants` explicitly names `{environment,connector_id,connector_version,operations,destinations}`. Each destination is an object with `label`, `type` and concrete recipient fields: database `host,port,database`; SFTP `host,port,path_prefix`; S3 `endpoint,bucket,prefix`; HTTP `base_url`. Local SQLite/file recipes use the exact customer-host `path`. These consented recipient descriptors are visible to the owner and retained inactive in archives. Queries and named local credentials stay on the host. A connector repair or new version needs a new grant. Grant changes bump TEAM-001's authority revision; both ends check exact version, operation, destination, environment, grant revision and status. The gateway resolves recipients itself and pins the resulting socket, follows no redirect, and refuses metadata/link-local addresses, including mapped IPv6.

A private workflow step pins `gateway_id` and `environment`. Existing workflows/connections migrate to production; new records may name an environment, and each dispatch refuses a connection or gateway from a different environment with an audited `cross_environment` access decision. Current adapters cover read-only SQLite, PostgreSQL, MySQL, SQL Server, SFTP/S3 and streamed UTF-8 file pages: 64 MiB source, 64 KiB page, 1 MiB aggregate output, declared page/item limits and a five-second local process deadline. Source-bound cursors refuse changed files. Tasks wait without holding an execution slot and expire after fifteen minutes. Physical gateway attempts use account admission and the ordinary retained request/retry ledger. Transient read failures retry with bounded exponential backoff and parked budgets, retaining the same page and input; refused operations, changed sources and invalid inputs fail without retry. Private POST actions use the explicitly configured `postgres-command` adapter: structured insert/update fields, a named local write credential and a preprovisioned customer receipt table. The signed job includes its reviewed method. Exact-version owner grants authorize the named operation and database; native owner confirmation covers each production-effect draft test. The customer transaction commits the effect and its operation-key receipt together. No write is retried blindly. After a lost result, `node gateways/node/cli.mjs recover --state PATH --manifest PATH --task-id ID` requests reconciliation of the same frozen task within its original fifteen-minute deadline. The next poll is marked `recovery_only` and may read an existing matching host receipt; it must refuse a missing receipt and cannot perform a new mutation. Revoked or changed authority refuses recovery. Unknown write outcomes stay uncertain and require inspection before replay.

Owners and admins can `POST /gateways/:id/revoke` or `/gateways/grants/:id/revoke` without step-up. Revocation is terminal, effective at the next dispatch; later results are withheld and the run fails with `gateway revoked`. Poll/result doors recheck current owner, workflow, environment and grant authority. Run history shows each page's status and each physical attempt; Cron resumes the exact waiting checkpoint or fails revoked work.

Under **Access → Team workflow access**, the owner shares an active private gateway as a named connection-use scope with a builder or admin. The scope ID is `gateway:<gateway-id>`; gateways remain separate from credential-bearing connection records. A scoped person may test and publish the reviewed exact connector version for a named workflow. Installation, review, enrollment and concrete grants remain owner-only. Tests and publications freeze the person's version and team revision; scope removal ends pending results and further pages, and later regrant cannot resurrect them.

Under **Connections → Create a scoped service account**, or `POST /api/crank/service-accounts`, the native owner after the same five-minute email proof names `{label,environment,workflow_ids,connection_ids,expires_in_days}`. Expiry defaults to 365 days and cannot exceed 730. The non-person credential is shown once and SHA-256-held. Connection scopes use existing connection IDs and `gateway:<gateway-id>` for an active gateway in that environment. Every private workflow reference needs its explicitly named gateway scope. It can read named workflow/draft/version data and save an existing workflow draft referencing only its scoped connections and gateways. It cannot create workflows, inspect collections, publish, test, execute, approve or manage access. Scope/environment/minter changes permanently suspend it; neither revocation nor suspension can be reversed or transferred. Owner `GET /service-accounts` lists metadata and `POST /service-accounts/:id/revoke` ends authority. Archives exclude these credentials.

These rules implement ct's 21 October gateway ruling. SQL Server and other real-provider journeys require their exact-candidate receipts before DONE. Agent-built connectors, ServiceNow/SAP test instances and buyer Auth/IdP interoperability belong to CONN-020. Writes, watched-field triggers, find-or-create and automatic schema/field refresh remain unimplemented; resource reads remain explicit owner actions.

Enterprise GET proposals use the same `POST /api/crank/custom-connectors/propose` door with the reviewed recipe request documented in `docs/enterprise-connectors.md`. SFTP/S3 gateway manifests and their source-bound cursor protocol are documented in `gateways/node/README.md`. Connector re-review rotates consent generation: existing published snapshots and sandbox receipts cannot confer authority on the new review.


### Run failure and approval notices (EXEC-003)

The native owner explicitly authorizes each workflow's Slack destination with
`POST /api/crank/notices/slack` and
`{workflow_id, connection_id, channel_id, confirm:"SEND_OPERATIONAL_NOTICES"}`.
The connection must be active, production Slack with `chat:write`; `channel_id`
is an exact Slack conversation ID. `{workflow_id, enabled:false}` revokes it.
Changing consent cancels pending notices under the old revision; it never moves
old notices to the new destination. No Slack notice is sent without this consent.

`GET /api/crank/notices/deliveries?run_id=ID` is owner-only delivery history,
also shown on the run's page. Failure/approval notices contain kind/category,
accountable owner reference, due action and an ordinary authenticated run link.
Slack gets no workflow payload, error text, mentions or approval authority.
The Data page discloses the recipient, purpose, fields, credential and unverified
provider-controlled region/retention. Email continues to use the workflow owner.

Dispatch records intent and a claimed attempt before contacting either provider.
Acceptance means provider acceptance, never mailbox receipt or a human read.
Definite rejection/throttling retries on the first minute-Cron tick at or after
1, 2, 4 and 8 minutes (five attempts total). A lost response, unknown outcome or
interrupted claim becomes uncertain and is never automatically resent. Development
mail is labelled suppressed. Revoked/changed consent, inactive owners and answered
approvals cancel pending delivery. Delivery/attempt history travels in archives
inactive; routes do not travel. Run erasure removes its delivery/attempt rows.

Teams/Nook, failure calendar escalation/resolution, compensation and the full
failure-route acceptance remain unfinished. This slice does not claim EXEC-003 DONE.


### Automatic OAuth renewal history (CONN-002)

`GET /api/crank/connections/:id/history` is an owner-only connection audit.
Public connection state includes `previous_expires_at`, `renewed_at` and
`expires_at`; the `connection.token_renewed` audit records the automatic actor,
previous/new expiry and granted scope names, never credential values. Scheduled
runs do not need a signed-in browser to renew an expired token. Concurrent callers
share one rotating-token exchange. Revocation/rotation wins over a late exchange;
new scopes require fresh consent. An unconfirmed or interrupted refresh requires
reconnection. Refresh leases never travel in archives. Admission remains per
connection; no account label or credential becomes provider-verified identity.

### Structured effect readback (EXEC-006)

An HTTP step's existing `readback` may use
`{url, records_path:"items", path:"business_key", equals:"{{trigger.input.order}}"}`.
The response list is bounded to 1,000 records. One exact match supplies that
record as `steps.<step>.body` with `reconciled:true`; zero or several matches
leave the original write uncertain without another mutation. Multiple matches
name `match_count` and `decision_required`. An unsuccessful, malformed or invalid
readback also preserves uncertainty. This is an immediate HTTP recovery slice;
it is not an authorized compensation or a complete financial connector.


### Native collected information (WORK-009 partial)

A workflow may declare `{id:"ask",type:"collect",fields:{po:{type:"text",required:true},amount:{type:"usd",required:true}}}`.
Available field types are `text` (trimmed, 2,000 characters), `number` (finite JSON
number), `usd` (decimal string, at most two fractional digits, canonical cents),
`date` (actual YYYY-MM-DD), `choice` (distinct `choices`) and `checkbox` (boolean).
There are at most 30 fields. Unknown fields, extra USD precision and invalid dates
are refused. File fields and non-owner assignments are not implemented.

The existing owner decision form says **Submit answers**. The same owner-only
`POST /workflow-runs/:id/approve` with `{path,digest,edits}` validates and records
one answer; output is `{answered,timed_out,answers,answered_by,answered_at}`.
`steps.ask.answers.po` maps into later steps. Late/resolved duplicate answers are
ignored with an audit. Native contacts can use the existing explicit follow-up
calendar/cadence/escalation door; receiving a contact grants no read or answer
right. Native owner-only answering is a conservative default pending ct approval,
not completion of the role/external-assignee requirement.

Optional `timeout:{amount,unit}`, `calendar`, `timezone` and `on_timeout:"continue"`
produce `{answered:false,timed_out:true,answers:null}` for a published timeout
branch. Default timeout behavior stops; it never fabricates an answer. An earlier
standing-grant review deadline remains earlier. Paused/restored workflows do not
resume implicitly. Values use the existing sealed wait/step records, immediate
blind index, retention and erasure; restored archives carry no answer authority.


### Pinned pure subflows (WORK-006 partial)

The native owner creates a definition with `POST /api/crank/subflows` and
`{name,definition:{inputs:{address:"string"},outputs:{normalized:"string"},steps:[{id:"trim",fn:"text.trim",input:{value:"{{trigger.input.address}}"}}],result:{normalized:"{{steps.trim}}"}}`.
`POST /subflows/:id/versions` creates the next immutable version. `GET /subflows`
and `GET /subflows/:id/versions/:n` are owner-only. Inputs/outputs are required,
exact top-level typed fields (`string,number,boolean,object,array,null`); values,
intermediate results and definitions are bounded to 64 KiB, with at most 30 fields
and 20 operations. Functions are trim, case, literal replace and HTML stripping;
no connection, code, recursive invocation or grant is accepted.

A workflow step pins `{type:"subflow",subflow_id,subflow_version,input}`. Its owner
publishes normally after reviewing the referenced definition. Upgrading one
caller changes only its draft/publication; ordinary workflow rollback restores
its earlier pin. Results are the typed output object, and the parent step trace
identifies its immutable definition. This is one bounded pure parent-step
invocation, not a separate child-run capability.

Owner `POST /subflows/:id/versions/:n/revoke` stops further use. Restored versions
start inactive. `POST .../review` with `{definition_digest,confirm:"REVIEW_PURE_SUBFLOW"}`
reviews that exact definition without publishing or resuming a caller. Native owner pure registry and use were approved by ct on 23 October at 09:30Z.

`POST /api/crank/subflows/install` accepts `recipe`, its canonical SHA-256
`recipe_digest`, and `confirm: "INSTALL_PURE_RECIPE"`. A recipe declares only
`format: "crank.pure-recipe.v1"`, `name`, an explicit `release` identifier,
`definition`, empty `connector_requirements`, and one to three synthetic
`samples` with typed `input` and expected `output`. The complete manifest is at
most 64 KiB. Every sample runs through the same bounded pure evaluator before
installation. The community source is unverified; the owner reviews the exact
bytes. Extra credentials, actions, nested function mappings or nonempty connector requirements are refused.

Installation retains the immutable manifest in the returned version's `recipe`
field and leaves that version inactive. Ordinary definition review and caller
publication remain separate actions. An explicit `subflow_id` installs a chosen
release as that registry's next local version; no caller adopts it automatically.
Read the full manifest back from the ordinary version door. Recipe manifests and
all definition versions travel in archives, with eligibility reset to inactive.
Use synthetic examples only: manifests are portable configuration, and must not
contain real customer values or secrets.

A step with `mode: "child"` queues the same pure definition separately. Its
parent returns waiting with a `children` list and the stable `child_id` in its
step trace. `GET /api/crank/subflows/calls/:child_id` returns a separate metadata
history and parent-history link. Inputs and results live only in the parent's
sealed checkpoint; this history introduces no second payload copy. Cron executes
queued children and then continues the parent. Native owners may also
the `run` POST action on that child history endpoint; duplicate dispatch retains the same history.
These children require native-owner production publication; draft tests and
execution grants cannot queue them. Arbitrary child workflows remain unbuilt.

the `cancel` POST action on that child history endpoint cancels the child and stops its parent;
cancelling the parent also cancels unfinished children. Completed effects are
never undone. Current publication and definition review are checked before every
pure operation. Revocation pauses execution. After reviewing the definition,
the `resume` POST action on that child history endpoint requires its `definition_digest` and
`confirm: "RESUME_PURE_CHILD"`. This grants no workflow publication or adoption.
Unfinished archived children restore interrupted with cleared leases; run and
definition adoption are required before explicit receiving-owner continuation.
Child metadata follows parent run erasure and its restore fences.

Lead-to-invoice recipes, buyer account binding and provider recipe journeys
remain unproved and require Google OAuth and a QuickBooks Online sandbox.

### Operational workflow tables (partial WORK-007)

Native owner session and same-origin mutation protection are required. These tables hold non-sensitive operational safe integers or lists of up to 1000 safe integers, with at most 100 keyed records per table. General records, customer/financial/health data, strings/objects, intake forms and record-trigger events are not implemented. Data remains until explicit owner erasure.

- `POST /api/crank/tables` with `name` and `confirm: "OPERATIONAL_NUMBERS_ONLY"`; `GET /api/crank/tables` lists tables; `GET /api/crank/tables/:id` returns records and a review digest.
- `POST /api/crank/tables/:id/records` takes a fresh UUIDv4 `operation_id` retained for retries, a lower-case identifier `key`, and `operation`: `upsert` (`value`), `increment`/`decrement` (`by`, default 1), `append` (`value`), `pop_first` or `pop_last`. A matching retry returns the original receipt; changed reuse is refused. Counters return the new number; pops return the removed number or `list empty`.
- `GET /api/crank/tables/:id/records/:key` reads one record. Native production steps `table.atomic` and `table.lookup` select a fixed `table_id`; exact-key lookup supports `no_match` halt/continue and the shared found/not-found shape. Find-or-create is refused. Only current native-owner publication in an unclassified workflow may invoke this state; no grants, sensitive flows or draft tests can use it.
- `POST /api/crank/tables/:id/pause` fences writes. An inactive/restored table requires `POST /adopt` with its exact `digest` and `confirm: "ADOPT_OPERATIONAL_STATE"`; this never publishes a caller or reactivates old operation receipts.
- On a paused table, `POST /records/:key/erase` with `confirm: "ERASE"` removes its state and receipts through the erasure journal. Opaque operation/key tombstones remain to prevent recreation and replay. Existing calling-run histories have their separate run erasure controls.

Operational state erasure retains append-only actor/time/opaque record and operation references, with no state values; existing operator erasure governs actor attribution.

### Native financial effect recovery

QuickBooks sandbox OAuth uses app `quickbooks`, accounting scope `com.intuit.quickbooks.accounting`, and the installation's `/api/crank/oauth/callback`. Register the held app through the existing owner OAuth app door; company consent supplies the sandbox realm identity. Reconnecting an existing connection must select the same company.

Native steps `quickbooks.create_invoice` and `quickbooks.create_refund_receipt` take `realm_id`, a `business_key` of at most 21 characters and `payload` containing the provider customer reference and line items. Requests carry stable QuickBooks request IDs. Readback matches document number and customer; a zero result never licenses a repeat write. For an uncertain step, the owner reads `GET /api/crank/workflow-runs/:id/reconcile?path=:step`, then posts `path`, current `digest`, selected `remote_id` and an accountable `reason` to that same door. The selected checkpoint succeeds and continuation reuses prior effects. The run screen provides these controls.

A separately published `quickbooks.void_invoice` step takes `source_run_id` and `source_path` naming a completed native invoice in a failed run, on the same connection. It always asks for exact human approval, retains its own audit and outcome, and uses a compensation identity derived from the original effect. A void does not reverse a payment or refund.

Gusto native steps are listed in the catalog. Connections bind the company UUID in `account_name`, use the `sandbox` environment for demo APIs, and retain provider-granted scopes. Under Account → Provider settings, the owner reviews responsibilities and records an agreement reference with separate consent for each company and operation. The API doors are `GET /api/crank/regulated-operations` with `connection_id` and `company_id`, and `POST /api/crank/regulated-operations/consent` with those fields, `operation`, boolean `consent` and `agreement_reference`. No agreement is signed by this operation. Missing agreement, consent, provider scopes or onboarding holds the existing obligation. Worker data handoffs preserve declared USD tax lines and ACH references and read the created worker back; they neither file tax forms nor send onboarding invitations. Provider payment acceptance and funded receipt readback remain distinct from settlement. CT adopted this consent policy with riders on 25 October 2026. Consent binds the reviewed immutable definition digest, credential authority generation and native owner version. Read the current operation definition first and supply its `operation_definition_digest` as `definition_digest` when consenting; a stale definition is refused. Every physical request rechecks authority after admission. Same-company renewal with unchanged effective scopes preserves consent; replacement, withdrawal, owner changes and inactive restore invalidate it. The completed Demo ACH receipt and worker handoffs are recorded in ACCEPTANCE.md.

## Independent invoice obligations

`quickbooks.invoice_outcome` checks the authorized CRM lead checkpoint and the
completed native invoice intent, then independently queries the connected
QuickBooks sandbox. Its input names `lead_path`, `source_path`, `lead_id`,
`realm_id`, `business_key`, `customer_id`, `amount_usd`, `due_at` and
`remaining_cost_usd`. The source lead supplies `id`, `customer_id` and
`amount_usd`. The provider record must match the document number, customer,
USD currency and exact amount. HTTP success alone cannot satisfy it.

A missing or incorrect invoice opens an exact native approval. Repair requires
an unchanged standing grant and original CRM and invoice evidence. A missing
invoice retains the original provider request identity; an incorrect invoice
update binds its current provider ID and version. Acknowledged repairs still
need a fresh correct readback. Ambiguous or unavailable readback remains open.
The run screen shows due, blocked, uncertain and satisfied states with the
remaining owner estimate and provider evidence. Notification acceptance remains
a separate subsequent checkpoint. This does not change operations reporting's
separately labelled owner attestation.

When a native invoice supplies `amount_usd`, Crank validates its exact line,
discount and tax total before dispatch. Conflicting quantity and price inputs
or percentage discounts without an exact bounded total are refused. A grant's
amount cannot be supplied as an unrelated label beside a larger invoice.

## Provider drift and reviewed mapping repair

The workflow run links to its Provider drift screen. A `drift.map` step declares
typed business fields with their provider source paths and takes an authorized
`record`. Optional `provider_schema` and typed `changelog` inputs let it compare
current provider documentation with the retained data shape. Documentation is
untrusted evidence and supplies no permission or business equivalence.

Native owner doors under `/api/crank/drift` list incidents and prepare minimal
mapping proposals. `POST /api/crank/drift` takes `incident_id` and `source_after`,
or `kind: "scope"` with explicitly requested `scopes`. Scope proposals can be
rejected; this door never grants them. Every open incident fences affected
production writes, including physical retries after admission waits.

`POST /api/crank/drift/incidents/:id/recheck` retries only the original failed
bound GET or HEAD. Actual provider success under the unchanged original scopes
can resolve that permission incident. It cannot speculate with a write.

`POST /api/crank/drift/:id/test` takes the current `digest` and explicit
`bindings` from each original connection to a current test-purpose sandbox
connection. It replays the latest 20 retained production trigger envelopes in
native test mode and retains each source and test run. Reads and writes use the
selected sandbox accounts; the production write fence stays closed. This
initial repair supports linear native mapping workflows; operational state,
custom connector execution, subflows and external code need isolated repair
support before they can use it.

`POST /api/crank/drift/:id/approve` requires the current reviewed digest, all
20 passing retained cases, `business_meaning_confirmed: true` and the normal
four-component owner cost quotation. It publishes only the tested mapping and
continues eligible held native runs from their existing completed checkpoints.
The original version and every continuation remain inspectable. Standing-grant
runs need fresh exact-version authority; uncertain writes still require
reconciliation. `POST /api/crank/drift/:id/rollback` restores the previous mapping
and reinstates the write fence. The UI exposes the same tests and decisions.


## Per-client connector tools

Open Access, then **Manage client tool servers**. Choose a published workflow,
enabled native Slack or Google Calendar steps, structural input schemas, fixed
parameters and a standing grant. The per-client URL accepts Streamable HTTP MCP
with a Bearer secret shown once. Client secrets work only at their own endpoint;
they cannot use the general task or workflow APIs.

The owner creates a server through `POST /api/crank/mcp-clients` with `label`,
`workflow_id`, `version_id`, `expires_at`, `policy` and `tools`. Each tool names
`name`, `description`, `step_id`, `inputSchema` and `fixed`. Schemas use the
structural JSON types supported by code-output schemas, with an object root and
`additionalProperties: false`; unsupported keywords are rejected. Fixed values
cannot also be caller arguments. A tool may name `approval_step_id` for a
stopping approval leaf whose grant permits a `proposal` input.

Disabled tools, extra arguments, wrong types, fixed-parameter overrides,
ungranted recipients, excessive amounts and request rates are refused before
provider execution and recorded in the client call history and audit. Calls
within the client boundary still obey the native workflow's approval and cost
controls. Tool aliases share their underlying step's client rate limit. An
optional `Idempotency-Key` retains the task identity on an identical retry.

Every admitted call links to normal run inputs, outputs, provider IDs and
approvals. Refused calls create terminal ordinary runs containing the attempted inputs and
refusal outcome, under the same payload retention and erasure controls. Their
client index and audit retain value-free reasons and tool identity. A refusal
has no executable checkpoint and cannot be resumed or replayed. Per-client secrets and bindings remain
installation-local and are excluded from archives. Portable run history confers
no execution authority. A new publication, grant expiry or revocation fences the
next dispatch. Revoke the client from its Settings screen or through
`POST /api/crank/mcp-clients/CLIENT_ID/revoke`.

Google Calendar uses the existing managed Google OAuth connection with event
write scope. It requires an exact calendar ID and explicitly zoned start and end
times. Each event gets a stable operation identity and an independent exact
readback; an unconfirmed creation is never blindly repeated. Update emails are
not requested. Google documents that email can still occur for some attendee
changes, so initial MCP tools should omit attendee inputs. Provider region and
retention remain controlled by the provider and unverified by Crank.

The native provider-edge journeys establish implementation behaviour. Actual
Google Calendar consent and readback remain pending the owner's console step;
this feature does not establish PLATFORM-002 completion.

## Natural-language workflow proposals

The native owner opens Skills and chooses **Describe a workflow**. Configure
`AI_ENABLED=true`, `AI_MODEL`, and either the installation's `AI_API_KEY`
(with optional `AI_BASE_URL`) or its existing Models service configuration.
Disabled or unavailable models refuse generation; no substitute graph is used.
Generation makes one bounded request and reports provider usage with the USD
charge explicitly unverified when the provider does not report it.

`POST /api/crank/authoring` takes `prompt`, `crm_connection_id`,
`quickbooks_connection_id`, `lead_url`, `realm_id`, `customer_id`, `item_id`,
`amount_usd` and a `samples` array. Only the selected connection definitions,
native operation schemas, submitted samples and bounded invoice scope reach the
model. Connection secrets never enter the model prompt. This initial scope is
one manual CRM GET, a US country filter and one USD QuickBooks sandbox invoice.
Generation never reads app records or executes the proposed workflow.

`GET /api/crank/authoring/WORKFLOW_ID` returns the editable graph, samples,
unresolved questions, scope, provenance, test result and costs. Use its `revise`
action with `graph`, `samples` and `answers` keyed by question ID. Transport,
accounts, customer, amount and tools cannot widen. Blank answers remain
unresolved. Every edit invalidates previous test evidence.

The `test` action requires explicit `bindings` for both selected accounts. Both
must be active sandbox accounts declared for testing. Each sample produces an
ordinary retained native test run. The executor refuses production effects
even through an approved test wait or a later connection-purpose change.

The `promote` action requires `confirm:true` and the current returned `digest`.
All questions must be answered, the exact current graph and samples must have
successful test runs, and owner estimates must be recorded before publication.
Ordinary publication cannot bypass these checks. Promotion records the deciding
human and immutable version; it creates no grant and supports only future
authorized sandbox runs. Drafts and provenance travel in inactive archives;
connections and execution authority must be re-established by the receiving
owner. The adopted human-only promotion policy remains subject to ct approval;
AI-002 remains partial until that decision and all contract evidence are complete.

## Recurring invoice skills

Open Skills, then Recurring invoice skills. This native slice retains immutable
instructions and named safety cases and executes one bounded invoice-check tool.
Customer messaging remains blocked pending its authorized transport.

The source is a published manual workflow with exactly one
`quickbooks.followup_invoice` step, a QuickBooks sandbox connection, and literal
`input: {realm_id, invoice_id}`. `invoice_id` is the stable provider Id.
Quote and publish that workflow and issue its exact TEAM-002 execution grant
through the existing doors. The rule covers the two input fields and carries
no customer-recipient overrides. The task stores the grant identifier; its
credential is never copied.

All following routes are under `/api/crank`, require the native owner, and use
ordinary origin-bound JSON writes.

| Door | Input and result |
| --- | --- |
| GET `/recurring-skills` or `/recurring-tasks` | Retained skill versions and current task summaries |
| POST `/recurring-skills` | `{name, workflow_id, workflow_version_id, instructions, eval_cases, skill_id?}`; omit `skill_id` for a new identity and supply it to publish another immutable version |
| POST `/recurring-tasks` | `{name, skill_version_id, grant_id, objective: {realm_id, invoice_id, interval_minutes}}`; exact template invoice and current matching grant required |
| GET `/recurring-tasks/:id` | Current pins, objective, native run history, original pins, costs, blocked work and owner stop reasons |
| POST `/recurring-tasks/:id/adopt` | `{revision, skill_version_id, grant_id, objective}`; selects only the next run's immutable pair and matching grant |
| POST `/recurring-tasks/:id/dispatch` | `{}`; checks a due objective or returns its existing open run; accepts no authority or recipient override |
| POST `/recurring-tasks/:id/pause`, `/resume`, `/takeover`, `/cancel` or `/revoke-tool` | `{revision}`; stale revisions refuse; takeover and cancellation end automatic work, and tool revocation is permanent for the task |

Each safety case is `{name, invoice_status, expected}`. Retain the four states
`open`, `paid`, `closed` and `void`; an open invoice remains blocked and terminal
states stop its objective. These retained cases describe native safety behavior;
they are not customer-delivery evidence or a general agent evaluation engine.

The per-minute scheduler reuses the open run and its original cadence. Missed
checks produce no backlog. A new version cannot replace an open run's tools,
invoice, grant or objective. A broader source needs its own owner-issued grant.
Every connected read rechecks current authority, including after rate waiting.
At a due-contact boundary another live invoice read selects the current billing
contact and suppresses satisfied invoices. The checkpoint exposes a stable
contact operation key and a blocked obligation, with no sent-message receipt.

The ordinary native run doors inherit task pause, takeover, cancellation,
authority expiry, budget holds and tool revocation. Complete history exports
inactive without grants or active invoice claims; receiving authority requires
fresh owner review and grants. Run erasure removes its recurring history link
and billing-contact values under the existing data policy. Provider recipients,
field categories and unverified provider-controlled terms remain in Data.


### Native Nook delivery

Create a native connection through `POST /api/crank/connections` as the owner:

```json
{
  "app": "nook",
  "label": "Operations conversation",
  "auth_kind": "bearer",
  "scopes": ["messages:write"],
  "binding": {
    "origin": "https://nook.example.com",
    "conversation_id": "your-conversation-id"
  },
  "secret": {"token": "<owner-supplied Nook integration token>"}
}
```

Issue the token in Nook's Integration tokens settings for this conversation. Nook independently enforces its current channel membership, posting permissions and token status. The Crank scope is an owner declaration; it does not establish a provider grant. Bindings are immutable: create another connection to select a different installation or conversation. Rotation replaces the secret and scopes without changing the destination. The native connection test refuses this post-only credential; test the action through the normal draft-test door with an explicit production-effect confirmation or a declared test binding.

Publish a step with `type: "nook.send_message"`, its `connection_id`, and `input: {"body": "your mapped message"}`. No URL or conversation may be mapped. Both native and generic HTTP use of this connection are confined to the exact HTTPS origin and conversation message endpoint; redirects never carry the token elsewhere. The native action checks messages:write immediately before physical dispatch after admission and retries. Its stable operation key follows Nook's family-scoped idempotency contract. A possibly accepted write stays bound to its original bearer; replacing the bearer leaves that operation uncertain because the posting API cannot verify token-family continuity. Resealing the same bearer permits bounded recovery. A definite 401 or 403 refusal is re-executed only when the owner explicitly reconnects and resumes; prior possibly accepted writes keep their credential fence. Retained retry budgets and provider waits survive restart.

The output includes the provider message `id`, `body`, `conversation_id`, `origin`, `acknowledgement: "provider_response"` and `independently_read_back: false`. An invalid or mismatched acknowledgement stays uncertain. This token cannot read messages or subscribe to events; the action does not claim either capability, app identity or independent readback. Archive restore retains the binding and history without credentials or execution authority. Local erasure does not delete a message in Nook.

Protocol source: [Nook integration token documentation](https://github.com/just-every/run-nook/blob/2db1fd4fd41b3b4fa89f2a40d3549d46d747529b/docs/integration-tokens.md).


### Bounded native subflow children

The owner may POST an immutable definition to `/api/crank/subflows` with
`kind: "native"`, `inputs`, `outputs`, `steps` and `result`. The type declarations
use the same top-level field types as pure subflows. Native definitions start
inactive. Review the returned digest through the version's `review` door with
`confirm: "REVIEW_PURE_SUBFLOW"` (the existing compatibility token), then publish
a caller that pins its version and uses `mode: "child"`. Review does not publish
a caller or resume retained work.

Native graphs support `map`, `transform`, `filter`, `paths`, `loop` and `delay`.
Transform functions are `text.trim`, `text.case`, literal `text.replace` and
`text.strip_html`. Declare transforms as steps; inline function mappings are
refused. Delays use `for` or `until`; shared named queues are outside this slice.
There are at most 20 declared steps, four nesting levels, 50 items in each loop
and 2000 expanded invocations. Mapped inputs, outputs and intermediate
checkpoints are bounded to 64 KiB. Oversized traces and error details are
replaced with an explicit `truncated: true` summary and `original_bytes`;
error summaries retain their failure category. The caller's own execution
ceiling also applies. Provider steps, account bindings, code and recursive children are
refused. Pure recipes retain their existing format and sample rules.

The queued call returns a child id. The call's history door under
`/api/crank/subflows/calls/{id}` returns its parent history link and child
checkpoint metadata. A running call can be parked on its durable delay;
checkpoint status identifies the wait. Values remain in the parent's sealed
records. The ordinary executor continues the immutable graph from those
checkpoints, including loop item identities. Current owner publication and
review eligibility apply before each child step. Cancelling either the child
or parent stops continuation. Revocation durably pauses unfinished children
and their parents immediately, including children parked on delays. Review
before the next scheduler pass cannot clear that fence. Review after
revocation does not resume a child;
the existing resume door requires the active digest and
`confirm: "RESUME_PURE_CHILD"`. Imported unfinished children are interrupted,
definitions are inactive, and receiving adoption and review remain necessary.

### Retained draft samples

The native owner starts a single-use, ten-minute draft webhook listener with
`POST /api/crank/workflows/:id/samples/listen`. Send the actual form-encoded,
JSON or multipart POST to the returned draft URL. It captures parsed and raw
body, safe headers, query and file references plus retained file bytes. It
never admits a production event or consumes its dedup identity. Changing the
draft or revoking the starting session invalidates the listener. Receiving URLs
are shown once and excluded from archives.

Authorized payload readers use `GET /api/crank/workflows/:id/samples`.
Preparation callers save a manual trigger sample with
`POST /api/crank/workflows/:id/samples` and `{source:"manual",sample:{...}}`,
or select retained workflow history with `{source:"history",run_id:"..."}`.
Include `step_path` to select that step's successful retained output instead of
the trigger. The source keeps the run ID, step path and completion time. Missing
or expired outputs, foreign workflows and callers without payload access are
refused. Manual step outputs also use `step_path`; unlike trigger payloads,
step outputs may be any JSON value, including a scalar or an array.
A schema example uses `{source:"schema",step_path:"...",sample:{...}}` and
always remains explicitly not tested. Use the same route with a `select` or
`delete` suffix and `{sample_id:"..."}` to choose or remove a record. Deletion
honors legal holds and records the portability erasure fence. Restored samples retain all portable
values but are unselected; the owner must adopt the workflow before selecting
samples or opening another listener.

The `fields` suffix accepts `{fields:["body.email","body.new_question"]}` to
refresh the native expected-field list. Validation and publication report
missing named fields and app steps still relying on schema examples. This is
not connected-provider field discovery. The workflow preview accepts
`{sample_id:"..."}` or the selected trigger sample by default, and carries its
source identity and time through pure mapping, transform and condition results.
An explicit `{sample:{...}}` preview is always labelled manual.
Selected step outputs carry previews past app steps without executing them.
Each result names all sample sources consumed so far, and schema sources remain
labelled not tested. A saved output does not bypass an approval, delay, loop or
subflow. Missing fields referenced from selected outputs are named in validation
and publication warnings. Restored step samples stay unselected until adoption
and explicit selection; history erasure removes their retained copies too.
