# sx-crank-f64-ci-repair-1-prep1 — BLOCKED at unchanged before-shard reproduction

The exact prescribed prerequisites all passed, but the ONE unchanged owner-decisions before run failed earlier than the target dev JSON loader error. It stopped in the first recurring browser journey at the 390 recurring-list overflow assertion. Decision-browser and its real rer-dev Worker were never reached. The brief requires ending BLOCKED when the unchanged target case cannot be reproduced, so no product repair, after run or blind retry was attempted. This is an observed different assertion failure, not a guessed infrastructure classification.

Terminal product branch: cloud/sx-crank-f64-ci-repair-1-prep1. Terminal product head: 2b7186c1c3ef673f610070a9c0b2a3a34f43b310. No product edit, commit, push, PR, new CI run, workflow rerun/dispatch, lifecycle mutation or acceptance change occurred. No finished unpushed product change exists.

## Plan and source custody

PLAN.md records the full plan: fleet setup and exact rejected-head checkout; immutable diagnostic review; serial exact prerequisites; one unchanged before run; conditional genuine loader repair and unchanged after proof; main/contract generation and lock-last handling; identity-guarded product publication; sanitized report-only return and cleanup. Steps through the before reproduction were executed. The conditional repair and candidate-publication steps were not authorized by the observed result and were not executed.

Only just-every/run-crank was cloned, shallow and filtered. The original candidate branch was fetched with depth 150, retaining f64 commits 862198ed3c42d259d1c4e7f491b09bfe621d64ae and 598f9307bd61093d260ae2f8bdf9bd1947f85cd4 and rejected integrated head 2b7186c1c3ef673f610070a9c0b2a3a34f43b310. Main was e2c146dc38eb64e685cf01d2c56e798404b3936e. The local named branch started at the exact rejected head and stayed there. The working tree was clean and the recorded source/test/config/contract hashes remained unchanged; see before-source.json and reproduction-source-integrity.json. actual-code.diff is empty.

The launcher was read and refreshed, then the bundle-only Git helper, task push guard, explicit fleet Git identity and preserved repository commit hooks were installed. Hooks were reinstalled after dependency setup steps. No commit bypass was used. All three candidate commits have fleet authors and committers and absent trailers, as preserved in original-candidate-identities.txt and original-candidate-messages.txt. There was no product push to audit or retry.

The original blocked repair report-only ref was fetched at fba6c4bdbfed2a1079bd5243c8ba913e64d8d785 and triage at 6dabfd37ec460c3d5d3f3f14f5ffaa41ed0ff2a7, without merging either into product. Their reports, receipts, loader observations and source trace were read. Original report files remain byte-identical to their manifests; the historical verification receipt records length/SHA-256 checks and selected unchanged text evidence is included under historical/. The historical failure remains BLOCKED and is not converted into a successful reproduction. No fresh main baseline was spent and no additional successor was launched.

## Exact preparation and actual runtime

This host is Debian GNU/Linux 13 x86_64, kernel 6.18.57; historical CI used Ubuntu 24.04. This is not exact-host equivalence. Actual command runtime was Node 22.20.0 and pnpm 10.12.4. Each phase sourced the required toolchain and then explicitly prepended the exact Node 22.20.0 binary, recorded its version and path, and set CI=true. The toolchain's initial informational line shows the VM's Node 24.19.0 before that explicit selection; it is not the command's runtime.

The real HOME was retained. No owner session, cookie, profile, private state or private settings were transplanted or manually initialized. No standalone rer setup was invoked. The ordinary committed journey was left to perform its own ordinary behavior. Browser was the actual default Playwright Chromium headless shell revision 1243, version 153.0.8010.12, with --no-sandbox and its normal keychain/password-store flags. There was no browser executable override. The awaited launch/close probe exited 0 after the browser process exited and temporary profile cleanup completed. Browser binary SHA-256 receipts are in browser-binaries.json.

All heavy/browser commands ran serially through cloud_run/subreaper with timeout 1200, preserving ordinary environment and commands. Complete sanitized logs and started/completed JSON receipts are retained.

| Phase, in execution order | Exit | Seconds |
| --- | ---: | ---: |
| pnpm install --frozen-lockfile | 0 | 4.504 |
| pnpm run deps | 0 | 3.889 |
| npm ci --prefix gateways/node --ignore-scripts | 0 | 2.609 |
| pnpm exec playwright install chromium | 0 | 139.105 |
| default Chromium launch/close readiness | 0 | 1.598 |
| node scripts/verify-ci.mjs --build | 0 | 11.742 |
| node scripts/verify-ci.mjs owner-decisions | 1 | 28.755 |

The build ran its unchanged Worker/assets build, site build, typecheck, first-party check, contract-doc check and deployment-spec check. All passed. No prerequisite failed.

## Required before run: actual failure and scope

Exact command, with only the evidence destination adapted to this task:

