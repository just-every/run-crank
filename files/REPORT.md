# sx-crank-c-f91 — local named approval admission

Repository: just-every/run-crank
Branch: cloud/sx-crank-c-f91
Candidate: e84518d7cd85e61dfd0f68f6eec9cb3dd9fce190
Base main: c16d7b09492b2c61c4cbfb4c0f892be6b0e9c1ef
PR: none; the existing push workflow is the branch entry point.

BASE-AGENT-007 remains PARTIAL. The selected local inert approval slice is implemented and passes its public-door and browser journeys. Counts remain 32 DONE, 50 PARTIAL, 17 MISSING; all 99 Status rows are retained. No acceptance text, Status, Gap or Evidence cell changed. The generated views were written, checked and restored to main; neither view is committed. The source lock is regenerated with the installed release CLI used by Verify, and its exact command passes after commit. The copied seed helper has a different tool digest and is not the authoritative generator for this release.

## Result and plan execution

The full working plan is in PLAN.md. The admission gap was isolated to the local policy save route: signed Business adoption already resolved its subject references, but local saves accepted an unresolved native person. The three-line product change resolves all unique named approver and reviewer references through `people.person`, requires current active identity, and returns `policy_refs_unresolved` before touching durable policy state. The native adapter already resolves durable native IDs correctly and required no change.

The new named approval journey extends the existing native CORE journey and the existing PLATFORM-001 registration. It invites and accepts three disposable native people: two named independent reviewers and one unrelated person. It saves a complete explicit standard approval policy, crosses production MCP, and observes actual native drafts. Both people decide through their own native sessions. The browser version makes those decisions by keyboard on the real production approval pages at 1440; its six states are recorded once at both 1440 and 390.

No test registration or existing assertion was removed, weakened or hidden behind a width condition. The declared node test budget remains 200 of 200. The requested standalone browser script is registered in the existing agent-executor Verify group. No workflow or Base pin changed. The browser uses native production modules on a real Worker with D1 and serves candidate built assets; it has no test-only policy, approval or effect route. The captured mail boundary is the only provider fake in this local scenario. It supplies disposable invitation links, not an owner's real profile or session.

A regression run with main's unchanged policy-store source returns HTTP 200 for an unresolved person where the new journey requires 400. The actual nonzero assertion and source binding are retained in baseline-regression.log and baseline-regression.json. Candidate runtime and browser journeys then pass; the targeted released CORE conformance also passes 1,020 of 1,020 points on the exact candidate, including the existing disposition assertions; concurrent keyed retries may report the existing `decision_busy` or `call_in_progress` refusal, and subsequent retries must return the original result and receipt. There is exactly one draft from the held operation, no published version and no workflow execution.

Implementation and proof locations:

- `src/modules/agent-door/policy-store.ts`, lines 85–88: resolution before the local state write.
- `tests/agent-door/named-approvals-journey.mjs`, named journey `local named references and independent human approvals retain exact evidence and once-only inert effects`.
- `tests/agent-door/named-approvals-browser.mjs`: independent keyboard decisions and all six states.
- `tests/agent-door/journey.mjs`: native CORE journey invocation.
- `tests/platform.test.mjs`, `PLATFORM-001: SDK and CORE door draft lifecycle, native granted execution/progress, paginated reads and out-of-grant denial share native approval and audit`: existing registration extended, no new registration.
- `verification.json`: the new browser script runs in the existing agent-executor group.
- `docs/AGENT-DOOR.md`: the local native reference boundary and retained holds.

## Frozen rubric for the selected POINTS

This rubric scores this local slice, not completion of the broader clause. All runtime rows were executed on the candidate. Verify event and conclusion are recorded in checks.json; no row assumes an unrelated SHA is green.

