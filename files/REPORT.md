# sx-crank-ci-limit-1

Repository: just-every/run-crank
Branch: cloud/sx-crank-ci-limit-1

## Plan
1. Shallow filtered clone of current main; read repository instructions, contract and workflow.
2. Inspect recent Verify runs, including 42235687658 and a green run; record every shard job duration.
3. Change only the shard timeout configuration. Keep shard composition, assertions, job count, plan/build/light/summary limits intact.
4. Check workflow permissions and existing CI planning tests; regenerate and check the source lock last.
5. Audit candidate commit identities/trailers, commit and push the named product branch, then observe exact-SHA Verify within the ten-call GitHub budget.
6. Publish the complete public-safe report and actual receipts separately on the evidence ref.

## Measurement and choice
The three sampled runs are 42235687658 (attempt 2), 42355375302 and green 42384703867.
The green run skipped shards, so it provides no completed full-shard timing.
No sampled shard completed above the current general 12-minute limit. The largest observed cancelled connections job was 12m47s.
That cut duration is a FLOOR, not a successful completion measurement.
Required fallback: ceil(12m47s + 8 minutes) = ceil(20m47s) = 21 minutes.
The longest sampled successful shard was app-comparisons, 11m12s.

Set workflow_call.inputs.timeout.default and the shard job fallback to 21.
Replace the old app-comparisons-specific 16-minute override with the common shard limit:
all eight push shards get 21 minutes; an explicit caller timeout still governs (nightly retains its existing 45-minute input).
Plan=3, build=8, light=12 and proof/summary=1 minute remain unchanged.
No shard rebalance, test move, assertion change, contract clause/status edit or generated contract-view edit.

## Every sampled shard duration
| Run | Shard | Result | Duration |
| --- | --- | --- | --- |
| 42235687658 | shards (financial-outcomes) | success | 7m19s |
| 42235687658 | shards (regulated-calendar) | success | 8m03s |
| 42235687658 | shards (owner-decisions) | success | 7m46s |
| 42235687658 | shards (workflow-custody) | success | 7m41s |
| 42235687658 | shards (agent-executor) | success | 9m11s |
| 42235687658 | shards (connections) | cancelled | 12m47s |
| 42235687658 | shards (runtime-authority) | success | 8m50s |
| 42235687658 | shards (app-comparisons) | failure | 7m01s |
| 42355375302 | shards (app-comparisons) | success | 11m12s |
| 42355375302 | shards (regulated-calendar) | success | 6m51s |
| 42355375302 | shards (agent-executor) | success | 8m58s |
| 42355375302 | shards (owner-decisions) | failure | 1m11s |
| 42355375302 | shards (runtime-authority) | success | 8m41s |
| 42355375302 | shards (financial-outcomes) | success | 5m56s |
| 42355375302 | shards (workflow-custody) | success | 7m30s |
| 42355375302 | shards (connections) | cancelled | 12m17s |
| 42384703867 | shards (${{ matrix.name }}) | skipped | 0m00s |

## Before/after
General shard timeout: 12 -> 21 minutes.
app-comparisons timeout: 16 -> 21 minutes on push; caller input honored on reusable invocation.
Push shard count: 8 -> 8. Tests moved: 0. Assertions changed: 0.
Clause status changes: none. Before/after clause counts: done 32 -> 32, partial 50 -> 50, missing 17 -> 17; total 99 -> 99.
Source lock includes .github/workflows/verify.yml and must be regenerated after the final workflow edit.

## Results
Local checks passed: actionlint 1.7.7 on both Verify workflows; reusable-workflow permission check; contract-doc consistency (99 clauses); source-lock check; eight-shard matrix inspection and unchanged verification.json; git diff --check.
The source lock was regenerated after the final workflow/documentation edit; only the workflow and VERIFY-WORKFLOW.md hashes changed.
One normal product commit was pushed once successfully through cloud-push.py; no [skip ci] head and no PR was required by this repository's instructions.
Head: 97dbba76c57a620110886e92a959fbf15b07d3d0.
Exact-SHA push Verify: 42409599674, completed SUCCESS on 97dbba76c57a620110886e92a959fbf15b07d3d0, confirmed through REST at 2026-11-07T20:33:44Z.
GitHub invocation budget at discovery: 6/10 (one list, three historical views, one accidental empty discovery using an incorrect SHA, then the correct exact-SHA discovery). The empty query supplied no evidence and was not used for any conclusion.
The exact-SHA run is green. No failed-job rerun was needed. GitHub invocation budget used: 9/10.
The initial Go-based actionlint install failed because /usr/bin/go is a different program; official actionlint 1.7.7 release binary was then installed and both workflow checks passed.

## Final custody
Product branch was pushed once and its exact-SHA Verify completed successfully:
https://github.com/just-every/run-crank/actions/runs/42409599674
No PR created; this repository provides branch-push Verify and has no supplied PR landing requirement.
No blockers. The fleet retains landing and publication-scan responsibility; no default-branch push was performed.
Evidence is published separately through the mandated cloud_evidence.py entrypoint; its terminal transport receipt is retained outside the packet.
Candidate-specific job durations were not fetched; the complete requested three-run timing sample is above and preserved in actual JSON receipts.

READY branch=cloud/sx-crank-ci-limit-1 head=97dbba76c57a620110886e92a959fbf15b07d3d0
