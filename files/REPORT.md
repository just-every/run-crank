# sx-crank-f76fix1 — pre-0093 archive restore

Repository: just-every/run-crank
Product branch: cloud/sx-crank-f76fix1
Original gated head: 0c3b4cb0d00a0bd341d14a1c20ed64572c5296f0
Integration main: e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df

## Plan

1. Install the fleet decrypted-bundle Git helper, guarded push command, and commit hooks. Clone full history and configure fleet author/committer identity.
2. Start the named product branch at the gated head and merge current main. Preserve main's complete CONTRACT.md, generated views and newer test assertions. Resolve overlap conflicts in favor of main where it already contains the candidate implementation; regenerate the source lock with the installed pinned authoring tool last.
3. Compare migration 0093 and archive policy with main. Run the unchanged complete restore journey against real SQLite through the owner restore API, including the historical pre-0093 archive, a current archive, invalid archive refusal, inactive custody and migration bridging. If still failing, fix only the compatibility cause; preserve the journey assertions.
4. Run typecheck, affected platform tests, contract generator write/check with generated views restored, source-lock/migration-ledger checks and count review. Commit the integration with explicit fleet identity; inspect every candidate author, committer and trailer; push only the named cloud branch via the push guard.
5. Discover and poll exact-SHA Verify through REST, within ten GitHub calls and at least 300 seconds between observations of a run. Read failed-job logs once if needed. Preserve actual non-secret receipts, publish them on evidence/sx-crank-f76fix1 and report product and evidence custody separately.

## Initial integration findings

Current main already contains migration 0093 with the candidate's reviewer erasure trigger and the native preparation attribution implementation. It also contains the replacement migration-history-based archive compatibility implementation (archive-migrations.ts, archive-replay.mjs, archive-policy.mjs and the pinned rer 0.2.104 importer). Migration 0093 and archive policy have no diff against main after merge.

All five textual conflicts were overlapping candidate work now on main: main retains the newer attribution documentation and reviewer generation fence, migration entries through 0096 in the generated deployment spec, the newer scope-narrowing journey import and the current test-budget notes. Taking main's whole versions leaves the integrated tree identical to main. CONTRACT.md and generated views were explicitly taken whole from main; there are no clause status changes.

Execution results and product provenance follow.

## Checks completed before publication

- Typecheck: PASS (`pnpm typecheck`). The supplied toolchain shim retained the VM's Node 24.19.0 because its version comparison does not replace a newer VM runtime; hosted Verify selects the repository's exact Node 22.20.0.
- Contract generator: write and check PASS, 99 clauses. Main's ACCEPTANCE.md and docs/CLAIMS.md restored whole. CONTRACT.md remains byte-identical to main, including ID-MAP and clause judgments.
- Applied migration ledger: all 99 main migration files and SQL bytes are identical; no new, renamed or edited migrations. Main has historical shared numeric prefixes 0080 and 0085; an initial overly broad uniqueness assertion was corrected to check actual applied filenames and bytes. The 0093 SHA-256 is 827a8662dc0a567f6d1f44b8da57cf2fbd49db079fa24b4b65fc82bac6db8adf.
- Installed rer 0.2.104 authoring tool: `changes`, `lock`, `check` PASS. Regeneration is byte-identical to main. Lock SHA-256: 2387cf46ebc935f9696e45c2cc52cd4531b0ab5e3034719223bbd5fc98479e0c.
- Test inventory: main recorded 199 / merged recorded 199, cap 200. No registration or assertion is added, removed, skipped or weakened. No UI change or local browser suite is required for this integration-only result.
- Publication scan: not run, as explicitly directed by this brief; the cloud cannot perform the fleet landing publication scan. Every candidate author, committer and trailer is inspected before the guarded product push, including side parents. The original candidate's owner identity is James Peter <github@zemaj.com>; the new merge uses Run Edit Run fleet <fleet@runeditrun.com>.

## Compatibility cause and proof

The old candidate's hard-coded trigger compatibility policy is superseded by current main's destination-owned migration replay. The current importer verifies the archive's original checksums and schema against the trusted historical migration history, then keeps the destination's current schema. It does not execute archive SQL or grant unknown schema changes. No additional compatibility exception or product edit is necessary.

The separate task-only public-door probe confirms HTTP 200 for the actual archived historical fixture and for a current export; both retain the exact current `crank_audit_append_only` definition. Historical trigger SHA-256: deb7dc6710f71a28999cef5c44e7579d5c299abaeb3d584ca87b8ca60afbb053. Current SQLite trigger SHA-256: dfb7709910f2beecc717eb0f8a2b5e6c0d331bececd26c2365b0c4cd34b3e3ce. This differs from the migration file's hash because it hashes the actual stored trigger SQL. The probe is saved only as task evidence, outside the product repository.

The probe's initial launch failed before any database access because a package export alias was incorrectly treated as a physical file path. It was corrected to use the installed package's resolver; the original failure and corrected run receipts are retained separately. This changed no product file.

