# sx-crank-f89fix1 repair results

Both AP5 blocking findings are fixed on branch cloud/sx-crank-f89fix1 at 534a9088cebe5c956b09028ff8b3ad464bad747f. The branch was pushed successfully on its first guard attempt. No PR was needed: push starts Verify. No default branch was changed.

BASE-AGENT-011 remains PARTIAL to PARTIAL. Counts remain 32 DONE, 50 PARTIAL and 17 MISSING, with all 99 Status rows from both merge parents retained (153 total table lines per parent and candidate). The existing provider, policy, Business propagation, timed lifecycle and queued-execution gaps are retained. No DONE claim, acceptance rewrite, policy decision, extra campaign target or plan remainder was introduced. The only plan-row handoff is this clause's two AP5 reporting corrections.

The complete plan is in PLAN.md. Work followed that scope: incorporate the published refused candidate into current main without rewriting either history; reproduce the incorrect projection; repair the seed-owned report; extend the existing public-door sanity journey; run touched checks and browser proof; regenerate views and restore main's generated files; regenerate the source lock with the pinned tool; verify identities, preserve all rows and push the named branch.

## What changed

The report excludes person-triggered approval execution audit rows from agent request attempts and their monthly watermark. It retains the original request month, agent identity, classes and policy decision. A durable completed, rejected or expired approval supplies the original held request's current outcome. Expiry is effective at its deadline even when the agent never retries. An actual agent retry remains a counted replay.

The repair delta against the refused head touches the report projection, the existing usage journey, its documentation, a trailing blank line and the generated source lock. The merge also carries the original refused candidate's monthly-report feature. Native agent-door and provider execution code, shared Base code, homepage, branding and workflow definitions are unchanged.

## Reproduction

The regression was rerun against the actual refused product SHA in a detached worktree, with only the regression test and its entry script overlaid. It exited 1. Four held requests followed by one owner approval reported five attempts, one done and four pending; expected four attempts, one done and three pending. This reproduces both counting and stale-outcome defects. See reproduction.log and reproduction.json.

VERIFY_REPRODUCED {"head":"184178d3ca7b499818b5982021559c472a7a56dc","job":"sx-crank-c-f89-gate-1 blocking A findings","command":"node .cache/approval-probe.mjs","test":"approvalUsageJourney: Approval completion must update the held request without adding an attempt","exit":1,"failure":"request_attempts: 5 expected 4; pending requests: 4 expected 3","worktree":"Product at the refused SHA in a detached worktree; only the regression journey and its entry script overlaid"}

An initial ad hoc module-mode launch stalled Miniflare's synchronous worker because its eval worker inherited module-only execution. Running the same probe from a normal script fixed the launch; no product workaround was introduced. The broader suite also caught an old expectation that an approval remain pending after its deadline. The full report equality assertion remains, with the required refused outcome after expiry and unchanged attribution and counts. The initial browser failure is retained in browser-initial.log.

## Public-door proof

The existing registration in tests/usage.test.mjs invokes agentUsageJourney, which now also invokes approvalUsageJourney in tests/agent-door/usage-journey.mjs. No test registration was added relative to the refused candidate. Its recorded test budget stays 200; current main's recorded 201 was already reconciled by the original candidate's consolidation, which preserves the called assertions.

PROBE BASE-AGENT-011 AP5 monthly totals: native MCP workflow creation, then owner approval in November and December -> four November requests, no invented December request, and one December attempt only after an actual agent retry. Assertions: tests/agent-door/usage-journey.mjs lines 145–162 and 173–176.

PROBE BASE-AGENT-011 AP5 resolved outcomes: person approval, rejection and deadline expiry across restart -> two done, two refused and zero pending in both decision and class aggregates; Operations HTML shows the same final outcomes. Assertions: tests/agent-door/usage-journey.mjs lines 146–172.

The existing complete-month journey still covers more than 200 retained calls, two agents, current owner authority, revoked identity retention, an empty month, month validation and actual replay accounting. The existing browser script passes its functional assertions at 1440 and captures populated, empty and error screens at 1440 and 390. Hover delay and immediate focus tooltips, readable report text and viewport fit pass. Screens are in browser/.

## Validation and custody

Touched usage suite: 4 passed, 0 failed. Typecheck, build, first-party checks and browser proof all exit 0. The product worktree was clean after the commit, and the source and test bytes match the validated tree. Build and test logs are included. No existing assertion was removed, skipped, moved behind a width condition or weakened; the expired-approval expectation now checks the correct terminal state with full equality.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and check exit=0; views=node src/base/contract-docs.mjs write and check exit=0, followed by restoring main's ACCEPTANCE.md and docs/CLAIMS.md; ledger=none exit=0.

The old repository copy of the authoring checker reports a tool-integrity mismatch. This is diagnostic only: Verify explicitly runs node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check, which passes. The refused candidate already selected that pinned tool. No hashes were edited by hand.

The candidate's restored generated views intentionally fail freshness with ACCEPTANCE.md stale; candidate-views.log preserves that expected result. Neither generated view was committed. The lander regenerates them before its landing verification.

Every candidate commit, including both published side-parent commits, passed the required fleet author, committer and trailer checks. The merge preserved current main and the refused head without rebasing or force pushing. Staged added text contains no email-shaped string or GitHub credential pattern. The repair is read-only reporting: no changed erasure, authority, retention or outbound effect path. Existing owner, viewer and billing access refusals and replay assertions still pass.

Baseline main e2c146dc38eb64e685cf01d2c56e798404b3936e had green Verify 42017109412 (also 42013805947) and Run site 42017109210. Candidate push Verify 42216502769 was in progress on the exact head at the one REST discovery. Its conclusion is not yet established; no green claim is made. Two GitHub API calls were used; no rerun or dispatch was made.

Cloud instructions exempt the product branch push from a local publication scan. Exact-SHA Verify, full-history publication scan, generated-view landing, main equality and candidate Run site remain fleet duties. There is no known reproduced real failure on this candidate and no product blocker. The only known candidate check failure is the explicitly expected generated-view freshness check. Evidence publication is separate custody and does not establish landing or DONE.

Actual structured receipt: checks.json. Product push receipt: product-push.log. Reproduction overlay and entry: usage-journey.mjs and regression-entry.mjs. Full locks, command logs and browser images are explicitly selected for the separate report-only evidence ref. No credentials, environment dumps, held-out material or symlinks are selected.
