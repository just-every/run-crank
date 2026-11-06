# sx-crank-c-f84 results

Product branch: `cloud/sx-crank-c-f84` at `ff071f1e55bf22bd4e19052dc48f676bd1e4e053`. No PR is required: Verify runs on a branch push. The branch preserves the two published f82 commits at `1f1db87c49472d9f7e0db584da4201b67ae77d4b` and both continuation commits. Final fetch and merge of main `e2c146dc38eb64e685cf01d2c56e798404b3936e` reported already up to date. Main was never pushed or changed.

BASE-AGENT-012 remains PARTIAL to PARTIAL. Counts remain 32 DONE, 50 PARTIAL and 17 MISSING, with all 99 Status rows retained in each commit. The recorded test inventory remains 201; no registrations were added, removed, skipped or narrowed. No acceptance sentence changed. Only the target Evidence cell changed; its entire existing Gap remains intact. Plan row: BASE-AGENT-012 native inert recovery now also covers transient outcome-storage failure and uncertainty when outcome storage is healthy; broader obligations remain open.

## Result and reproduction

The pinned f82 base already implemented atomic frozen metadata recovery for autonomous inert create, update and duplicate tools. This continuation found and reproduced a loss case: after the native mutation committed, the first door outcome save failed; the catch path could then successfully save an execution failure instead of retaining the frozen success. The extended public MCP journey failed at line 55 with a non-null stored refusal whose code was `execution_failed`, where the uncertain claim was expected. Actual nonzero exit: 1. See `reproduction-receipt.json` and `transient-before-fix.log`.

The pipeline now preserves the uncertain claim after an unexpected failure in a recovery-capable autonomous execution. It does not invent a failed native outcome. The next request must recover exclusively from the original native receipt through the existing binding and current authority and policy checks. Missing evidence still returns `call_in_progress` and cannot repeat the mutation. The change affects only tools that opt into native recovery and original autonomous execution; review, approval and provider lifecycle gaps are retained.

Implementation: `src/modules/agent-door/pipeline.ts:195` and line 208. The optional recovery adaptation remains documented in `docs/AGENT-DOOR.md:224`, with the exact local Base copy acknowledged in `base-copies.json`. Package and runtime pins remain unchanged. No screen or visual behavior changed.

## Acceptance coverage

1. One effect and equal results: `tests/agent-door/recovery-journey.mjs` recoveryJourney, lines 44 to 102, creates real draft state, injects one or sustained outcome-storage failures for each of the three verbs, observes the native commit, then retries four concurrent calls with fresh RPC IDs after restart and at least 24 hours. It checks the frozen exact public metadata, one native effect, unchanged later edits and truthful original audit.
2. Dropped response followed by a new RPC ID: the same journey performs the interrupted persistence boundary and restarted retries, rather than calling a mutation directly or synthesizing a receipt.
3. Changed arguments: the same journey at lines 81 to 82 requires `idempotency_conflict` and observes unchanged drafts and audit effects. Business binding checks reject foreign sponsor, changed consent and changed client; revoked credentials and current Pause and policy restrictions remain refused.
4. Stale revision: lines 88 to 92 check `revision_conflict` and the actual current revision after subsequent edits.
5. Cross-person job handle indistinguishability: no job family was added or claimed by this inert-write slice; this remains required in Gap.

Additional required safety: lines 104 to 117 prove absent-receipt uncertainty refuses with both unavailable and healthy outcome storage, without inventing an outcome or repeating a mutation. Lines 118 to 139 prove revoked credentials cannot complete the claim, exported archives contain no live receipt or authority tables, restored drafts are ownerless and inactive, and restart plus Cron cannot execute them. Business recovery also preserves consent and agent revocation.

## Actual validation

`candidate-receipt.json` records a clean checkout at the exact full candidate SHA. Its platform journey command passed with one selected registration and zero failures; that registration invokes all recovery probes. The exact-SHA installed source-lock check passed. `prepare-receipt.json` records the same source and journey hashes with passing typecheck, first-party check, deployment-spec check, standalone recovery journey, contract write and contract check. Both generated views were then restored whole from main and are not committed.

