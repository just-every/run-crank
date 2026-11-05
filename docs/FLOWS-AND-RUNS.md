# Flows and runs

A flow names a source app and one HTTP destination. Each incoming event becomes
a run with its own input, destination and delivery key. An owner reviews that
snapshot before delivery.

## Create, activate and pause a flow

In **Flows** (`/app`), fill in **Create a flow** and select **Create draft flow**.
Owners, admins and agents can create drafts. Only an owner can select
**Activate flow**. A flow must be active before it accepts a new event.

Select **Pause flow** to stop new events being admitted. A paused flow shows
`draft` and can be activated again. Pausing does not cancel an approved request
already on its way to the destination. Pending runs can still be approved or
rejected deliberately by the owner.

For incoming events, use a [Trigger credential](ACCESS.md#connect-a-source-app)
scoped to that flow. To enter one by hand, expand **Prepare a run** on an active
flow, supply an **Event ID** and an **Event input (JSON object)**, then select
**Prepare for approval**.

The event ID identifies an event within its flow. Submitting the same ID with the
same input returns the existing run. Reusing it with different input is refused.
An erased event cannot be admitted again under that flow and event ID.

## Decide on a run

Open **Runs** (`/app/runs`), or select **View runs** on a flow. The list shows
the newest 200 runs across the workspace; **View runs** filters that list.
Select the event ID to open **Run details**.

Workflow runs on the same page lead with the columns their workflow version
declares in `settings.run_columns` (such as Customer and Amount); a run whose
version declares none leads with its workflow's name.

Check when it was received, the source, destination URL, flow revision, delivery
key and **Exact input sent on approval**. For a `pending` run, an owner can select:

- **Approve and deliver**: record the decision and make the first HTTP delivery attempt.
- **Reject**: record the decision without sending anything.

The decision is recorded against the reviewed action. **Approval history** shows
who decided and when. **Delivery attempts** shows each attempt and its outcome.
Crank retains safe outcome details rather than arbitrary destination response
content. A `succeeded` result confirms the destination's acknowledgement; it
does not certify a later business action there.

## Replay a failed delivery once

Crank does not retry a failed delivery on its own. Check the destination first:
a timeout or interrupted request may have reached it even if Crank could not
confirm receipt.

An owner can select **Replay once** after a failed first attempt. An interrupted
attempt whose time limit has expired also becomes eligible. Replay sends the
same approved body to the same destination with the same delivery key. It uses
the run's only replay, even if that attempt also fails. Rejected and successful
runs cannot be replayed.

## Connect your own destination

Crank sends a JSON `POST` to a URL on the installation's single configured
destination origin, `CRANK_TARGET_ORIGIN`. Outside local development the origin
must use HTTPS. Destination URLs cannot contain credentials, query strings or
fragments. Redirects are refused. Authentication for the destination, if needed,
comes from the installation's `CRANK_TARGET_TOKEN` binding; it is not entered
in a flow or imported from n8n.

The receiver must atomically store the `Idempotency-Key` header and body digest
with its effect, refuse changed bytes under the same key, and acknowledge both
first delivery and duplicates with JSON:

```json
{"id":"destination-id","idempotencyKey":"the-run-id"}
```

The delivery key is the run ID shown in **Run details**. The receiver's handling
of that key makes a replay safe; an arbitrary HTTP endpoint is not sufficient.
See the [README deployment instructions](../README.md#deploy-to-your-cloudflare-account)
and [HTTP API](API.md) for configuration and request details.

Continue with [Access](ACCESS.md), [Move in](IMPORTING.md) or
[Backup, restore and erasure](BACKUP-RESTORE.md). For a local walkthrough, see
[Get started](GETTING-STARTED.md).

## Optional approval deadlines

A published graph can explicitly configure an approval step's `timeout` offset,
up to twelve `reminders` offsets, `timezone` and `calendar`. Each offset has a
positive whole `amount` and a time `unit`, including `business_days`. There are
no automatic reminders or timeout when those fields are absent. For example:

```json
{
  "id": "review",
  "type": "approval",
  "input": {"amount": "120.00"},
  "editable": ["amount"],
  "caps": {"amount": {"max_usd": "500.00"}},
  "timezone": "America/Chicago",
  "calendar": "us_federal",
  "reminders": [{"amount": 1, "unit": "business_days"}],
  "timeout": {"amount": 2, "unit": "business_days"},
  "on_timeout": "continue"
}
```

Offsets start when the step waits. Calendar units preserve local wall time
across daylight saving changes; a nonworking due date moves to the next working
date at that time. Reminders must increase, precede expiry and fall within 366
days. The run retains its exact published version, proposal digest and occurrence
identities across restarts. A standing grant's earlier deadline still limits the
configured wait; grant-only escalation retains its existing internal-task policy.

`on_timeout` defaults to `stop`: the run is cancelled with a timeout record,
without a human rejection or downstream work. With `continue`, the step returns
`{"timed_out":true,"proposal":null}`. Route this result separately from an
approved or rejected proposal. A deadline never approves, supplies a reviewer
identity or executes the rejection branch on a person's behalf. Late decisions
are refused even before the next Cron pass.

Reminder email uses the current workflow owner, only when that person can review
and did not start the run. Slack also needs the existing exact workflow notice
consent; replacing or withdrawing its route cannot redirect a scheduled reminder.
No new recipient or reviewer authority is created. Resolution, cancellation,
pause and authority loss suppress unsent reminders. Only definite non-delivery
retries; uncertain provider acknowledgements retain their uncertainty. Required
live Teams, Nook and mobile notices remain unfinished.

Backups retain occurrence history inactive, with no receiving consent or automatic
reminder dispatch. Run erasure removes occurrences and delivery attempts together.
