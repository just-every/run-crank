# Consumer fixture layout

Put reusable importer examples under `modules/import-kit/tests/fixtures/`, with
one directory per consumer format and case. A fixture is a test input and proof
of the adapter contract; synthetic data does not verify a vendor export or
authorize a catalogue status change.

```text
tests/fixtures/<consumer>-<format>-<case>/
  manifest.json       # destination, namespace, format, artifact names and paths
  source/             # exact received file bytes, or captured API page bytes
  mapping.json        # mapping version, supported kinds and explicit omissions
  expected.json       # source accounting, effects, unmapped outcomes and snapshots
  adapter.ts          # parser, mapping and native adapter helpers for tests only
```

Keep every synthetic export, page, mapping description, expectation and adapter
helper in `tests/`. Store source inputs exactly as received: do not pretty-print a
fixture and call the reconstructed JSON the original. A file manifest names one
artifact and its `json` or `ndjson` format. A paginated API fixture lists each
response artifact in page order; its test-only transport feeds those exact bytes
to `readApiSource`. Neither case should contact a live provider. The reader's
artifact name, SHA-256 and byte length describe the exact bytes it received.

The mapping file versions the consumer's mapping and records which source kinds
and fields have native representations. Its companion `adapter.ts` implements
that specific example with the public reader and planner APIs. Preserve every
parsed source object, including unsupported kinds. Map supported fields and
report each unsupported field and unsupported object in the plan's `unmapped`
outcomes; do not silently discard them. Keep source outcomes separate from
target effects: one source can have several effects, partial unmapped fields,
or no native effect at all. `expected.json` should name every source identity
and its expected effects or unmapped reasons, plus the plan counts. Check that
`input` equals reader record count and that `unique + duplicates` accounts for
every parsed record. Duplicate identities remain visible in reader diagnostics;
conflicting duplicate content rejects planning.

Record the initial native rows as `priorState` before planning. An effect that
replaces an existing row must carry that row's reviewed `expectedRevision`; a
new row must have no prior row. The fixture must state the expected native rows
after each exercised apply batch, after completion, and after undo. Use a real
`TargetAdapter` on the same SQLite database as the import journal, with native
constraints for important relations. Assert the relation's physical row as well
as the import kit's readback and reconciliation result.

After plan review, `createImportJob` retains each available artifact's exact
original bytes in SQLite. Tests should read them back with
`readImportOriginals` and compare name, digest, size and bytes. Mutating the
reviewed source originals or mapped effects must make job creation fail the
fingerprint check. The mapping function itself is not persisted: changing its
behavior requires a new mapping version and a newly reviewed plan.

For a resumable fixture, cap apply with `maxBatches`, close the database, reopen
the same native SQLite file, and call `resumeImport` using only the durable job.
Do not re-read the source or rerun the mapping to resume. Reconcile the completed
job against native readback, then undo it and compare the full native state with
`priorState`. Undo must restore replaced before-images, remove new imported rows
in relation-safe order, preserve unrelated native rows, and leave retained
original custody available. Existing native edits should be tested as explicit
conflicts when the fixture covers that case.

`workspace-archive-v1` in this directory is a synthetic file consumer example.
It exercises partial mapping, an unsupported source kind, a native relation,
prior state, original custody, durable resume and undo. It makes no claim about
any real product export or importer.

## Adding a non-Lily adapter example

Create a new fixture directory and keep the runnable test at
`modules/import-kit/tests/<consumer>-fixture.test.ts`; Base's existing
`node --test modules/*/tests/*.test.ts` command discovers files at that level.
Use `readFileSource` or `readApiSource` on the fixture's exact source bytes, and
make the parser account for every source object and stable source ID. Implement
the example's `ImportMapping` and native `TargetAdapter` in the fixture's
`adapter.ts`, backed by the same SQLite connection passed to
`openSqliteImportStorage`. Keep this code specific to the consumer and under
`tests/`; a fixture does not justify adding a production adapter abstraction.

Fill `expected.json` with the plan counts, each unique source ID's effects and
unmapped reasons, the initial rows, a bounded batch snapshot, the completed
native rows, and the expected rows after undo. Include the exact source artifact
hash and size. The test should compare `readImportOriginals` byte-for-byte,
reject reviewed-source and mapping-result tampering, close and reopen the SQLite
file before resume, and verify native relations and the final before-image.
`reconcileImport` compares plan effects with all rows returned for its
destination; when a fixture includes unrelated existing rows, assert their
unchanged state and report any explicit `extra` reconciliation outcomes instead
of treating them as successful imported effects.
