# sx-crank-c-f85 results

BASE-AGENT-010 remains PARTIAL → PARTIAL on cloud/sx-crank-c-f85 at 0d42476763f6b3f48fc54ae915e0f290805bba6c. The bounded native lifecycle slice is proved; the full clause is not claimed DONE. Counts remain 32 DONE, 50 PARTIAL, 17 MISSING. All 99 Status rows and all 153 table lines remain. The inherited recorded test count is 201, unchanged; the brief's 200 was stale. This continuation adds zero registrations or Verify assertion scripts and removes or weakens no existing assertion.

The requested base 4770731cb2b0d708b0ae2d3679abe34e998e752c already implements the planned bounded feed. This continuation preserves that work and adds two native lifecycle fixes:

- Mark reviewed now emits review.reviewed with a stable retained event identity, the actual signed-in person, decision identity and class identifiers. It uses the existing closed projection and current reviewer visibility. An agent cannot impersonate that person action.
- A feed read under review policy previously appended review.opened about itself, causing every subsequent page to extend the feed. The public-door reproduction exited 1 with “AssertionError [ERR_ASSERTION]: feed did not reach its retained end”. Feed reads now keep their policy-required review and audit without an automatic event about the read itself. A person's later Flag or Mark reviewed still emits its event. This bounded-feed exclusion does not claim full record-change coverage.

No acceptance sentence, policy disposition, company scope, existing credential scope, homepage, UI, workflow or Base pin changed. The only contract edit extends BASE-AGENT-010's Evidence cell; its complete Gap is retained. Vendored runtime adaptations were acknowledged with the documented adapt-base command. No generated view, fleet report or receipt is committed to the product branch.

## Plan and acceptance mapping

PLAN.md records the actual implementation plan. The only plan row to update on the fleet is BASE-AGENT-010: retain PARTIAL and its full remaining Gap; add marked-review events, refused agent impersonation and finite replay under review policy to native proof. No full plan was rebuilt and no other clause was started.

The six full-clause outcomes are mapped as follows:

1. Record subscription notification within ten seconds remains unproved and undeclared. Native record-change coverage and BASE-AGENT-003 resource scope remain owed.
2. Matching event identities between the cursor tool and signed integrations webhooks remain owed. No webhook channel was enabled.
3. Native lifecycle cursor replay is proved across multiple pages, repeat reads and restart. Under held review policy, paging now reaches a stable end while the review and audit remain present.
4. The native feed refuses missing event scope, revoked consent, revoked agent and inactive person; current reviewer demotion filters old cursors and restart replay. Restoring legitimate eligibility restores only the same authorized identities. Other delivery channels remain owed.
5. Failed webhook history and replay without duplicate effects remain owed.
6. Native approval.pending, approval.decided, review.flagged and person policy.adopted remain proved; review.opened and review.reviewed supplement them. Class facts, arguments, notes, summaries, errors and credentials are withheld. Policy adoption has its revision and adoption decision and no invented tool class. Real Business propagation and signed Business policy actor provenance remain unproved.

Remaining scope is unchanged: complete native record changes, resource-linked events, subscriptions and the ten-second notification journey, signed integrations webhooks and matching identities, failed delivery history and replay, real Business propagation and policy actor provenance, every provider-change channel, PLATFORM-001 enforcing egress, and all existing owner, account, ct and device holds. These are neither waived nor represented as completed by the lifecycle feed. No DONE judgment is requested.

## Actual checks and provenance

- Production Worker and assets build: cloud_run npx -y @runeditrun/rer build, exit 0.
- Touched Verify registration: node --test --test-concurrency=1 --test-name-pattern='^PLATFORM-001: SDK and CORE door' tests/platform.test.mjs, exit 0, one passed. It invokes nativeEventsProof. This was rerun on the exact pushed SHA; platform-exact.log is the complete output.
- Installed hosted conformance: node node_modules/@runeditrun/rer/cli/agent-door.mjs ., exit 0, 1203 of 1203 points passed, including BASE-AGENT-013.native-journey and the hosted native lifecycle replay. The receipt hashes show unchanged relevant source and journey bytes in the pushed tree. conformance.log is complete.
- pnpm run typecheck and pnpm exec rer check --profile first-party both exit 0.
- Contract generator write and check both exit 0 for 99 clauses. ACCEPTANCE.md and docs/CLAIMS.md were then restored whole from origin/main. The same generation and restoration on the exact pushed SHA leaves the tree unchanged.
- Installed edition-authoring lock and check both exit 0, regenerated after the final source and documentation edits. No migration changed, so no migration-ledger command applies.
- git diff --check passed. All candidate authors, committers and trailers, including side parents, were inspected; only the fleet identity and no co-author trailer are present. Added prose has no bare two-word slash references and added text has no email-shaped strings. Existing fixture data elsewhere was not rewritten.
- The checked-out main was merged before the candidate push; it was already an ancestor, so no merge commit or rewrite was needed. Main remains e2c146dc38eb64e685cf01d2c56e798404b3936e. The requested f80 base commits are retained.
- An attempted node scripts/test-budget.mjs command failed because that helper is absent. Reading the existing budget and counting registrations confirmed 166 ordinary registrations across 29 files, inherited recorded total 201, and delta zero. No product test failed in that attempt.
- Native direct checks used the supplied toolchain, Node 24.19.0 and pnpm 10.12.4. CI selects the repository's Node 22.20.0. No runtime pin changed.