The checkout's older authoring CLI and the installed pinned CLI have different toolchain fingerprints. The final lock was generated and checked with the installed pinned CLI, which is the command Verify actually uses. The local CLI was not used to rewrite that final lock, and no hash was hand-edited.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock, then check exit=0; views=node src/base/contract-docs.mjs write, then check exit=0; ledger=none exit=0 (this continuation adds or edits no migration; inherited migration runs in the native D1 journey).

## DONE riders and self-check

No DONE flip or judge request is made. Assessment of the supplied riders:

1. Native slice covered by the named journey above; broader clause outcomes remain unproved and honestly PARTIAL.
2. Native positive and unsafe directions pass: real committed drafts, concurrent recovery, changed arguments, authority and policy refusals, absent receipts and inactive restored data.
3. Exact-SHA local public-door proof passes; remote Verify is reported separately, never inferred from another SHA.
4. Exact-SHA candidate proof passes; preparation source and journey hashes exactly match the candidate.
5. No inherited duty or receiving clause was rewritten; existing adoption duties remain in Gap.
6. Contract generation and check passed locally; views restored from main by the cloud rule. Evidence updated, Gap preserved, no stale DONE provenance claim.
7. No acceptance point, clause ID, CT rider or coverage obligation changed.
8. Current native preparation, revocation, principal binding and policy refusals are exercised without any new authority grant.
9. No external completion, provider effect, live account or legal boundary claimed.
10. No new custody, consent, spending or authority policy default adopted.
11. Main equality, final publication scan and Run site are maintained-lander duties and have not been claimed here.

The user-visible native recovery breaks the extended journey if the catch-path overwrite is restored, as the actual before-fix failure demonstrates. No assertion was removed or weakened; no new credential or email-shaped fixture string was introduced. No UI controls were touched. Restored data remains inert. No provider retry, queued lifecycle declaration or DATA-001 fence change was introduced.

## Remaining work and holds

Interrupted human review and approval lifecycles, other mutating tools, durable queued and provider uncertainty and replay, long-work handles and status, and cross-person handle indistinguishability remain required. All existing owner and account, CT, enforcing-egress and device holds remain unchanged. These are the pre-existing wider Gap, not a claim that the whole clause is DONE. There is no new product blocker for this scoped improvement.

The full original implementation plan is retained in `PLAN.md`. Product push custody and report transfer are separate; the evidence ref does not grant acceptance or landing. Publication scanning and Run site remain with the maintained lander.

## Probes

PROBE BASE-AGENT-012 create: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 create transient: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 update: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 update transient: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 duplicate: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 duplicate transient: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved
PROBE BASE-AGENT-012 unmatched: interrupted admission without a native receipt, with outcome storage available or failed -> call_in_progress, no invented result or mutation replay
PROBE BASE-AGENT-012 restore: public export and restore -> no native receipts or credentials; inert drafts without owners; no execution after restart
PROBE BASE-AGENT-012 authority: signed Business MCP retries with changed consent, client, foreign sponsor and revoked consent -> refused without completion; original current consent returns frozen metadata

## CI custody

Exact-SHA Verify push run 42155448075 completed with raw conclusion failure. The installed source-lock check passed in plan job 127688384892. Build job 127688554946 completed application build, run-site build, typecheck and first-party checks, then failed only on `node src/base/contract-docs.mjs check` with `Error: ACCEPTANCE.md is stale; run node src/base/contract-docs.mjs write`. The final verify job 127688829757 reports that upstream failure, and dependent shards were skipped. No remote journey pass is claimed.

This is the exact generated-view-only exception in the cloud instructions, which counts for the READY handoff. No generated file was committed or workflow changed to repair it. The lander must write views from the merged contract and require its subsequent exact-SHA Verify, full-history COMPLETE publication scan and final Run site. Those landing receipts are not claimed here.

GitHub reads: four invocations total (exact-SHA discovery, one status poll after more than 300 seconds, completed-run job metadata, and the failed build archive once). Actual archive command: `gh run view 42155448075 --repo just-every/run-crank --job 127688554946 --log-failed`, exit 0. No dispatch, rerun or PR was created.
