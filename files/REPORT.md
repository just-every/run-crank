# sx-crank-container-hosted-1 — hosted container qualification

Repository: just-every/run-crank
Branch: cloud/sx-crank-container-hosted-1
Product head: 0fbed5e5bcb6965d68505fc2358bb442c983905d
Base: 18cf94064499fd097f145cd1c45a681dadd08445
PR: none; the repository has branch-push Verify.
No workflow was dispatched. No container acceptance, landing or DONE claim is made.

## Plan and implementation

1. Completed fleet identity and launcher refresh, bundle-only Git authentication, cloud push guard, repository commit-message hook and separate evidence transport. Used a fresh full-history clone and the named branch from origin/main.
2. Read the inline RULES, launcher and repository AGENTS, BASE-005 prose and live Gap, the installed rer container command path and preserved f104 operational context. Current main has no numbered container-row table. Read Base's source-only conformance entry point via gh api: it accepts default-seed, Lamp and Uptime, not Crank, and is absent from the npm package. It was not invoked with a false seed identity.
3. Added .github/workflows/container-qualify.yml: workflow_dispatch only, ubuntu-24.04, contents: read, 25 minutes, no repository secrets. Existing push, PR, nightly and reusable workflows are unchanged. Checkout, Node setup and artifact upload use existing repository action SHA pins.
4. Added scripts/container-qualify.mjs. It installs the checkout's pinned pnpm with frozen dependencies, verifies exact rer installation, and wraps Base's build, preview and archive commands. It records per-row status and elapsed time, source SHA, rer version and immutable image ID. Failure prints command output and makes the job fail. A 22-minute driver budget leaves cleanup/upload time. Interruption and dependent NOT RUN rows cannot yield success.
5. The intended dispatch path builds the real Base image, launches Base preview on a fresh volume, checks native container health and exact digest, creates and publishes a synthetic map-only workflow, kills the actual container and relaunches through Base using the same volume, then checks retained native state. Each inspected runtime receives a 1 GiB limit. This is not proof of cold startup at that limit.
6. Archive export and empty-destination import use Base's own commands, not a copied archive policy. The driver never changes Base, generated Dockerfiles, image runtime, migration inventory or Crank policy. Restore, if reachable, uses the same image ID and a different checkout/volume, fresh owner sign-in and paused-workflow readback. Archives and settings are excluded from artifacts.
7. Added docs/CONTAINER-QUALIFICATION.md explaining invocation, artifact contents, exact command mapping and unsupported duties. Uploads explicitly select result.json, summary.md and sanitized logs/*.log, not directories containing private inputs.
8. Ran touched checks, regenerated sources.lock.json last with the installed pinned authoring tool, checked it, committed and pushed the first real commit through cloud-push.py. Fetch/rebase before the first commit found main unchanged. There is no published-history rewrite, force push, default-branch push or PR.
9. Exact-SHA Verify completed successfully with one REST watcher, no more often than every 300 seconds, within ten GitHub calls. The complete actual non-secret packet is returned only on evidence/sx-crank-container-hosted-1.

## Actual checks

local-checks.json contains actual argv, exit codes, durations and log hashes.

- actionlint 1.7.7 on the new workflow: PASS.
- node --check scripts/container-qualify.mjs: PASS.
- node scripts/verify-ci.mjs --check-workflows: PASS.
- pnpm typecheck: PASS.
- pnpm exec rer check --profile first-party: PASS.
- Installed edition-authoring source lock generation/check: PASS.
- Staged diff whitespace check: PASS.
- Synthetic command-boundary probes: PASS for preserved failing-command output/nonzero exit, installed-pin mismatch, refusal to use/delete an existing data volume and interrupted-result finalization. These prove reporting/custody behavior only, not a container or native application.
- Actual pinned Base archive-policy preflight: REFUSED with safety_refusal and container_policy_module_unsupported, as documented below.

Local checks used the supplied toolchain's Node 24.19.0 and pnpm 10.12.4. The workflow uses .node-version (22.20.0). Package, lockfile and runtime pins are unchanged. No full local verify, browser session, Docker image build or hosted workflow dispatch was run; this is not UI work.

## Actual unresolved boundary

Crank's installed adapter uses:

    localPortability({ database: 'foundation', policyModule: 'src/crank/archive-policy.mjs', ... })

The actual installed @runeditrun/rer/portability public API was invoked with that policy and platform=container, without starting Docker or transferring data. It refused with:

    Local portability policy refused (container_policy_module_unsupported). Executable policies require a seed-owned policyModule with a valid default policy export; policyModule requires native local transport.

The complete actual receipt is archive-policy-preflight.json. This is an existing Base boundary, not the proxy certificate failure. A hosted runner avoids the observed build proxy but cannot remove this pinned API refusal. The workflow will retain the actual export failure and label dependent restore NOT RUN. No serializable replacement, policy weakening, Base patch or pin bump was introduced.

There is also no Crank-compatible Base recovery-suite entry point in the pinned npm package, and current main does not contain the brief's referenced container-row table. The delivered wrapper qualifies only the explicitly documented command/health/state rows. It does not replace the production acceptance journey. The lane must retain the maintained Base archive-policy door and the documented unproved recovery duties as unresolved; this command-level mapping does not narrow the prose acceptance.

Not established by this run or the workflow: clean macOS one-line signed-in start; supervised owned-server boot or Docker-daemon restart; owned HTTPS; one run per due five-minute schedule; same-identity production upgrade; recovery of active effects; authorized Cloudflare deployment; SSH-host export or server-to-Cloudflare import. The native draft/map persistence check is not a substitute for any of these. No provider/customer request or ownership/account receipt is claimed. SEC-002, HTTP-002, TRIG-007, PLATFORM-001 and WORK-005 holds remain unchanged.

## Custody, scope and counts

Product diff: exactly the new workflow, its script, cited documentation and regenerated sources.lock.json. Contract, generated views, all src paths, package/runtime pins and existing workflows match main byte-for-byte (product.json).
Candidate author and committer are Run Edit Run fleet <fleet@runeditrun.com>; full candidate messages contain no trailers.
Guarded product push succeeded on its first attempt; remote ref readback matched the full product SHA.
No publication scan is claimed from this cloud. Fleet publication and landing gates remain required.

Clause counts before -> after: 32 DONE, 50 PARTIAL, 17 MISSING -> 32 DONE, 50 PARTIAL, 17 MISSING.
BASE-005 remains PARTIAL; no Status, Gap, Evidence or acceptance sentence changed.
Test-budget metadata remains 199. No ordinary registration or push Verify command changed. Counting the new dispatch-only assertion driver once brings the inventory from 199 to 200 under the fleet rule; no budget raise is requested.

BASE-005 remains PARTIAL; this undispatched workflow proves no complete acceptance point.
GAP BASE-005: Pinned Base refuses Crank's executable policy for container archives; hosted image/process qualification remains undispatched and does not establish owned-host, Cron, HTTPS, macOS or Cloudflare acceptance.
No new product-policy default is adopted.

## CI and terminal state

Exact product Verify: run 42533994392 on 0fbed5e5bcb6965d68505fc2358bb442c983905d.
Completed SUCCESS on the exact product SHA; https://github.com/just-every/run-crank/actions/runs/42533994392 . See CI.json, ci-discovery.json and ci-status-1.json through ci-status-4.json. Eight total GitHub calls were used, including three reference/tool-install reads and five exact-SHA CI observations. No failed-job log request was needed.
Container qualification: NOT RUN, deliberately not dispatched by the builder.
The workflow is pushed for review and later lane dispatch. Archive qualification remains unavailable through the pinned Base policy door. Workflow delivery and branch Verify do not close these acceptance limits.

READY branch=cloud/sx-crank-container-hosted-1 head=0fbed5e5bcb6965d68505fc2358bb442c983905d
