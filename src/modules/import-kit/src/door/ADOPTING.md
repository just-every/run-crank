# Adopt one import pipeline

For an owner moving data, start at the seed's signed-in import screen:

```text
/app/import
```

In a Base checkout, the [default reference journey](../../../../default-seed/IMPORTING.md) uses
an exported people JSON file, review, apply, reconcile and undo. The
[local-run guide](../../../../export/RUN-LOCALLY.md) describes how to launch and
claim the local app. Installation `.rer` archive recovery is currently a
separate developer-only mechanism; it is not accepted by this door.

Installation backup/restore keeps its archive integrity and erasure fences. It
is separate from bringing records in; never claim an archive traverses the door.

The seed's signed-in move-in screen, `rer` and Business must share **upload →
plan → reviewed fingerprint → apply → reconcile → undo**. Keep source readers,
mappings and native target adapters; delete the old importer routes, separate
job creation/apply code and their callers. Do not leave a hidden second importer.
Owner history and undo must include jobs from either authority.

## Add to the seed

1. **Schema and copies.** Vendor `modules/import-kit/src`, its schema JSON in
   `modules/import-kit/schema`, and sibling `./modules/d1-transport` with relative
   paths intact; record copies using the
   seed's existing Base provenance workflow. Never rename applied migrations.
   Refresh the recorded kit copies together with `rer refresh-base`. For example,
   `atomic-prefix.ts` and `budget.ts` must agree on the `batchExecutions` export.
   Unadapted recorded dependencies advance together. If a dependency is marked
   adapted or is unrecorded seed source, refresh preserves it and refuses before
   writing when an incoming module needs an export it lacks. Use the printed
   comparison command, merge the required exports while preserving seed edits,
   and remove the comparison file. For a recorded adaptation, run the printed
   `adapt-base` acknowledgement after the merge, then repeat refresh. Acknowledging
   the old bytes alone does not resolve a missing export.
   Apply these in new numbered seed migrations, in this order,
   skipping any the seed already applied:
   - the D1 kit schemas, in the order `initializeD1ImportStorage` in
     `modules/import-kit/src/d1/database.ts` installs them (all exported from
     `modules/import-kit/src/d1/index.ts`): `d1Schema` (with
     `preservedUndoEvolution`), `d1ErasureSchema`, `d1StreamOriginSchema` and
     `d1LegacyStreamReceiptUpgrade`, `d1StagingSchema`, `d1NativeStagingSchema`,
     `d1CustodyStateSchema`, `d1ReversalFenceSchema`, `d1PreparationSchema`,
     `d1PreparationStepsSchema`, `d1RetirementSchema`,
     `d1CustodyStateReplaceSchema` (Base's default seed ships it as
     `default-seed/migrations/core/0026_import_custody_replace.sql`) and
     `d1ErasureProgressSchema`, plus the
     kit evolutions in `modules/import-kit/src/d1/README.md` that apply to the
     seed;
   - a seed without a door: `importDoorSchema` from
     `modules/import-kit/src/door/schema.ts` (also exported by `index.ts` and
     `operator.ts`);
   - a seed that already installed an earlier door: never `importDoorSchema`
     again (it refuses that schema at deploy), but
     `importDoorApplyFailureMigration` as one atomic batch, then
     `importDoorScopesMigration`. Until both are applied, the door answers 503
     `import_door_schema_outdated`. Then `importDoorArchiveMigration`; until it
     is applied, only `archive` and `restore-check` answer that 503.
   - only when an installed adapter declares `intake`:
     `importDoorIntakeMigration`, which adds nullable `intake_json` to
     `ik_door_uploads`. Fresh `importDoorSchema` includes the column. Existing
     undeclared installations need no intake migration or upload changes.
