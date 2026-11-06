# sx-crank-c-f87 results

The gate's sole blocking B finding is fixed. After an owner removes `runs:read`, an agent retaining `workflows:read` cannot read aggregate run payloads. Both `/api/crank/state` and the direct run door return 403 immediately and after a Worker restart. Workflow metadata remains available. The aggregate route now requires both workflow and run read scopes.

Repository: https://github.com/just-every/run-crank
Product branch: `cloud/sx-crank-c-f87`
Candidate: `60fb60c691440430e2c0bcd7f8aee3461e954edd`
Starting candidate: `d8623c31cf359634b9516a57754ede47e02fa8e8`
Product push: success, first attempt through the supplied fleet guard.
PR: none; Verify has a push entry point.

## Scope and plan result

The FIX section overrides the campaign. Only blocking B was implemented; no next clause or unrelated work was taken. PLAN.md contains the full executable plan and its intended gates. All steps through local checks and branch publication are complete. CI outcome and evidence transfer are recorded separately below and in checks.json.

BASE-AGENT-005: PARTIAL to PARTIAL. Counts remain 32 DONE, 50 PARTIAL and 17 MISSING. All 99 Status rows remain; the contract has 153 table lines before and after. The inherited recorded test count remains 201, with zero new registrations. The existing four platform tests were extended without removing, narrowing or conditionally hiding an existing assertion. No test budget file was changed.

No acceptance text or contract status was edited by this FIX. Existing broader role parity, resource and budget intersection, sponsor lifecycle, access actions, injection-resistance, token lifecycle, IdP, Business, account, policy, enforcing-egress and device holds remain unchanged. These are the clause's retained remainder, not new FIX blockers. No plan rows were edited; the lane should record this one finding as closed against the candidate and leave the clause status unchanged.

## Implementation and public-door proof

`src/crank/access.ts`, lines 46 through 51: raw native agent admission obtains the persistent current scope intersection. Aggregate state GET now requires both `workflows:read` and `runs:read`. Failure occurs before the aggregate reader queries or returns payloads. Other route-family and mutation requirements remain as before.

`tests/platform.test.mjs`, the existing test named “PLATFORM-001: SDK and CORE door draft lifecycle, native granted execution/progress, paginated reads and out-of-grant denial share native approval and audit”, lines 106 through 126:

- Native owner flow and run doors create an actual pending legacy run containing a distinctive synthetic payload.
- A credential with both read scopes reads that payload from aggregate state, establishing a populated positive control.
- The owner removes run read authority through the native agent-access control.
- Both aggregate state and direct run reads return 403 without the distinctive payload; workflow metadata still returns 200.
- The same allowed and refused results hold after restart. The owner's stored run payload remains unchanged.
- A run-only credential can read the direct run but is refused aggregate state, proving workflow authority is also required there.

The test then continues through the existing narrowing journey, including allowed scope removal, stale and forged changes, native commit fencing, human approval, revoked authority and inactive restore. All those assertions remain intact.

PROBE BASE-AGENT-005 B: native owner issues both read scopes and creates a populated run, then removes runs:read while retaining workflows:read -> aggregate and direct run GET return 403 immediately and after restart; workflow metadata GET returns 200; owner payload remains intact; run-only direct read returns 200 and aggregate returns 403.

## Reproduction and checks

Before modifying production code, the new regression failed on the original f81 implementation: “Removed run authority must refuse state”, actual 200, expected 403. The worktree contained the added regression but unchanged production code from d8623c31cf359634b9516a57754ede47e02fa8e8. The actual command, nonzero exit and error are retained in reproduction.log and verify-reproduced.json. This was a gate finding reproduction, not an earlier failed CI job repair; there was one production fix and no second or third repair round.

VERIFY_REPRODUCED {"head":"d8623c31cf359634b9516a57754ede47e02fa8e8","job":"sx-crank-c-f81-gate-1 blocking B","command":"node --test --test-concurrency=1 --test-name-pattern='^PLATFORM-001: SDK and CORE door draft lifecycle' tests/platform.test.mjs","test":"PLATFORM-001: SDK and CORE door draft lifecycle, native granted execution/progress, paginated reads and out-of-grant denial share native approval and audit","exit":1,"failure":"Removed run authority must refuse state: 200 !== 403","worktree":"added regression assertions; unchanged production code"}

Passed checks:

- All four affected platform tests: 4 passed, 0 failed. platform-tests.log records the complete output.
- The targeted first platform journey on the committed candidate using the checkout's pinned Node 22.20.0: 1 passed, 0 failed. candidate-probe.log records the complete output. It includes the new aggregate proof and all existing narrowing and restoration checks.
- `pnpm run typecheck`: exit 0.
- `pnpm exec rer check --profile first-party`: exit 0.
- Contract generator write then check: exit 0, 99 clauses. Generated views were restored whole from origin/main and were not committed. The exact committed tree consequently returns exit 1 only for its expected stale ACCEPTANCE.md view; candidate-views-check.log records that permitted landing-owned condition.
- Source lock regenerated last using the installed pinned edition-authoring tool; both the immediate and committed-candidate checks exited 0.
- `git diff --check`: exit 0. Candidate source, test and lock bytes were verified equal to committed HEAD.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock then check exit=0; views=node src/base/contract-docs.mjs write then check exit=0; ledger=none exit=0.

The FIX adds no migration and changes no screen. No browser rerun or provider account is needed for this backend-only scope correction. The local tests use real native routing and D1 persistence; the fake provider edge belongs to the pre-existing broader journey.

## Integration and publication safeguards

Fetched main and rebased before the candidate commit; main was an ancestor and the rebase retained the two f81 commits without modification. Every candidate author and committer, including side parents, was checked with the required log command. All three candidate commits use the fleet identity and have no trailers. Every parent Status row is retained in each candidate commit. Hooks remained active.

Only the source guard, the existing platform test and the regenerated source lock were changed by the FIX commit. No generated contract view, fleet evidence, workflow, policy, homepage or Base pin was added to the product commit. Added source and test text contains no email-shaped literal or bare prose repository token. Existing unrelated legacy fixture content was preserved.

Publication scanning and landing remain the Mac guarded lander's duties. No scan result or Run site success is claimed from cloud. Main was not pushed or fast-forwarded. DONE is not claimed, so the DONE-RIDERS completion gate and independent ct judgment remain unclaimed. The security behavior in scope was exercised in both its allowed and refused directions on populated records.

## CI and custody

Exact candidate Verify was discovered as push run 42165704318: https://github.com/just-every/run-crank/actions/runs/42165704318 . Its discovered state was in_progress. No dispatch or rerun was issued. Final observed state is recorded in CI-RESULT.md and checks.json. One initial discovery request had a mistyped SHA and returned no runs; the corrected request is bound to the full candidate SHA above. The API budget includes that request.

All selected non-secret reports and actual receipt files remain in the packet directory, outside the product checkout. Evidence publication uses only the separate evidence ref. Its exact transport line will accompany the final handoff. Product readiness, evidence transfer and landing are separate results.

## Final observed CI and handoff

Verify 42165704318 completed with failure. Build job 127721717098 failed only on stale ACCEPTANCE.md, and dependent verify job 127721998601 failed its coverage guard. The plan job and installed-tool source lock check passed; dependent test shards did not execute. This is the permitted generated-view-only exception. The failed-job logs were retrieved once each and are included; CI-RESULT.md contains the complete classification. No real product failure remains known. The exact candidate is READY under that exception, subject to guarded lander regeneration, scan and Verify. Six GitHub invocations were used. No clause completion, successful workflow conclusion or landing is claimed.
