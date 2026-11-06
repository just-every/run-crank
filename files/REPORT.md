# sx-crank-f64-ci-triage-1-setup1 actual diagnostic result

TRIAGE COMPLETE: the single corrected pair reproduced the historical failure only on the exact rejected candidate. Its new root-JSON import fails in the real Vite dev Worker before decision-browser can obtain its normal listener/open handshake. Fresh main passed that same original decision-browser journey at 1440 and 390. The production build prerequisites passed on both inputs. Main's complete owner-decisions exit is 0.

## Inputs and custody

- Declared repository: just-every/run-crank. Two disposable shallow filtered clones on the same admitted Debian 13 x86_64 cloud host; no owner profiles, sessions, secrets or environment files copied.
- Candidate: 2b7186c1c3ef673f610070a9c0b2a3a34f43b310 from cloud/sx-crank-c-f64-rebase-2b7186c1c3ef673f610070a9c0b2a3a34f43b310, detached and unretargeted.
- Fresh main, cloned from main: e2c146dc38eb64e685cf01d2c56e798404b3936e. This equals the supplied previous main e2c146dc38eb64e685cf01d2c56e798404b3936e.
- Original f64 source: 598f9307bd61093d260ae2f8bdf9bd1947f85cd4 (brief provenance, not a third baseline).
- No task product branch, product commit, product push, PR, CI rerun/dispatch, admission, submission or lifecycle change was created. Evidence-only publication is separate.
- Original failed preparation attempt remains immutable and is not reclassified: both builds passed; both shards stopped on missing chromium_headless_shell-1243 before browser assertions or decision-browser startup. This task performed only its separately authorized corrected pair.

## Plan executed and prerequisites

PLAN.md contains the full plan. After launcher setup and Git identity/authentication setup, read each checkout's committed AGENTS, verification plan, workflow prerequisites and relevant source. Run all ordinary setup serially for candidate then main before either shard. The ten setup phases all exited 0. Frozen install was pnpm install --frozen-lockfile; committed deps was pnpm run deps (rer install); gateway setup was npm ci --prefix gateways/node --ignore-scripts. Each clone's pnpm exec playwright install chromium completed with exit 0 before its trivial launch/close-only readiness probe. No app/assertions were used for readiness.

Exact execution runtime was Node 22.20.0 and pnpm 10.12.4, with identical dependency pins. The supplied toolchain shim initially reports VM Node 24; the task then explicitly prepends the exact Node 22.20.0 binary before executing each command. Build/shard logs record the actual Node version, pnpm version and Node path. Browser was Playwright Chromium/headless shell revision 1243, Chrome Headless Shell 153.0.8010.12. browser-binaries.json records exact paths, executable status and SHA-256; probes log the actual default launch binary. No system Chrome or executable override was used. Host/runtime/setup receipts retain nonsecret provenance.

Then execute unchanged node scripts/verify-ci.mjs --build and unchanged node scripts/verify-ci.mjs owner-decisions exactly once for candidate, followed by the same commands exactly once for fresh main. Each command was bounded by timeout 1200 and run through cloud_run/subreaper. Original assertions, real Worker/D1, journey order and cleanup remained committed and unchanged. No broader suite, further baseline, rerun, fallback, retry, mock injection, hand-copied manifest or harness modification occurred.

| Phase | Exit | Seconds | Complete nonsecret log |
|---|---:|---:|---|
| candidate-frozen-deps | 0 | 6.432 | candidate-frozen-deps.log |
| candidate-committed-deps | 0 | 5.175 | candidate-committed-deps.log |
| candidate-gateway-deps | 0 | 3.837 | candidate-gateway-deps.log |
| candidate-chromium-install | 0 | 19.101 | candidate-chromium-install.log |
| candidate-chromium-probe | 0 | 1.876 | candidate-chromium-probe.log |
| candidate-build | 0 | 15.98 | candidate-build.log |
| candidate-owner-decisions | 1 | 212.371 | candidate-owner-decisions.log |
| main-frozen-deps | 0 | 8.558 | main-frozen-deps.log |
| main-committed-deps | 0 | 5.412 | main-committed-deps.log |
| main-gateway-deps | 0 | 2.987 | main-gateway-deps.log |
| main-chromium-install | 0 | 1.486 | main-chromium-install.log |
| main-chromium-probe | 0 | 1.243 | main-chromium-probe.log |
| main-build | 0 | 16.899 | main-build.log |
| main-owner-decisions | 0 | 546.493 | main-owner-decisions.log |

## Dynamic evidence and failure reached

