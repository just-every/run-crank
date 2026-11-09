# sx-crank-flake-1 results

Both recurring browser assertion patterns are deterministic on the candidate. Twenty consecutive journey executions passed: ten inbound-email runs and ten sample/table runs, with the tenth pair using 6× browser CPU throttling. No test retry wrapper, skip, larger fixed timeout or production-source change was added.

Repository: just-every/run-crank
Product branch: cloud/sx-crank-flake-1
Pushed head: 89b071efdb8561e4fc8050f1e23554d92cf6725c
Integrated main: e118d7c2269232b7fee52c6d2159a53f561fb3f3
PR: none; the fleet's branch landing contract applies.
Exact-SHA Verify: 42547214977, https://github.com/just-every/run-crank/actions/runs/42547214977 (completed/success).

## What changed

The original tooltip checks already moved the pointer away and blurred before the first hidden assertion, but later asserted hidden after a 150 ms Node sleep while hover remained active. Hosted scheduling can miss that short interval. Eleven browser scripts now use tests/tooltip-browser.mjs to clear pointer/focus, freeze Chromium's animation clock before hover, seek the shipped CSS transitions to 150 ms, assert hidden, restore playback in finally and wait for actual hover visibility. Existing immediate-focus assertions remain. A mutation with the hover delay removed is rejected.

The table failure was not an unsettled update. The data/flows descriptor contains the random table ID, which can contain the digits 201. Waiting cannot change that ID. The assertion verifies identity separately and searches every other serialized field for the same record-value leakage. Empty external recipients, exact destination results, complete inactive restoration, pause, adoption and erasure checks remain.

Product diff: only tests/** and regenerated sources.lock.json. No src/**, CONTRACT.md, ACCEPTANCE.md or docs/CLAIMS.md changes relative to integrated main. All candidate authors/committers are fleet identity, no trailers remain, published ancestry is preserved and the guarded product push succeeded on its first attempt. Remote branch custody was verified with git ls-remote.

## Validation and counts

- Inbound email: 10/10; sample/table journey: 10/10; 18 normal runs and 2 runs at CPU throttling rate 6, all on the exact pushed SHA.
- Other touched consumers: AI, digest, sibling/Teams, Calendar/Gmail/HubSpot/Typeform, editor/attribution and native run-notices passed through their existing Verify entry points.
- Focused WORK-007 operational-table registration, pnpm run typecheck, emitted app build, syntax/diff checks and the installed edition source lock check passed.
- Browser proof captures the relevant synthetic email and table screens once at 1440 and 390.
- Recorded test budget: 199 before, 199 after; zero registration or independently invoked assertion-script changes. Contract counts: 32 done, 50 partial, 17 missing before and after. Clause status changes: none. No DONE claim.

The full plan is PLAN.md. Complete per-run details are repeat-receipt.json, sweep-receipt.json, local-receipt.json, product-receipt.json and ci-receipt.json, with actual selected logs and proof files. The source-lock and scope checks are recorded with product provenance.

## Resolved execution issues and limits

The first mouseenter-handler prototype failed its seventh email repetition; it was corrected to freeze the animation clock before pointer entry. That attempt is retained under attempt-1. A later main merge occurred during exploratory checks and invalidated migration snapshots; those schema_mismatch runs are retained under attempt-2. Final proof was restarted on a stable checkout. Required setup initially failed under the VM's Node 24 PATH, then succeeded with exact Node 22.20.0 on PATH; native proof passed after setup and again after main integration. Initial PATH/browser selectors and temporary checkout-sharing refusals are retained in actual diagnostics.

No current local blocker remains. Exact-SHA Verify completed successfully on the pushed candidate. Publication scanning and landing belong to the fleet on its own machine. Evidence publication is report custody, never product acceptance or landing. No credentials, environment dumps, provider keys, real account sessions or held-out gate material are selected.

Terminal CI result: completed/success, exact head 89b071efdb8561e4fc8050f1e23554d92cf6725c, Verify run 42547214977. GitHub calls used: 6/10. Current blockers: none. Evidence transport remains separate from product acceptance and landing.
