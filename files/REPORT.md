# sx-crank-f86fix1-push-1

Repository: just-every/run-crank
Product branch: cloud/sx-crank-f86fix1-push-1
Required unchanged product commit: dea20ab568c8c5be25accec8b425a0fa125e00f9

## Plan

1. Refresh the fleet launcher, install fleet Git authentication and push guard, and read launcher rules.
2. Make a shallow blob-filtered clone of main, configure fleet identity and commit hooks, then read repository landing rules and contract context.
3. Fetch cloud/sx-crank-f86fix1 with enough history to verify its exact head and audit every candidate commit's author, committer, and trailers against origin/main.
4. Read Verify run 42479803993 without rerunning anything; require success and the exact requested SHA.
5. Publish the same commit unchanged to cloud/sx-crank-f86fix1-push-1 with the fleet push guard. Verify remote custody.
6. Save actual non-secret receipts, publish the explicitly selected evidence packet to evidence/sx-crank-f86fix1-push-1, then delete the disposable product clone after successful custody checks.

## Scope

No product commits, code changes, tests, releases, CONTRACT.md edits, clause changes, or DONE claim. Existing publication identity checks remain required. Before/after clause counts will be unchanged; record actual counts if the repository provides them. No PR unless repository landing rules require one.

## Results

- Fetched source branch head exactly `dea20ab568c8c5be25accec8b425a0fa125e00f9`; the product commit was reused unchanged.
- Existing Verify run [42479803993](https://github.com/just-every/run-crank/actions/runs/42479803993), number 662, is completed/success on that exact SHA. No workflow was rerun or manually dispatched.
- Audited both candidate commits, including side parents, against origin/main. Both author and committer are Run Edit Run fleet <fleet@runeditrun.com>; both messages have no trailers. Candidate history does not reach a shallow boundary.
- Product push guard succeeded on its first attempt, creating only `cloud/sx-crank-f86fix1-push-1`. A separate `git ls-remote` verified the remote branch at the exact required SHA.
- No product commit, source edit, test run, release, contract edit, clause promotion, or DONE claim was made. The worktree remains clean. No PR was required by the repository instructions, so none was created.
- Before/after: 99 clauses; 32 done → 32 done, 50 partial → 50 partial, 17 missing → 17 missing. DATA-001 remains done and BASE-AGENT-012 remains partial. These are existing contract judgments, unchanged by this task.
- Actual receipts are `verify-42479803993.json`, `publication-audit.json`, `candidate-identities.txt`, `product-push-receipt.txt` and `remote-custody.json`. The report-only evidence publication is separate from product readiness and landing.
- The disposable product clone will be deleted after evidence publication and exact evidence remote custody are verified, as the brief requires. The packet stays outside the clone.
- Blockers: none. The fleet retains landing authority; this task has not changed main.