2. **Native adapter.** Supply the seed's real `D1TargetAdapter`, parser,
   `ImportMapping`, destination and actual owner principal. Read/write/remove
   guards must protect native revisions and values in the same D1 transaction.
   Mapping only creates inert native records: importing cannot send mail, page
   someone, activate monitors or grant access. Keep any activation as a separate
   owner-approved product action. Declare unsupported records as rejections or
   explained omissions; never fabricate success. `write` must also replace an
   already-imported target for catch-up, `list` must read the native set in a
   fixed number of queries, and large imports need a compact `matchesMany`
   (see Pitfalls).
   **Undo policy.** An adapter declaring `preparePreservedUndo` automatically
   selects `preserve-conflicts` for each new door job, on both operator and
   grant mounts. An adapter without that method keeps the kit's `strict`
   policy. `reversalPolicy` remains an explicit override; requesting preserve
   without the method refuses construction with 503 `invalid_configuration`.
   No seed-specific change to the vendored door is needed. For example, Orbit's
   native adapter declaring the method makes new door imports preserve native
   edits after re-vendoring this door; this does not change earlier strict jobs.

   The selected policy is persisted and integrity-bound at job creation.
   Apply resume, status, undo and request replay use that stored policy, even
   after an adapter upgrade or a different mount setting. Adding the method
   never upgrades an earlier strict job. Removing it from an adapter needed by
   an existing preserving job refuses further apply batches and active undo
   before native effects; restore a compatible adapter to undo earlier batches.
   Apply resumes still use the stored policy. Every preserving publication
   needs a valid preparation; if refused, that plan needs a new plan and approval. Keep adapter ownership
   projections compatible with previously recorded undo evidence.

   Before every preserving apply publication, including resumed or replayed
   applies with pending work, the kit validates the adapter's preparation for
   that batch's prospective effects in a read-only admission. Invalid structure
   or a false observation fence answers 409 `import_door_apply_failed`, with no
   effects from the refused batch. At checkpoint zero no imported native rows
   remain; a new plan and approval are required. Admission makes
   no undo decision and does not authorize effects: apply retains its existing
   exact before-image and current-authority guards in each write transaction.
   A later failed batch leaves earlier committed progress available to undo.
   For small consecutive batches in one request, preparation can admit a window
   before any of its effects publish. Every batch checks its exact prospective
   effects against that admission; changed effects or adapter methods require a
   new preparation. Admission never carries across requests.

   Preserving undo reverses unchanged independent rows and leaves native edits,
   native deletions and their required dependencies untouched. The door returns
   `job.state: 'undone'` when finished, including when every effect was retained;
   it does not answer a strict native-edit 409 for those conflicts. The durable
   kit `readD1ImportUndoReport` reports `outcome: 'compensated'` when anything
   was retained, with `retained` dispositions and `edited`, `dependency` or
   `superseded` reasons; otherwise its outcome is `undone`. Read report pages
   through the seed's owner-authorized kit context for native history details.
   Repeated undo is idempotent. Undoing a catch-up that kept an owner's edit
   releases the layer beneath it, so the baseline can then undo too.

