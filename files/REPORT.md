# Crank rer 0.2.105 adoption

Repository: just-every/run-crank
Branch: cloud/sx-crank-rer-0-2-105-1
Product head: 4d5b30636d0bc954dad715dee2984e9f0ea8a137
Starting main: e6ba1c6dd98f68e02826afdfe1e7ffb7fe2ab4df
PR: none; this brief returns the named branch to the fleet lander.

## Change and plan

The plan is preserved in PLAN.md. The product pins @runeditrun/rer 0.2.105 in package.json and pnpm-lock.yaml, with the npm integrity matching the published rer-v0.2.105 release. Current-version guidance in AGENTS.md, docs/AGENT-DOOR.md, docs/SOURCES.md and docs/CONTAINER-QUALIFICATION.md now names the new pin and immutable Base revision. CHANGELOG.md adds the adoption without rewriting the prior release entry.

The installed public refresh command was:

    pnpm exec rer refresh-base --ref feb76ac8321ff1275168cce10009291721064738 --from-api

Base was read only through gh api. No Base checkout was cloned. The first API refresh was interrupted before writes after inspection showed it was fetching every immutable blob individually. The completed invocation used a task-only immutable blob cache populated from a gh api download of that exact Base archive. Each cached blob was verified with the Git blob SHA-1; the installed refresh tool independently matched each blob to the live immutable API tree. Commit/tree and ancestry requests still went to the real GitHub API. No product tool or generated copy was patched to perform the refresh. These source caches are outside the product checkout and are not evidence selections.

Refresh updated 245 maintained-copy records, delivered the shared principal inference and approval-execution changes, and acquired their two upstream regression fixture/test files. It withheld and retired no files and requested no edition migration. Crank's existing workflow, recovery, named-person, counting, transport, policy and audit adaptations were retained. Older adaptation-baseline notices are recorded in refresh-receipt.json; no workflow or unrelated legacy behavior was replaced. The copied authoring tool's existing dependency version differences were preserved; the changed runtime adds only an internal type import.

New source files were staged before the installed edition-authoring changes/lock/check sequence. sources.lock.json was regenerated after source/docs edits and again after the final changelog edit. verify-base --offline passed; this check proves local bytes against the recorded hashes, while the refresh itself obtained the upstream immutable source proof. No generated copies or lock hashes were hand-edited.

The first real save, 81f7b6822d98e5b367c142ca56be0ab179d5cf49, was immediately pushed with [skip ci]. The final documentation/lock commit is 4d5b30636d0bc954dad715dee2984e9f0ea8a137. Fresh main fetches required no merge. Both pushes used cloud-push.py, succeeded on the first attempt and preserved published history. Every candidate commit, including all reachable side parents, was checked for fleet author/committer identity and allowed trailers before each push; neither candidate has a co-author trailer.

## Native public-door probe

legacy-approval-probe.mjs is a one-off evidence script outside the product tree. It creates a disposable native Worker and D1 database with Crank's real 99 migrations, native owner session, signed Business settings and signed company policy. It requests a native inert workflow preparation through /mcp and removes only principal.source from the pending saved row to represent a pre-0.2.96 Business principal; the Business consent and other saved fields remain intact. No provider effect is reachable from this preparation tool. The script restarts the Worker before each decision and acts through /agents/api/approvals/:id/approve.

Before refreshing the shared runtime, the running control executed, but the stopped approval returned execution_failed rather than sponsor_unavailable. After refresh, and again on the exact final head:

- Running Business: HTTP 200, executed, one native inert draft.
- Business stopped by a signed settings envelope: HTTP 200, refused with sponsor_unavailable, zero native drafts.
- Restart and repeated decision after stop: the same refusal and zero native drafts.

The exact-head actual receipt is legacy-approval-receipt.json. No cookie, JWT, generated key, private settings or archive is included in that receipt or the packet.

## Scope and counts

There is no clause work or status promotion. CONTRACT.md, ACCEPTANCE.md, docs/CLAIMS.md and test-budget.json are unchanged. Clause counts remain 32 done, 50 partial and 17 missing (99 total). The unchanged budget declares a seed test count of 199/200; vendored Base fixtures are excluded by the existing counting rule. Migration count remains 99 and every existing migration file is unchanged. No per-seed row-tagging migration was added; the existing 0.2.104 schema and people.businessStopped() adoption remain in place.

The cloud did not run a publication scan, as the adoption brief explicitly excludes it. A check of this branch's own added diff found zero credential-shaped matches. The fleet retains its separate publication and landing gates. Evidence publication is report custody only and grants no product acceptance or READY status.

## Validation and current outcome