```text
timeout 1200 env CRANK_EVIDENCE=/home/agent/rer-consolidation/work/sx-crank-f64-ci-repair-1-prep1/packet/before-artifacts node scripts/verify-ci.mjs owner-decisions
```

The first original command was tests/recurring-browser.mjs. It reached all eight recorded 1440 states and seven 390 states. Its next unchanged shot call, after opening All recurring objectives at width 390, failed before taking the ordinary recurring-list screenshot:

```text
AssertionError [ERR_ASSERTION]: 390 recurring-list overflow
    at shot (.../tests/recurring-browser.mjs:31:10)
    at async .../tests/recurring-browser.mjs:62:86
actual: false
expected: true
operator: '=='
```

The overall unchanged shard exited 1 in 28.755 seconds. before-owner-decisions.log preserves the full assertion and the current synthetic page text. before-artifacts/recurring contains the 15 completed state screenshots plus journey-error.png captured by the committed catch path. The ordinary context/browser/harness/bridge cleanup completed. The startup-log capture is empty because no decision-browser dev process started. Sibling/Teams, decision-browser and all subsequent original commands were not reached; no claim is made that they passed here. No replacement assertion, timeout change, screenshot retry, shard rerun, test edit or UI repair was made.

VERIFY_REPRODUCED.json records reproduced=false, exact head 2b7186c1c3ef673f610070a9c0b2a3a34f43b310, historical job 127671299542, actual command/test/nonzeroexit/quotedfailure and successful preparation. There is no after receipt because no repair occurred.

## Loader evidence and why no patch was applied

The immutable diagnostic established a previous valid candidate/main differential on the pinned runtime: candidate owner-decisions exited 1 on the JSON loader failure, fresh main exited 0 including decision 1440/390. That historical proof is retained as context, not counted as this continuation's required before run.

The installed Vite 8.2.2 / Cloudflare source was inspected. Vite normalizes the inside-root JSON import to /agent-surface.json and adds that URL-derived string to safeModulePaths. Its loader later receives the resolved absolute filename, tests isFileLoadingAllowed before reading, and finds neither the absolute safe-path entry nor an explicit allow path for that file. Cloudflare delegates the ordinary JSON fetch to Vite. The historical observing pre-load plugin supplied no replacement data and recorded the file's presence and hash, safeAbsolute=false and absoluteAllowed=false. static-loader-trace.md records installed source locations. No runtime probe was added in this continuation, and noticing the allowlist alone was not treated as a substitute for the required before-shard reproduction.

That required unchanged reproduction stopped earlier at an unrelated original UI assertion. The brief explicitly directs stopping in that situation. A setup/probe-only observation does not satisfy the gate; no code patch or after proof was justified or attempted.

## Contract, checks, CI and holds

BASE-AGENT-013 remains PARTIAL. Before/after done/partial/missing counts are 32/50/17, with no clause text or status changes. Entire inherited Status, Gap/Evidence/provenance/newer assertions, original f64 changes, AP/Base/riders/frozen lifetime and all source/stack/review/provider/release holds remain unchanged. No POINTS, source pin, judge request, policy decision, supported review-hold release, source acceptance, submission/readmission or landing occurred. The SAME original frozen independent affected re-gate remains required for a future valid repaired candidate; this continuation does not authorize another successor or extend a repair/acceptance budget.

No new candidate was created, so no final main merge, generation write, generated-view resolution, lock regeneration or candidate push was applicable. The unchanged contract check passed within the required build. No generated view was edited or newly committed. Listings/migration check: N/A, because there was no product, listing or schema edit. Affected typecheck passed in the build; direct native/manifest after regression was not run because there was no repair. No full suite, full verify, additional baseline or permanent duplicate test/pin was added.

GitHub API usage: 0/10. No new run IDs exist; 42150056848 / job 127671299542 are historical only, neither rerun nor dispatched. No CI green, READY, product PUSHED or landing is claimed. No PR exists. No product push was attempted or rejected, so there is no failing push command/status or product recovery bundle.

## Preservation and return

terminal-product-provenance.json records clean unchanged product provenance before cleanup. owned-runtime-cleanup.json records no remaining active runtime/browser processes and no task-side kills. checkout-cleanup-receipt.json records actual cleanup of the disposable worktree, dependency/private data and task browser cache while preserving the original clone's Git storage solely for report return. No broad/computed kills or rer stop were used.

The complete actual non-secret packet is explicitly selected after redaction checks and published only to refs/heads/evidence/sx-crank-f64-ci-repair-1-prep1 using cloud_evidence.py. Evidence publication is separate from product readiness and does not readmit or land the candidate. The final message returns the exact evidence ref/head and an inbox POST line with tag, unchanged clause/counts, terminal SHA and historical/new CI IDs.

The precise blocker is the required before-shard reproduction: 390 recurring-list overflow prevented reaching the originally failed JSON loading case after every prescribed prerequisite passed. No third repair or additional successor is requested by this result.
