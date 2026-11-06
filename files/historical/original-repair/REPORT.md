# sx-crank-f64-ci-repair-1 — BLOCKED before product repair

The required unchanged owner-decisions reproduction did not reach the original JSON-load failure. No product edit, commit, push, PR, workflow dispatch/rerun, acceptance change or lifecycle change was made. The brief explicitly says to end BLOCKED if that case is not reproduced, so no repair or blind shard retry was attempted. The actual terminal product head remains 2b7186c1c3ef673f610070a9c0b2a3a34f43b310 on local branch cloud/sx-crank-f64-ci-repair-1.

## Scope, plan and provenance

PLAN.md contains the full eight-step plan, including setup, exact rejected-SHA reproduction, loader isolation, one minimal repair, unchanged before/after shard proof, main/source/contract generation and lock-last handling, guarded product publication and report-only return. Only prerequisite and before-reproduction work completed; repair and later candidate steps were not reached. The sole declared write repository was just-every/run-crank. It was cloned shallow and filtered, then its history was deepened to retain the original f64 commits. No other repository was cloned or modified.

The fleet Git identity, decrypted-bundle helper, push guard and preserved-hook cleanup were installed. Relevant original diagnostic files were read directly from immutable refs/heads/evidence/sx-crank-f64-ci-triage-1-setup1 at 6dabfd37ec460c3d5d3f3f14f5ffaa41ed0ff2a7 without merging evidence files. Twenty selected files were length/SHA-256 verified against its manifest and are retained under diagnostic/. Original f64 commits 862198ed3c42d259d1c4e7f491b09bfe621d64ae and 598f9307bd61093d260ae2f8bdf9bd1947f85cd4 and the rejected integrated commit remain in the retained Git history. Fetched main was e2c146dc38eb64e685cf01d2c56e798404b3936e and is already an ancestor of the rejected candidate. There was no new product candidate requiring a fresh-main merge.

## Actual runtime and setup

This host is Debian GNU/Linux 13 x86_64. Historical CI used Ubuntu 24.04: no exact-host equivalence is claimed. Runtime was explicitly pinned to Node 22.20.0 and pnpm 10.12.4 after sourcing the required toolchain. The toolchain's initial informational line reports VM Node 24.19.0; each actual phase then prepended the exact Node 22.20.0 binary and logged its version/path. Playwright installed and successfully launch/close-probed Chromium headless shell revision 1243, version 153.0.8010.12, with --no-sandbox. browser-binaries.json records executable hashes. Real HOME was retained; no owner profile, cookie or session was transferred. All heavy/browser commands ran serially through cloud_run/subreaper and timeout bounds.

| Phase | Exit | Seconds |
| --- | ---: | ---: |
| pnpm install --frozen-lockfile | 0 | 11.315 |
| pnpm run deps | 0 | 5.404 |
| npm ci --prefix gateways/node --ignore-scripts | 0 | 5.024 |
| npx -y @runeditrun/rer setup --owner-email fleet@runeditrun.com --non-interactive | 1 | 42.802 |
| pnpm exec playwright install chromium | 0 | 36.267 |
| awaited Chromium launch/close readiness | 0 | 2.290 |
| node scripts/verify-ci.mjs --build | 0 | 16.976 |
| node scripts/verify-ci.mjs owner-decisions | 1 | 195.183 |
| one observational loader probe | 1 | 11.582 |

Ordinary setup completed dependencies, build and database migrations but failed during real Worker startup:

> Error: Failed to load url /agent-surface.json (resolved id: [checkout]/agent-surface.json) in [checkout]/src/crank/agent-door/index.ts. Does the file exist?

It then reported a failed listener handshake and setup exit 1. Setup was therefore attempted, not successfully completed. Its partial private local setup remained incomplete. No setup rerun was made.

Chromium installation/readiness completed before the unchanged build and shard. The committed --build prerequisite passed all of its ordinary commands: Worker/assets build, site build, typecheck, first-party check, contract-doc check and deployment-spec check. Product source, shard order and decision assertions were byte-identical to the rejected SHA; reproduction-source-integrity.json proves those hashes.

## Required unchanged shard: actual failure, not a claimed reproduction

Actual command, bounded by timeout 1200 and executed through cloud_run:

```text
env CRANK_EVIDENCE=/home/agent/rer-consolidation/work/sx-crank-f64-ci-repair-1/packet/before-artifacts node scripts/verify-ci.mjs owner-decisions
```