The corrected schema probe completed with exit 0: pre-0093 restore 200; post-0093 restore 200; checksummed unknown audit-trigger mutation 400 `schema_mismatch`, with every destination row and schema object unchanged. See `restore-schema-probe.log` and `restore-schema-probe-receipt.json`.

Clause counts before/after this integration: DONE 32 → 32; PARTIAL 50 → 50; MISSING 17 → 17; total 99 → 99. BASE-AGENT-008 remains PARTIAL. No clause award or status change is claimed.

Affected platform regression suite: PASS, 3 tests / 3 passed / 0 failed / 0 skipped, exit 0. Its existing native preparation, reviewer revocation, erasure and inactive restore assertions all remain intact. Runtime was approximately 820 seconds including cold migration-history preparation. See `platform.log` and `platform-receipt.json`.

## Product custody

Final product head: 170fc5b484d475fd80f29c8dc7f00093f0d6703d
Branch: cloud/sx-crank-f76fix1
Integration main: e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df
Tree: 9cb37f00c79da9f4c6cf6bcab4d9c69891e7289a (identical to integration main)
Parents: 0c3b4cb0d00a0bd341d14a1c20ed64572c5296f0 e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df

The unchanged complete registered BASE-003 DATA-001 restore journey passed: one selected test, one pass, zero failures, zero skips, exit 0, approximately 970 seconds including cold historical migration preparation and synthetic future migration compatibility cases. The public-door journey includes the pre-0093 fixture, current export/restore/re-export inventory equality, inactive restoration and explicit adoption, checksum tampering, semantically invalid records and incompatible migration refusal. See restore-journey.log and command-receipts.json.

Every requested local check passed on exactly this Git tree. The worktree is clean, the clone has full history, and no tests or product source were changed relative to current main. The source lock was regenerated last and is included via the main merge.

The first real commit was the final integration merge, using explicit fleet author and committer environment variables with the fleet commit hook active. The first guarded push succeeded on attempt 1. All two candidate commits, including the original gated side parent, passed the author, committer and complete-message/trailer checks. No history was rewritten or force-pushed. No default branch was pushed. No PR was created; the named product branch is returned to the lane's landing path.

Exact-SHA hosted Verify completed red. The terminal standing-bar blocker is recorded below; this is a PUSHED product, not a READY claim.

## Exact-SHA CI result and remaining blocker

Verify run: 42672083743
URL: https://github.com/just-every/run-crank/actions/runs/42672083743
Exact head: 170fc5b484d475fd80f29c8dc7f00093f0d6703d
Conclusion: completed / failure
Failed aggregate job: verify, 129348753720

The one completed-run job-list response exposed only the failed aggregate `verify` job and skipped `build` and `light` jobs. No `plan` job was returned. The exact-SHA check-run list likewise exposed only those three checks. The aggregate's failed log records `PLAN: abandoned`, empty COVERAGE/HAS_SHARDS/SKIP, and BUILD/SHARDS/LIGHT/PUSH_PROOF/NIGHTLY_PROOF all skipped. It fails the unchanged `test "$PLAN" = success` standing guard. There is no hosted application assertion failure and no contract generator failure in these receipts: the build and test shards did not execute. The cause of the upstream abandonment is not exposed by the inspected APIs or failed log.

The mandated archive-log command succeeded once:
`gh run view 42672083743 --repo just-every/run-crank --job 129348753720 --log-failed`
Its complete sanitized output is `github-call-4.log`. Job and check listings are `github-call-3.log` and `github-call-5.log`.

Five task GitHub observations/diagnostic calls were used, with a single watcher and 301 seconds between workflow discovery and the one run-status poll. No workflow was dispatched or rerun, no no-op commit was created, and no CI guard was weakened. The brief forbids dispatching or rerunning Verify for a SHA which already has a run. This upstream abandoned plan cannot be repaired by a scoped restore-code change; the integrated tree is exactly main and every requested local check passes. The lane must resolve the upstream Actions failure and obtain successful exact-SHA Verify before landing. No READY claim is made.

## Final result and evidence custody

The reported pre-0093 restore regression is already fixed by current main, and that fix is included in the pushed integration merge. Both archive generations restore with the current trigger; an independently checksummed unknown trigger mutation remains atomically refused. The unchanged full restore registration, all three affected platform registrations, typecheck, migration comparison, contract generation and source-lock checks pass. No product source, test, migration, contract row or generated view differs from current main.

Before/after clause counts: 32 DONE / 50 PARTIAL / 17 MISSING / 99 total, unchanged. Recorded tests: 199 → 199, cap 200. Clause changes: none; BASE-AGENT-008 remains PARTIAL. PR: none created. Product custody: cloud/sx-crank-f76fix1 at 170fc5b484d475fd80f29c8dc7f00093f0d6703d, pushed and verified by Git ls-remote. Product standing bar: BLOCKED solely on Verify's abandoned upstream plan.

All owned local test processes exited and subreapers completed. The clean clone is retained through evidence publication and will then be removed under the builder cleanup rule. Actual reports, logs, probes and receipts remain outside that clone in this packet. The complete explicit non-secret packet is published separately to evidence/sx-crank-f76fix1. Evidence transport is not product acceptance, READY or landing.