Candidate --build exit 0: production Worker/assets, site build, typecheck, first-party check, contract-doc check and deployment-spec check passed. Candidate owner-decisions exit 1. Recurring, Nook/Orbit sibling and Teams journeys passed with original 1440/390 evidence. Its next original command, decision-browser, launched ordinary rer dev --foreground. The dev Worker emitted: Failed to load url /agent-surface.json (resolved id: [REDACTED]/agent-surface.json) in [REDACTED]/src/crank/agent-door/index.ts. Does the file exist? It exited 1 and the installer reported Waiting for the application listener handshake. The decision UI assertions were not reached; later commands were not run. candidate-owner-decisions.log and candidate-owner-decisions-dev-startup.log preserve this exact failure.

Fresh main --build exit 0. The same preceding journeys passed. The real dev Worker reached RER_READY, and decision-browser passed UX-001 at both 1440 and 390: offline input retained, all decisions frozen, authoritative GET recovery, one approve and one committed-response-lost reject, no POST replay, legacy rejection, and the original 1440 bounded timeout. Main did not reach the historical JSON-load failure. See main-owner-decisions.log for all subsequent original commands and its final exit; main's complete shard exit is 0.

## Source/cleanup trace and causal limits

relevant-source.diff and source-provenance.json bind the trace to exact committed bytes. Candidate src/crank/agent-door/index.ts:5 adds import surface from '../../../agent-surface.json' and consumes its seed/specialist/documentation fields; main uses literals and lacks that import. The root JSON is tracked and edition-selected on both inputs. It remained present and byte-identical on the candidate after the preceding cleanup and failure. Both tracked checkouts remain clean after execution.

Preceding recurring/sibling/Teams cleanups close their contexts, browsers, bridges and disposable harnesses. tests/harness.mjs disposes Miniflare and removes only its mkdtemp crank-tests-* persistence directory. No inspected cleanup deletes the root JSON. vite.config.ts is identical on both inputs and lists src/public/node_modules/deploy-site.json in its dev filesystem allowlist. Installed Vite 8.2.2 also admits safeModulePaths before the allowlist and can populate them during module resolution (vite-static-excerpt.txt). Thus allowlist omission alone is not causal proof.

The controlled dynamic differential establishes the introduced dev JSON import/load failure on this candidate and the resulting inability to run the original owner-decisions/UX-001 standing bar. It is not classified as infrastructure from startup wording. The precise internal Vite/Cloudflare loader and safe-module/allowlist interaction was not independently isolated by the authorized pair; no further app probe or repair was performed. The current host is Debian 13, whereas historical CI was Ubuntu 24.04, so host equivalence is a limitation despite the matching failure.

## Historical CI and limits of fetched logs

Historical Verify 42150056848 attempt 1: failed owner-decisions job 127671299542 on candidate 2b7186c1c3ef673f610070a9c0b2a3a34f43b310; connections 127671299444 cancelled; aggregate verify 127675746913 failed derivatively. A single REST jobs request confirmed the exact SHA, statuses and failed step Run this shard. One gh run view 42150056848 --repo just-every/run-crank --job 127671299542 --log-failed exited 0 with no stdout/stderr log text. No blob-download retry or additional log call was made. The detailed historical startup text comes from the supplied immutable brief; this task's matching failure is directly captured in its own logs. GitHub budget used: 2/10 calls. No new CI run IDs exist.

## Standing status, remaining dependency and preservation

Clause/status changes: none. BASE-AGENT-013 remains PARTIAL. Before/after counts remain 32/50/17. Original AP/Base/riders/frozen lifetimes/source/stack/review/provider/release holds remain. This diagnostic does not award acceptance or authorize landing. No diagnostic prerequisite remains missing. The rejected candidate's real dev JSON-load failure remains for a separately authorized product action; the exact loader mechanism is not proved further here.

Complete actual nonsecret commands, logs, screenshots, provenance and exits are retained in this packet; RESULTS.json is the machine receipt. Query strings, URL fragments/local sign-in links and credential-labelled runtime output are removed before selecting files. No credentials, environment dumps, held-out material or symlinks are selected. Phase wrappers/collector are retained for the redaction and command record, without secret values. Only the ordinary report-return entrypoint publishes explicitly selected files to refs/heads/evidence/sx-crank-f64-ci-triage-1-setup1. Product heads/indexes remain unchanged. Both disposable checkout directories and all their node_modules have been deleted; checkout-cleanup-receipt.json records the actual outcome. The original main clone Git directory was moved temporarily to return-transport.git (no third clone) so the ordinary report-return command can read its unchanged head/origin. That temporary Git storage is removed after publication. The task-created browser cache was deleted after binary provenance was saved. After all original assertions finished, a task-owned rer dev server outlived the test command. Record its literal PID 6350, cwd, executable, parentage and start ticks in owned-server-cleanup-start.json, then run only kill -TERM 6350. It and its runtime descendants exited; the subreaper completed with main shard exit 0. The task-side cleanup used no computed PID kill, rer stop, pkill or killall; the committed journey cleanup was preserved unchanged. See owned-server-cleanup-receipt.json.
