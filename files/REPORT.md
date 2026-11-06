# sx-crank-f81fix1 result

Repository: just-every/run-crank. Product branch: cloud/sx-crank-f81fix1.
Rejected head: d8623c31cf359634b9516a57754ede47e02fa8e8.
Final candidate: cb5bd681c5d0ec59cf990150b33e2d83755d3896.
Fresh main merged before candidate push: e2c146dc38eb64e685cf01d2c56e798404b3936e (already up to date).
No PR was created; this repository's shipped instructions name no PR landing requirement. No main/default branch write, force push, rerun, dispatch or landing submission occurred. One product push succeeded on its first attempt.

## Repair and frozen scope

Only frozen blocking B was repaired. Native agent admission now requires both workflows:read and runs:read for GET /api/crank/state, because that aggregate contains flow metadata plus run payloads, approvals and attempts. The guard uses the existing currentScopes intersection of original issuance and retained grant, before entering the aggregate handler. Other URL-family rules and all other source behavior remain unchanged. The fix returns HTTP 403 for an insufficient aggregate grant; authorized native and bearer reads retain HTTP 200 and complete synthetic input.

The rejected candidate's two original commits e4e82fafc93b7f60099b4615128a555a775b25de and d8623c31cf359634b9516a57754ede47e02fa8e8 remain unchanged ancestors. The repair adds only src/crank/access.ts, tests/platform.test.mjs and the regenerated sources.lock.json. There is no UI, copy, checkbox, provider, Base, other-clause or migration work. All original frozen assertions remain in place and passed in the affected four-registration file, including issuance/refused upgrade, human/agent controls, forged identity/direction refusal, revision-bound persistent removal, stale/concurrent refusal, preparation commit fencing, held human approval and revoked/withdrawn authority, and inactive restoration.

## Public-door reproduction

PROBE B: cloud_run node ../packet/scope-probe.mjs before -> exit 0, policy FAIL. Before any product edit, the native owner created and activated a synthetic flow, an independent native owner created a pending run containing synthetic private input, and the owner issued an agent bearer and removed runs:read while retaining workflows:read. Direct GET /api/crank/runs/:id returned 403. GET /api/crank/state returned 200 with the same run and private input both immediately and after Worker restart. An agent originally issued only workflows:read exposed it too. The probe exits zero because its before mode asserts the observed vulnerability, not policy compliance.

The same executed probe after repair -> exit 0, policy PASS. Direct and aggregate reads return 403 both immediately and after restart, for both an original restricted ceiling and a later removal. No run input is returned. Retained flow reads return 200. An independently issued bearer with both workflow and run read scopes, and the native owner, continue to read the exact input with 200 before removal and in both post-removal stages. The probe uses native HTTP, the real Worker/D1, no application mock, and only synthetic-crank fixtures.

The existing first platform registration is extended with the same denial, restart, original-ceiling and authorized-read controls. No test registration, test skip or deletion was added, and no assertion was weakened.

## Executed mechanical checks

MECHANICAL cloud_run pnpm install --frozen-lockfile -> exit 0.
MECHANICAL cloud_run npx -y @runeditrun/rer setup --owner-email fleet@runeditrun.com --non-interactive -> exit 0. Setup output stays private because it may contain local sign-in material; it is not selected for evidence.
MECHANICAL cloud_run node ../packet/scope-probe.mjs before -> exit 0; actual policy FAIL recorded in probe-before.json.
MECHANICAL cloud_run node ../packet/scope-probe.mjs after -> exit 0; policy PASS recorded in probe-after.json.
MECHANICAL cloud_run node --test --test-concurrency=1 tests/platform.test.mjs -> exit 0, four passed, zero failed/skipped/cancelled; platform-tests.log.
MECHANICAL cloud_run pnpm typecheck -> exit 0; typecheck.log.
MECHANICAL cloud_run npx -y @runeditrun/rer build -> exit 0; build.log.
MECHANICAL git fetch origin main and identity-bound git merge --no-edit origin/main -> both exit 0; main already up to date.
MECHANICAL node src/base/contract-docs.mjs write -> exit 0, 99 clauses.
MECHANICAL node src/base/contract-docs.mjs check -> exit 0, documents current immediately after generation.
MECHANICAL git checkout origin/main -- ACCEPTANCE.md docs/CLAIMS.md -> exit 0; both generated views restored whole, neither committed.
MECHANICAL node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock -> exit 0, run after all final source/document changes.
MECHANICAL node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check -> exit 0, installed @runeditrun/rer 0.2.91 pinned by this checkout and used by Verify.
MECHANICAL git diff --check -> exit 0; candidate worktree clean.
MECHANICAL python3 $HOME/rer-consolidation/.tools/cloud-push.py origin cloud/sx-crank-f81fix1 -> exit 0, first attempt.
Migration-ledger check: not applicable; no migration changed.
No full local suite or local rer verify was run. No browser proof is required because this repair has no visual change. Every started local Worker was disposed by its harness or rer command; cloud_run reaped descendants.

