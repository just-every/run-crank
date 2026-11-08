# sx-crank-f86fix1 report

Repository: just-every/run-crank
Branch: cloud/sx-crank-f86fix1
Product head: dea20ab568c8c5be25accec8b425a0fa125e00f9
Resolver: 6f6dcc7defff54a5111ca851f9fdfe621090a051
Integrated main: c449a78d4b6502270a4383c6517eee55b5964262 (already an ancestor; merge was up to date).
Product push: succeeded on first attempt through cloud-push.py. No main push, force push or PR.

## Scope and implementation

Only BLOCKING B, BASE-AGENT-012 / DATA-001: current-main archives were refused by f86 because five newly excluded agent tables changed the portable schema identity. This FIX uses the explicitly allowed compatibility alternative; the five exclusions remain because existing recovery assertions require installation authority and native receipts to stay out of archives. No tests or assertions were deleted, weakened or skipped.

After the ordinary reader completely verifies the supplied archive, restoreArchive projects out only agent_door_state, agent_door_agents, agent_door_calls, agent_door_approvals and agent_door_reviews, including their rows. It recomputes the manifest schema and part/content/archive checksums for the strict existing import path. All other product rows, schema objects, erasure journals, payloads and configuration declarations remain subject to the existing checks. It executes no archived SQL and replays no migration. The audit retains the original archive hash and records the projected hash when different. Ordinary current archives pass through unchanged.

The regression uses a gzip-compressed real public-door export from the frozen main head, containing one synthetic draft flow, migration 0091's schema and no agent use. One additional restore status assertion is folded into tests/restore-journey.mjs's existing registration. The actual export and independent before/after probe scripts are retained outside the product checkout; public fixture provenance is included.

## Before and after

Same archive SHA-256: 790421bfcf7cc594067a7a4f36fc88573113797d884697ca925d9460f509d5f3; 287,330 bytes.

- Main c449a78d4b6502270a4383c6517eee55b5964262: export 200, restore 200, one draft flow retained.
- Unchanged f86 6f6dcc7defff54a5111ca851f9fdfe621090a051: restore 400, schema_mismatch, zero restored flows.
- Exact pushed candidate dea20ab568c8c5be25accec8b425a0fa125e00f9: restore 200, one retained draft flow.
- Test budget: 200 before / 200 after; zero new registrations; one added regression assertion.
- Selected touched journeys: 2 passed, 0 failed (one restore registration and one SDK/CORE registration including native recovery and named approvals).

## Local verification

- Existing complete portable inventory/inactive restore/explicit adoption/atomic refusal journey: PASS; includes the new main-archive compatibility assertion.
- Existing SDK and CORE lifecycle journey: PASS; includes native f86 recovery, uncertain receipt handling, current authority, unchanged export exclusions, inactive restore and named approval/refusal journeys.
- pnpm typecheck: PASS. Local environment supplied Node 24.19.0 / pnpm 10.12.4 under the prescribed toolchain; CI uses the repository's Node 22.20.0.
- Installed edition source lock: regenerated last and check passed.
- git diff --check: PASS.
- All 8 candidate commits, including side parents: identity and trailer inspection passed. The already published owner merge's non-email Validation trailer was preserved. New commit has no co-author trailer.

## CI and custody

Exact-SHA Verify run 42479803993: completed/failure on dea20ab568c8c5be25accec8b425a0fa125e00f9. URL: https://github.com/just-every/run-crank/actions/runs/42479803993. GitHub calls used: 10/10. Product and evidence refs are separate; evidence publication carries no landing or acceptance claim. No UI changes or browser screenshots required.

## Clause changes and limits

BASE-AGENT-012 remains partial; DATA-001 remains done; no Status, Gap or Evidence cells changed in this FIX. No CONTRACT.md edit or generated ACCEPTANCE.md / docs/CLAIMS.md commit. No DONE claim. No publication scan, campaign continuation, redesign, Base refresh, release or independent gate was run. The fleet lander owns the one independent gate and landing.

CLAIM BASE-AGENT-012 PARTIAL points=none tests=tests/crank.test.mjs#BASE-003 DATA-001: complete portable inventory, inactive restore, explicit per-run adoption and atomic refusal; tests/platform.test.mjs#PLATFORM-001: SDK and CORE door draft lifecycle, native granted execution/progress, paginated reads and out-of-grant denial share native approval and audit

The claim identifies this narrow regression fix and preserved related coverage; it claims no new acceptance-point completion. No new default or missing ruling. Blockers: Exact-SHA Verify failure

The full execution plan is PLAN.md. Actual before/main/candidate receipts, touched-check logs, lock check, identity inspection and product push receipt are selected explicitly for the separate evidence ref.

## First Verify failure and lock correction

Verify 42479308952 on initial product commit 37fbdf45d6177fa0be8a03793ef5566d580f4aa6 failed in plan job 128727551408 at the edition source lock check; build and shards did not run. The new fixture was untracked when the initial lock was generated. Its tracked content is now included by lock-only commit dea20ab568c8c5be25accec8b425a0fa125e00f9. The failed-job log was fetched once using the required gh run view archive command and confirms the stale-lock diagnostic. The downstream verify job 128727644145 failed because selected coverage was unavailable. No product assertion failed. Both published commits were preserved; main was fetched and merge checked again before the second normal guarded push. The final lock was regenerated after the fixture was tracked and check passed. The final candidate contains identical product code and tests to the locally passing first candidate, with only the corrected lock added.

CLAIM DATA-001 PARTIAL points=none tests=tests/crank.test.mjs#BASE-003 DATA-001: complete portable inventory, inactive restore, explicit per-run adoption and atomic refusal

This partial-scope claim records only this compatibility correction and changes no existing clause judgment.

## Final Verify blocker

Exact-SHA run 42479803993 completed/failure on dea20ab568c8c5be25accec8b425a0fa125e00f9. Plan (including the corrected lock), build and seven of eight shards passed. Owner-decisions job 128729432184 failed in tests/table-state-journey.mjs:149, invoked by tests/sample-browser.mjs:157: `assert.equal(JSON.stringify(disclosed).includes('201'),false)` observed `true`. The dependent verify coverage job also failed. This failure is before that journey exports or restores any archive; the new compatibility helper is called only during POST /api/crank/data/restore. The assertion, browser caller and disclosure implementation have identical hashes on main, f86 and this candidate; the hash receipt is ci-failure-analysis.json. The assertion could match an opaque ID containing 201, but the log does not retain its value, so that cause is not proven.

The failed-job archive log was fetched once using `gh run view 42479803993 --repo just-every/run-crank --job 128729432184 --log-failed`. All ten GitHub calls are recorded. No workflow was rerun or dispatched; no unrelated code/test fix or assertion weakening was made. This is an ordinary red required workflow, not the contract-view generator exception, so terminal custody is BLOCKED, not READY. The sole requested archive regression itself is fixed and pushed, with exact-head 400-to-200 proof and the preserved existing restore/recovery checks. The lane needs to resolve the separate CI failure within its own scope before this head can qualify for landing.

Product commits: 37fbdf45d6177fa0be8a03793ef5566d580f4aa6 (archive compatibility and regression) and dea20ab568c8c5be25accec8b425a0fa125e00f9 (tracked fixture source lock). Both normal guarded pushes succeeded on their first attempts. No product push rejection occurred. Final evidence is published independently of this blocked product readiness.
