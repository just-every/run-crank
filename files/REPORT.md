# Crank unchanged-commit republication

Repository: just-every/run-crank
Tag: sx-crank-container-hosted-2-push-1
Product branch: cloud/sx-crank-container-hosted-2-push-1
Product head: 2e4477cb76b9787b4b3c0ed0f9f90ba4453a8716
Source branch: cloud/sx-crank-container-hosted-2

## Full plan

1. Set the fleet Git identity, refresh the authorized launcher, install the bundle-reading credential helper, credential cleanup, product push guard, and separate evidence entrypoint. Read launcher and repository AGENTS.md instructions and the repository contract documents.
2. Make a shallow filtered clone of the declared repository's main, set its local identity, install the fleet commit hooks, and configure the supplied cloud toolchain. Fetch the source branch with enough history to prove the candidate range and common ancestor.
3. Verify the source branch head is exactly the required SHA. Create the requested branch from main and point it at the unchanged source commit without creating a product commit, merging, rebasing, or changing files.
4. Confirm the provided Verify run is successful without rerunning it. Check all candidate commit identities and trailers, including side ancestry; check the worktree, source identity and unchanged contract/view files. Push through cloud-push.py and read back the exact remote ref.
5. Make a rate-limited REST exact-SHA workflow discovery, preserve actual non-secret receipts, and publish this explicitly selected packet only through the evidence ref. No PR is requested or required by the supplied repository instructions.
6. After successful evidence publication, delete the disposable clone as instructed. Keep the report packet outside the clone; the final message confirms cleanup and carries the evidence ref/head and lane POST.

## Results

The required source head was verified and republished unchanged. There are zero new product commits and one candidate commit relative to origin/main. The candidate's original author and committer are the owner, James Peter <github@zemaj.com>, with no trailers. The fleet identity and original repository hooks were configured for any new commits; no product commit was created and published history was not rewritten.

The common ancestor of main and the candidate is 0fbed5e5bcb6965d68505fc2358bb442c983905d. The entire candidate range contains only 2e4477cb76b9787b4b3c0ed0f9f90ba4453a8716, so no side-parent candidate was omitted.

The original commit changes scripts/container-qualify.mjs, docs/CONTAINER-QUALIFICATION.md and sources.lock.json: 32 insertions and 10 deletions. It puts qualification backups under exports/, distinguishes local usage/path errors from the pinned Base policyModule refusal, and retains sanitized failure output and honest FAIL/NOT RUN rows. This task changes none of those bytes.

The product push succeeded on its first guarded attempt. A separate ls-remote read confirmed refs/heads/cloud/sx-crank-container-hosted-2-push-1 points to the exact required SHA. main was not pushed. No PR was created. No rerun or manual workflow dispatch was requested.

The explicitly requested command, gh run view 42539539780 -R just-every/run-crank --json conclusion, returned {"conclusion":"success"}. REST discovery after the required 300-second interval confirmed original Verify 42539539780, attempt 2, is completed/success on the required exact SHA. It also confirmed the automatic push-triggered Verify 42544662613 for cloud/sx-crank-container-hosted-2-push-1 is completed/success on that same SHA. No manual rerun was needed. The actual selected REST response is in verify-runs.json and the exact-SHA decision is in product-receipt.json.

## Counts and clause status

Before and after: 32 done, 50 partial, 17 missing; 99 total. Published: 9 done, 3 partial, 0 missing; 12 total. Target and push further: 23 done, 47 partial, 17 missing; 87 total.

No clause status changed. CONTRACT.md, ACCEPTANCE.md and docs/CLAIMS.md are byte-identical to the original commit's parent. No contract generator, lock regeneration or acceptance view edits were needed or performed. No DONE claim is made.

## Validation and limits

PASS: exact source SHA; complete one-commit candidate range; owner author/committer and absent trailers; clean product worktree; unchanged contract and generated views; guarded product push; remote ref identity; both original and new-branch Verify completed/success on the exact SHA.

Local product tests were not rerun, as the brief explicitly requests unchanged republication and no reruns. No app setup, live provider operation, browser launch, UI change, deployment or landing was performed. The pinned cloud-toolchain environment was configured, but project dependencies were unnecessary for this transport-only task.

No product blocker was observed. Evidence publication is a separate report transport and does not establish acceptance or landing. The fleet's publication scan and landing remain external to this cloud task.

## Packet inventory

- REPORT.md: this full plan and report.
- product-receipt.json: structured source/product identity, counts, publication and CI observations.
- product-push.txt: actual guarded product push output, without secret values.
- remote-product-ref.txt: actual remote product ref readback.
- candidate-commits.txt: complete candidate commit metadata.
- identity-trailers.txt: prescribed identity/trailer inspection output.
- product-change.patch: the original published commit, unchanged.
- verify-conclusion.json: actual requested gh run view response and command.
- verify-runs.json: exact-SHA REST discovery response and command.