## Counts, contract and retained obligations

Affected registrations: 4 before / 4 after; 4 pass / 0 fail / 0 skip. Net registration change: 0. Inherited test-budget.json still records current 201, maximum 200; this frozen repair neither changes that record nor adds registrations.

Contract counts before / after: 32 done / 50 partial / 17 missing = 99, unchanged. Status changes: none. BASE-AGENT-005 stays PARTIAL. CONTRACT.md is byte-identical to the rejected candidate, preserving its original bounded evidence delta and all current-main requirements, judgments, evidence/provenance, riders, holds, acceptance and original lifetime. The broader Gap remains exactly:

Explicit owner-issued tool-scope ceilings, shared person and agent removal, server-resolved identity, revision-bound narrowing, immediate and restarted native preparation refusal, held human approval and inactive scope restoration are proved. Full per-role and per-tool UI parity; resource, folder, action and budget grant intersection; broader sponsor downgrade and suspension journeys; other access and security actions; complete injection resistance remain required. Existing BASE-AGENT-004 token and consent lifecycle, real IdP interoperability, Business propagation, owner and account, ct, enforcing-egress and device holds remain unchanged; TEAM-001 policy and TEAM-006 creation revisions are untouched.

This is original sx-crank-c-f81 lifetime FIX 1 of 2. The original and repaired candidate remain held for the SAME frozen independent re-gate. No promotion, judge request or acceptance expansion is made.

## Publication and custody

Every candidate commit, including side parents, was inspected with git log origin/main..HEAD --format="%an <%ae>%n%cn <%ce>%n%(trailers:only,unfold)" and full messages before pushing. All three candidates use Run Edit Run fleet <fleet@runeditrun.com> as both author and committer; no trailers are present. The fleet cleanup hook remained enabled and preserved repository hooks. The repair diff contains only product admission, synthetic test fixtures and source hashes. No credentials, private gate material, environment dump or fleet evidence is committed to the product branch.

The full-history COMPLETE publication scan cannot run in this cloud and remains the maintained Mac lander's duty, along with the final executed runtime Verify, guarded main/equality checks and Run site after the frozen re-gate. Product READY is a candidate handoff, not acceptance or landing. Evidence publication is a separate report-only tree and does not establish product readiness.

## Exact-SHA CI

Verify run 42158651905 completed with overall conclusion failure on the exact candidate SHA cb5bd681c5d0ec59cf990150b33e2d83755d3896: https://github.com/just-every/run-crank/actions/runs/42158651905.

The sole root failure is the permitted generated-view mismatch: shared build job 127698893615 reaches `node src/base/contract-docs.mjs check` and exits 1 with `Error: ACCEPTANCE.md is stale; run node src/base/contract-docs.mjs write`. Its preceding Worker build, site build, typecheck and first-party check succeeded. Plan and its installed source-lock check succeeded. Final verify job 127699165908 fails because BUILD=failure and SHARDS=skipped; runtime shards were skipped, so no full CI runtime pass is claimed. Both failed job archives were read exactly once with the required `gh run view ... --log-failed` commands, exits 0; actual logs are in ci-build-failed.log and ci-verify-failed.log. There were no transport archive failures.

This qualifies for READY under the brief's explicit generated-view-only exception. Neither generated view was committed to turn Verify green. No real blocker remains for this builder handoff. The same frozen independent re-gate is still required; final actual runtime Verify and full-history publication/landing gates remain the Mac lander's duty.

Five GitHub CLI invocations were used: discovery, one run poll after more than 300 seconds, completed-run jobs, and one archive read per failed job. The sole watcher has exited. No workflow dispatch, rerun or additional product push occurred.

The complete plan is PLAN.md. Actual receipts and the executed public-door probe are explicitly selected in this packet. Setup logs, injected credentials, private settings and unselected files are excluded.

Cleanup: all owned runtime processes have exited. The product clone and dependencies will be removed after successful report-only publication and custody verification; the packet remains outside the clone.