| ID | Checkable selected outcome | Public-door proof and lines | Local result |
| --- | --- | --- | --- |
| R1 | Resolve named local approvers before saving; invalid reference retains prior revision and document | Named journey 44–73: native invitation, confirmation and policy PUT, including missing and mixed references | PASS |
| R2 | Resolve named local reviewers too; inactive references retain prior state | Named journey 70–73 and 151–159: review and approval policies refused after native deactivation | PASS |
| R3 | Two accepted native people are required for the explicit standard policy | Named journey 56–82 and 99–102: no draft while pending or after the first mark | PASS |
| R4 | Sponsor, unrelated person, agent and device cannot substitute for the named human decisions | Named journey 84–97: ordinary person decision route returns 403 and no marks or effect | PASS |
| R5 | Retain server facts, expiry, URL handle and exact summary and revision binding | Named journey 77–98: pending view and changed evidence refusal | PASS |
| R6 | Two decisions release one inert effect; concurrent and restarted keyed retries keep the original receipt | Named journey 99–124: actual native draft, no run, original receipt with both approver IDs | PASS |
| R7 | Changed draft, policy revision or summary evidence cannot apply held work | Named journey 93–98 and 133–149: mismatched evidence and actual owner draft change | PASS |
| R8 | Rejection, lapse and deactivation of the first approver prevent the held effect | Named journey 127–131 and 151–172: refused result and unchanged number of drafts | PASS |
| R9 | Explicit autonomous and standard review controls keep working | Named journey 175–180: native draft and independent review feed mark | PASS |
| R10 | Inspect pending, first-approved, executed, rejected, expired and refused pages at both widths | Browser journey 28–69; browser JSON lists all 12 actual image files | PASS |

## Each acceptance sentence of BASE-AGENT-007

The clause retains its original acceptance text. The points claimed below describe native standard behavior only; they do not release the retained wider obligations. Source paths in this section refer to the exact candidate.

| Item | Contract outcome | Evidence or retained boundary | Result |
| --- | --- | --- | --- |
| A1 | Every tool and carried class under every disposition | Existing shared CORE disposition journey remains; this round adds a native standard create and update sanity flow, not full every-tool and every-class disposition coverage | PARTIAL |
| A2 | Unanswered setup, incomplete revisions, wildcard completion and a newly unanswered upgrade class | Existing setup and conformance remain; this round specifically strengthens named-reference admission and retains prior valid policy | PARTIAL; broader acceptance not newly claimed |
| A3 | Money amounts and the daily cap select the required rule | No money tool or provider execution is added; money and undeclared-class threshold and daily-cap journeys remain required | UNPROVED, held boundary unchanged |
| A4 | Two carried classes take the stricter disposition | Registry remains standard-only; no new multi-class claim | UNPROVED, held boundary unchanged |
| A5.1 | Approval has facts, expiry, URL elicitation and pending handle, and completes once after the named decision | Named journey 77–124 and the explicit named journey URL handoff assertions cover server facts, URL handle, two independent native decisions and retained receipt; named journey lines 13–20 explicitly assert the optional URL elicitation envelope after advertising the client capability | PASS for the selected local slice; the native journey directly asserts elicitation |
| A5.2 | Changed input requires fresh approval; rejection and lapse leave no effect | Named journey 93–98, 127–172 checks changed input, summary and revision, actual changed draft, rejection, expiry and deactivation | PASS for the selected local slice |
| A6 | MCP, integration API and embedded agent agree | Production MCP is exercised; integration API and embedded-agent adoption parity remain unproved | PARTIAL |
| A7 | Next call adopts policy change within 60 seconds and audit cites revision | Policy replacement immediately prevents old approval execution; the complete propagation and attribution obligation remains held | PARTIAL |
| A8 | Bad signature or foreign Business identity retains last valid revision | Signed adoption path is unchanged; this round proves local invalid or inactive references retain the prior complete native policy | PARTIAL; no new real Business claim |

## DONE-RIDERS results

No DONE is claimed. Rows are scored against the slice and the retained whole-clause boundary so a partial result cannot be mistaken for completion.

