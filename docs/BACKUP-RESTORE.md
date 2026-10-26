# Backup, restore and erasure

Owners manage archives in **Data** (`/app/data`). An archive contains sensitive
event input and workflow details. Keep it private and retain a new archive after
erasing a run.

Inspect **Where data can leave** on this screen before exporting or reconnecting
a restored provider. See [Data flows](DATA-FLOWS.md) for the current request
classes, field disclosures and provider-controlled region/retention labels.

## Download a backup

Select **Download archive** under **Export your data**. The archive includes
flows, runs, approvals, delivery attempts and the import journal. It excludes
owners, sign-in sessions, agent and trigger credentials, standing grants and
rate authority, and private
configuration. It does not back up the source app or destination app.

For larger archives, stop Crank and export from the checkout root:

```sh
rer dev --stop
rer export --output exports/crank.rer
chmod 600 exports/crank.rer
```

The browser download supports archives up to 8 MiB; use the command when it asks
you to. Keep archive files outside public or shared folders.

## Interrupted transfers

Open **Operations → Service recovery** after a disconnected export or restore.
The archive transfer ID, phase and retained part count survive a service restart.
An unfinished transfer does not claim completion. Select **Resume export** to build the next ten parts from its retained cursor;
repeat until complete, then select
**Download archive** when complete. Alternatively select **Abort retained transfer**
as the owner, then start a fresh export or restore from **Data**. The abort is
attributed in the permanent audit. Export generation records that an archive was
built; Crank does not verify that you received or stored an external backup.

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

Standing-grant task versions, payloads, reviews, revisions, escalation records
and audit travel as history; their source grant credential cannot execute in the
receiving installation. When the receiving owner explicitly chooses Resume at
publish, the frozen task becomes native-owner-authorized fixed work, with its
original grant provenance still in the immutable version and audit. Any still-pending
approval requires receiving-owner review. Issue a new grant for new agent tasks.

Old actor IDs remain history only; invite people and create credentials afresh.
Legacy pending deliveries require a fresh receiving-owner approval. Failed or
interrupted legacy delivery history cannot be replayed from the archive; reconcile
the destination and prepare a fresh run if needed. An older archive written
without these fences still restores: import forces its activation off before
anything is committed (flows draft, workflows paused and awaiting adoption,
connections to reconnect, unfinished runs fenced, running remote writes
uncertain, polls and schedules parked, legacy delivery replay spent) and the
receipt counts each change by table, column and value. An older run's run-level
pause reason is not kept; its steps keep their errors.
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
Granted-task idempotency receipts likewise keep hashes and IDs only, disclosed in
the erasure receipt, to refuse a lost-response retry after the history is erased.
These local receipts and execution grants never travel in archives.

Erasure invalidates local transfer snapshots and fences older archives on this
installation. A downloaded archive is a separate copy: erasing a run cannot
remove data from files you already downloaded. Handle those copies according to
your own data retention requirements.

## Erase everything about one person or key

To erase every run that carries one identifier, such as a customer's email
address or a business key, open **Data**, enter it under **Erase a person or
key** and select **Preview erasure**; type ERASE to confirm the previewed runs.
Over HTTP, `POST /api/crank/data/subject` with
`{"subject":"..."}` as the owner. The preview lists each matching workflow run
and flow run (matched case-insensitively by business key, event id, or anywhere
in the retained trigger, inputs and outputs) and names any that must first be
finished or canceled and whose workflow or flow must be paused. Then `POST
/api/crank/data/erase` with `{"subject":"...","confirm":"ERASE","digest":"..."}`
using the preview's digest. Each run is erased with its event fence and
receipt, and the audit keeps one subject receipt with only a SHA-256 digest of
the identifier. Files uploaded to an erased run, or written by its steps, are
erased with it, and run history search no longer finds it.

## Erase a former team member

Deactivate the person in **Access** first; the owner cannot be erased. In
**Data**, select **Erase this person** under **Erase a former team member** (or
`POST /api/crank/data/erase` with `{"operator_id":"...","confirm":"ERASE"}`).
Their id becomes one random label everywhere Crank records who acted or created
something (audit, decisions, runs, versions, credentials, flows and workflows),
their sessions are revoked, any linked sign-in provider identity is removed, and
their email address and display name are replaced. What they did stays in the
history under the label, recorded as `operator.erase`. Archives never contain
sign-in identities.

## Keep data for a set time

Nothing expires until you set a period on the Data screen. Payload, attachment
and run-history periods are whole days after a run finished, counted in UTC.
Preview what a period removes first: the dry run lists every run and file it
would remove now and every run it keeps, with the reason. Saving needs that
preview. The per-minute maintenance pass then expires up to 25 runs of each
kind a minute.

