# sx-crank-c-f89

Repository: just-every/run-crank
Product branch: cloud/sx-crank-c-f89
Candidate: 184178d3ca7b499818b5982021559c472a7a56dc
Main integrated before candidate: e2c146dc38eb64e685cf01d2c56e798404b3936e
PR: none; push Verify accepts this branch directly.

BASE-AGENT-011 remains PARTIAL -> PARTIAL. This round completes only acceptance point 5's selected native call-reporting slice. Counts remain 32 DONE, 50 PARTIAL, 17 MISSING, 99 total. All 99 parent Status rows remain. The only plan row changed is BASE-AGENT-011's native reporting evidence and remaining Gap; no lane plan file was available or edited. The full execution plan is PLAN.md.

## Result

The existing owner report at GET /api/crank/reports/usage now includes agent_usage. The existing Operations screen renders a focused Native agent calls panel. Storage aggregation covers the complete selected UTC month rather than the first audit page. It uses an inclusive month start, exclusive next-month start and sequence watermark. It groups request attempts and retained current outcomes by stable agent ID, overall decision and class-specific decision. Original operation identities and replay attempts are separate. Retained audit names supply historical attribution; native credential revocation is reflected without removing call history.

This reporting covers all native agent calls and explicitly explains that workflow and team filters apply to the existing workflow accounting separately. Owner authorization is unchanged. Existing billing access still receives its original aggregate array, never agent details. Signed-out readers, ordinary viewers and agent credentials cannot read the owner report.

The admitted registry rejects provider-cost tools and currently classifies its native preparation and metadata calls as standard. Money moved and provider spend remain null and Not reported. They are not inferred from class measures, workflow estimates or absent provider charges. No provider execution, spend cap or money movement was added or claimed.

## Public-door proof

tests/agent-door/usage-journey.mjs:6, agentUsageJourney, is invoked by tests/usage.test.mjs:266 and the existing tests/agent-door/journey.mjs. It obtains two actual native agent credentials, configures the ordinary native policy door and performs real MCP calls through the existing policy, authority and D1 pipeline. There are no fabricated audit rows and no provider fakes in this journey.

- Lines 29-38: empty report, one call immediately before the month, 205 calls at the inclusive month boundary, one keyed native draft creation and replay.
- Lines 40-56: review, approval pending, blocked, autonomous, paused and invalid-argument outcomes. A Pause refusal that cannot be classified remains in overall decisions rather than inventing a class.
- Lines 48-67: exact 212 attempts, 211 original operations, one replay; 107 attempts for one agent and 105 for the other. Complete owner audit pages contain more than 200 records and independently reconcile every returned decision and class group.
- Lines 68-75: Worker restart preserves complete reporting; revoked native credentials return 401, retain historical names and totals, and appear revoked.
- Lines 76-89: signed-out and machine report reads are refused, a signed-in viewer is refused, billing receives only the existing aggregate, and invalid months return 400.
- Lines 90-98: rendered totals match the complete API, adjacent months contain exactly one call each, and a December call does not change November's report.

tests/agent-usage-browser.mjs:33-56 verifies every rendered agent, overall decision and class group against the complete native API report at 1440. It checks unknown money and spend, report text at least 13px, no viewport overflow, and the existing Search runs and Your account tooltips after hover delay and immediately on focus. Populated, empty and invalid-month states are captured at both 1440 and 390. The final browser run was on the exact candidate and all browsers and owned bridges were closed. Six actual screenshots are in screens/.

PROBE BASE-AGENT-011 point 5 native reporting: two public MCP credentials, 212 in-month attempts across more than one audit page -> owner API and Operations show 211 originals, one replay, actual decisions and class groups, retained revoked attribution and unknown costs.
PROBE BASE-AGENT-011 month boundaries: calls immediately before November, at November's start and at December's start -> October 1, November 212, December 1, with November unchanged after restart and December admission.
PROBE BASE-AGENT-011 authority: signed-out, viewer and agent report reads -> refused; billing -> prior aggregate only; revoked native token -> 401 without changing historical totals.

## Validation

The complete touched usage test file passes, four registered sanity journeys. All prior six usage tests' assertion lines are byte-for-byte retained in six helper functions, grouped under three related budget and custody registrations. One native reporting registration and one browser script are added. The recorded test count is 201 - 3 + 2 = 200; the cap stays 200. No existing assertion was removed, narrowed, skipped or placed behind a width condition.

Build, typecheck, first-party checks, generator write and check, and installed source-lock check pass. checks.json, usage-receipt.json, probe-receipt.json and the actual logs contain the receipts. Contract generation proves the source generates all 99 clauses. ACCEPTANCE.md and docs/CLAIMS.md were restored from origin/main and are absent from the product diff. No migration was added or edited.

