# sx-crank-restore-bridge-fix1

Repository: just-every/run-crank
Product branch: cloud/sx-crank-restore-bridge-fix1
Candidate: 1780553f1cae64f9026db32567cb84983fa9a137
Start: 0b8655204eeba01ba499becbfc727763a1e356de
Scope: blocking A only, earlier-archive restoration with a missing additive migration sorting between recorded migration filenames.

## Plan and implementation

The full plan is in [PLAN.md](PLAN.md). The existing bridge was started from the requested full-history head. Its prefix cache could supply schema hashes only for filename prefixes. The shared importer instead places an archive using its recorded ledger and selects every missing applied migration.

The bridge now resolves destination-owned files in the destination ledger's order, filters that ordered list by the importer's chosen migration names, and uses cached hashes when available. Any other chosen set is replayed in an isolated memory-only SQLite engine. The resulting schema identity uses the shared importer's own catalogue and identity functions. No archive SQL is executed and replay never writes to the product database. Existing schema, additive-change, integrity, staging, semantic and atomic destination checks remain in the shared importer.

A pinned sql.js dependency supplies SQLite to Workers, which cannot open node:sqlite. Its asm.js build avoids dynamic WebAssembly compilation in Workers. The build adapter disables host discovery for this memory-only engine because Workers expose WorkerGlobalScope without a browser location. Both Vite production bundling and the existing Worker test harness use that adapter. This dependency emits an upstream deprecation warning; its explicit pinned asm.js entry point remains functional.

The existing restore journey gains one regression scenario for 0050_synthetic_restore_additive.sql. It creates a real earlier archive through the native export API, restores through the native restore API into a destination with the extra migration sorted among existing files, and checks completion, the exact missing migration, inactive flow state and migration-seeded rows. All previous assertions remain, including the tail-additive migration, complete portable inventory, inactive authority, owner adoption, incompatible/newer schema refusal and unchanged destination snapshots.

## Before and after proof

Before: the sorted-middle fixture against the original prefix-only bridge returned HTTP 400 with schema_mismatch. The existing registered DATA-001 journey failed at the new scenario. See before.log.

After: the complete touched journey passed after the Worker host adapter correction. The earlier uncached integration run also passed every assertion (integration-before-cache.log); common-prefix caching was retained for normal restore cost. Final candidate check results and exact command receipts are in RECEIPT.json and after.log.

A standalone diagnostic compared the memory replay's complete, tables-only and legacy-excluded-object schema identities against the CLI migrationReplay. All three matched (replay-probe.log). This diagnostic is not a new CI assertion or test registration.

## Integration and judgments

Current main was merged after the two published save commits; no published history was rewritten and no force push was used. Main's complete CONTRACT.md and generated views were retained. docs/contract/ID-MAP.json is absent on main, so no replacement file was invented. Contract generation write/check passed, then ACCEPTANCE.md and docs/CLAIMS.md were restored from main and were not committed as changes.

The installed edition-authoring tool regenerated sources.lock.json last and its check passed. Product commits contain the restore bridge, dependency/build/test changes, inherited bridge documentation and source lock, plus the required main merge. Fleet reports and receipts stay outside the product branch.

Clause judgments: none changed. DATA-001 remains done. Contract counts remain 32 done / 50 partial / 17 missing, 99 total. The published subset remains 9 / 3 / 0, 12 total; target/push-further remains 23 / 47 / 17, 87 total.

Test counts: ordinary registrations remain 166 across 29 files. Recounting the declared CI entrypoints gives 201 before and after (166 ordinary, 1 site, 2 runtime, 22 browser, 1 Linux, 9 long journeys). The repository budget records 200; that discrepancy is inherited from main and this blocking-only fix changes no registration count. There is no new registration, independently invoked CI assertion script, deletion, skip or weakened assertion. See test-counts.json.

CLAIM DATA-001 DONE points=none tests=tests/crank.test.mjs#BASE-003 DATA-001: complete portable inventory, inactive restore, explicit per-run adoption and atomic refusal

This scoped fix retains the existing DONE judgment; it introduces no numbered acceptance point or status promotion.

## Checks and limits

Touched checks only were run locally: the existing DATA-001 restore journey, typecheck, production build, contract generation/check and installed source-lock check. No full local verify, UI change, browser proof, publication scan, provider deploy or landing was performed. The fleet owns the independent gate, publication scan and main landing.

Initial rer setup installed dependencies and built but reported a local readiness port mismatch. It did not prevent the native Worker/D1 regression checks, typecheck or subsequent production builds. No account, provider key or owner ruling was needed for this fix.

CI custody, exact-SHA Verify run IDs and final disposition are recorded below after observation. Evidence publication is separate from product READY and never signals landing or acceptance.

## Terminal product custody

READY branch=cloud/sx-crank-restore-bridge-fix1 head=1780553f1cae64f9026db32567cb84983fa9a137

Exact-SHA Verify: 42511123908, completed/success.
Run: https://github.com/just-every/run-crank/actions/runs/42511123908
GitHub API calls used: 6 of 10. One watcher was used at a time, with at least 300 seconds between calls for the run. No workflow dispatch or rerun was used.
The product branch was pushed successfully and its advertised remote head matches this exact candidate.
PR: none created; this repository's supplied rules use the fleet's branch landing path.
Blockers: none.
Clause status changes: none. DATA-001 remains done; all 99 contract judgments and summary counts are unchanged.
The before/after restore result is HTTP 400 schema_mismatch -> completed HTTP 200, with the sorted-middle migration reported, an inactive receiving flow and its seeded defaults intact.
Evidence destination: refs/heads/evidence/sx-crank-restore-bridge-fix1. The terminal EVIDENCE line names the actual published report-only head; publication does not land the product or waive the independent gate.
