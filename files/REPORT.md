# sx-crank-f64-ci-triage-1 — original f64 final-Verify triage

The requested differential is **NOT RUN at the original failure point**. Both clean inputs built successfully, but both owner-decisions invocations exited 1 at the first journey's browser launch, before any browser assertions and before `tests/decision-browser.mjs` or its real development Worker started. I started the shard controller before the ordinary Playwright browser installation finished. This is a preparation/sequencing error in this triage run, not evidence about the original CI failure. No repeat was performed under the brief's one-pair limit.

## Exact source custody

Repository: `just-every/run-crank`.

| Input | Branch | Full committed SHA |
| --- | --- | --- |
| Rejected integration candidate | `cloud/sx-crank-c-f64-rebase-2b7186c1c3ef673f610070a9c0b2a3a34f43b310` | `2b7186c1c3ef673f610070a9c0b2a3a34f43b310` |
| Fresh remote main, cloned independently | `main` | `e2c146dc38eb64e685cf01d2c56e798404b3936e` |
| Saved baseline named by brief | supplied reference | `e2c146dc38eb64e685cf01d2c56e798404b3936e` |
| Original f64 source named by brief | supplied reference, not separately tested | `598f9307bd61093d260ae2f8bdf9bd1947f85cd4` |

`git ls-remote` confirmed the rejected branch still points to the named SHA. There was no identity retargeting. Fresh main equals the saved baseline. Both checkouts were shallow, filtered, single-branch clones on this one dedicated cloud VM. `git status --porcelain=v1` was empty before and after both commands; no tracked or untracked product files were changed. Source bindings and lock hashes are in `provenance-before.json` and `provenance-after.json`.

The frozen pnpm lock is identical on both inputs: SHA-256 `3764eeff5aad3b6371aff04d277021fad944c5f67d9b6195597f247d631c9ff9`. Both actual command processes ran Node **22.20.0**, pnpm **10.12.4**, and installed `@runeditrun/rer` **0.2.91**. The VM is Debian GNU/Linux 13 x86_64, rather than the historical Ubuntu 24.04 runner. This host distinction remains a limitation of any later interpretation. Runtime details are in `runtime.json`; no credential/environment dump was retained.

## Plan and ordinary command bindings

The complete plan is also retained as `PLAN.txt`.

1. Read the launcher and repository instructions and the committed workflow/verification scripts before testing. Initialize fleet authentication and identity outside the product trees.
2. Confirm the exact rejected branch and fresh main, then make two disposable shallow filtered clones on the same host. Preserve each committed HEAD and frozen dependency lock.
3. Select exact Node 22.20.0 and pnpm 10.12.4. Use the workflow's ordinary dependency commands and build prerequisite; preserve the public shard command, real Worker/D1, all assertions and journey setup/cleanup order.
4. Run the candidate, then main serially, with a 1200-second bound per build/shard. Preserve full non-secret logs, commands, times, exits and clean-tree receipts outside the clones. Do not run the full suite, rerun/dispatch CI or repeat the bounded differential.
5. Trace the changed manifest import, packaging/source selection and preceding journey cleanup. Separate supplied historical evidence, local observations and unresolved source hypotheses.
6. Publish only explicitly selected non-secret reports/receipts to `refs/heads/evidence/sx-crank-f64-ci-triage-1`; delete both clones/dependencies and task-owned runtime scratch after capture. Preserve all original holds and acceptance judgments.

Clone commands:

```sh
git ls-remote https://github.com/just-every/run-crank.git refs/heads/main refs/heads/cloud/sx-crank-c-f64-rebase-2b7186c1c3ef673f610070a9c0b2a3a34f43b310
git clone --depth 1 --filter=blob:none --single-branch --branch cloud/sx-crank-c-f64-rebase-2b7186c1c3ef673f610070a9c0b2a3a34f43b310 https://github.com/just-every/run-crank.git <task>/candidate
git clone --depth 1 --filter=blob:none --single-branch --branch main https://github.com/just-every/run-crank.git <task>/main
```

After each clone the local fleet identity and preserved-hooks installer were applied. Dependency setup from each checkout used:

```sh
. /tmp/rer-cloud-toolchain.sh
export PATH="$HOME/.rer/toolchain/node-22.20.0/node_modules/node/bin:$PATH"
cloud_run timeout 600 pnpm install --frozen-lockfile
cloud_run timeout 600 pnpm run deps
cloud_run timeout 300 npm ci --prefix gateways/node --ignore-scripts
```

