# sx-crank-rer-0-2-104-1 — Crank adoption report

Repository: just-every/run-crank. Product branch: cloud/sx-crank-rer-0-2-104-1.
Product head: e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df. Terminal product and CI identity are recorded in PRODUCT-RECEIPT.json and CI-RECEIPT.json.

## Plan and implementation

The full working plan is PLAN.md. The work follows that plan: inspect the seed and pinned Base guidance, pin the published package, refresh maintained copies through the public runner, reconcile seed adaptations without broadening authority, validate the touched paths, regenerate source metadata last, push the named branch, check exact-SHA Verify, and return the report separately on the evidence ref.

The package and pnpm lock now pin @runeditrun/rer 0.2.104, from 0.2.91. The successful public refresh uses Base 96045612467d5e752c668e8557b4bf6e906edfb1. All 245 maintained copy records name that revision. The pre-refresh copies named 114ef7a61f080da053af783c5fbe06f625d692cc. Historical foundation provenance (fc0e1041efa55771142bbb57c4ab4743147e264d) and composition receipts remain historical rather than being rewritten as new proof.

Read Base's ADOPTING, portability and container guides through GitHub API archives. No undeclared repository was cloned or written. ADOPTION-NOTES.md records the adaptation decisions, original refusal messages and their resolutions. The successful refresh result, dependency closure and retained adaptations are in refresh-base-7.log, refresh-summary.json and verify-base-final.log.

Crank already declares its seed-owned src/crank/archive-policy.mjs as localPortability's policyModule. Base 0.2.104 can compile that executable default policy for container transfers. Its native export/import fences and staged validation remain in force: workflows restore paused and without an owner, connections require reconnection, credentials do not travel, and policy, approval and relay custody remain local. Passive audit and value-free reference suppression remain portable. The Base compiler probe confirms that functions and module-local behavior survive bundling.

The runtime refresh required newer agent-door dependencies. Three-way reconciliation against the recorded Base ancestor preserves Crank's receipt-backed draft recovery, named-person policy validation and audit classification. The custom people adapter forwards the durable Business stop check. Applied migration 0091 is unchanged; 0095 adds the new schema fields and bookkeeping. The existing Run chooser remains a seed adaptation. The refreshed import-kit and D1 transport closure required no additional import-door wiring or dependency adoption. Base's detailed agent-door guide also requires forwarding its signed audit pull before app authentication. The seed filter now forwards that route to the existing Base handler, with its current Business, signature and stop checks intact. Migration 0096 applies Base's legacy audit membership backfill; no external Business custody implementation or clause completion is claimed.

Tests exposed adoption issues. Base's waiting policy admission eliminated Crank's existing immediate contention refusals; counting.ts retains the prior decision_busy boundary while keeping the new interface and protected reservation writes. The recovery fault injector also needed its injection point moved to the new null-guarded persistence boundary. The refreshed MCP transport also changed protocol-error ordering. Native-cookie requests retain their existing bounded errors without becoming MCP credentials; anonymous and bearer requests retain Base's authentication-first challenge before body/header validation. A current principal remains mandatory for every admitted call, including initialization. No behavioral assertion was removed or weakened. The initial failed runs remain in the packet, with the corrected rerun recorded separately.

The generated deployment specification was stale after the additive schema update. Regenerated it with pnpm delivery:spec and verified it. Regenerated sources.lock.json with the installed edition-authoring tool after the last product edits and checked it. Current-version documentation and the changelog name the new pin; the historical rer 0.2.91 CORE receipt is explicitly historical.

## Validation

See CHECKS-RECEIPT.json for the final observed results and exact log filenames. Typecheck, first-party check, offline Base-copy verification, contract consistency, workflow permission check, generated deployment-spec check, source-lock check, syntax checks and the container policy compilation probe passed.

Ownership, platform and security public-door tests cover disconnected operation, native policy/approval/audit, credential-free inactive custody, replay recovery, current grants, revocation and import boundaries. Individual initial failures and final reruns are retained so the result is not confused with the earlier candidate.

The container command completed the real client/server application build and reached Docker image construction. Docker 28.4.0 was available. The image failed at the maintained generated Dockerfile's npm install with SELF_SIGNED_CERT_IN_CHAIN while requesting miniflare through the cloud TLS proxy. No image digest, container execution, container export or import pass is claimed. No generated Dockerfile was edited, and TLS verification remained enabled. CONTAINER-RECEIPT.json and container-build.log preserve the actual result. The lane must dispatch container-qualify.yml once after landing, as assigned; this task did not dispatch it.

A full local rer verify was not run, following the builder rule to run touched checks locally and use exact-SHA branch Verify for the full wall. Its container-relevant application build, native transfer/custody tests, policy compilation, and signed audit adoption probe were exercised as described above. Hosted CI remains separate from local container qualification.

## Counts and clause custody

The standard seed inventory is 200 before and after: 165 ordinary registrations, one site registration, two runtime scripts, 22 Verify browser commands, one Linux executor script and nine nightly assertions. Counting the pre-existing manual container qualification assertion script brings the complete CI-script inventory to 201 before and after. The inherited test-budget.json current field remains 199 and is stale; no registration files changed. This inherited count issue is outside the adoption and no cap increase or test deletion was made. COUNT-RECEIPT.json records the inventory. No ordinary test registration was added or removed; vendored Base tests are refreshed source and excluded from that count. There are still 99 clauses: 32 done, 50 partial and 17 missing. BASE-005 remains partial. There are no clause Status, Gap, Evidence or acceptance-text changes, and no acceptance promotion is claimed.

CONTRACT.md, ACCEPTANCE.md, docs/CLAIMS.md and test-budget.json are unchanged. No generated contract view or fleet report is committed to the product branch. The publication scan was not run, as explicitly instructed by this adoption assignment. No deployment, main push, workflow dispatch, PR or inbox write occurred. The fleet owns qualification dispatch and landing.

## Publication and remaining work

The first real save was pushed as 81f65fc with [skip ci]; the full identity and final push receipts are separate packet files. The intermediate 3c397ae candidate was superseded after completing the required audit-route adoption. Its observed Verify run (42624756348) is preserved in CI-SUPERSEDED-RECEIPT.json; no conclusion is inferred for it. The terminal product SHA is e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df. Its own exact-SHA Verify outcome is recorded separately in CI-RECEIPT.json. Evidence publication is report-only and does not imply acceptance or landing.

The remaining environment limitation is the image build's cloud proxy CA. The existing BASE-005 gaps for owned hosting, cold-start memory, durable scheduling, production upgrade, active-effect recovery and Cloudflare transfer remain unchanged. A hosted container qualification receipt is still required after landing; this adoption does not convert the clause to done.

## Terminal exact-SHA result

Verify run 42626876257 completed successfully on e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df.
Run: https://github.com/just-every/run-crank/actions/runs/42626876257

Eight GitHub API calls were used, including the two Base archive reads and the superseded run observations. The terminal branch is pushed and its remote head was verified. There is no product blocker. The cloud image certificate failure remains the explicitly reported environment limit; the lane owns hosted container qualification after landing.
