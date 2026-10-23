# Import kit contract v1

For records move-in, start at the seed's signed-in owner import screen:

```text
/app/import
```

Upload a supported source export, review its plan, approve that fingerprint,
apply, reconcile and undo through the shared door. Follow
[src/door/ADOPTING.md](src/door/ADOPTING.md) for integration; the engine APIs
below implement that door rather than a second product importer. Installation
archive backup/restore is a separate recovery mechanism.

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


## Shared D1 import door with optional grant authority

`src/door/index.ts` exports `createImportDoorHandler(options)`, returning an
async `(request: Request) => Promise<Response | null>` handler for POST
`/api/rer/import/{uploads,plan,apply,status,reconcile,undo,archive,restore-check}`
(the last two grant-only: an archive of a tool's final export and its
no-write test restore). A seed must mount it
explicitly, retain its own product parser and D1 target adapter, and apply
`importDoorSchema` as a new numbered migration after the D1 schemas. No seed is
mounted by this module. The door is disabled by default and answers 404 until
the installation opts in. See `src/door/README.md` for the wire contract.

Every request requires a short-lived, single-use ES256 grant under the same
`OwnerClaimConfig` trusted key ring as owner-claim. Grants bind issuer, audience,
installation, owner email, action, namespace, expiry, nonce and upload/record
quotas. Apply additionally binds the retained plan fingerprint and the owner's
approval record and time. Its body `reviewedFingerprint` must equal both the
signed fingerprint and retained plan. Fresh grants are required for each chunk,
status request and retry. Wrong installation, action, fingerprint, expired or
replayed grants fail closed. Current enablement, key revocation and expiry are
checked inside kit mutation batches; operator-session authority is unchanged.

The seed calls `writeImportDoorSettings(database, installationId, settings,
ownerPredicate)` from its existing server-only owner session or provisioning
under the owner's approved plan. The SQL predicate checks that authority at the
write. Settings contain `enabled` and optional `revokedKids`; revoked key ids
remain revoked permanently, so rotation uses a new id. These controls are not
public door routes. `readImportDoorHistory(database, installationId,
ownerPredicate)` joins approval metadata to the real kit jobs, with the caption
"approved via Business by <owner> at <time>, fingerprint <x>". Failed target
applies end the job as `failed`, with an allowlisted reason in `job.error`:
`import_door_apply_constraint` (409), `import_door_apply_transient` (503), or
`import_door_apply_failed` (409). Status/history include a durable `failureCode`
and caption the approval as "approved, then failed". The failed atomic batch
leaves no native effects. Its approval and consumed nonce remain audit facts;
the failed plan and its approval cannot authorise a retry. Replan the retained
upload for a fresh fingerprint and owner approval; roll back earlier committed
batches first. Existing adopters apply the door migrations once each, in order, each in a
new numbered migration: `importDoorApplyFailureMigration` as one atomic batch,
then `importDoorScopesMigration`, then `importDoorArchiveMigration`; they never
re-apply `importDoorSchema`. Fresh
adopters use `importDoorSchema`, whose first statement refuses the older door
schema so a wrong upgrade fails at deploy. An enabled door on an outdated schema
(old per-bundle uniqueness, no failure table or no scope table) answers 503
`import_door_schema_outdated`; without the archive tables only `archive` and
`restore-check` answer it. Retryable D1 errors
(storage resets, code updates, lost connections, overload, timeouts) and SQLite
busy/locked classify as `import_door_apply_transient`. Configure
`ownerPrincipalId` as the seed owner's actual principal, and use that same
principal in its ordinary history and undo context. The door does not rebind
existing operator jobs or weaken their authority predicates.

Each logical namespace has a lineage of distinct bundle snapshots. Kit
namespaces derive from that logical namespace and the bundle SHA-256, preserving
original source ids. Unchanged records have no effects but remain accounted for;
changed records replace only rows the import created, fenced by their original
provenance revision and native values. Missing source records are listed, never
deleted. One plan remains pending per logical namespace until applied or undone;
kit job state recovers the lineage after interrupted calls. The same bundle
reuses its exact retained plan unless its apply failed or its import was undone
or rolled back; a catch-up never reuses an applied plan, so an unchanged source
plans a catch-up with no changes against the head. Changing mapping requires a
fresh explicit namespace and review.
Undo proceeds newest first and preserves native edits.