3. **Operator mount.** Import `createImportOperatorHandler` from
   `modules/import-kit/src/door/operator.ts`. Supply the runtime options in
   `types.ts`, plus server-owned `installationId`, `appOrigin`, `ownerEmail`,
   `namespace`, and `authorize(request, action)`. That callback authenticates the
   current owner with the seed's normal session/CSRF checks and returns a
   `D1Sql` predicate checking that exact session and owner in the same database;
   return `null` for other callers. The predicate is rechecked inside mutations.
   Mount the handler before ordinary route rejection, including the host router
   and body-size boundary; pass its `null` response to the next dispatcher.
   `installationId` is the **permanent door key** for settings, lineage and
   history: pick one stable server-owned value (the RER owner-claim installation
   id when the seed already has it, otherwise a fixed seed value) and never
   change it.

   **Several import sources.** One namespace per source (for example one per
   vendor). Keep **one** server-owned allow-list, `importSource(name)`, that
   returns a fresh `{parse, mapping, ownerPrincipalId?, intake?}` for a listed
   name and `null` otherwise; step 4 passes the same function to the grant mount. Build
   the owner handler per request from it and refuse anything else before the
   door runs. An entry may supply a mapping that needs that request's whole
   parsed bundle, or a per-request owner principal. Construction is cheap and
   stateless; plans and uploads are reachable only in their own namespace. The
   optional `intake` is a static declaration of formats and fields per source, shared
   unchanged with both mounts. Declare it when the source contract forbids
   retaining other fields, so the door drops them before any persistent write,
   rather than dropping them later in the product parser. See the
   [Auth example below](#example-auth-source-contract).
   The move-in screen sends the source on every call. Answer `/api/rer/import/*`
   with 404 here: a configured grant mount (step 4) runs before this handler.
   ```ts
   const sources = {pagerduty: pagerDutyImport, opsgenie: opsgenieImport}; // server-owned factories
   export const importSource = (name: string) => Object.hasOwn(sources, name) ? sources[name]() : null;
   export async function importDoor(request: Request, env: Env) {
     const path = new URL(request.url).pathname;
     if (path.startsWith('/api/rer/import/')) return Response.json({error: 'not_found'}, {status: 404});
     if (!path.startsWith('/api/operator/import/')) return null;
     const name = request.headers.get('X-Import-Source') ?? '', source = importSource(name);
     if (!source) return Response.json({error: 'unknown_import_source'}, {status: 400});
     return createImportOperatorHandler({...runtime(env), ...source, namespace: name})(request);
   }
   ```
4. **Settings and grants.** The door is off until a settings row enables it;
   the owner's settings action writes it with
   `writeImportDoorSettings(db, installationId, {enabled}, ownerPredicate)`.
   This flag controls Business grants, not the owner's own imports.
   **Recommended consent path: owner opt-in.** On an install RER provisions for
   a Business plan, `RER_IMPORT_DOOR` is `on`, and grants still stay closed
   until the owner turns **Business imports** on at Move in (step 5's screen,
   through that settings action). Never write an enabled row on the owner's
   behalf. Until then every grant route answers 404 and the owner's own imports
   work as usual.
   `enableDoorAtFirstClaim(db, installationId, ownerPredicate)` remains
   available for a seed that instead opens the door at the first owner claim
   when the variable is exactly `on`: call it from the path that completes the
   first owner claim (bootstrap or signed) **and** from every later owner path
   while the variable is `on`: the claim's already-initialized answer, and
   owner sign-in or session start. Pass the door key and a predicate that holds
   once that owner exists. The claim and the enable are separate commits and
   the claim cannot complete twice, so the later calls are what heal a failure
   between them; without them the door stays closed until the owner turns it
   on in settings. It enables the door only while no settings row exists, so
   never write a disabled row before the first claim on such an install; it
   never reopens a door the owner turned off.
   Self-host `rer deploy` never sets the variable. Read the grant mount's claim
   configuration from `RER_OWNER_CLAIM_ISSUER`, `RER_OWNER_CLAIM_INSTALLATION_ID`,
   `RER_OWNER_CLAIM_APP_ORIGIN`, `RER_OWNER_CLAIM_PUBLIC_KEYS` and the owner
   email; RER sets that trust on Business installs whatever the claim mode. If the seed
   has owner-claim, additionally mount `createImportDoorHandler` from `index.ts`
   with the **same** server-owned claim/key-ring configuration and
   `installationId` set to the operator mount's door key (it defaults to
   `claim.installationId`). With several sources, pass `source: importSource`
   (step 3's allow-list) instead of `parse`/`mapping`: the door calls it with
   each verified grant's namespace before writing anything, parses with that
   entry, and refuses an unlisted namespace with 403 `unknown_import_source`.
   Dispatch this grant handler **before** the operator
   handler. Enable only through an owner
   settings action or `enableDoorAtFirstClaim` under the owner's provisioning
   approval. Keep durable key
   revocations and show them in that settings row; re-enabling never unrevokes.
   A seed route RER reads outside the door (Uptime's runner status) verifies
   its request with `verifyRerGrant(request, claimConfig, action)` from
   `index.ts`; see README.md.
5. **Move-in screen.** Call POST `/api/operator/import/{uploads,plan,apply,status,
   reconcile,undo}` with the current owner cookie, exact `Origin` and normal
   seed CSRF headers. Show the **Business imports** setting here (step 4): it
   starts off, and the owner's switch is what opens the door to Business
   grants. Bodies and results are in [README.md](README.md). Without declared
   intake, upload original bytes through the existing JSON chunk protocol.
   With intake, POST the full raw stream to the same uploads route with
   `Content-Type: application/octet-stream`, `X-Import-Format` and `X-Import-Name`;
   custody and response hashes then describe sanitized NDJSON. Do not send
   JSON chunk envelopes or a client sanitizer/hash for that source. Show the
   returned counts, rejections, differences and each
   `CREDENTIAL_REMOVED` diagnostic (a credential value the door removed from that
   record), and each named source refusal's `details.reason`, then
   require the owner's review before posting `{planId, reviewedFingerprint}`.
   Repeat bounded apply calls with that fingerprint until `job.state` is
   `completed`; reconcile from native data and expose Undo. Never mint an import
   grant for this screen. Use `readImportDoorHistory` with the current owner
   predicate and the door key for approval metadata; local approvals are
   labelled `approved by`, Business approvals `approved via Business by`.
6. **Erasure.** Include retained uploads/chunks, plan snapshots/chunks, archive
   bytes (`ik_door_archive_chunks`, withdrawn whole) and headers, approvals,
   namespace lineage and destination bindings (`ik_door_scopes`), apply-failure
   facts (`ik_door_apply_failures`) and grant metadata in the seed's
   erasure/custody inventory,
   alongside ordinary kit originals/provenance. Withdraw an indivisible bundle
   when erasing any contained subject; preserve unrelated native records. Include
   partial sanitized uploads left by interrupted or invalid intake streams;
   forbidden raw fields were never stored. Keep installation settings and
   permanent revoked keys. Exercise **every erase path with door rows present**
   (see Pitfalls), even with grants disabled.
   Do not omit tables from retirement tallies to hide retained personal data.
7. **Tests.** Extend existing HTTP journeys within the seed's 200-test cap. Use
   its actual migrated Worker, real sign-in, synthetic exports and public native
   reads. Cover anonymous/non-owner and cross-origin refusal, no-write planning,
   fingerprint refusal, apply/reconcile/undo, native edit protection, session
   revocation during mutation, disabled/revoked grants, owner undo while Business
   is off, grants staying closed under `RER_IMPORT_DOOR=on` until the owner
   turns Business imports on (or, if the seed uses `enableDoorAtFirstClaim`,
   the door opening at the first claim and staying closed without the
   variable), and erasure of retained door custody. No test
   skips or SQL bypasses.

**Without owner-claim:** vendor the operator runtime, omitting the three optional
grant-only files `door/index.ts`, `door/admission.ts` and `door/grants.ts` from
the source-copy inventory. Import `operator.ts` directly. This also lets a seed
typecheck its entire copied source tree without unresolved owner-claim imports.
Do not vendor owner-claim or operator-auth merely for imports: the operator
runtime has no dependency on either;
use the seed's existing owner authentication. All `/api/rer/import/*` requests
return 404 through that mount. No signer, dummy claim configuration or grant is
needed. Keep the `installationId` you chose: it stays the door key. To add
Business later, add those three grant files, `modules/owner-claim/verify.mjs`
and its dependency `modules/operator-auth/loopback.mjs`, then configure its
trusted ring with RER's claim installation id, pass your existing door key as
the grant mount's `installationId` (and, with several sources, your
`importSource` as its `source`), mount the grant handler first and explicitly
opt in. Earlier owner imports then stay in history, and Business catches up on
their lineage instead of re-creating them. The existing grant signature, nonce,
scope, expiry and approval rules do not change.

## Example: Auth source contract

Auth's [MOVE-IN contract at commit 35c2080](https://github.com/just-every/run-auth/blob/35c2080c07c0c17fc7fd1315f0899bd953f0fa2e/MOVE-IN.md)
keeps email, name, disabled state, provider id and review context. Credentials,
MFA, roles, sessions and policies do not move. Its Auth0 and Okta sources can
declare separate intake lists:

```ts
const auth0Intake = {
  formats: ['csv', 'ndjson'],
  allow: {
    csv: ['user_id', 'email', 'name', 'blocked'],
    ndjson: ['/user_id', '/email', '/name', '/blocked'],
  },
} as const;
const oktaIntake = {
  formats: ['json'],
  allow: {
    json: ['/id', '/status', '/profile/email', '/profile/login',
      '/profile/displayName', '/profile/firstName', '/profile/lastName',
      '/profile/department'],
  },
} as const;
```

Auth0's CSV and NDJSON lists contain only those four fields. Okta's Users API
JSON array retains email with login as fallback, displayName with firstName
plus lastName as fallback, and department for review only. Those choices stay
in the product parser/mapping; intake only drops fields and preserves values.

Return each declaration with its source's `{parse, mapping, ownerPrincipalId?,
intake?}`. The operator mount spreads that source entry and the grant mount
uses the same `importSource` resolver, so both enforce the same list before
custody. This is a documentation example, not an Auth seed change. See the
[streaming protocol and scalar-leaf rules](README.md#optional-intake-before-custody).

## Pitfalls found in adoptions

- **Credential fields in exports.** Vendor exports carry credential-named
  fields (UptimeRobot's `apiKey: null` on every monitor) and URLs with
  `user:pass@`. The door reads every upload with the kit's `credentials:
  'remove'`: null, empty, masked and boolean values pass, and a real value is
  removed from its record, which is kept and noted. Names match by whole parts
  (camelCase, `_`, `-`, digits), not letters: it covers compound names
  (`httpPassword`, `client_secret`, `customHttpHeaders['X-Api-Key']`,
  `secret_key`, `Ocp-Apim-Subscription-Key`, `X-Auth`, `pwd`), plurals holding
  text (`apiKeys: [...]`), header pairs (`{name: 'Authorization', value}`) and
  `[name, value]` header tuples, and URLs of any scheme, including the markers
  rer's vendor exports leave (`removed@`, `?api_key=removed`). Look-alikes such
  as UptimeRobot's `?keyword=up`, `author`, `signal` or `primaryKey` are not
  credentials and import with the URL and fields intact, and neither is a
  support export's agent `signature` or a chat's `session_id` (`Signature` and
  `Session-Id` count only as header names), nor `auth: {type: 'oauth2'}` or
  `credentials: []`. The plan
  holds none, the original bytes are withheld and the upload's chunks are
  deleted once the plan is saved, or once a plan of them is refused.
  Do not drop such records or fields in the seed's parser to get past a refusal.

- **Export custody.** A seed whose export policy excludes import custody
  (`excludeTables`) must also exclude `ik_door_%`; door uploads and plans hold
  original source bytes for undeclared sources, or sanitized NDJSON custody
  for declared intake sources.
- **Catch-up writes.** Catch-up replaces imported targets; the kit guards each
  replacement with `expectedRevision` from the import's provenance and the full
  before-image. `write` must upsert the target, replace the child rows it owns
  and set its new revision in the same statements, without cascading deletes
  into rows that reference it. An insert-only writer fails every catch-up apply
  with 409 `import_door_apply_constraint`; that plan is then terminal, so fix
  `write` and plan again for a fresh approval.
- **Large imports.** Reconcile and catch-up planning guard the destination's
  whole native set in one read capped at 2 MiB. Without `matchesMany`, guards
  that inline row values exceed that read (Lamp's 124-record Statuspage fixture
  did), and the door answers 413 `import_door_too_large`, naming the target
  kind. Implement a compact exact `matchesMany(rows, destination)`: counts per
  kind, revision markers and an in-SQL digest of each entity's owned rows
  compared with the hash of its listed value (Base's default seed `personSet` in
  `default-seed/src/core/features/people/imports.server.ts` is one). A native
  set still past that read gets the same 413. Every statement of one door
  request also counts in one 1,000-statement budget, so `list` must read the
  native set in a fixed number of queries, not one per row; past the budget the
  door answers the same 413. Test reconcile and catch-up on the seed's largest
  fixture.
- **Erasure.** Run every erase path (each public erasure route, account,
  project or workspace deletion, retirement) with door rows present (an applied
  import's uploads, plans and approvals), not only with the tables installed.
- **Door migrations.** Apply every mandatory door migration Base ships, each once, in
  order, in its own new numbered seed migration: today
  `importDoorApplyFailureMigration` (one atomic batch, foreign keys on), then
  `importDoorScopesMigration`, then `importDoorArchiveMigration`. Apply optional
  `importDoorIntakeMigration` only for installed adapters declaring intake.
  Never re-apply an updated `importDoorSchema` to
  an installed door: its `CREATE TABLE IF NOT EXISTS` statements would skip
  changed tables, so its first statement refuses an earlier door's plan table
  and the deploy fails.

## Real integration example: Spool

[Spool PR 9](https://github.com/just-every/run-spool/pull/9) demonstrates the
native integration: `migrations/core/0041_business_import_door.sql`,
`src/domain/sentry-import/door.server.ts`, `source.ts`, `mapping.ts`, `targets.ts`
and `context.ts`; settings/history in `business-routes.ts` and
`src/ui/workbench/BusinessImports.tsx`; custody in
`src/domain/erasure/business-custody.ts`; public HTTP proof in
`tests/business-import.mjs` using `tests/worker.mjs`, `tests/auth.mjs` and
`tests/archive.mjs`. These paths are in Spool. Its Sentry parser and adapter are
reused, imports remain historical, and project erasure withdraws duplicate door
custody. That PR still keeps `/api/imports/sentry`: finishing single-path adoption
requires replacing that caller with the operator mount and deleting the old
HTTP importer in `src/domain/sentry-import/routes.ts`.
Do not copy its older vendored door instead of current Base.

## Raw source files

For ZIP or another binary export, declare `format: 'raw'` and
`readRaw(upload, limits)` instead of `parse`. The same source declaration serves
both mounts, including a grant allow-list entry. The reader receives the verified
`upload.bytes` (`Uint8Array`), `name`, `sha256` and `size`, before any text decoding,
and returns a `ParsedRecord[]` (or a promise of it). Bound archive expansion while
reading, inspect every member for credentials, and reject malformed or unsupported
archives; thrown errors become a non-secret 422 `source_raw_reader_failed`.
The door validates returned records, retains the exact original archive and binds
it to the reviewed fingerprint. Raw sources cannot declare `intake`, which changes
custody bytes. Chunk uploads have at most 1,024 chunks of 64 KiB: a 64 MiB
(67,108,864-byte) ceiling, also the default owner quota. Signed quotas can reduce
it. `limits.maxBytes` may lower it further and is checked before the
reader runs; excess upload declarations are refused, or planning answers 413
`source_byte_limit` (a previously retained upload above a lowered owner quota
answers 403 `upload_exceeds_grant_quota`). Record count and per-record byte limits still apply. Export
exclusion, erasure of complete or partial custody, archive restore-check, catch-up
and Undo use the existing lifecycle and require the same seed integration proof.

## Copyable public HTTP conformance

Copy the following into an existing seed test journey and call `checkDoor`.
It needs only Node built-ins. `request(action, body, review)` must return the
actual HTTP `Response`: use owner-cookie requests to the operator mount, or
mint a **fresh action-bound grant per call** for the grant mount (the apply
`review` argument supplies its signed fingerprint/approval). `nativeSnapshot`
reads a stable projection of native records through the seed's public API/export,
excluding import bookkeeping. Supply nonempty synthetic source bytes plus
`assertApplied(before, after, report)` and `assertUndone(before, after)` to check
real field values and the seed's undo policy. Those hooks must use public reads,
not SQL, mocks or precomputed results. The existing seed journey separately
covers settings, revocation, native edits and erasure as above.

The chunk-upload portion below is for a source **without** an intake
declaration. For declared intake, replace it with one authenticated streaming
upload using the headers in [README.md](README.md#optional-intake-before-custody).
Take `bundleSha256` and received sizes from that response/inventory and compare
those custody hashes across plan and reconcile; do not assert the raw input's
hash or size. Assert `intake.sanitized`, `inputFormat`, `custodyFormat` and the
server-derived `allowlistSha256`, and exercise forbidden-field exclusion,
invalid-row refusal and partial-upload erasure in that source's HTTP journey.

```js
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function checkDoor({request, bytes, name, nativeSnapshot,
  assertApplied, assertUndone}) {
  const hash = b => createHash('sha256').update(b).digest('hex');
  const json = async (action, body, review, expected = 200) => {
    const response = await request(action, body, review);
    assert.equal(response.status, expected, `${action}: ${response.status}`);
    return response.json();
  };
  const until = async (action, body, review, state) => {
    for (let batch = 0; batch < 100; batch++) {
      const result = await json(action, body, review);
      if (result.job?.state === state) return result.job;
      assert.ok(['queued','applying','undoing'].includes(result.job?.state));
    }
    assert.fail(`${action} did not finish`);
  };
  assert.ok(bytes.length > 0);
  const before = await nativeSnapshot(), bundleSha256 = hash(bytes);
  const totalChunks = Math.ceil(bytes.length / 65536);
  let uploadId;
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * 65536, (index + 1) * 65536);
    const uploaded = await json('uploads', {uploadId, name, bundleSha256,
      totalBytes:bytes.length, totalChunks, index,
      chunkSha256:hash(chunk), base64:chunk.toString('base64')});
    uploadId = uploaded.uploadId;
  }
  const inventory = await json('uploads', {uploadId});
  assert.equal(inventory.complete, true);
  assert.equal(inventory.bundleSha256, bundleSha256);
  assert.equal(inventory.received.reduce((n,c) => n + c.size, 0), bytes.length);
  const plan = await json('plan', {uploadId});
  assert.equal(plan.bundleSha256, bundleSha256);
  assert.ok(plan.summary.sourceRecords > 0);
  assert.deepEqual(await nativeSnapshot(), before);
  const review = {fingerprint:plan.fingerprint,
    approvalRecordId:randomUUID(), approvedAt:new Date().toISOString()};
  const wrong = (plan.fingerprint[0] === '0' ? '1' : '0') + plan.fingerprint.slice(1);
  await json('apply', {planId:plan.planId, reviewedFingerprint:wrong}, review, 403);
  assert.deepEqual(await nativeSnapshot(), before);
  const job = await until('apply', {planId:plan.planId,
    reviewedFingerprint:plan.fingerprint}, review, 'completed');
  const status = await json('status', {planId:plan.planId});
  assert.equal(status.job.id, job.id);
  assert.equal(status.job.state, 'completed');
  const report = await json('reconcile', {planId:plan.planId});
  assert.equal(report.ok, true);
  assert.equal(report.fingerprint, plan.fingerprint);
  assert.equal(report.bundleSha256, bundleSha256);
  assert.equal(report.counts.sourceRecords, plan.summary.sourceRecords);
  assert.equal(report.counts.present + report.counts.explained, report.counts.sourceRecords);
  assert.equal(report.sourceIds.length, report.counts.sourceRecords);
  await assertApplied(before, await nativeSnapshot(), report);
  await until('undo', {planId:plan.planId}, undefined, 'undone');
  await assertUndone(before, await nativeSnapshot());
}
```

For a concrete grant client and harness see Spool's `tests/business-import.mjs`;
its `grant`, `doorRequest`, `nativeSnapshot`, `startTestWorker` and `signIn`
provide those network edges. Run with `nice -n 15 node <existing-test-journey>`
after the seed's normal build. No `rer check` extension is required.
