# People, agents and trigger keys

Open **Access** (`/app/access`) as an owner to invite people and issue or revoke
machine credentials. Use **Account** (`/auth/settings/identity`) for your own
identity settings.

## Invite people

Under **People**, enter a name and email, choose a role and select **Invite
person**. Local development invitations arrive only in the development outbox.

| Role | What they can do in Crank |
| --- | --- |
| Owner | Prepare and read; activate or pause flows; approve, reject and replay runs; manage access, imports and data |
| Admin | Prepare draft flows and runs; read flows, inputs, decisions and attempts |
| Member | Read flows, inputs, decisions and attempts |

Select **Deactivate** beside an active non-owner to remove their access. Reading
includes event input, so invite people who should be able to see that data.

## Create a credential

Under **Agent and trigger credentials**, enter a **Label** that identifies its
user or sending app, then choose a **Scope**:

- **Agent — prepare and read** lets an agent read workflow state, create draft
  flows and prepare runs on active flows. Leave **Flow** at
  **All accessible flows (agent)**.
- **Trigger — one flow only** lets a source submit events to the selected
  **Flow**. A trigger key cannot read workspace state or submit to another flow.

Select **Create credential**. Copy its one-time value into a private regular file
outside source control, with permissions `0600`. Crank stores only its hash.
Never paste credentials into chat or workflow JSON. Lost credentials cannot be
shown again; revoke them and create replacements.

Neither scope can activate flows, approve or reject runs, replay delivery,
manage credentials, import, export, restore or erase data. An agent's prepared
work still needs the owner's decision in the app.

Under **Issued credentials**, select **Revoke credential** to stop it being used
immediately. Credentials are excluded from [archives](BACKUP-RESTORE.md); issue
new ones after moving to another installation.

## Connect a source app

Activate the flow as an owner. Configure the source to `POST` to
`/api/crank/flows/FLOW_ID/trigger` on your Crank origin, with
`Authorization: Bearer <credential>` and `Content-Type: application/json`.
Use its flow-scoped trigger credential and this envelope:

```json
{"event_id":"ticket-1044","input":{"customer":"Harbor Workshop"}}
```

Keep the source's stable event ID for duplicate submissions. Incoming events
prepare pending runs; they do not deliver to the destination. The owner opens
**Runs** to inspect and decide.

## Use the included agent commands

Set `CRANK_ORIGIN` to your exact Crank origin, without a trailing slash, and
`CRANK_TOKEN_FILE` to the private credential file. With an agent credential:

```sh
node scripts/crank.mjs state
node scripts/crank.mjs prepare-flow flow.json
node scripts/crank.mjs prepare-run FLOW_ID event.json
```

`flow.json` needs `name`, `source_app`, `destination_app` and `target_url`.
`event.json` uses the event envelope above. With a trigger credential, use only:

```sh
node scripts/crank.mjs trigger FLOW_ID event.json
```

Credentials issued through local dev identity also require the local dev gate.
Save the `rer-dev` fragment value from your private **RER_OPEN** link in a second
`0600` file and set `CRANK_DEV_KEY_FILE` to its path. Alternatively stop dev,
start `rer dev --login`, sign in through the outbox, and issue a credential
through that sign-in session. Keep both files private.

See [Flows and runs](FLOWS-AND-RUNS.md), the [HTTP API](API.md),
[Get started](GETTING-STARTED.md) or [Move in from n8n](IMPORTING.md).
