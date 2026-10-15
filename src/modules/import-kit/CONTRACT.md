# Import kit contract v1

This is an inert data import engine. It cannot send, enqueue or activate access.
The default adapter retains JSON rows and attachment originals in durable SQLite;
native integrations supply a synchronous TargetAdapter on the SAME database and
must preserve inert historical identity semantics. It is not a universal domain schema.

Public signatures are `src/types.ts` and `src/index.ts`. `planImport(source,
mapping, context)` returns an ImportPlan synchronously. All engine operations
return Promise<ImportJob>: `createImportJob(plan, context)`,
`applyImportBatches(jobOrId, context)`, `resumeImport(jobId, context)`,
`undoImport(jobId, context)`, `rollbackImport(jobId, context)`.
`readImportJob(jobId, context)` is synchronous. `reconcileImport(plan, persisted,
context)` is synchronous and independently compares each expected effect.
`openSqliteImportStorage(filename, { targets? }?)` opens a real SQLite database.
`readPersistedImport(context)` reads target rows and all active provenance in destination.
Node's built-in SQLite is the synchronous durable adapter. The additive D1
port and its distinct async batch contract are documented in src/d1/README.md;
the synchronous signatures and lease protocol below apply to Node SQLite.
No new package is required. ImportStorage transactions must be synchronous,
serializable and rollback on any thrown error. Native adapter writes are part of
that same transaction. Adapters must not invoke HTTP, queues or lifecycle hooks.

Readers export `readFileSource(input, limits?)` and
`readApiSource(input, transport)` from their own `src/readers/index.ts`; both
resolve SourceBundle. API pagination is bounded, cancellation aware and same-origin;
a token is passed only in memory. SourceBundle contains full records and exact
artifact/page byte hashes. Readers reject malformed input/size excess. Mapping
must explicitly report unsupported fields and objects. The core retains originals,
unmapped entries and source locations, including rejected objects. File input
requires an explicit parser, JSON or NDJSON format and namespace.

Plans bind principal, destination, namespace, mapping version, full source,
diagnostics, effects and attachment bytes. `context.reviewedFingerprint` is
required for job creation and must equal the plan fingerprint. Mutation of a plan
invalidates its fingerprint. An operationKey is optional; reusing one with a
different fingerprint fails. Jobs remain actor-bound even for administrators.
Authorization is synchronous and rechecked inside every mutation transaction;
assertAuthorized must throw on denial and must not return a promise. Consumer
adapters should consult current authority in the supplied database to close TOCTOU.

Exact duplicate source identities collapse with a diagnostic. Conflicting duplicates
reject planning. Identity is SHA-256 of [destination,namespace,kind,sourceId].
Previously imported changed content, changed mapping or changed effects under an
existing identity fail without modifying it. A target appears at most once in a
plan. Replacements require an explicit expectedRevision matching the current row.
Imports never silently overwrite an unrelated or natively edited row.

A durable job owns its immutable retained plan. Lease claims increase a fence and
have an expiry. Publication and reversal each revalidate lease, fence, actor,
current authority and job state. Committed batches atomically contain domain
rows, source identity ledger, provenance with before-images, journal and checkpoint.
Attachments stage under job/fence/effect identity in SQLite, then publish in the
same database transaction as their row; abandoned stages are deleted only by the
next claim holder. Stale holders never delete recovered work. SIGKILL can lose only
an uncommitted transaction. Resume waits for the previous lease expiry and reopens
the stored plan; no token or parser/mapping function is persisted or needed again.

Undo/rollback reverses attributed active effects in bounded transactions, restores
full before-images and uses exact applied revision plus value/attachment hash
comparison. A later native edit yields an explicit NATIVE_EDIT_CONFLICT and is
preserved. Reversal is restartable; completed reversal repeats without mutation.
Rollback covers already committed batches after partial failure; failed publication
itself is atomic. Once reversal starts, further apply is forbidden. Retained source
and before-image audit data remain after reversal; staging is cleaned. Source
identity claims are released only for the reversing job. Readback and reconciliation
compare identities, values, provenance and attachment hashes, not totals.

`batchSize` defaults 100 source records, max 1000; at most 1000 target effects
are published in one batch, and a source mapping over 1000 effects is rejected.
Sources/effects are processed in plan order and reversed in exact reverse order. `maxBatches` allows bounded work per invocation.
Lease duration defaults 30s and can be set shorter for offline crash tests. Each
batch is one event-loop yield, allowing other workers to claim expired work.
No automatic retry hides conflict or storage failure. The caller retries after
fixing the condition or uses rollback. API authentication tokens never enter context,
plans or the durable job; secret-bearing keys and credential URLs in persisted
metadata are rejected rather than retained.


## Exact originals and attribution (additive v1 custody contract)

Readers supply `SourceArtifact.original = { status: 'available', base64 }` for
EVERY file/API page, using canonical base64 of its exact received bytes before
parsing. Artifact `sha256` and `size` describe those bytes; whitespace, wrappers
and unsupported fields remain intact. Readers reject credential-bearing original
content, including metadata their parser excludes; they never redact bytes and
then claim the original hash. Authentication remains ephemeral. Source attachments
can be additional artifacts (including unmapped attachments); mapped attachment
bytes also receive dedicated durable custody records.

