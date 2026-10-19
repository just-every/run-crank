# Operations reporting and external logs

Open **Operations** in the signed-in workspace. The report reconciles production run
states with run history. Success means the workflow finished its declared steps;
it does not mean an invoice settled, a customer received a parcel, or another
business outcome happened.

## Reports and the business day

`GET /api/crank/reports/operations` returns aggregate counts, workflow and team
breakdowns, queue age (including durable delay queues), trigger-to-start and receipt-to-finish latency, throughput,
uncertainty, business obligations and connector connection health. Time filters
use `from` and `to` ISO timestamps, with an inclusive start and exclusive end.
The default window is the last seven days. Use `workflow` and `team` to narrow
the report. Uncertain effects are counted separately from ordinary failures,
matching the statuses shown in run history.
Stopped filters/searches, rejected runs and cancelled runs are separate states.
Throughput measures finished runs per hour in the receipt-time cohort.

The home summary uses today's local business date in the workspace timezone,
including daylight-saving days lasting 23 or 25 hours. It shows today's runs
and failed runs, the number of currently active workflows that received a run
today out of all active workflows, and named active schedules that are overdue,
were skipped by schedule policy, have an admission with no durable run, or have
a due run that has not started.
The today panel follows the workflow/team selection while retaining the local
business-day window. The other metrics follow the report's time window.

The owner can set the timezone and reporting team assignments with:

```http
POST /api/crank/reports/settings
Content-Type: application/json

{"timezone":"America/Chicago","assignments":[{"workflow_id":"WORKFLOW_ID","team":"Finance"}]}
```

Teams here are reporting labels, not permission boundaries. Unassigned workflows
appear under `Unassigned`. Connector health reports connected, expired, revoked
or needs-reconnect credentials for the connections in each published workflow.
Connected means stored connection state; it does not claim a live provider probe.

Add `format=csv` to the report URL to download the same filtered workflow rows.
CSV includes the reporting window and timezone. Cells use RFC 4180 quoting;
formula-like names are escaped before spreadsheets open the file. Run payloads,
credentials and obligation evidence are absent from this export.

## Business obligations

Every run starts with an unverified business outcome. A successful HTTP response
or a succeeded workflow cannot increment `business_completed`.

Owners can declare a real obligation using
`POST /api/crank/reports/obligations` with `run_id`, a stable `key`, a
`description` and optional `due_at`. Open obligations appear separately, with
overdue indicators. To attest that the actual outcome has been checked, use
`POST /api/crank/reports/obligations/OBLIGATION_ID/verify` with written `evidence`
and `confirm_business_outcome: true`. Verification records the owner and time,
and is labelled `owner_attestation`. Evidence should identify the independently
checked ledger entry, provider record or other business result.

The business-completed count includes only succeeded, non-uncertain runs with
at least one declared obligation and every declared obligation verified. Runs
without declared obligations remain business-incomplete. This is an attributed
owner attestation, not automated provider readback or independent reconciliation.
Adding another open obligation makes that run incomplete again.

## External event delivery

Owners configure sinks through `POST /api/crank/reports/log-sinks`. Native owner
authorization and the normal same-origin write checks apply. Read status using
`GET /api/crank/reports/log-sinks`. Each sink reports pending event count, oldest
pending event age (`lag_ms`), cursor, last attempt/delivery, consecutive failures
and next retry. The Operations screen also shows these statuses.

Every destination requires an explicit public HTTPS endpoint without URL query
credentials or a fragment. Credentials are encrypted under installation custody
and never returned by these APIs. Internal/private network targets and redirects
are refused by the existing bounded egress layer. DNS rebinding requires the
platform's egress policy, as it does for other outbound workflow calls.

Example configuration (replace the placeholders privately):

```json
{
  "label": "Buyer audit intake",
  "kind": "http",
  "endpoint": "https://logs.example.com/crank",
  "secret": { "token": "SUPPLY_PRIVATELY" },
  "fields": ["at", "event", "workflow_id", "run_id", "status"],
  "events": ["run.received", "run.status", "step.status", "audit"]
}
```

The supported transports are:

| Kind | Credentials and delivery |
| --- | --- |
| `http` | `secret.token`; POST a JSON object containing `source`, `batch_id` and `events`, authorized with Bearer. A 2xx acknowledges the batch. |
| `datadog` | `secret.token` as the `DD-API-KEY`; POST Datadog JSON log objects to the buyer-selected Logs intake endpoint, with `ddsource` and `service` set to `crank`. A 2xx acknowledges intake. |
| `splunk` | `secret.token` as `Authorization: Splunk …`; POST newline-separated HEC event objects to the buyer's collector endpoint. Both a 2xx and HEC response `code: 0` are required. |
| `s3` | `secret.access_key`, `secret.secret_key`, optional `secret.session_token`, plus `region`, `bucket` and optional `prefix`; SigV4 path-style PUT of newline-delimited JSON objects to the buyer's S3-compatible endpoint. A 2xx acknowledges storage. |

Wire formats follow the official [Datadog Logs intake](https://docs.datadoghq.com/api/latest/logs/send-logs/),
[Splunk HEC event format](https://help.splunk.com/en/splunk-enterprise/get-started/get-data-in/10.6/get-data-with-http-event-collector/format-events-for-http-event-collector),
[S3 SigV4 signing](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)
and [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
contracts. Splunk delivery means HEC intake acceptance, not indexer acknowledgement.
S3 uses general-purpose/path-style compatible buckets; AWS directory buckets
require different endpoint and authentication support.

Only these metadata fields can be selected: `at`, `event`, `workflow_id`,
`run_id`, `status`, `step_type`, `actor_id`, `subject_kind`, `subject_id` and
`action`. Default selection omits `actor_id`. Payloads, step inputs/outputs,
audit details, provider response bodies, credentials and obligation evidence
never enter the event outbox. Select fewer metadata fields to redact identifiers
further. An immutable numeric `event_id` is always included for deduplication.
`workflow`, `team` and `events` optionally select the stream. Team filters follow
the current reporting assignment at delivery time.

Run and step transitions, audit entries and connection status changes create
metadata events atomically in the same D1 write as their source. New sinks start
with future events. Set `replay_history: true` at creation to deliver existing
retained metadata events as well. The stream contains events recorded since this
migration; it does not invent historical transitions from older runs.

Cron flushes one bounded batch per enabled sink each minute. Owners can also
request a pass with `POST /api/crank/reports/log-streams/flush`. A failure keeps
the cursor unchanged and backs off from one minute to one hour. Status remains
visible during the outage, and the next eligible pass resumes after a restart.
The per-sink lease prevents overlapping flush passes from owning the same batch.
Delivery is at least once; receivers should deduplicate `event_id`. HTTP batches
also carry an idempotency key. S3 keys identify the sink and event range, so
repeating the same range replaces the same object. A network loss after provider
acceptance can produce duplicate events; no event is marked acknowledged first.

To change a sink, send its `id` and complete configuration to the same POST
endpoint. Credentials may be omitted when the kind and endpoint are unchanged.
Use `enabled: false` to pause it. Its cursor and pending events remain durable.
Use `POST /api/crank/reports/log-sinks/SINK_ID/delete` to remove its credentials
and cursor. Archives exclude sink configuration and the delivery outbox, so a
restore cannot resume outbound delivery to a former destination. Team assignments
and business obligations remain portable domain data.

Provider acknowledgement is log-transport acceptance only. It never changes a
workflow's outcome or verifies a business obligation.