The original recurring, Nook/Orbit sibling and Teams journeys passed in order, including their original 1440/390 evidence. The next original command was tests/decision-browser.mjs. Its real rer dev --foreground invocation stopped before the listener/decision journey with:

> Local migrations, owner or local authentication/mail settings are missing. Run rer setup first.
> dev: failed (exit 3)

The overall unchanged shard exited 1, not 3. It did not reach its original JSON-load failure or decision UI assertions. VERIFY_REPRODUCED.json therefore explicitly records reproduced=false, head=2b7186c1c3ef673f610070a9c0b2a3a34f43b310, historical job=127671299542, actual command/test/nonzeroexit/quotedfailure. No successful after receipt exists. The required reproduction is blocked by the incomplete setup state left by setup's real module-loading failure.

A progress message initially inferred the wrong failure from the nonzero phase result; inspection of the actual log corrected that claim immediately. Receipt extraction raised StopIteration because the expected JSON-load line was absent. That shell did not use set -e, so the next already-prepared report-only probe started. orchestration-receipt.json preserves this error and its consequence. This probe is not a rerun of owner-decisions and does not satisfy the required reproduction gate.

## Additional observed loader attribution, no repair applied

The one-off manifest-loader-probe.mjs uses the actual installed Vite/Cloudflare dev server and an observing pre-load plugin that returns no replacement content. It does not alter source, manifests, configuration, safe-module paths, assertions or loader code. Its actual ssr observation is saved in loader-observation.json and probe-manifest-before.log:

- The resolved absolute root JSON exists and has SHA-256 05856b153904d58868ef2703b4073c7a7d1e66dd701df4fef5f27ba53396e983.
- strict=true; safeAbsolute=false; safeManifestEntries contains /agent-surface.json.
- absoluteAllowed=false. The allow paths are src, public, node_modules and deploy-site.json.
- .seed, .rer and export paths remain denied.
- The real Worker then fails on that JSON load with exit 1, before the probe's intended HTTP check.

Installed Vite 8.2.2 normalizes the inside-root import to /agent-surface.json and inserts that URL-derived string into safeModulePaths. Its filesystem loader later checks the resolved absolute filename, which is a different string and outside the explicit allow paths. The loader therefore skips reading the existing file and emits the generic missing-file error. static-loader-trace.md records exact installed-source locations, including Cloudflare's ordinary fetchModule delegation. This observation goes beyond an allowlist-only inference, but no proposed fix was applied because the assignment's mandatory unchanged shard reproduction did not establish its required failing case.

## Product, contract and CI custody

actual-code.diff is empty. terminal-product-provenance.json records the clean checkout, unchanged head and branch. No product commit or product push exists for this task. No PR was opened. No new CI run ID exists and no final green is claimed. GitHub API calls used: 0/10. Historical Verify 42150056848 / owner-decisions job 127671299542 was neither rerun nor dispatched; those IDs are historical context only.

BASE-AGENT-013 remains PARTIAL. Done/partial/missing counts remain 32/50/17 before and after; no clause status changed. All original AP/Base/riders/frozen lifetime/source/stack/review/provider/release holds remain. No POINTS, source pin, judge request, provider claim, source acceptance, review-hold release, submission/readmission, landing or main mutation occurred. Independent affected re-gating remains required for any future repaired candidate.

No source/contract edits were made, so there is no new contract-generation/lock-last step to execute or commit. The existing contract check passed within the build. No generated views were resolved or newly committed. Listings/migration change check: N/A, because no product, listing or schema change was made. No broader suite, full verify, extra baseline, timeout increase, fallback, generated substitute manifest, assertion suppression or permanent pin/test was added. Typecheck ran only as part of the required unchanged build. Direct native/manifest after-regression and full post-repair shard were not executed because no repair occurred.

## Preservation and return

The full plan, actual logs/receipts, original verified diagnosis, source hashes, empty code diff, loader observation and screenshots are retained in this packet. Cleanup receipts record the absence of remaining owned runtime processes and removal of disposable checkout/dependencies/private setup/browser data after preserving its Git transport storage. No broad/computed task-side kills or rer stop were used. All publication is report-only to evidence/sx-crank-f64-ci-repair-1, separate from product readiness. There was no product push rejection, so no product recovery bundle is required; no finished unpushed product change exists.

The blocker is the required shard reproduction, not an approval or policy question. A corrected prerequisite path is needed before any authorized product repair can proceed. This run does not consume or extend an acceptance budget or authorize another repair attempt.
