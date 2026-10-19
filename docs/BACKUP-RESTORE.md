# Backup, restore and erasure

Owners manage archives in **Data** (`/app/data`). An archive contains sensitive
event input and workflow details. Keep it private and retain a new archive after
erasing a run.

## Download a backup

Select **Download archive** under **Export your data**. The archive includes
flows, runs, approvals, delivery attempts and the import journal. It excludes
owners, sign-in sessions, agent and trigger credentials, and private
configuration. It does not back up the source app or destination app.

For larger archives, stop Crank and export from the checkout root:

```sh
rer dev --stop
rer export --output exports/crank.rer
chmod 600 exports/crank.rer
```

The browser download supports archives up to 8 MiB; use the command when it asks
you to. Keep archive files outside public or shared folders.

## Restore into an empty installation

Restore requires an empty destination for product data; it does not merge into
an existing workspace. Restored legacy flows are drafts and multi-step workflows are draft or paused.
Restoration sends no events. Unfinished runs are visibly fenced, leases and
continuation authority are cleared, and waits, queues, held batches, polls and
schedules cannot advance before owner adoption. Connections need reconnection.
Open each restored workflow and select **Review restore**. The existing **Publish**
control lists its connections and every interrupted run. Reconnect the connections,
choose **Resume** or **Cancel** for each run, then select **Publish**. No run resumes
implicitly. Resumed runs keep their original frozen graph/checkpoints and are
checked against current connections at every step. Interrupted remote writes stay
uncertain: reconcile the destination before taking further action. Held events
still need their separate current cost estimate and explicit release.

Old actor IDs remain history only; invite people and create credentials afresh.
Legacy pending deliveries require a fresh receiving-owner approval. Failed or
interrupted legacy delivery history cannot be replayed from the archive; reconcile
the destination and prepare a fresh run if needed. Older archives must ultimately import with activation forced off. Until Base’s
import normalization hook ships, an unsafe older archive is refused atomically;
export it again from an updated source. DATA-001 remains partial for that gap.
Schema, integrity, workflow version digests and product links are checked before
any data is committed; unknown data is refused.

For a small archive, sign in as the owner of a fresh installation. In **Data**,
paste the archive text under **Restore into an empty installation**, type
`RESTORE`, and select **Restore archive**. The form is for small archives only;
use the command if it refuses the size.

For a larger archive, use a separate empty checkout with the app stopped:

```sh
npx -y @runeditrun/rer install just-every/run-crank
cd run-crank
rer import --input exports/crank.rer --yes
rer setup --owner-email you@example.com
rer dev
```

Supply your own owner email. The archive must be a regular private file; use
`chmod 600` on it before import. Set up the destination's owner and private
configuration separately, including the permitted destination origin and any
destination credential. Invite people and issue agent and trigger credentials
again; restored history does not recreate their sign-in access.

Review the restored flow destinations and run history before activating flows
or deliberately replaying any eligible failed run. Restore preserves history;
it does not undo an effect that already happened at a destination.

## Erase a run

1. In **Flows**, select **Pause flow** for the run's flow. Its status becomes `draft`.
2. Open the run from **Runs**. It must be `succeeded`, `failed` or `rejected`;
   pending and running runs cannot be erased.
3. Under **Erase this run**, select **Erase run and its data**.

Erasure removes the run's input, approval and attempt records from Crank. It
does not delete the source app's records or reverse an existing destination
effect. Crank retains a value-free deletion record, the run identity and an
opaque event digest to block restoration and readmission of the erased event.

Erasure invalidates local transfer snapshots and fences older archives on this
installation. A downloaded archive is a separate copy: erasing a run cannot
remove data from files you already downloaded. Handle those copies according to
your own data retention requirements.

## Erase everything about one person or key

To erase every run that carries one identifier, such as a customer's email
address or a business key, `POST /api/crank/data/subject` with
`{"subject":"..."}` as the owner. The preview lists each matching workflow run
and flow run (matched case-insensitively by business key, event id, or anywhere
in the retained trigger, inputs and outputs) and names any that must first be
finished or canceled and whose workflow or flow must be paused. Then `POST
/api/crank/data/erase` with `{"subject":"...","confirm":"ERASE","digest":"..."}`
using the preview's digest. Each run is erased with its event fence and
receipt, and the audit keeps one subject receipt with only a SHA-256 digest of
the identifier.

## Recover an older backup after erasure

Make a new export after erasure. When restoring an older backup into a different
empty installation, provide that newer post-erasure archive as the deletion
journal:

```sh
rer import --input exports/old.rer --journal exports/latest.rer --yes
```

The newer archive must come from the same source installation. It supplies later
deletion records so recovery can respect those erasures. The browser restore
form has no journal field; use the command for this recovery. Without the newer
journal, a fresh installation cannot know about deletions made after the old
backup. Keep the latest post-erasure archive with your recovery materials.

See [Get started](GETTING-STARTED.md), [Flows and runs](FLOWS-AND-RUNS.md),
[Access](ACCESS.md) and [Move in from n8n](IMPORTING.md).

Multi-step webhook run erasure uses the same owner-only door with
`{ "workflow_run_id": "RUN_ID", "confirm": "ERASE" }`. Pause its workflow and
finish or cancel the run first. The linked run values and decisions are removed;
the audit retains action chronology with an anonymized run subject and no detail.
An opaque event-key digest prevents re-admission after restart and restore.
This bounded run operation does not establish subject/operator erasure or erase
shared file references; those DATA-002 obligations remain partial.