See check-receipt.json for the actual commands, execution heads, durations and exit codes, product-receipt.json for the before/after inventory, refresh-receipt.json for maintained-source results, and ci-receipt.json for exact-head workflow observations. The final results are recorded below. Receipts record HEAD at command start; pre-save checks used the modified adoption worktree and are not claimed as proof of unmodified starting main. The final native probe, typecheck, source-lock check and all three targeted public-door registrations were repeated successfully on the exact pushed head. The local rer verify command selects the documented runtime-authority shard; its start head is the saved adoption commit, whose runtime sources are identical to the final documentation/lock commit.


## CI blocker and container follow-up

Exact-head Verify run 42673558714: https://github.com/just-every/run-crank/actions/runs/42673558714

The plan job (129350727506) succeeded. GitHub supplied no build/shard job record; the failed final job (129351166958, Require the selected coverage and its proof) reported the shared build result as abandoned, shards and full-push-proof as skipped, and coverage as full. Its exit was 1 because the required build and full proof were absent. This is not the generated-contract-view exception. The returned diagnostics did not identify the provider's reason for abandonment. The task made seven CI investigation calls, including discovery and its sole status poll separated by 300 seconds, one jobs read and one failed-log archive read for the failed job. There was no same-SHA workflow rerun and no empty/no-op CI-trigger commit. The branch is PUSHED but cannot be called READY while this exact-head Verify is red.

The container attempt first encountered the documented no-queue caller guard, then waited in the ordinary queue. That still-queued attempt was stopped by its own PID, without starting a build. The pinned pnpm repair printed by rer fixed its subsequent fetch failure. Rer correctly refused concurrent ownership of the original checkout's local state, so the final container attempt used a disposable git archive of exact pushed HEAD, the same pinned dependencies and documented CI/no-queue mode. Its production client and Worker build passed. Docker then failed at Dockerfile line 6, npm install --omit=dev --no-audit --no-fund, with SELF_SIGNED_CERT_IN_CHAIN while fetching miniflare from registry.npmjs.org. TLS verification stayed enabled; no generated Dockerfile or product source was edited to work around it. No image digest, run, export or restore success is claimed. See container-receipt.json and container-build-excerpt.txt.

REMOTE-NEEDS-LOCAL: The cloud proxy CA blocks npm inside the generated container image (SELF_SIGNED_CERT_IN_CHAIN); sx owns the later hosted container-qualify.yml dispatch after landing, as stated in the brief.


## Completed local results

- Native setup: PASS, including production build, the same 99 migrations and disposable first-owner claim.
- Exact final head: legacy source-less Business approval probe PASS; typecheck PASS; source lock PASS; three native public-door registrations PASS (3/3). The first broader attempt had three transport failures; the isolated retry and full retry passed without changing source or assertions. The actual first-attempt and final logs are included.
- Base-copy offline integrity, first-party profile, contract-doc consistency and workflow-shape checks: PASS.
- Public rer verify with runtime-authority selected ran all 46 unit/integration registrations: 46 PASS, 0 FAIL. Its first invocation then exited 1 because dist/site had not been built locally; the site's HTTP root returned 404. The CI shared build normally supplies that artifact. After building the 13-page/75-file site, its unchanged HTTP/link test passed. Both remaining seed callback commands, emitted runtime/recovery and email-link sign-in, passed on the final head. No second full rer verify exit is claimed and the initial failure remains in check-receipt.json.
- The unchanged installed rer 0.2.105 lifecycle functions that follow the seed callback were then called directly with the same project adapter and deploy declaration: hosted-output PASS; hydration checker PASS with its actual limit of one plain-HTML public page and no React hydration case, with /setup redirecting to sign-in; Agent door PASS, 1,524/1,524 declared conformance points. These are separate actual receipts and do not substitute a claimed successful public rer verify invocation. The initial hydration caller selected a missing transitive Playwright browser; selecting that actual controller with the cloud-required /usr/bin/chromium and --no-sandbox fixed it without changing checker assertions or product copies. Both the failure and final receipt are retained.
- Container production build: PASS; image npm install: FAIL, SELF_SIGNED_CERT_IN_CHAIN. No image/run/export/restore qualification is claimed. This is the anticipated remote-needs-local follow-up, separate from the exact-SHA Verify blocker.

The final product branch remains cloud/sx-crank-rer-0-2-105-1 at 4d5b30636d0bc954dad715dee2984e9f0ea8a137. There is no PR and no clause status change. Both product commits are already published. Final status is BLOCKED by exact-SHA Verify 42673558714 reporting the shared build abandoned and no full push proof. The fleet must resolve that CI custody barrier before landing; this cloud did not rerun the existing SHA or push main. Evidence publication is a separate report-only transfer.