Product commits in this continuation are bb24fedad9367b58c5e85b094de534ef9c60eb65 (save with CI skipped) and 0d42476763f6b3f48fc54ae915e0f290805bba6c (landing candidate). Both product pushes succeeded through cloud-push.py on their first attempt. No PR is required because Verify has a branch push entry point; none was created.

The f80 base Verify 42150421648, build job 127672174778, failed only at the expected stale ACCEPTANCE.md generator check. Its single failed-job archive read is retained in base-verify-failure.log. That failure is not repaired by committing generated views.

Candidate branch Verify is run 42156198466, push event, bound to the exact full candidate SHA. It completed with failure only at the expected stale ACCEPTANCE.md generator check in build job 127690970486. The production build, site build, typecheck and first-party checks passed; downstream suites were skipped, not reported passing. The brief's generated-view exception permits READY. The complete failed-job archive is candidate-verify-failure.log; it was read once. Eight of the ten GitHub calls were used. Its final observation is recorded in checks.json and ci-status.json. The initial discovery is retained in ci-discovery.json. Publication scanning and Run site on landed main remain fleet duties. No cloud scan or landing success is claimed.

## Public-door probes

PROBE BASE-AGENT-010 lifecycle: production MCP creates drafts under autonomous, approval and review policies; signed-in people approve, reject, flag and mark reviewed → six native lifecycle types with truthful actors and closed metadata.

PROBE BASE-AGENT-010 replay: crank.events.list with two-item pages and retained cursors, repeated before and after restart → identical authorized IDs in order; 202 flagged events cross storage pages without duplication.

PROBE BASE-AGENT-010 held-policy: signed reader under standard review → finite stable feed, retained native review and audit; a person's later mark emits exactly its visible lifecycle event.

PROBE BASE-AGENT-010 authority: preparation-only token, revoked consent, revoked agent, reviewer demotion and inactive person against retained cursors → missing scope or credential refusals, or an empty currently authorized feed; restoring reviewer eligibility returns the same IDs.

PROBE BASE-AGENT-010 erasure: erase inactive native reviewer, then replay before and after restart → prior reviewer name withheld and replaced by Removed person; the erased person's credential stays refused.

PROBE BASE-AGENT-010 impersonation: event-reader Bearer token sent to the Mark reviewed person door → 403, unchanged review state and unchanged visible feed.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and check exit=0; views=node src/base/contract-docs.mjs write and check exit=0; ledger=none exit=0.

## DONE-RIDERS review

This is a PARTIAL continuation, not a DONE claim. Each rider is recorded to avoid implying completion:

1. UNMET for the full clause: outcomes 1, 2 and 5 and the remaining channel and record scope lack journeys. Native outcomes 3, 4 and 6 are covered by tests/agent-door/events-journey.mjs nativeEventsProof at lines 181, 199, 210 and 264.
2. PASS for the delivered slice: real native decisions populate the feed; allowed Mark reviewed and refused agent impersonation are checked at lines 241 and 254, with state and feed equality at lines 259 and 261.
3. EXPECTED GENERATED-VIEW FAILURE: Verify 42156198466 stopped at the stale ACCEPTANCE.md check, so downstream suites were skipped. The new assertions remain invoked by the existing push registration in tests/platform.test.mjs, not hidden behind a new flag. Local exact-SHA execution passes. The brief's explicit exception permits READY but is not full DONE outcome proof.
4. PASS locally: the platform journey was run on the exact candidate. checks.json binds source and test hashes; the hosted conformance's relevant bytes are unchanged.
5. UNCHANGED: BASE-AGENT-003 resource scope and PLATFORM-001 enforcing egress remain explicitly in the target Gap. No inheriting clause or citation changed.
6. PASS for partial bookkeeping: full Gap retained, Evidence updated, 99 parent rows retained and generator write and check pass. Candidate generated views are intentionally main's files, and no generated view is committed. No DONE provenance was asserted.
7. PASS: no acceptance sentence, clause ID or coverage mapping changed.
8. PASS for delivered authority: person-only mark refusal, reviewer demotion, consent and agent revocation and deactivation are exercised through production doors at lines 254 and 274.
9. PASS boundary honesty: fixtures establish native protocol behavior only. No real Business, provider, legal, device or notification-timing completion is claimed.
10. NOT APPLICABLE: no new custody, consent, spending or delegated authority default was adopted; existing policy-required review and audit remain enforced.
11. PENDING fleet landing: no main update, publication scan or candidate Run site is claimed. These conditions are not counted as satisfied by evidence publication.

The pre-ready review found no changed user outcome without a failing assertion, no removed or weakened assertion, and no new authority, erasure or replay exposure. The held-feed bug was reproduced before repair. This is not a Verify repair round: the only observed base Verify failure is the permitted generated-view check. No screens or controls changed, so no new UI proof, design tool or screenshot is required for this backend continuation. The full publication scan and main Run site remain independent fleet gates.