`planImport` validates canonical base64, size and SHA-256, and binds original bytes
in the reviewed fingerprint. Legacy artifacts without `original` are normalized
to `{ status: 'unavailable', reason: 'not-supplied' }`, with an explicit diagnostic.
No reconstruction of a parsed payload is an original. The same unavailable state
is returned for old durable jobs which never supplied file/page originals; their
mapped attachment bytes are read and digest-checked from the retained plan. These jobs can
still apply their parsed records but do not satisfy original-file retention.

`createImportJob` retains all available artifact and mapped attachment originals
as SQLite BLOBs in the SAME transaction as the job. Failure leaves neither a job
nor partial custody. The SQLite database in `ImportStorage` is the custody port:
a pointer to external content is not accepted. Digest/size/identity are checked
on insertion and readback; retention remains after apply, rollback and undo.
Existing lease/fence and native target atomicity are unchanged. Resume requires
no source fetch, reader/parser, credentials or mapping function.

Public synchronous `readImportOriginals(jobId: string, context: ImportContext):
RetainedOriginal[]` checks current read authority and actor/destination/namespace/
mapping binding. An artifact key is its canonical JSON `[name, sha256]`; an
attachment key is canonical JSON `[sourceIdentity, effectIndex]`. Returned
`original.status` is `retained` with exact canonical base64, or `unavailable` with
`reason: 'not-supplied'`. Missing/corrupt custody that was promised by a job fails
explicitly; it never silently becomes unavailable.

`readPersistedImport` crosschecks SQL provenance columns against record JSON and
returns optional `integrity` diagnostics on disagreement. Its normal shape stays
`{ rows, provenance }`. `reconcileImport` also checks durable source claims,
job/plan attribution, SQL identities and all active destination provenance, even
with independent `{ rows, provenance }` readback. It counts physical records;
reused JSON IDs cannot suppress extra SQL rows. It reports missing, duplicate,
extra and mismatched source/target/provenance attribution, including nonexistent
or unrelated jobs. Independent readback remains supported without extra fields.

Consumer fixture conventions, exact source accounting, prior-state expectations,
and a synthetic native SQLite adapter example are documented in
[FIXTURES.md](./FIXTURES.md). Consumer fixtures and their adapter helpers belong
under `tests/`; they are not production adapters or evidence of a real export.

### D1 sequential ownership extension

For distinct source identities, the D1 port permits explicitly reviewed replacement
of a completed import's target through exact `expectedRevision` and native-value
checks. Prior active provenance moves unchanged into durable `ik_d1_history`;
there is still one active target attribution. A predecessor cannot reverse while
superseded. Reversing the latest import atomically restores its native before-image
and predecessor attribution. See src/d1/README.md for migration and conflict
semantics. This does not change the synchronous SQLite engine's contract.

### Explicit D1 privacy withdrawal

The exact-original retention guarantee above has one deliberate D1 exception:
`eraseD1ImportTarget` may use `originalErasurePolicy: 'withdraw-affected-artifacts'`
(or conservative `withdraw-all-job-artifacts` for multi-page mappings)
to delete whole selected original artifacts while preserving other normalized
records and the job. Default erasure still refuses retained originals. Custody
readback exposes `unavailable-after-erasure` and the named policy; original bytes
are never rewritten or reconstructed. The changed plan binds the choice, and
artifact metadata and peer provenance locations lose potentially personal names.
See the D1 erasure documentation for lineage requirements and supported scope.

### Person erasure retires custody

Retained jobs are never removed as an erasure shortcut, with one exception:
`retireD1ImportCustody` deletes the whole custody of a job or stream whose
header (namespace, operation key, original name, stage header) equals an exact
identifier of the person being erased, because renaming it would break the source
identities undo and resume depend on. The person's own records elsewhere become
tombstones and every other job keeps undo and resume. A retired job or stream
keeps only a plain retirement row naming the append-only erasure journal entry,
answers `IMPORT_JOB_RETIRED` or `IMPORT_STREAM_RETIRED`, and keeps the native rows
it wrote. Matching is exact; nothing is matched as a substring. The journal holds
counts, receipt id and time, never an erased value; it and the retirements are
append-only (no update, delete or insert over an existing key). A batch that
rewrites or retires custody carries the product's restore checkpoint, so an
archive older than the erasure is refused whole under the later journal.

Credential-key validation permits a JSON boolean under the exact key `secret`,
a common noncredential visibility flag. Every nonboolean value under that key,
other credential keys and credential-bearing URLs remain forbidden, including in
raw file/API originals excluded by a parser. Accepted originals remain exact.

Public D1 planning is SELECT-only and checks the current SQL `plan` grant before
mapping and before returning. A different `read` grant cannot substitute for it.
Mutation publication retains its SQL rollback fences and action-specific grants.

Trusted reader inputs may explicitly select `paginationCursorPolicy:
'page-token-v1'` to retain and navigate documented noncredential `page_token`
URL queries. The default remains strict; the exception requires that exact query
key spelling. The finite policy is retained on SourceBundle, fingerprint-bound,
and used when validating source records and exact originals during planning,
creation and custody readback. It never changes bytes or URLs. Encoded aliases,
other credential query keys, userinfo, cross-origin API navigation/redirects and
reflected provided authentication secrets remain rejected. Target mappings retain
the strict credential policy. See the reader documentation for combining bundles
and the absence of an authentication context when reading saved files.