All six dependency commands exited 0. `pnpm run deps` selects the repository's pinned `rer install`; no application setup answers, manifest copies, owner profiles or held credentials were supplied manually. The pinned Node runtime was installed outside the clones with `cloud_run timeout 300 npm install --prefix "$HOME/.rer/toolchain/node-22.20.0" --no-audit --no-fund node@22.20.0`.

The committed `.github/workflows/verify.yml`, `scripts/verify-ci.mjs:121-135`, `scripts/verify-app.mjs` and `verification.json` bind the commands as follows:

```sh
cloud_run timeout --signal=TERM --kill-after=30s 1200 node scripts/verify-ci.mjs --build
cloud_run timeout --signal=TERM --kill-after=30s 1200 node scripts/verify-ci.mjs owner-decisions
```

The build prerequisite runs `pnpm run build`, `pnpm exec rer build --site`, `pnpm run typecheck`, `pnpm exec rer check --profile first-party`, `node src/base/contract-docs.mjs check`, and `pnpm check:deployment-spec`, in that committed order. Both completed all of these successfully. No generated view write or source-lock regeneration was performed.

The owner-decisions entrypoint runs `pnpm run verify:app` with `SEED_VERIFY_SHARD=owner-decisions`. Its unchanged committed order is recurring-browser, sibling-browser (which includes Teams), decision-browser, executor-schema-browser, digest-browser, run-notices-browser, team-browser, then sample-browser. It is the unmodified public command, not a reconstructed harness. `CI=true`, metrics disabled, and browser-cache GC disabled followed the ordinary workflow conventions. `CRANK_EVIDENCE` pointed outside the clones. `CRANK_CHROMIUM_EXECUTABLE=/usr/bin/chromium` used the existing override where supported; `decision-browser.mjs:72` adds `--no-sandbox` on Linux. The first recurring journey does not read that override and uses Playwright's default headless-shell path.

## Actual terminal results

| Input | Build UTC | Build exit | Owner-decisions UTC | Shard exit | Original failure reached? |
| --- | --- | --- | --- | --- | --- |
| Candidate | 03:11:40–03:12:00 | 0 | 03:12:00–03:12:05 | 1 | No |
| Fresh main | 03:12:06–03:12:27 | 0 | 03:12:28–03:12:33 | 1 | No |

All timestamps are 2026-11-06 UTC. Both phases were controlled by PID 1251 on this same VM. Neither reached its timeout. The four `*-receipt.json` files contain actual full SHAs, UTC times, exact commands, versions, lock hashes, exits and empty Git status. Full build and shard logs are included.

Both shard logs terminate at the same **different** failure, `tests/recurring-browser.mjs:26:30`:

```text
browserType.launch: Executable doesn't exist at /home/agent/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
```

The ordinary installer was invoked as:

```sh
cloud_run timeout 300 pnpm exec playwright install chromium
```

It subsequently completed successfully, installing the frozen Playwright build 1243. The installer output is `browser-install.log`. It was not complete when either shard started. No browser or real decision Worker was started manually to bypass that prerequisite. No assertion, timeout, catch, retry, manifest, pin, workflow or test was changed. No application input was fabricated. The original runtime comparison therefore remains **NOT RUN**, rather than a passing reproduction, a reproduced product regression or a proven infrastructure flake.

A corrected pair was requested asynchronously after discovering the sequencing error. Without new authorization, the brief's bounded one-pair limit prevents another invocation. The remaining prerequisite is **authorization for one fresh bounded differential, after the ordinary Playwright Chromium installation has completed and before either shard starts**. No corrected pair is represented in these receipts.

## Source trace relevant to the original failure

`source-diff.txt` and `source-trace.txt` retain the exact compared code and line bindings. The relevant observations are:

- The candidate newly adds `import surface from '../../../agent-surface.json'` at `src/crank/agent-door/index.ts:5`. Main's corresponding module has no manifest import and uses literal `seed` and `specialist` values. The candidate now reads seed, specialist, limits and documentation path from that root JSON and wraps discovery/documentation responses.
- `agent-surface.json` exists and is tracked in both clean inputs. `edition.json:62` includes it in the edition's local source path list, which is unchanged between candidate and main. There is no demonstrated omission from the clone or declared source package. The file itself changes in the candidate, but is not missing. The normal production builds pass on both inputs.
- `src/server.ts:17` statically imports the agent-door entrypoint. `src/server.dev.ts:4` imports that server and wraps it with the ordinary development identity/AI layers. Thus the new root JSON dependency belongs to the live development Worker's module graph before request handling; it is not confined to opening `/docs/agents`.
- The unchanged `vite.config.ts:14-21` selects `src/server.dev.ts` for `vite dev`, while the production build uses `src/server.ts`. Its filesystem allowlist contains `src`, `public`, `node_modules` and `deploy-site.json`; it does not explicitly list the root `agent-surface.json`.
- Frozen Vite 8.2.2's file loader checks `isFileLoadingAllowed`, whose decision includes the filesystem allowlist and `safeModulePaths`. When no plugin supplies a module and the filesystem load does not produce code, its error is `Failed to load url ... (resolved id: ...) in ...`. This matches the shape of the historical error. Because the decision journey was not reached here, this trace is **consistent with**, but does not dynamically prove, a filesystem/source-loading refusal for the newly imported root JSON. The loader's safe-module mechanism also means an absent explicit allowlist entry alone is not sufficient dynamic proof.
- The earlier recurring journey uses emitted production modules from `dist/server`, while sibling/Teams journeys use their existing esbuild/Miniflare harness and browser bridges. They do not start the same Vite development Worker used by decision-browser. Their success in the supplied CI log is therefore compatible with a later source-loading failure, without proving its cause.
- Recurring cleanup (`tests/recurring-browser.mjs:66`) closes its browser, native harness and HTTP bridge. Sibling cleanup (`tests/sibling-browser.mjs:94`) closes context, browser and bridge before importing/awaiting Teams at lines 96–97. Teams closes its per-screen context/bridge (`tests/teams-search-browser.mjs:53`) and browser (`:55`); its journeys close all created harnesses in their own `finally` blocks. The harness native close method disposes Miniflare and removes only its temporary resource-persistence directory (`tests/harness.mjs:122`). These committed cleanup paths contain no removal of `agent-surface.json` or the source checkout.
- Decision-browser starts `rer dev --foreground` (`tests/decision-browser.mjs:22-25`), reads readiness from its own private temporary log, and reports startup failure before browser assertions if the child exits (`:60-72`). Its own final cleanup closes the browser, stops its recorded child tree and removes its own private temporary directory. This order was not changed.

The preceding journeys, verification plan, workflow, Vite configuration, package pins and frozen lock are identical between the two inputs. No local evidence establishes that their cleanup deleted the JSON file. The smallest established local cause is the **missing browser prerequisite at the first journey**. The original missing-agent-surface failure's product-versus-infrastructure attribution remains unresolved. The candidate-only static import is the precise introduced dependency relevant to further diagnosis; this report makes no causal verdict or repair proposal beyond that evidence.

## Historical CI evidence and unchanged acceptance custody

The inline brief supplied the already-read complete failed-job evidence: Verify run **42150056848**, attempt **1**, exact head `2b7186c1c3ef673f610070a9c0b2a3a34f43b310`; owner-decisions job **127671299542** failed after recurring 1440/390, sibling and Teams journeys passed. Decision-browser's development Worker reported `Failed to load url /agent-surface.json ... in .../src/crank/agent-door/index.ts`, followed by a listener-handshake failure. Connections job **127671299444** was cancelled, and aggregate job **127675746913** was derivative. `ci-supplied-evidence.json` clearly labels these facts as supplied history rather than newly fetched logs.

No GitHub API call, new workflow, retry or dispatch was made. The historical exact-SHA Verify remains red. There is no local full Verify claim, no infrastructure item attributing this original failure, and no FIX verdict. The failure's startup wording alone does not establish infrastructure.

BASE-AGENT-013 remains **PARTIAL**. Before/after counts remain **32 done / 50 partial / 17 missing** as frozen in the brief. Clause status changes: **none**. FIX count increment: **0**. The named incumbent context remains Zapier, Make, Workato, n8n, Gumloop and Pipedream; this diagnostic did not judge an acceptance point against them. No acceptance or standing-bar judgment is changed. Original AP/Base/riders/frozen FIX lifetime, source/stack/review/authority/provider/release holds, stranger-specialist gaps and account/egress/device holds remain intact.

Final runtime-green exact-SHA Verify, full-history NEW0, guarded main equality and exact-main Run site remain required for any future landing. Diagnosis is not landing. No product commit, product push, PR, READY, submission, lifecycle action, hold release or product award was made. The generic product branch `cloud/sx-crank-f64-ci-triage-1` was not created or pushed because this brief is read-only triage. Only the explicitly authorized report-return evidence ref is published.

NOTE G: This triage's two shard invocations ended at a missing Playwright browser prerequisite before the original failing decision journey. Trigger: ordinary owner-decisions on this fresh VM before browser installation completed. New: caused by this run's preparation sequence, not established as a product change. Original CI attribution remains unresolved; no A/B/BAR finding or FIX is issued.

TRIAGE BLOCKED — prerequisite: authorize one fresh bounded candidate/main differential after the ordinary Playwright Chromium installation completes, preserving the unchanged commands and 1200-second bounds.
