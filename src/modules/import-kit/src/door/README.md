# Shared D1 import door

To bring existing data into a seed, sign in as the owner and use its import
screen. First step: open this path on the destination app:

```text
/app/import
```

Upload a supported source export, review the plan and its differences, then
approve that exact plan to apply it. Reconcile the result against native data;
use Undo from the same history when needed. Base's reference accepts people JSON
here, not installation `.rer` archives. Editions adopt this same door
with their own supported readers and native adapters.

See [ADOPTING.md](ADOPTING.md) for the single-path adoption checklist, the
owner-session mount without owner-claim, and public HTTP conformance.

Import `createImportDoorHandler`, `importDoorSchema`,
`importDoorApplyFailureMigration`, `importDoorScopesMigration`,
`importDoorArchiveMigration`,
`writeImportDoorSettings`, `enableDoorAtFirstClaim`, `readImportDoorHistory`
and `verifyRerGrant` from `./index.ts`.
The handler returns `(request: Request) => Promise<Response | null>`; pass
unhandled requests to the seed's existing router. Only POST routes under
`/api/rer/import/` are supported. Nothing mounts a route automatically.

Construct the handler with these seed-owned options:

| Option | Meaning |
| --- | --- |
| `database`, `targets` | D1 database and its real `D1TargetAdapter`. |
| `claim` | The same server-owned `OwnerClaimConfig` and trusted key ring used by owner-claim. |
| `installationId` | Optional permanent door key for settings, lineage and history; defaults to `claim.installationId`. Use the owner-session mount's key when RER's claim id differs. |
| `ownerPrincipalId` | Actual owner principal used by the seed's ordinary import history and undo context. |
| `destination`, `mapping` | Product destination and reviewed `ImportMapping`. |
| `format`, `parse` | `'json'` or `'ndjson'`, and the product's parser of source records. |
| `source` | Instead of `parse`/`mapping`, for several sources: `source(namespace)` returns that namespace's `{parse, mapping, ownerPrincipalId?}` from the seed's server-owned allow-list, or `null`. It runs after grant verification and before any write; `null` is refused with 403 `unknown_import_source`. |
| `limits` | Optional reader limits; grant quotas still apply. |
| `reversalPolicy` | Optional undo policy for new door jobs: `'strict'` (the default) or `'preserve-conflicts'`, which keeps the owner's native edits on undo, as a seed's own preserving imports do, and needs the adapter's `preparePreservedUndo`. Existing jobs keep their policy. See ADOPTING.md. |

A fresh installation applies the statements in `importDoorSchema: string[]`
in a new product-owned numbered migration after the D1 import-kit schemas.
Preserve existing applied migration names. Copy the import-kit runtime and its
sibling owner-claim and D1 transport dependencies with their relative topology
intact.