- Payload expiry clears trigger data and step input and output, but keeps the
  run, its step outcomes, times, failure category and audit. The run can no
  longer be replayed.
- Attachment expiry deletes the run's files.
- History expiry removes the run and leaves a receipt without values.

Unfinished runs, runs waiting for a decision, runs with an unverified
obligation or an uncertain write, runs being repaired and held runs are never
expired. A legal hold names one exact identifier or one workflow; a held run
cannot be erased until you release the hold. An archive made before an expiry
is refused on this installation, or when you supply a later archive as the
journal.

Mark a workflow as financial or health data on the Data screen. It publishes
only after you record the provider agreements in place and where the data is
held. Crank records this as your attestation; it does not verify it.

## Encrypted customer, financial and health data

Crank encrypts the payload values of customer, financial and health workflows
(trigger data, step input, output and trace, approvals, held events and run
files) with AES-256-GCM. Each installation has its own key per data class,
sealed under the installation secret. When you classify a workflow, the
maintenance pass encrypts its earlier runs, 25 a minute.

- Name the workflow's identifier fields (for example `email, customer_id`) next
  to its data class. Erasing a person and legal holds find encrypted runs by
  business key or by an exact value of those fields. Run search text does not
  reach encrypted values.
- Rotate a key on the Data screen by typing ROTATE. New values use the new key
  at once; older values are re-encrypted in the background, and the old key is
  destroyed when nothing uses it.
- Backups carry only the encrypted values, never the keys. Download the key
  file on the Data screen (it asks you to confirm by email and to choose a
  passphrase) and keep it apart from your backups. To read a backup restored on
  another installation, import that file there with its passphrase; until then
  its encrypted values show as sealed.

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
Files the run's trigger or steps name are erased with it.


OPS-002 usage archives contain quotes and version estimates, monthly budgets and
owner allowances, reservations, value-free per-scope/month spending totals,
observations, physical request history, source-reported charges, unusable reports,
notices and budget holds. Restored budgets, allowances and pending notices are
inactive. Saving a budget is a new owner action; old allowances never reactivate.
The workflow/approval-flow DATA-001 fence remains in force, so restart and Cron
cannot dispatch restored work. Erasure removes run-linked usage details, while its
receipt discloses that value-free scope/month debit totals remain; erasure cannot
replenish an allowance.


EXEC-003 run-notice delivery and attempt rows are portable operational history.
Export and import force `crank_notice_deliveries.active=0` and clear send leases;
Cron cannot send restored notices. `crank_notice_routes` is installation-local
owner consent and is excluded. Notice records contain references/category/outcome,
not copies of run payloads. Run erasure removes deliveries and their attempts.


CONN-002 automatic-renewal timestamps and value-free renewal audit are portable
connection history; rotating-token refresh leases are excluded. Credentials
remain excluded and restored connections still need explicit reconnecting.


WORK-006 pure subflow versions are immutable portable definitions, with their
original schema, transformation list and digest. Export/import force eligibility
off. Owner digest review is separate from caller publication and cannot restore
execution authority. Runtime input/output/trace stays in the ordinary calling
run's DATA-003 custody and DATA-002 erasure. Published component references and
definition digests are checked during staging before an archive commits.

Operational tables, records, mutation receipts and value-free replay fences are portable. Tables and old operation receipts normalize inactive. The receiving native owner reviews the complete table digest and explicitly adopts it; ordinary workflow publication is still required, and an imported operation receipt never authorizes replay. Paused record erasure uses the shared journal so later journals block old records. Only non-sensitive integer/list state is supported; general record/form custody remains unimplemented.

Operational state erasure retains append-only actor/time/opaque record and operation references, with no state values; existing operator erasure governs actor attribution.

Independent invoice obligations use the existing sealed run input, output,
reconciliation trace and approval proposal and decision records. The complete
criteria, provider evidence and original operation identities travel in the
archive. Receiving workflows remain inactive; credentials and standing grants
do not travel. Importing an obligation never sends a repair or notification.

Provider drift incidents, minimal versioned proposals, retained test-case links
and checkpoint continuation links are portable. Incidents and proposals restore
inactive and sandbox bindings are cleared. They cannot authorize deployment or
release a restored run. Case expiry or erasure invalidates approval; the normal
run erasure journal covers incident, proposal, test and continuation links.
Provider schema and changelog values remain in the source run's existing sealed
payload custody, rather than an extra unprotected sample store.
