# sx-crank-c-f97 — WORK-005 aggregate task memory

Product repository: just-every/run-crank
Product branch: cloud/sx-crank-c-f97
Full SHA: 7ef378f73cfaf5576bc7f133172668363c0a8bca

The requested aggregate-memory implementation and its proof are already on main at the brief's starting SHA. The previous round's pending Verify completed successfully before this run. This continuation independently checked the implementation, reran the relevant native journeys and built browser proof, and published the requested branch at the unchanged SHA. No new product commit, empty commit, PR, status edit or workflow edit was needed. No history was rewritten and this task did not push main.

WORK-005 remains PARTIAL. The aggregate-memory slice is implemented and its real Linux proof is green; the clause still requires Base enforcing egress, versioned third-party dependencies and heavier executors. No full clause completion or publication-scan result is claimed.

Counts before and after: 32 DONE, 50 PARTIAL, 17 MISSING, all 99 clauses retained. Test registrations remain 200. There are zero product changes and zero new registrations in this continuation.

## Plan and completed results

1. Read launcher and repository instructions, the full WORK-005 clause and Status Gap, registered journeys, plan extract, ct rulings and all DONE-RIDERS rows. Established the lease is the aggregate-memory slice; other plan entries are read-only context.
2. Fresh full-history clone, local fleet identity and commit hook installed, fetched the previous branch and created the requested branch at the specified SHA. Refreshed main and rebased the unpublished branch: already current. Main and candidate were the same SHA, so no replay or conflict resolution was necessary.
3. Checked each requested behavior against the existing code and registered journeys. The earlier pending real Linux proof is now successful. The Verify job executes the actual Linux script with sudo on Ubuntu; it does not substitute a fake filesystem or per-process limit for the cgroup quota. The local cloud user cannot administer the root-owned cgroup controller and has no sudo, so this run did not attempt a duplicate privileged Linux proof. That limitation is specific to this cloud VM; the Verify host proved delegation successfully.
4. Reran all three registered executor tests, typecheck, first-party checks, contract generation and check, source-lock generation and check, installation setup, build, and the installed browser journey using system Chromium with no sandbox. All final checks passed. Kept the generated views equal to main and verified the product tree and index stayed clean.
5. Pushed only cloud/sx-crank-c-f97 using the cloud push guard. Remote main and the named branch both resolve to the full SHA above. Published this report and its actual receipts only through the separate evidence ref. Browser and server processes started by the journey exited; no local command is pending.

Plan row result: WORK-005 aggregate-memory proof is no longer pending Verify 42504682826. The WORK-005 plan status remains PARTIAL; no other row changes. The current Status Gap's aggregate-quota phrase is older than the completed implementation and proof; builders cannot edit that cell. The lane can reconcile that bookkeeping while retaining every broader obligation.

## Exact-SHA CI and custody

- Verify 42504682826: push event on cloud/sx-crank-c-f96, completed success, exact SHA 7ef378f73cfaf5576bc7f133172668363c0a8bca. Relevant successful jobs: agent-executor 128804981702, owner-decisions 128804981689, runtime-authority 128804981731. The same commit is the unchanged f97 candidate; no byte differs from the recorded run.
- Main Verify 42506673983: push event, completed success on the same SHA.
- Main Run site 42506674020: push event, completed success on the same SHA.
- Remote main equality and branch custody were checked with git ls-remote after the guarded push. Product push succeeded on attempt 1. No PR was created because the candidate already equals main.
- Publication scan: commit=7ef378f73cfaf5576bc7f133172668363c0a8bca; complete=unestablished in this cloud; historyScanned=unestablished; findings=unestablished. Scan custody remains with the fleet; green Verify is not represented as a scan receipt.

The successful CI data is in verify.json, verify-jobs.json and exact-sha-runs.json. Job receipt fields were recorded from the actual API response, not inferred from a prior report. Artifact metadata is in artifacts.json. One attempt to fetch the owner-decisions artifact failed at the redirected blob transport; the diagnostic exposed no HTTP status. Signed query data was not retained in the packet. No retry or alternative credential was used. Instead this run produced the actual local browser screenshots below.

## Frozen behavior rubric for this slice

Each row uses public task HTTP, workflow API or installed browser doors. Source locations refer to the exact unchanged candidate. CI event and conclusion for every row: push Verify 42504682826, completed success. The Linux journey is tests/executor-linux.mjs; its single script registration is the test name for this report.

