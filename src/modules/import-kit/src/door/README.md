# Optional D1 import door

See [ADOPTING.md](ADOPTING.md) for the single-path adoption checklist, the
owner-session mount without owner-claim, and public HTTP conformance.

Import `createImportDoorHandler`, `importDoorSchema`,
`importDoorApplyFailureMigration`, `importDoorScopesMigration`,
`writeImportDoorSettings` and `readImportDoorHistory` from `./index.ts`.
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

Until both have run, an enabled door answers every route with 503
`import_door_schema_outdated`; a disabled grant door still answers 404. The
owner-session mount (`createImportOperatorHandler` in `operator.ts`, which
exports the same schema and migrations) has no opt-in and answers 503 too.

`ik_door_scopes` binds each logical namespace to the product destination on
the first uploaded chunk, before a plan/job exists. Old applied namespaces remain scoped through their kit job id
or the recoverable `door:<plan id>` operation key. Rows the previous door wrote
in a namespace with neither link (an unplanned upload, a plan never applied,
or rows a rolled-back previous Worker keeps writing) were never applied by any
destination, so every destination's erasure withdraws them. No seed migration
has to bind them.

Import-kit custody retirement withdraws the record content in scope whole, in
the same D1 batch as native erasure, the restore checkpoint and the journal:
uploaded chunks, upload headers and saved snapshot bodies, including unapplied
uploads. The journal counts the withdrawn rows. Withdrawing door content fences
the erasure, so a values-only erasure that touches it requires the restore
checkpoint (`IMPORT_RETIREMENT_CHECKPOINT_REQUIRED` without one). Plans,
approvals, namespace heads, namespace bindings and apply-failure facts (a plan
id and an allowlisted reason code) hold no record content and stay, so the seed's history still lists a surviving import "via Business",
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

## Requests

All bodies are JSON. Quotas are admission limits, not a hosted capacity promise.

| POST route suffix | Body and result |
| --- | --- |
| `uploads` | `{ uploadId?, name, bundleSha256, totalBytes, totalChunks, index, chunkSha256, base64 }`; decoded chunks are exactly 64 KiB except the final chunk. `totalChunks` must equal `ceil(totalBytes / 65536)`. Omit `uploadId` on the first chunk to receive a server-generated UUID. Reuse it and the same bundle metadata for subsequent chunks. Both chunk and complete bundle SHA-256 are checked before reporting completion. |
| `uploads` | `{ uploadId }` returns received-chunk inventory for resuming. An identical duplicate chunk is idempotent with a fresh grant. |
| `plan` | `{ uploadId, catchup?: boolean }` returns `planId`, `fingerprint`, server-derived counts, summary, rejected rows with reasons and differences including gone source ids. Planning makes no native target writes. |
| `apply` | `{ planId, reviewedFingerprint }` creates or resumes the real kit job in bounded batches. Repeat with a fresh valid grant to continue. |
| `status` | `{ planId }` reads current job progress. |
| `reconcile` | `{ planId }` derives source-id disposition/presence and native/provenance revision, value, attachment and count checks on the server. |
| `undo` | `{ planId }` reverses the newest snapshot's attributed effects in bounded kit work, preserving native edits. |

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

## Catch-up and recovery

A logical namespace tracks a lineage of snapshots; each snapshot's kit namespace
derives from the logical namespace, the exact bundle SHA-256 and its plan id. Original source ids
remain intact. Unchanged records produce no effects but remain accounted for.
Replacements use the revision in original import provenance as
`expectedRevision`, and compare native values too, protecting edits even when
their revision was unchanged. Gone source records are reported without deletion.

Only one plan may remain pending per logical namespace until applied or undone.
Committed kit state recovers lineage after an interrupted call. Repeating a
bundle reuses its exact retained plan unless that plan's apply failed; use a fresh explicit namespace and review
for a different mapping. Undo snapshots newest first, including undo from the
seed's ordinary owner history.

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
prepare the same retained upload again in the same logical namespace. If earlier
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
