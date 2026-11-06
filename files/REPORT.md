# sx-crank-c-f81 report

Repository: just-every/run-crank
Branch: cloud/sx-crank-c-f81
Candidate: d8623c31cf359634b9516a57754ede47e02fa8e8
Published save: e4e82fafc93b7f60099b4615128a555a775b25de
Base main: e2c146dc38eb64e685cf01d2c56e798404b3936e
PR: none; branch pushes start Verify directly.

BASE-AGENT-005 remains PARTIAL. Counts remain 32 DONE, 50 PARTIAL, 17 MISSING; all 99 parent Status rows and 153 table lines remain. Recorded test registrations remain 201; this run adds no registration and removes or weakens no existing assertion. The inherited recorded total exceeds the unchanged maximum of 200; this run extends existing sanity journeys.

The selected native scope-removal slice is implemented and proved. A native owner explicitly authorizes the new access-family permission when minting a new preparation credential. Existing credentials retain their previous permissions. An explicit once-only owner ceiling can also restrict a Business agent without adding anything to its original token. The shared native action serves the signed-in person's Access control and crank.agents.narrow. It resolves sponsor and agent from server authority, compares retained scopes, refuses additions as self_escalation, requires the current native revision, and atomically rejects conflicting removals. The edition currentScopes adapter intersects each call with the original credential. The native transaction repeats the ceiling, including legacy preparation routes. An admitted write is refused after scope removal. Scope ceilings survive restart and travel inactive in archives; credentials never travel. Pending human approval cannot restore withdrawn or revoked authority. No role, company-policy or Pause mutation is exposed.

The native owner control uses existing settings components. Keyboard scope removal, subsequent write refusal and retained metadata reads pass at 1440. The changed panel is captured at 1440 and 390, with readable text and no phone overflow. It adds no icon-only control. The existing screen journey retains its previous checks. The candidate changes no product source or browser-test byte after the passing browser run on the published save; checks.json records the empty relevant diff.

The full execution plan is in PLAN.md. Plan row changed: BASE-AGENT-005 native scope-removal progress and evidence only. No plan was rebuilt. TEAM-001 policy and TEAM-006 creation revisions remain untouched.

## Public-door proof rubric

All line references below are to the candidate. The module is tests/agent-door/narrowing-journey.mjs, invoked by the existing native Agent door journey and the existing PLATFORM-001 SDK and CORE door sanity registration. Runtime and restore assertions run at the candidate SHA under Node 22.20.0.

| Row | Selected point | Door, observed result and assertion |
| --- | --- | --- |
| R1 | Explicit owner permission without expanding existing credentials | Native POST of tokens followed by MCP: default credential is refused with insufficient_scope; an attempted upgrade of that existing credential is refused without changing its scopes. Lines 31–39. |
| R2 | Server-resolved agent and sponsor; computed access direction | MCP scope addition is self_escalation; forged agent, sponsor, direction, role, policy and Pause arguments cannot retarget removal, change a person or change policy state. Audit records access with direction narrows. Lines 40–52. |
| R3 | Remove preparation and retain permitted metadata | MCP preparation succeeds before removal, then returns insufficient_scope; the legacy write returns 403; metadata read returns the seeded workflow; lists remain unchanged. Lines 38–39 and 53–58. |
| R4 | Persistent, revision-bound removal | The same completed key returns its first result; stale revision conflicts; re-addition is self_escalation; restart keeps write refusal and the permitted read. Lines 59–63. |
| R5 | Concurrent removal and native mutation fencing | Two owner removals at one revision produce one 200 and one 409; regrant is refused. A preparation request paused at its native commit boundary receives 403 after owner removal, and creates no workflow. Lines 65–82. |
| R6 | Held policy through the signed-in human door | Access action waits with no effect, an agent cannot approve it, and the native person approves its exact summary and revision. The result loses preparation. Withdrawn and revoked pending authority cannot execute or restore access. Lines 84–104. |
| R7 | No resurrection through restoration | Complete removal succeeds and stops reads. Export preserves the narrowed scopes and revision with active=0, includes no native credentials, and the receiving installation cannot use the old token or acquire the original sponsor's authority. Lines 107–116 and tests/platform.test.mjs restore callback. |
| R8 | Person-control parity and changed-screen proof | tests/agent-door/narrowing-browser.mjs lines 7–32: owner explicitly checks permission for a new credential, uses keyboard removal, observes revision 1, write 403 and metadata 200; captures the panel at both release widths. |