- Q1 MET — Explicit whole-task memory quota, swap disabled and pids bounded before sandbox execution. tests/executor-linux.mjs lines 59–65 checks simultaneous active task groups, memory.max, memory.swap.max, pids.max and membership; executors/linux/launch.py creates and verifies controls before the pre-exec entry into the group. Every sandbox descendant inherits it. This is real kernel enforcement in the recorded agent-executor job.
- Q2 MET — Forked children exceed the aggregate while each stays below its separate address-space bound; named value-free memory_limit is durable. tests/executor-linux.mjs lines 34–50 forks four 24 MiB private allocations with 128 MiB per-process bounds and a 64 MiB aggregate, checks failed status, exact safe error and declared quota, then checks group removal. The 192 MiB case at lines 55–56 succeeds. No memory pressure generator or substitute limit was used in this continuation.
- Q3 MET — Restart reads the recorded result without relaunch, including a crash before HTTP acknowledgement. tests/executor-linux.mjs lines 51–54 stops the HTTP process while the supervisor records its OOM, verifies state is still running, then proves graceful and crash reconciliation preserve memory_limit and leave no task group.
- Q4 MET — Independent concurrent tasks keep their own quotas. tests/executor-linux.mjs lines 57–68 runs two independent executor services under distinct delegated roots, checks distinct controls, cancels one and observes the other succeed. One service deliberately serializes its own admitted queue; this test makes no claim of intra-service parallel dispatch.
- Q5 MET — Completion, cancellation, HTTP crash and supervisor crash clean the cgroup before terminal readback. tests/executor-linux.mjs lines 50, 56 and 67–71 observes absent task groups after each path, with durable interrupted readback and repeat submission refusing a second execution.
- Q6 MET — Missing delegation fails with the named setup requirement, without per-process fallback. tests/executor-linux.mjs line 72 starts an undelegated executor, checks cgroup_setup_required, restarts it and checks identical recorded readback. The fixture requires real cgroup delegation for quota-capable instances and fails explicitly if the Verify host cannot supply it.
- Q7 MET — Valid declarations, immutable published quota, unchanged legacy meaning and inactive restore. tests/executors.test.mjs, test “WORK-005 EXEC-002 BASE-001: published executor work keeps one durable identity across lost responses/restart, checks live connection authority and discloses values without secrets”, lines 24–40 validates bad values, pinned 96 MiB publication despite a later 192 MiB draft, memory_limit readback after restart, no implicit aggregate field on legacy declarations and current revocation fencing. Test “WORK-005 DATA-001 DATA-002: cancellation reports remote confirmation, task references restore inactive and erase with their run”, lines 55–71 compares complete portable rows, retains the published quota, proves inactive restore survives restart without contacting the executor, and erases local task references. Both passed locally in this run and in the recorded runtime-authority job.
- Q8 MET — Named failure is visible in installed screens and downstream work is stopped. tests/executor-schema-browser.mjs lines 32–42 publishes the declared quota, observes memory_limit and no downstream retain step, and records all relevant screens at 1440 and 390. It asserts visible memory_limit text at 1440. The remote protocol edge is explicitly faked for browser display, while Q1–Q6 use real Linux enforcement. This run reproduced the browser journey successfully and inspected both failure screenshots.

No full WORK-005 acceptance sentence was newly completed in f97, so the claim uses points=none rather than inventing acceptance numbers or treating this bounded slice as the whole clause.

## Original acceptance and inherited duties

- Published code transformation and remote Python job, limit failure, unauthorized-egress refusal, long-job cancellation and duplicate-free restart: reached by tests/executor-linux.mjs lines 17–31 and 74–94; registered executor lifecycle and cancellation tests cover the workflow doors. Aggregate-specific additions are Q1–Q7 above. Permitted network-enabled execution remains unavailable under the Base hold.
- Nested schema declaration validation, no coercion, matching and mismatching results, stopped downstream effects, immutable schema and restart: tests/executors.test.mjs test “WORK-005: declared output schemas reject invalid authoring and fence mismatched remote results before downstream effects”, starting line 76, passed locally; the schema browser journey also passed. This continuation changes none of that existing proof.
- EXEC-002 inherited bounded request and continuation safety: first registered executor journey checks stable identity, lost response, restart, polling deadline, no duplicate task and current connection authority. Transport enforcing egress remains explicitly unfinished.
- BASE-001 owned operation and inactive credential-free custody: the registered lifecycle test checks disclosure without source or token leakage; the registered cancellation and custody test compares complete archives and proves no execution on restore. Broader clause obligations are not silently promoted.
- Versioned third-party dependencies, heavier browser and ETL executors, permitted enforcing egress and the complete broader clause remain unproved by these journeys. No new provider, account, key, Base release or policy default was introduced.