| Rider | Result | Evidence and limitation |
| --- | --- | --- |
| 1 | FAIL for full DONE; PASS for selected slice | R1–R10 execute all selected native outcomes. Full provider, money, every-class and door-parity outcomes remain unproved. |
| 2 | PASS for selected security behavior | Named journey 66–168 runs allowed and refused paths on real records, with unchanged state on unsafe requests. |
| 3 | PENDING exact-SHA Verify conclusion | Push run 42238086547; final conclusion is retained in checks.json. Both new journeys are wired into existing Verify entry points. |
| 4 | PASS local candidate binding | Candidate runtime and browser commands were repeated on e84518d7cd85e61dfd0f68f6eec9cb3dd9fce190; older build and typecheck source is unchanged. |
| 5 | INSPECTED, no inheritance rewrite | No receiving clause or Base duty changed; existing ownership fences are preserved below. |
| 6 | PASS mechanical; held metadata unchanged | Contract generator write and check exit 0, views restored; Status cells and counts untouched, with no premature promotion. |
| 7 | PASS | No acceptance sentence changed and no new acceptance point was added. |
| 8 | PASS for selected authority path | Named journey 84–102 and 151–160 checks unrelated, sponsor, agent, device and deactivated person refusal plus the allowed two-person execution. |
| 9 | PASS honest boundary | No real provider, IdP, Business propagation, legal, money, egress or device completion is claimed. |
| 10 | PASS, no new default | The run uses the brief's explicitly selected native named-person admission semantics. No custody, spending, consent or delegated-authority policy was added. |
| 11 | PENDING lander | The candidate is branch-only. Main equality, complete publication scan and candidate Run site remain lander duties. |

## Retained duties and pre-ready self-check

| Duty | Result and boundary |
| --- | --- |
| TEAM-001 | INSPECTED: no IdP or public-mint completion claimed and no further TEAM-001 gate introduced. Owner tenant remains required. |
| TEAM-006 | INSPECTED: creation-revision work remains unresolved and unchanged. |
| DATA-001 | INSPECTED: no archive, restore, adoption or erasure fence changed. This slice proves no restored authority. |
| BASE-AGENT-004 | INSPECTED: existing token and consent lifecycle is untouched; an issued local preparation token is used and revoked through native doors. |
| BASE-AGENT-005 | INSPECTED: native scope authority and retained recovery work remain owned there. No scope expansion is added. |
| BASE-AGENT-008 | PASS selected receipt attribution, INSPECTED wider boundary: receipt retains both independent approvers; provider and native attribution obligations stay named. |
| BASE-AGENT-009 | INSPECTED: activity and Undo ownership remains there; no new audit or Undo claim is made. |
| BASE-AGENT-011 | INSPECTED: live usage ownership and all wider pause and quota obligations remain there. |
| BASE-AGENT-012 | PASS selected keyed replay, INSPECTED wider scope: concurrent and restarted approval retries retain the original result; broader scope and recovery work remains. |
| Enforcing egress and device holds | UNMET-EXTERNAL: no change or release. |

Pre-ready (1): the selected unsafe and allowed paths have runtime assertions; the main-source regression demonstrates the new admission assertion fails when the fix is removed. The full clause remains PARTIAL.

Pre-ready (2): no existing assertion was removed, narrowed, skipped or conditioned on width. Functional browser decisions run at 1440; both widths provide the requested actual screens.

Pre-ready (3): agent and device decisions are refused, deactivation fences the next request and final execution, and keyed replay produces no additional draft. Erasure and restore are unchanged; no new erasure guarantee is claimed.

Pre-ready (4): the existing pages use readable text of at least 13px, complete rounded borders and text-labelled controls. Browser assertions and manual image inspection found no overflow or icon-only controls. No new configuration surface or homepage change was made.

Pre-ready (5): local source-lock checks pass; changed product lines contain no email-shaped literals. Publication scanning was not run in cloud, as the cloud adaptation assigns it to the Mac lander. Scan provenance is recorded honestly as commit=e84518d7cd85e61dfd0f68f6eec9cb3dd9fce190, complete=false, historyScanned=null, findings=null. This is not a scan PASS or a zero-findings claim. Exact-SHA Verify status is retained in checks.json. Main equality is false; candidate Run site is not available before landing. Current base main has successful Verify 42231003408 and Run site 42231003149, and those runs are not represented as candidate evidence.

## Probes, custody and remaining work

PROBE BASE-AGENT-007 reference admission: native policy PUT with absent or inactive named approver or reviewer -> HTTP 400 policy_refs_unresolved, previous document and revision unchanged.
PROBE BASE-AGENT-007 independent approval: production MCP inert draft -> no effect before both independent signed-in people approve; sponsor, unrelated, agent and device decisions refused.
PROBE BASE-AGENT-007 replay: concurrent and restarted operation-keyed MCP retry -> original result and receipt, one draft, no published version and no run.
PROBE BASE-AGENT-007 invalidation: changed input, summary, native draft or policy revision, rejection, expiry and first-approver deactivation -> no held effect.
PROBE BASE-AGENT-007 controls: explicit autonomous and standard review policies -> inert draft, and independent review marking for the review case.
PROBE BASE-AGENT-007 browser: pending, first-approved, executed, rejected, expired and refused -> all 12 actual screens at 1440 and 390, with keyboard decisions at 1440.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock then check exit=0; views=node src/base/contract-docs.mjs write then check, restored from origin/main exit=0; ledger=none exit=0.

