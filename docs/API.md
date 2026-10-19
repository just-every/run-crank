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
| POST `/imports/plan` | Native/dev owner | `{namespace,source}`; no native writes |
| POST `/imports/apply` | Native/dev owner | Same input plus reviewed `fingerprint` |
| GET `/imports` | Native/dev owner | Last 100 durable import jobs and approvals |
| POST `/imports/:id/undo` | Native/dev owner | Undo unused drafts, refusing target drift |
| POST `/data/export` | Native/dev owner | Download installation archive |
| POST `/data/restore` | Native/dev owner | `{archive,confirm:"RESTORE",journal?}`; empty destination only |
| POST `/data/erase` | Native/dev owner | `{run_id,confirm:"ERASE"}`; paused flow, terminal run |

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

## Workflows

Published workflows run unattended: publishing a version authorizes exactly its
declared steps on its bound connections, recorded on the version (publisher,
time, steps, connections). Approval steps and USD caps are opt-in. Drafts run
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
| GET/POST `/settings` | Owner for writes | Timezone, category USD caps, auto-pause policy |
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