A seed that installed an earlier door upgrades by applying the door
migrations once each, in this order, each in its own new numbered migration,
never by re-applying `importDoorSchema` (its first statement refuses an
earlier door's plan table, so re-applying it fails the deploy):

1. `importDoorApplyFailureMigration`, in a single atomic `database.batch()`
   with foreign keys enabled. It preserves every plan id, chunk and approval,
   removes the old one-plan-per-bundle uniqueness constraint and adds the
   `ik_door_apply_failures` table (see "Catch-up and recovery").
2. `importDoorScopesMigration`, the additive `ik_door_scopes` table.
3. `importDoorArchiveMigration`, the additive `ik_door_archives` and
   `ik_door_archive_chunks` tables (see "Archives").

Until the first two have run, an enabled door answers every route with 503
`import_door_schema_outdated`; a disabled grant door still answers 404. The
owner-session mount (`createImportOperatorHandler` in `operator.ts`, which
exports the same schema and migrations) has no opt-in and answers 503 too.
Until the third has run, only `archive` and `restore-check` answer that 503.

`ik_door_scopes` binds each logical namespace to the product destination on
the first uploaded chunk, before a plan/job exists. Old applied namespaces remain scoped through their kit job id
or the recoverable `door:<plan id>` operation key. Rows the previous door wrote
in a namespace with neither link (an unplanned upload, a plan never applied,
or rows a rolled-back previous Worker keeps writing) were never applied by any
destination, so every destination's erasure withdraws them. No seed migration
has to bind them.

Import-kit custody retirement withdraws the record content in scope whole, in
the same D1 batch as native erasure, the restore checkpoint and the journal:
uploaded chunks, upload headers, saved snapshot bodies and archive bytes,
including unapplied uploads. The journal counts the withdrawn rows. Withdrawing door content fences
the erasure, so a values-only erasure that touches it requires the restore
checkpoint (`IMPORT_RETIREMENT_CHECKPOINT_REQUIRED` without one). Plans,
approvals, namespace heads, namespace bindings, apply-failure facts (a plan
id and an allowlisted reason code) and archive headers hold no record content and stay, so the seed's history still lists a surviving import "via Business",
and `status` and `undo` keep working through its kit job. Where a withdrawn
snapshot is needed (`reconcile`, catch-up `plan`, an `apply` that has not
completed) the door answers 410 `snapshot_withdrawn` with `details.planId`.
Door work already in flight is fenced against the erasure: every snapshot
batch and the batch completing a plan require the source upload, a catch-up's
previous snapshot and the chunks before it, and every kit batch an `apply`
writes requires the plan's snapshot. A `plan` or `apply` racing an erasure
answers the same 410 and never writes withdrawn content back; replaying `apply`
on a completed import still answers its job. Every door batch, and every kit
batch a door request runs, also asserts that the destination's erasure journal
count is unchanged since the request was admitted, so any other request an
erasure overtakes (an upload chunk, say) answers 410 `erased_during_request`
and leaves nothing behind. Owner-session requests run under the same fence
and answer the same 410s. `plan` refuses a bundle holding an erased record
with 409 `source_erased` and deletes that upload, whatever else would refuse
that plan first: a withdrawn snapshot, a pending import, interrupted staging,
the catch-up shape or a bound. Any other bundle keeps that refusal and stays.
A catch-up keeps each unchanged record as a zero-effect entry in its own kit
job. Erasing a target a door import wrote severs the same source record in every
kit job of that door namespace, and withdraws the originals that hold it. A
resumable erasure severs those copies in the bounded steps that read their jobs.
The same steps erase each earlier import of the target that a later catch-up
superseded or that was undone, oldest first, bound to the erased target like the
copies. Every step, and the final step, fits one request in statements (1,000,
or the caller's lower limit) and in bytes (one 32 MiB D1 call); one that would
not writes nothing and is retried with fewer jobs, then with pages of one job's
entries. The final step reads the target's live import and the jobs no step has
read since they last changed, and runs the native statements. So a lineage of
any length, however often the person changed, erases as long as each job (a step
rewrites its plan whole) fits one such request, and the live import's job fits
one together with the native statements; otherwise the erasure answers
`IMPORT_D1_REQUEST_LIMIT` and writes nothing. Earlier imports outside the live
import's door namespace, or superseded under a `preserve-conflicts` job, wait
for the final step. A step or an erasure fails closed if a catch-up joins that
namespace while it reads; a retry then erases it too.
Later imports start a new namespace, or a new baseline after `undo`.
Enablement, key revocations and grant replay protection survive.

The grant door starts disabled and returns 404 until explicitly enabled. From the
seed's server-only owner control, call
`writeImportDoorSettings(database, installationId, { enabled, revokedKids? },
ownerPredicate)`. The `D1Sql` predicate must check the existing owner session,
or provisioning authority under the owner's approved plan, in the same database.
No public door route enables itself. Revoked key ids persist across settings
writes; removal is unsupported. Rotate to a new `kid` to grant access again.

An install RER provisions for a Business plan the owner approved with the door
opted in carries `RER_IMPORT_DOOR=on` alongside its `RER_OWNER_CLAIM_ISSUER`,
`RER_OWNER_CLAIM_INSTALLATION_ID`, `RER_OWNER_CLAIM_APP_ORIGIN` and
`RER_OWNER_CLAIM_PUBLIC_KEYS` trust, whatever its claim mode (bootstrap or
signed). The recommended consent path is owner opt-in: grants stay closed
under `RER_IMPORT_DOOR=on` until the owner turns Business imports on at Move
in, through the settings action above. A seed may instead open the door at the
first owner claim: when it sees exactly `on`, it calls
`enableDoorAtFirstClaim(database, installationId, ownerPredicate)` from the
path that completes its first owner claim and again from every later owner path
while the variable is `on`: the claim's already-initialized answer, and owner
sign-in or session start. The call takes the door key and a predicate that holds
once that owner exists. One batch checks the predicate before and after and
creates the settings row enabled only when the installation has no settings row
yet. So it never overrides the owner: a door the owner turned off stays off,
revoked keys stay revoked, and a repeated call changes nothing. The claim and
this batch are separate commits and the claim cannot complete twice, so if the
Worker or D1 fails between them, the next owner path's call is what opens the
door; without it the door stays closed until the owner turns it on in settings.
Before an
owner exists it writes nothing and throws 403 `owner_required`. Self-host
`rer deploy` never sets `RER_IMPORT_DOOR`, so a self-hosted door stays off until
its owner opts in.

Call `readImportDoorHistory(database, installationId, ownerPredicate)` to show
approval metadata joined to real kit jobs. The caption is
"approved via Business by <owner> at <time>, fingerprint <x>" for a job without
an apply failure. A failed apply is captioned "approved, then failed (<reason>)
via Business by …"; `state`, `error` and the durable `failureCode` accompany it.
Keep the ordinary
seed history and undo flow, using the configured owner principal and its current
owner-session predicate. Existing operator job binding remains unchanged.

## Grants

Each request carries `Authorization: Bearer <compact JWS>`. The exact protected
header is `{ "alg": "ES256", "typ": "rer-import-grant+jwt", "kid": "..." }`.
Use the existing owner-claim trusted key ring; the door does not supply a signer.
The required flat payload fields are:

| Fields | Constraint |
| --- | --- |
| `v`, `iss`, `aud` | Version `1` and the configured owner-claim issuer/audience. |
| `installationId`, `email` | Exact installation and owner identity. |
| `jti` | UUID nonce, durably single-use. |
| `iat`, `exp` | Issued/expiry Unix seconds; lifetime at most 300 seconds, future issue allowance at most 30 seconds. |
| `action` | Exactly the requested route suffix. |
| `namespace` | Logical import-tool namespace. |
| `maxBytes`, `maxChunks`, `maxRecords` | Positive quotas capped at 300,000,000 bytes, 1,024 chunks and 1,000,000 records. |

Unknown keys are rejected. Apply additionally requires `fingerprint` (64 hex
characters), `approvalRecordId` and `approvedAt` (canonical ISO timestamp).
Plan grants carry no fingerprint. Optional `catchup: 'bounded'` is accepted only
for plan/apply; bounded plan and apply grants carry the same standing owner
`approvalRecordId` and `approvedAt`. The apply body `reviewedFingerprint` must
match both the signed fingerprint and the exact retained plan.

Expired, replayed, forged, wrong-installation and wrong-fingerprint grants fail
closed. Every request needs a fresh nonce, including each chunk, upload inventory
read, status call and retry. Current enablement, key revocation and expiry are
checked inside kit mutation batches, so a previously accepted request does not
grant continuing authority after revocation or expiry.

### RER-signed reads outside the door

`verifyRerGrant(request, claimConfig, action)` lets a seed accept an RER-signed
request on its own route outside `/api/rer/import/`, such as Uptime's
`POST /api/rer/runner-status` (action `runner-status`). Pass the same
server-owned claim configuration as the grant mount. The grant uses the same
protected header and key ring; its payload is exactly
`{v, iss, aud, installationId, email, jti, iat, exp, action}`, under the same
issuer, audience, installation, owner, nonce-format and 300-second rules, with
`action` equal to the route's action. `action` is lowercase letters, digits and
hyphens, and never a door action. A door grant, an unknown or missing member,
another action, a forged signature or an expired grant answers 403
`invalid_grant`; a missing bearer 401 `grant_required`; a request not addressed
to the claim's app origin 403 `grant_binding_mismatch`; a bad configuration or
action 503 `invalid_configuration`. It returns `{grant, kid}`. It records no
nonce, so serve only reads whose repeat within the grant's life discloses
nothing more, and check `kid` against the seed's revoked keys
(`ik_door_revoked_keys` for the door key) where the route needs revocation.

## Requests

All bodies are JSON. Quotas are admission limits, not a hosted capacity promise.

| POST route suffix | Body and result |
| --- | --- |
| `uploads` | `{ uploadId?, name, bundleSha256, totalBytes, totalChunks, index, chunkSha256, base64 }`; decoded chunks are exactly 64 KiB except the final chunk. `totalChunks` must equal `ceil(totalBytes / 65536)`. Omit `uploadId` on the first chunk to receive a server-generated UUID. Reuse it and the same bundle metadata for subsequent chunks. Both chunk and complete bundle SHA-256 are checked before reporting completion. |
| `uploads` | `{ uploadId }` returns received-chunk inventory for resuming. An identical duplicate chunk is idempotent with a fresh grant. |
| `plan` | `{ uploadId, catchup?: boolean }` returns `planId`, `fingerprint`, server-derived counts, summary, rejected rows with reasons, `diagnostics` and differences including gone source ids. Planning makes no native target writes. |
| `apply` | `{ planId, reviewedFingerprint }` creates or resumes the real kit job in bounded batches. Repeat with a fresh valid grant to continue. A large source (a stored plan over 4 MiB, such as a multi-megabyte Notion export) is created in bounded staged steps within one request, and the answer may be the still `queued` job; an interrupted creation is never a job and the next `apply` resumes it from what was staged. |
| `status` | `{ planId }` reads current job progress. |
| `reconcile` | `{ planId }` derives source-id disposition/presence and native/provenance revision, value, attachment and count checks on the server. |
| `undo` | `{ planId }` reverses the newest snapshot's attributed effects in bounded kit work, preserving native edits. |
| `archive` | `{ uploadId, tool, takenAt }` keeps a fully uploaded bundle as the tool's archive; returns `archiveId`, `key`, `tool`, `takenAt`, `bundleSha256`, `bytes` and `counts`. Grant only. See "Archives". |
| `restore-check` | `{ archiveId }` parses the archive with the namespace's reader and mapping and writes nothing native; returns the archive's fields with `bundleSha256`, `bytes` and `counts` recomputed from its bytes, and `rejected`. Grant only. |

### Large sources

A large reviewed plan does not push a door request past D1's 32 MiB RPC
ceiling or its 1,000-statement budget: snapshot,
upload and original reads are paged; job creation stages the plan (and the
original it holds) a few MiB at a time and publishes the job in one small
transaction that copies the staged rows inside D1; and later batches fence the
plan's custody revision instead of resending it. No request carries a whole
plan or a whole original. See the kit README, "Large plans: staged creation and
revision fences". The seed's target adapter `planCodec`, when it has one, now
retains a door job whose plan holds no original bytes (for example, an upload
whose credential values were removed).

### Credentials and source refusals

`plan` reads the upload with the kit's `credentials: 'remove'`. A credential
field holding null, an empty string or a mask is not a credential and imports as
it is. A real value is removed from its record, which is kept: a credential-named
field is dropped: any key whose whole name parts are a credential word or
phrase (`apiKey`, `httpPassword`, `http_password`, `client_secret`, `X-Api-Key`,
`pushToken`, `integration_key`, `webhook_url`, `secret_key`, `x-functions-key`,
`Ocp-Apim-Subscription-Key`, `pwd`, `X-Auth` and the like; `Signature` and
`Session-Id` only as header names, so an agent's `signature` field stays; `auth`
and `credentials` only when they hold a credential, so `auth: {type: 'oauth2'}`
stays and `auth: {token}` loses its token); a plural
(`apiKeys: [...]`, `tokens: [...]`) when it holds text, so a count such as
`tokens: 1500` stays; the `value` of a `{name|key, value}` pair naming one
(`{name: 'Authorization', value}`), and the value of such a `[name, value]`
pair in a list of them (Sentry's header tuples). Booleans stay, and names
merely containing such letters (`keyword`, `monkey`, `author`, `signal`, `design`,
`primaryKey`) are not credential names, so a keyword monitor's `?keyword=up` URL
imports intact. A URL of any scheme, after leading whitespace, loses its
user name and password and its credential query and fragment parameters
(`api_key`, `access_token`, `sig` and the like), including the `removed@` and
`?api_key=removed` markers rer's vendor exports leave. Each removal is a
`CREDENTIAL_REMOVED` warning in `diagnostics` with the record's `kind`,
`sourceId`, the field pointer and its kind, never the value; a field holding the
`[removed]` marker rer's vendor exports leave is reported as removed before
upload. The plan never holds a removed value: the original bytes are withheld
(`ORIGINAL_UNAVAILABLE`), and the upload's chunks are deleted once the plan is
saved, keeping its header so the same plan can be fetched again. A plan refused
for any other reason (`catchup_required`, a catch-up bound, a pending import)
deletes them too. Planning such an upload again reads its records from a plan
of the same bytes the namespace still holds (one whose apply failed, or that
was undone); with none, `plan` answers 410 `upload_credentials_withheld` and
Business uploads the bundle again. These wider rules apply only to the door's
removal; the kit's default refuse mode, which seeds' local imports use, is
unchanged.

Every refusal from the reader or a bundle check is a named 4xx whose
`details.reason` is a fixed sentence and whose `details.row`/`details.pointer`
locate it; no source value is reflected:

| Error / status | Meaning |
| --- | --- |
| `source_credential` / 422 | A credential the door cannot remove: one a record repeats elsewhere, an encoded or nested credential URL, or a credential field the mapping proposes. `details.field` names its kind (`credential field "token"`, `URL user name or password`, `URL credential query parameter`, `repeated credential value`). The upload is deleted. |
| `source_invalid_or_credential_source_data` / 422 | A value the reader cannot inspect for credentials: a URL that cannot be parsed, or text encoded more than 32 layers deep. The upload is deleted. |
| `source_<reader or bundle code>` / 422 | For example `source_malformed_json`, `source_malformed_utf8`, `source_parser_failed`, `source_duplicate_source_conflict`, `source_duplicate_target`, `source_active_effect_forbidden`. |
| `source_byte_limit`, `source_record_limit`, `source_record_byte_limit`, `source_effect_limit`, `source_import_plan_too_large` / 413 | A source or plan bound. |

Bodies are limited to 100,000 bytes. The 1,024-chunk bound limits one bundle to
64 MiB even if a grant's byte quota is larger. A smaller grant quota wins.

Adapters for large records must implement a compact `matchesMany`, because plan,
reconcile and catch-up fence the destination's whole native set in one 2 MiB D1
read, and per-row `matches` or `matchesParts` guards repeat every row in full. A
native set too large for that read answers 413 `import_door_too_large`, with
`details.targetKinds` and `details.reason` naming the target kind.

Every statement a door request runs, the door's own, the adapter's and each kit
call's, counts in one 1,000-statement budget (hosted D1's per-invocation limit
on Workers Paid). A request that would exceed it answers 413
`import_door_too_large` instead of a provider error. Reconcile and catch-up
planning take each target's current state from the native rows the persisted
read fenced under its atomic guard, and read every owning plan in one query, so
their statement count does not grow with the records imported. An adapter's
`list` must read its native set in a fixed number of queries, not one per row.

Uploaded bytes and retained originals remain in the seed; RER retains receipts
only. Parsing and mapping are product-owned and cannot send, enqueue or activate
access. An adopting seed supplies its native field sampling and integrated
acceptance evidence; this module has no external side effects.

## Archives

When Business switches off a tool, it uploads the tool's final export and calls
`archive` with the `uploadId`, the tool's id (`tool`: lowercase letters, digits,
`.`, `_` and `-`, at most 64, starting with a letter or digit) and when the
export was taken (`takenAt`, a canonical ISO timestamp). The door copies the
exact uploaded bytes into the seed's own D1 as the tool's archive, named
`business-archive/<tool>/<takenAt>` (`key`), and answers its `archiveId`, the
bundle's `bundleSha256` and `bytes`, and `counts`: the reader and mapping's
counts of the bundle (`input`, `unique`, `mapped`, `rejected`, `byKind` and the
rest), as a first plan of it would report them. `counts.input` counts every
record read, a repeated identical record included, and `counts.unique` each
source identity once: to check an archive against the catch-up of the same
export, compare `counts.unique` with the catch-up's `summary.sourceRecords`, or
`counts.input` with the catch-up's `counts.input`. Archiving writes nothing native. The archive
holds its own copy, so `plan`, a catch-up, a cancelled preparation or an `undo`
never deletes it, and the upload stays usable for planning. The same request
again answers the same archive; another `tool` or `takenAt` for an archived
upload answers 409 `archive_exists` with `details.archiveId`.

An archive keeps exact bytes, so it refuses what the door never keeps: a bundle
from which the reader had to remove a live credential value answers 422
`archive_holds_credentials`. The markers rer's vendor exports leave in place of
the values they strip (`[removed]` in a field, `removed@` in a URL, `=removed`
for a query or fragment parameter) hold no credential, so such a bundle
archives, although a plan of it still withholds the original; a bundle holding an erased record answers 409 `source_erased`
and the upload goes, as `plan` does; a reader refusal answers its named 4xx. An
upload whose bytes already went (planned with credentials removed, or refused)
answers 410 `upload_bytes_withheld`: upload it again and archive before
planning.

`restore-check` with `{archiveId}` reads the archive's bytes back, checks each
chunk and the bundle hash (409 `archive_custody_mismatch` otherwise), and parses
them with the namespace's reader and current mapping without writing anything
native. It answers the archive's fields with `bundleSha256`, `bytes` and
`counts` recomputed from the bytes, and `rejected` (`kind`, `sourceId`,
`reason`). An unknown archive answers 404 `archive_not_found`; one over the
grant's quotas 403 `archive_exceeds_grant_quota`.

A person's erasure withdraws every archive's bytes in its scope with the rest
of the door's held content, and its journal counts them under
`ik_door_archive_chunks`. The archive header (id, tool, time, file name, hash,
size and kind counts) stays, so `restore-check` then answers 410
`archive_withdrawn` with `details.archiveId` and `details.reason`. The upload
went with it; the tool's export, uploaded again, is refused while it still
holds the erased person (`source_erased`).

Both are grant actions with the grant rules above: no fingerprint, approval or
`catchup`, a fresh single-use grant per call, bound to its action, namespace and
quotas. The owner-session mount answers them 404.

## Catch-up and recovery

A logical namespace tracks a lineage of snapshots; each snapshot's kit namespace
derives from the logical namespace, the exact bundle SHA-256 and its plan id. Original source ids
remain intact. Unchanged records produce no effects but remain accounted for.
Replacements use the revision in original import provenance as
`expectedRevision`, and compare native values too, protecting edits even when
their revision was unchanged. Gone source records are reported without deletion.

Only one plan may remain pending per logical namespace until applied or undone.
Committed kit state recovers lineage after an interrupted call. Repeating a
bundle reuses its exact retained plan unless that plan's apply failed or its
import was undone or rolled back: then the same bundle plans afresh, so a file
can be imported again after undo. A catch-up (`catchup: true`) never reuses an
applied plan, the head or one before it: a bundle identical to one already
applied plans afresh against the head, so an unchanged source yields a catch-up
with no changes that a standing approval can apply. Repeating it before it is
applied reuses that catch-up plan. Use a fresh explicit namespace and review
for a different mapping. Undo snapshots newest first, including undo from the
seed's ordinary owner history. Undoing a snapshot while a newer one still holds
its records answers 409 `import_superseded`; a strict undo after an owner edit
answers 409 `native_edit_conflict`. Each has a `details.reason`.

When an erasure withdrew the live import's snapshot, nothing can be compared
with it: an owner-session `plan` retires it as the baseline and plans a new
one, while a Business catch-up still answers 410 `snapshot_withdrawn`. While an
earlier import of the source still holds a record the new plan writes, the kit
would refuse its apply, so `plan` answers 409 `earlier_import_holds_records`
instead, with `details.planIds` and a `details.reason` to undo the earlier
import first; nothing is retired. After that undo the same upload plans and
applies.

An interrupted private plan preparation reports
`plan_staging_interrupted_cancel_and_replan` with `details.planId`. Call `undo` with that `planId`
to cancel its private preparation, then plan the retained upload again. A
preparation with no kit job cancels without native effects. Once a job exists,
the same route uses the kit's guarded rollback/undo instead.

An exception during the target apply ends that job as `failed`. Its native
batch is atomic: no writes from the failed batch remain. The approval and a
separate failure fact remain for audit, including after an owner rollback.
Status returns `job.state`, `job.error` and `failureCode`; history exposes the
same reason. Provider messages and customer records are never stored as reasons.

| Apply reason / HTTP status | Meaning |
| --- | --- |
| `import_door_apply_constraint` / 409 | A database constraint refused the batch. Correct the data or native writer before proposing another plan. |
| `import_door_apply_transient` / 503 | The provider reported busy, locked, interrupted or unavailable service, including D1's retryable errors (storage or code-update resets, lost connections, overload, timeouts). A fresh reviewed attempt can be proposed after recovery. |
| `import_door_apply_failed` / 409 | Another apply error. Inspect the seed's adapter before proposing another plan. |

Every failed plan is terminal: further applies return
`import_door_plan_failed`, even with a new grant or approval. The consumed grant
nonce stays consumed. A retry needs a new plan, fingerprint and approval record;
the approval associated with the failure cannot approve a retry, including a
standing catch-up approval. When checkpoint is zero, `plan` can immediately
prepare the same retained upload again in the same logical namespace, including
one whose credential-bearing bytes went: its records come from the failed
plan's snapshot. If earlier
batches committed, first finish `undo` (guarded rollback) before replanning.
The old job, immutable snapshot, approval and failure fact remain readable.

An erasure that overtakes an apply is not an apply failure: no failure fact is
recorded, the job keeps its state for `undo`, and the apply answers the
erasure's 410 (`snapshot_withdrawn` or `erased_during_request`). Nor is a kit
size or request limit, which refuses before its batch writes: the apply
answers 413 `import_door_too_large` and the plan stays applicable.

Seeds that installed an earlier door apply `importDoorApplyFailureMigration`
and then `importDoorScopesMigration`, as set out at the top of this document.

Bounded catch-up requires an existing nonempty baseline and standing owner
approval. It refuses gone, conflicting, rejected or unmapped records. Additions
plus replacements divided by baseline source count must be strictly below 5%;
the server derives these counts. A refusal leaves Business to present a new
proposal for owner review. No caller-supplied totals relax this boundary.