Product push succeeded on attempt 1 using the required cloud push guard. All candidate author and committer identities are the fleet identity, with no co-author trailers. All three product pushes succeeded without retries. There was no history rewrite, main push, PR or workflow edit. The initial unpublished rebase and the final published-branch merge both reported up to date. Evidence files stay outside the product checkout and are explicitly selected for the report-only ref.

Plan rows changed: none on the Mac. This report supplies the return for the BASE-AGENT-007 row: local named-reference admission and independent native approval proof are complete, while status and all held remainder remain unchanged.

GAP BASE-AGENT-007: real Business propagation, owner IdP tenant interoperability, provider execution with actual consent and readback, money and other undeclared-class threshold and daily-cap journeys, complete tool and class disposition coverage, and integration API and embedded-agent parity remain unproved. Existing enforcing-egress, account and device holds remain; no other clause's obligation is released.

CLAIM BASE-AGENT-007 PARTIAL points=5 tests=tests/agent-door/named-approvals-journey.mjs#local named references and independent human approvals retain exact evidence and once-only inert effects; tests/agent-door/named-approvals-browser.mjs#independent keyboard decisions and six approval states

## Reproduced Verify failure and one repair

Initial Verify run 42236087751 failed on source head 8af0ed1a6c0fd2743e101dba878b31b877b23bcc in plan job 127953945502 at `Check edition source lock with the installed tool`. The aggregate verify job 127954142620 then failed because the plan had failed. Both actual failed-job logs were read once through the required archive command and retained. No test shard ran in that failed workflow.

The exact failed command, `node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check`, was run on the failed source head with Node 22.20.0 and returned exit 1 with the same error. The copied seed helper reported a fresh lock because it computed its own tool digest. Regenerating with the installed CLI changed only the toolchain digest back to the release digest already used by main. No product, test, contract or workflow bytes changed in this repair; no hashes were edited by hand.

The correction is a new non-rewriting commit d60357bbece16bdfd49e8ffb65a4cfa9dc9a0656. The authoritative installed check passes on that committed head. Runtime, browser and targeted CORE conformance are repeated on the repaired head. This is one reproduced mechanical repair, not a weakened guard or an infrastructure rerun.

VERIFY_REPRODUCED {"head":"8af0ed1a6c0fd2743e101dba878b31b877b23bcc","job":"127953945502","command":"node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check","test":"Check edition source lock with the installed tool","exit":1,"failure":"Stale lock or source/tool integrity mismatch; run changes to inspect intentional edits before lock"}

## Final proof completion

The final proof commit e84518d7cd85e61dfd0f68f6eec9cb3dd9fce190 advertises the MCP URL elicitation client capability and asserts the returned elicitation method, URL mode and exact approval URL for every held request. The prior sanity journey checked the URL handle but did not request this optional envelope. This closes that proof detail directly in the selected native journey. Product source is unchanged. The installed CLI regenerates the source lock after this final test edit; the authoritative check passes after commit.

## Terminal custody

PUSHED branch=cloud/sx-crank-c-f91 head=e84518d7cd85e61dfd0f68f6eec9cb3dd9fce190

Final exact-SHA Verify: run 42238086547, event push, status in_progress, conclusion null, observed through REST after the required 300-second interval. The actual response is in final-ci-poll.json. Nine of the ten allowed GitHub command calls were used. No green Verify, completed publication scan, main equality or candidate Run site is claimed. The successful local gates are ready for the fleet's independent checks; a missing final READY receipt does not itself signal a product failure. There is no unresolved local product blocker and no known assertion failure on the final head.

Counts before and after: 32 DONE, 50 PARTIAL, 17 MISSING, 99 Status rows. BASE-AGENT-007 remains PARTIAL; selected native point 5 is proved, while every held obligation remains retained. No other plan row or clause status changed. The evidence publication is report transport only and grants no product READY, acceptance or landing.