## DONE-RIDERS review

1. PARTIAL for the whole clause: Q1–Q8 have public-door proof, but broader dependencies, egress and heavier executor outcomes remain open. No DONE claim.
2. PASS for this slice: allowed within-quota work succeeds; unsafe excess fails with no downstream continuation. Q2 and Q8 observe both outcomes; Q6 observes setup refusal.
3. PASS for the slice: real Linux, executor API and installed browser scripts are registered in verification.json and loaded in successful push Verify 42504682826 on the exact SHA.
4. PASS: unchanged full SHA; local tests and screenshots are also from that SHA.
5. PASS INSPECTED: WORK-005 explicitly names EXEC-002 and BASE-001 inherited duties. Existing text was preserved.
6. PASS for generation and source integrity; clause Gap bookkeeping remains for the lander. Contract write and check both exit 0; generated views restored to main. No Status, Gap or Evidence edit.
7. PASS INSPECTED: no acceptance rewrite, changed point, status row removal or new ct policy choice.
8. PASS for applicable authority paths: the existing workflow journey revokes the connection before continuation and observes no outbound request. No new authority door was added.
9. HONEST BOUNDARY: no provider or broader egress completion claimed. Linux enforcing proof is from the recorded real host, not the browser fake.
10. NOT APPLICABLE: no new custody, consent, spending or authority default adopted.
11. PARTIAL custody: main equality, exact-SHA Verify and Run site success are established above; a complete publication scan was not run or read by this cloud. No invented landing receipt.

## Pre-READY self-check and local receipts

1. The leased quota behavior has registered public-door assertions; exact-SHA Verify is green. The whole clause remains partial.
2. No existing test, assertion or registration was removed, narrowed or gated. There is no product diff.
3. Revocation, inactive restore and erasure paths pass in the registered executor tests; no new replay or data-disclosure surface.
4. No screen source was changed. The existing screens were reproduced and inspected at 1440 and 390 with no horizontal overflow, readable failure text and no reached downstream step. Eight screenshots are in screens. No UI redesign was performed.
5. Source lock fresh, contract generator check passes, exact-SHA Verify and Run site green. Publication scan is unestablished here and remains fleet custody. No new fixture, secret, address literal or product prose was committed.

Local final checks: three executor tests pass; typecheck exit 0; first-party check exit 0; setup exit 0; build exit 0; installed schema browser exit 0. Local Node is 24.19.0 with the provided pnpm 10.12.4 toolchain; CI used the repository's 22.20.0 pin. An initial mechanical invocation omitted sourcing the toolchain and selected the VM's newer pnpm, returning exit 1; rerunning the same first-party command under the required sourced toolchain passed. No product repair was made. Final commands and actual exits are recorded in mechanical.json and receipt.json.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock then check exit=0; views=node src/base/contract-docs.mjs write then check, restored from origin/main exit=0; ledger=none exit=0

PROBE WORK-005 quota: public task HTTP with forked children, below-quota control, independent quotas, cancellation, crash and undelegated host -> named memory_limit, success, independent controls, no residual group and named cgroup_setup_required; recorded real-host Verify 42504682826 job 128804981702.
PROBE WORK-005 declarations: workflow creation, publish, changed draft, run, restart and inactive restore -> invalid quota refused, published quota retained, legacy declaration unchanged, memory_limit readback, no restored dispatch; local three-test run passed.
PROBE WORK-005 browser: published workflow run through installed page -> visible memory_limit and downstream step not reached, screenshots at 1440 and 390, exit 0.

CLAIM WORK-005 PARTIAL points=none tests=tests/executor-linux.mjs#WORK-005 real Linux service and published Worker journey; tests/executors.test.mjs#WORK-005 EXEC-002 BASE-001: published executor work keeps one durable identity across lost responses/restart, checks live connection authority and discloses values without secrets; tests/executors.test.mjs#WORK-005 DATA-001 DATA-002: cancellation reports remote confirmation, task references restore inactive and erase with their run; tests/executor-schema-browser.mjs#WORK-005 installed workflow/result screens
GAP WORK-005: Base enforcing egress, versioned third-party dependencies and heavier browser and ETL executors remain unfinished; aggregate quota proof is green on the exact unchanged SHA.
