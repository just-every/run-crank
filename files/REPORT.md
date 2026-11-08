# sx-crank-restore-bridge-1

Repository: just-every/run-crank
Branch: cloud/sx-crank-restore-bridge-1

## Plan

1. Read the fleet launcher rules, inline builder rules, repository AGENTS.md, contract and existing restore/import code.
2. Reuse the installed RER portability migration replay and importer. Supply destination-owned replay evidence to the browser Worker through its build, because Node SQLite is unavailable in a Worker.
3. Extend the existing restore journey without changing the BASE-003 DATA-001 registration or removing any assertion. Export at current main's migration level, compile an additive fixture migration into a receiving Worker, and prove inactive restore and default values. Refuse a future-level export and a non-additive change with complete before/after database snapshots.
4. Run touched test files and the Verify typecheck command, build to exercise the production bundling plugin, regenerate sources.lock.json last, then validate it.
5. Preserve the first real commit on the named branch, merge any updated main without rewriting published history, publish the final candidate, and inspect its exact-SHA Verify using the bounded REST budget.
6. Publish actual non-secret report and receipt files to the separate evidence ref. Do not run the publication scan or edit contract statuses/views.

## Scope

Only the archive restore migration bridge is targeted. No clause status, gap, evidence, acceptance text, generated contract view, Base pin, or product migration is changed. No DONE claim is made. No UI changes are intended.

## Results

The product branch is pushed at `0b8655204eeba01ba499becbfc727763a1e356de`, based on main `52f8599de3a7083337a052d9416600d5380755ea`. Its earlier preservation commit is `420c82ea5acb76bb078567633e6411553cae3784` (`[skip ci]`). Both commits have fleet author/committer identity and no trailers. The full-history clone is not shallow. Main was fetched and the merge was already up to date; no published history was rewritten.

The browser restore door now supplies destination-owned replay evidence to the existing RER portability importer. The same Base engine places old archives in migration history, checks additive changes, applies defaults/backfills, normalizes inactive state and publishes atomically. Node SQLite replay runs while bundling; the Worker receives schema identities, SQL statements and migration-seeded row evidence. The source placeholder preserves existing standalone registry/documentation bundles and fails closed without build evidence. A content-addressed ignored cache avoids repeating identical replay generation in separate test processes. See IMPLEMENTATION.md for details.

The final focused BASE-003 DATA-001 test passes on pinned Node 22.20.0. It proves a genuine current-level export restores 200 into a test build with an additive column, new table and seeded default record, preserving source records and inactive authority. A genuine newer-level export is refused with 409/schema_mismatch and a non-additive column rename is refused with 400/schema_mismatch. Every readable application/authority/audit/transfer table and its SQL definition remains identical around each refusal. The existing tests/crank.test.mjs registration and all its original restore/inventory/adoption/erasure assertions are unchanged.

The production build, Verify's `pnpm run typecheck`, installed edition-authoring source-lock check, diff whitespace check and existing standalone bundle probes pass. The final full touched-file rerun passed 18/18, with zero failures, skips or cancellations, in 403 seconds on the unchanged candidate tree. No full local suite or publication scan was run. Exact command receipts and output hashes are in VALIDATION.json; development corrections are disclosed in DEVELOPMENT.md.

Verify run `42504310690` completed successfully on the exact pushed SHA: https://github.com/just-every/run-crank/actions/runs/42504310690 . Five REST calls were used by one watcher, at least 300 seconds apart, within the ten-call budget. CI.json records the complete observation sequence and terminal completed/success receipt; ci.log is the actual watcher output. No failing branch workflow remains.

Test count: recount 201 before / 201 after; recorded budget 200 before / 200 after, cap 200. Main already has 22 browser entrypoints where its budget note counts 21. The existing inventory convention is 166 ordinary registrations + 1 site + 2 runtime scripts + 22 browser scripts + 1 Linux executor + 9 nightly registrations/scripts = 201. This pre-existing bookkeeping discrepancy is reported in COUNTS.json; no test-budget change or cap raise is made. This task adds zero registrations or independently invoked assertion scripts. Product migration files: unchanged; fixture migrations exist only in the test harness. Clause status changes: none. No clause claims, Status/Gap/Evidence edits, Base refresh, generated contract view commits, PR, main/default-branch push or DONE claim.

Product push succeeded on the first attempt through the required cloud guard. No push blocker or rescue bundle is outstanding. Product custody and report-only evidence publication are separate; this report is not a landing claim.

## Terminal custody

Product branch and both commits are pushed. Exact-SHA Verify and all local touched checks pass. No PR was required or opened. No product blocker remains. The complete selected report packet is published through the separate evidence ref; evidence publication is not product acceptance or landing. The fleet owns the publication scan, independent gate and landing. The task clone is removed only after the final report transport succeeds; the packet is retained outside it.