Bounded catch-up requires a nonempty prior snapshot and a standing owner approval
record and time. It refuses gone, conflicting, rejected or unmapped records and
refuses when additions plus replacements are at least 5% of the baseline source
count. Counts come from retained server-side source and native/provenance state,
not caller totals. Reconciliation reports source-id disposition and presence,
native/provenance revision, value, attachments and counts. Original bytes remain
in the seed; RER keeps receipts only. Native field sampling and integrated seed
acceptance remain the adopting seed's responsibility. This D1-only door has no
external side effects and makes no hosted capacity claim.

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

Credential keys are names whose whole parts are a credential word or phrase
(see `README.md`, "Credential names"): the name is split at camelCase, `_`, `-`,
`.`, spaces and digits. Refuse mode takes the whole name, after an optional
header `x-`, as the phrase: `token`, `access_token`, `refresh_token`,
`authorization`, `cookie`, `password`, `api_key`/`apiKey`, `secret`, `bearer`,
`X-Auth`, `X-Auth-Token`, `httpPassword`, `client_secret`, `private_key`,
any name with `secret`, `subscription` or `functions` before `key`
(`secret_key`, `x-functions-key`, `Ocp-Apim-Subscription-Key`), `pwd`,
`passphrase`, `jwt`, `JSESSIONID` and `PHPSESSID`, and
their plurals holding text (`tokens: [...]`, `apiKeys: [...]`), under an object
key or as the name of a `[name, value]` pair in a list of them. `sessionId` and
`sig`/`signature` are credential keys only as HTTP header names (a
`[name, value]` pair, a key under `headers`, a `{name|key, value}` pair in a
header list) and URL keys, never as record fields; a `{name|key, value}` pair
elsewhere (Help Scout's `customFields`) labels a field. `auth` and
`credentials` count only when their value is text naming no scheme or mode (not
`include` or `oauth2`), or a list with such a member; an object under them is
checked field by field, and directly under them a `value`, `pass`, `pw` or
`secret…` member (Keycloak's `credentials: [{type: 'password', value}]`,
`secretData`, nodemailer's `{user, pass}`) is a credential too. A URL query or fragment key is a
credential when it ends in such a phrase, or is a bare `key`, ends in
`sig`/`signature` (`X-Amz-Signature`), has `application`, `user`, `account`,
`deploy` or `shared` before `key`, or `token`, `basic`, `http`, `proxy` or
`api` before `auth`, or is one part ending in `apikey`, `accesstoken` or
`authtoken` (`hapikey`). Names merely containing such letters
(`keyword`, `monkey`, `author`, `signal`, `design`, `tokenizer`, `primaryKey`,
`sortKey`) are not credential keys, and neither is a longer name such as the
pagination cursor `next_page_token`.
Credential-key validation permits a JSON boolean (a common noncredential
visibility flag such as `secret: true`), and null, an empty string or a mask
(`****`, `[redacted]`, `[removed]` and similar) under any credential key: they sit
where a credential would go but are not one. Every other value under a credential
key and credential-bearing URLs remain forbidden, including in raw file/API
originals excluded by a parser. Accepted originals remain exact.

`readFileSource` with `credentials: 'remove'` (the import door's choice) keeps a
record holding a plain credential value instead. It casts a wider net than the
refusal above: it drops any field whose name's parts end in a credential word or
phrase (`httpPassword`, `client_secret`, `X-Api-Key`, `pushToken`) or its plural holding text
(`apiKeys: [...]`), the `value` of a `{name|key, value}` pair naming one or of
such a `[name, value]` pair in a list of them, and a URL's (any scheme's) user name, password and
credential query and fragment parameters, keeping booleans. It reports each
per record as a `CREDENTIAL_REMOVED` warning diagnostic (field pointer and kind,
never the value), and withholds the file's original bytes as
`{ status: 'unavailable', reason: 'credentials-removed' }`. A record that still
repeats a removed value, or a credential in a form it cannot remove (encoded or
nested in a query value), still fails.

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
