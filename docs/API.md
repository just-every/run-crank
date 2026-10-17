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
