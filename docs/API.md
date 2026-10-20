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
| POST `/workflows/:id/test` | Native/dev owner | Freeze draft and sample as a test run; explicitly map every connection with `bindings`; production writes wait for exact live confirmation |
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