The repository copy of the source-lock tool emits a different toolchain digest from the pinned installed tool used by Verify. The final source lock was regenerated and checked with node node_modules/@runeditrun/rer/edition-authoring/cli.mjs, matching main's existing toolchain digest. No package, Base pin or workflow was changed.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and check exit=0; views=node src/base/contract-docs.mjs write and check, followed by restoration from origin/main exit=0; ledger=none exit=0.

The first save bd8e4547bb0fdc530536e82a09c9f579dca4efba used skip ci. Candidate 184178d3ca7b499818b5982021559c472a7a56dc corrects the lock toolchain digest and is pushed without skip ci. Every candidate commit's author, committer and trailers were inspected, including the full origin/main..HEAD range. All authors and committers are the fleet, with no co-author trailers. The product diff introduces no email-shaped literal. Publication scanning is intentionally left to the fleet's full-history lander.

## DONE riders and pre-ready check

No DONE claim or ct judge request is made.

1. PARTIAL for the whole clause: the native reporting outcomes pass the named public journeys; broader money, provider spending and Pause obligations remain unproved.
2. PASS for this slice: populated real calls, exact expected totals, supported owner reads and unsafe reads refused. The test never treats an empty report as proof of populated behavior.
3. Verify 42210178261 completed with the permitted generated-view-only failure; test shards were skipped. This is not a claim that those shards passed. Both the ordinary native journey and focused browser script are registered in existing push Verify paths.
4. PASS locally: the browser and captured usage receipts bind the exact candidate. The final product commit changes only the source-lock toolchain digest.
5. Unchanged: this round adds no inheritance or acceptance point. Existing Base duties and ownership fences remain in the Gap.
6. PASS for source generation and honest partial Gap. Generated views are intentionally restored for the lander; no DONE provenance is claimed.
7. PASS: no acceptance text, ID or existing obligation is removed or changed.
8. PASS for reporting authority: owner is served, viewer and machine reads refused, billing remains aggregate-only, and native credential revocation stops calls without changing historical totals.
9. PASS for an honest boundary: no live provider or money accounting is claimed. Unknown amounts stay null.
10. PASS: no new custody, spending or delegation policy default was adopted.
11. Pending fleet landing: main does not equal the candidate. Exact-SHA publication scan, final landing and candidate Run site are fleet duties, and no DONE count is taken.

Pre-ready proportional checks: named native reporting behavior has concrete populated API and browser assertions; existing assertions are preserved; replay and revoked credentials cannot create another native draft or reveal owner reporting; no restore, erasure or provider execution door was widened; the new view displays only existing retained agent attribution and read-only counts. Touched text, tooltips and viewport checks pass. Candidate Verify is reported separately below. No source or migration gate is waived.

## Held remainder

Spend caps, timed token and consent lifecycle, queued provider execution, provider estimates and spend-cap enforcement per seed, specialist and agent, actual money and recipient measures, provider-cost accounting, no-cap spending acceptance, real Business Pause propagation and omitted execution paths remain required. All existing owner and account, ct, enforcing-egress and device holds remain unchanged. BASE-AGENT-004, TEAM-001 IdP and public-mint restrictions with no further gate, DATA-001 adoption fences, BASE-AGENT-009 activity and Undo scope, and live BASE-AGENT-005 and BASE-AGENT-012 ownership are retained. This read-only slice releases none of those holds. There is no blocker to the completed native reporting slice; independent publication and landing gates remain outstanding.


## Exact-SHA CI and custody

Verify 42210178261, push event, exact head 184178d3ca7b499818b5982021559c472a7a56dc, completed with conclusion failure. Build job 127866778517 successfully built the app and run site, ran typecheck and first-party checks, then failed only at node src/base/contract-docs.mjs check with: Error: ACCEPTANCE.md is stale; run node src/base/contract-docs.mjs write. Shards skipped and final verify job 127867103429 failed because the build failed. Each failed job's log was read once through gh run view. No failed assertion was repaired, no workflow was edited and no run was dispatched or rerun.

This is the explicitly permitted generated-view failure. The source generator's write and check pass locally; those generated views remain uncommitted for the lander to write after merging CONTRACT.md. READY therefore identifies the pushed candidate under that handoff exception, and does not describe Verify's conclusion as success.

Main e2c146dc38eb64e685cf01d2c56e798404b3936e had successful Verify 42017109412 and Run site 42017109210. These baseline runs are not candidate proof. Main was never pushed or fast-forwarded from this cloud. The candidate has no PR because Verify accepts the named branch's push directly. Six GitHub CLI invocations were used. Full-history publication scanning, regenerated views, landing and candidate Run site remain fleet duties.

Final product custody: PUSHED cloud/sx-crank-c-f89 at 184178d3ca7b499818b5982021559c472a7a56dc. Evidence custody is separate on evidence/sx-crank-c-f89. The clone is removed only after evidence publication succeeds; the actual report, plan, receipts and screens remain in the fleet work packet.
