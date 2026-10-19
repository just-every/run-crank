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
     `import_door_schema_outdated`.
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
   **Undo policy.** Door jobs use the kit's `strict` undo unless the runtime
   options set `reversalPolicy`. A seed whose own imports preserve the owner's
   edits on undo passes `reversalPolicy: 'preserve-conflicts'` to every door
   mount (operator and grant), and its adapter implements `preparePreservedUndo`
   (a mount refuses construction with 503 `invalid_configuration` otherwise).
   Door jobs are then created with that policy: the seed's ordinary history,
   which reads each import job with its own policy, lists them, and door undo
   after an owner edit keeps the owner's change and reverses the rest, as the
   seed's local imports do. Only new door jobs take the option; earlier ones keep
   the policy they were created with, even when an apply in flight resumes
   after the seed remounts with another policy. Strict remains the default,
   unchanged. With preserve, undoing a catch-up that kept an owner's edit
   releases the layer beneath it, so the baseline then undoes too. A
   seed that adapted `door/types.ts` and `door/authority.ts` to pass a policy
   (Lamp) drops that change, re-vendors the door verbatim and passes the option.
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
   returns a fresh `{parse, mapping, ownerPrincipalId?}` for a listed name and
   `null` otherwise; step 4 passes the same function to the grant mount. Build
   the owner handler per request from it and refuse anything else before the
   door runs. An entry may supply a mapping that needs that request's whole
   parsed bundle, or a per-request owner principal. Construction is cheap and
   stateless; plans and uploads are reachable only in their own namespace. The
   move-in screen sends the source on every call. Answer `/api/rer/import/*`
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
   This flag controls Business grants, not the owner's own imports. On an
   install RER provisions for a Business plan, `RER_IMPORT_DOOR` is `on`: when it
   is exactly `on`, call
   `enableDoorAtFirstClaim(db, installationId, ownerPredicate)` from the path
   that completes the first owner claim (bootstrap or signed) **and** from every
   later owner path while the variable is `on`: the claim's already-initialized
   answer, and owner sign-in or session start. Pass the door key and a predicate
   that holds once that owner exists. The claim and the enable are separate
   commits and the claim cannot complete twice, so the later calls are what heal
   a failure between them; without them the door stays closed until the owner
   turns it on in settings. It enables the door only while no settings row
   exists, so never write a disabled row before the first claim on such an
   install; it never reopens a door the owner turned off.
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
   seed CSRF headers. Bodies and results are in [README.md](README.md). Upload
   original bytes, show the returned counts, rejections, differences and each
   `CREDENTIAL_REMOVED` diagnostic (a credential value the door removed from that
   record), and each named source refusal's `details.reason`, then
   require the owner's review before posting `{planId, reviewedFingerprint}`.
   Repeat bounded apply calls with that fingerprint until `job.state` is
   `completed`; reconcile from native data and expose Undo. Never mint an import
   grant for this screen. Use `readImportDoorHistory` with the current owner
   predicate and the door key for approval metadata; local approvals are
   labelled `approved by`, Business approvals `approved via Business by`.
6. **Erasure.** Include retained uploads/chunks, plan snapshots/chunks, approvals,
   namespace lineage and destination bindings (`ik_door_scopes`), apply-failure
   facts (`ik_door_apply_failures`) and grant metadata in the seed's
   erasure/custody inventory,
   alongside ordinary kit originals/provenance. Withdraw an indivisible bundle
   when erasing any contained subject; preserve unrelated native records. Keep
   installation settings and permanent revoked keys. Exercise **every erase
   path with door rows present** (see Pitfalls), even with grants disabled.
   Do not omit tables from retirement tallies to hide retained personal data.
7. **Tests.** Extend existing HTTP journeys within the seed's 200-test cap. Use
   its actual migrated Worker, real sign-in, synthetic exports and public native
   reads. Cover anonymous/non-owner and cross-origin refusal, no-write planning,
   fingerprint refusal, apply/reconcile/undo, native edit protection, session
   revocation during mutation, disabled/revoked grants, owner undo while Business
   is off, the door opening at the first claim with `RER_IMPORT_DOOR=on` and
   staying closed without it, and erasure of retained door custody. No test
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
  original source bytes.
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
- **Door migrations.** Apply every door migration Base ships, each once, in
  order, in its own new numbered seed migration: today
  `importDoorApplyFailureMigration` (one atomic batch, foreign keys on), then
  `importDoorScopesMigration`. Never re-apply an updated `importDoorSchema` to
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