PROBE BASE-AGENT-005 owner permission: native token mint without the new permission -> MCP insufficient_scope; explicit new permission -> allowed inert draft creation.
PROBE BASE-AGENT-005 identity and direction: forged foreign target and widening label with an actual subset -> only the calling agent narrows; an added scope -> self_escalation; person and policy state unchanged.
PROBE BASE-AGENT-005 persistence: remove workflows:prepare -> immediate MCP insufficient_scope and legacy write 403; restart -> same refusal and metadata read success.
PROBE BASE-AGENT-005 concurrency: two native owner changes at revision 0 -> one 200 and one 409; held native mutation after removal -> 403, unchanged workflow inventory.
PROBE BASE-AGENT-005 held policy: access action -> pending, agent approval 403, signed-in person approval -> narrowed grant; revoked and withdrawn pending authority -> no change.
PROBE BASE-AGENT-005 restoration: export and restore narrowed ceiling -> original scopes and revision retained inactive, no old credential, no original sponsor authority.
PROBE BASE-AGENT-005 browser: owner control at 1440 -> keyboard removal, write refusal and allowed read; 390 -> changed-panel proof without overflow.

## Checks and custody

- Candidate native narrowing sanity journey: 1 passed; actual terminal output is narrowing-test.log.
- Touched platform file: 4 passed; output is platform-test.log. Final candidate changes no application code relative to that full-file run.
- Native authorization, token revocation and disconnected inactive restore regressions: 4 passed; output is native-regressions.log.
- Candidate hosted Agent door conformance: 1,213 of 1,213 passed; output is conformance.log. Both autonomous and held registry fixtures include the new access tool.
- Installed-screen journey: passed at 1440 and 390; browser.log, browser/team-browser.json and the two agent-tool-scopes images hold the relevant proof.
- Typecheck and first-party check: exit 0. Build and native owner setup also completed successfully.
- Two temporary source mutations are rejected by distinct security assertions. Bypassing original-scope ceilings breaks the default-credential refusal; bypassing the transaction ceiling changes the expected late-write refusal from 403 to 201. Both exit 1. Source bytes are restored; mutations.json and its two logs record the actual results. No mutation is committed.
- All candidate author and committer identities are fleet, with no trailers; identity-check.json covers both candidate commits and side-parent traversal. The added product text has zero email-shaped values. Full-history publication scanning is a lander duty and is not claimed here.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check exit=0; views=node src/base/contract-docs.mjs write then check exit=0; ledger=Wrangler local applied migration names compared with the checkout inventory exit=0 (95 migrations); deployment-spec=node scripts/build-deployment-spec.mjs --check exit=0.

The generated views were restored from origin/main and are not committed. The deployment specification is generated from the new migration. The final lock was generated after the final source, test, contract and documentation changes. The legacy vendored lock helper reports a toolchain-only mismatch: its tool SHA differs from the installed tool. Main and candidate both use the installed tool SHA; there are no file changes in that helper's comparison. Verify uses the installed command above, which passes. This inherited helper difference is recorded explicitly in checks.json.

## Honest remaining scope

No DONE claim is made. The target retains full role and tool UI parity, resource, folder, action and budget intersections, broader sponsor downgrade and suspension journeys, other access and security actions, complete injection resistance, BASE-AGENT-004 token and consent lifecycle, real IdP interoperability, Business propagation, owner and account, ct, enforcing-egress and device holds. No provider, account, enforcing egress or device claim is promoted by synthetic native proof. There is no new account or policy ruling request.

DONE-RIDERS: rows 1, 3, 5 and 9 retain the broader scope and external proof gaps, so status remains PARTIAL. Rows 2 and 8 are exercised both ways for this selected security slice. Row 4 is bound to the candidate or a byte-identical relevant implementation. Rows 6 and 7 preserve all acceptance sentences, all Status rows and generated-view custody. Row 10 uses the explicitly briefed owner-authorized boundary and claims no wider policy completion. Row 11, exact-main equality, full-history scan and Run site remain with the guarded lander.

Exact-SHA branch Verify: run 42151249698, push event, completed with failure only at the expected contract-generated ACCEPTANCE.md freshness check. Build job 127674942894 reports the exact stale-view error; dependent verify job 127675251160 fails because BUILD is failure and the shards skip. The plan job, source lock, application build, site build, typecheck and first-party check succeeded. This qualifies for the explicit generated-view READY exception; it is not reported as an actual green workflow. CI.json, ci-jobs.json and CI-FAILURE.md record the observation. No workflow was dispatched or rerun; five GitHub CLI calls were used. No green result from another SHA is used. Evidence publication is report custody only and never a landing or acceptance signal.
