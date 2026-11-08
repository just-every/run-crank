# sx-crank-c-f101 results

BASE-005 remains PARTIAL. This is a preserved, blocked qualification attempt, not a READY candidate. Product branch: cloud/sx-crank-c-f101. Product head: 5d4c2784ba44da64911b1df5702d202c4400c8da. Initial and fetched main: 4da29fb0d18db5b317e43fb4a6ef9f9419f1c99b. No PR was created. Counts remain 32 DONE, 50 PARTIAL and 17 MISSING across all 99 clauses; registered tests remain 200.

The full intended plan is PLAN.md. Completed: read the full clauses and shipped rulings, inspected the pinned container door and its boundary, checked Docker availability, declared workerd, added a native inbound-email platform refusal with public-route regression proof, documented the supported commands and transfer limits, and preserved the changes on the named product branch. Not completed: disposable SSH host creation and the container deployment, reboot-path, memory qualification and transfer journey. The initial real image build failed before producing an image, so no replacement Worker-only container proof was substituted and no long-leg invocation was added to verification.json.

## Blocking dependency

Command: `npx -y @runeditrun/rer build --platform container`.
Exit: 1. At the generated Base Dockerfile line 6, `RUN npm install --omit=dev --no-audit --no-fund` failed with `SELF_SIGNED_CERT_IN_CHAIN` for the Miniflare registry request. The managed cloud network uses a trusted inspection CA, but the generated Dockerfile does not mount that CA into this networked step and the maintained build command exposes no build-secret argument. The image needs a maintained CA-trust door or an admitted build host whose trust requirements the existing door supports. A Base or rer change is outside this run's permitted write scope. No Base copy, Docker base tag, dependency pin or TLS verification was altered. The actual sanitized failure output is container-build-failure.txt. This attempt used initial main; the Base builder is byte-for-byte unchanged in the product commits.

Docker itself was available: version 28.4.0, local Unix socket, vfs storage, zero initial containers. SSH server executable was present. The environment runs as UID 1000 and cannot restart the managed outer daemon; the planned disposable nested Docker host would isolate the daemon-restart proof. That host was not constructed because image build had already reached the explicit Base stop condition. No claim is made about Verify runner Docker or SSH availability.

Local `rer setup --owner-email fleet@runeditrun.com --non-interactive` also exited 1: its readiness check expected internal port 29605 while the application reported other listeners. Ordinary `rer build` passed afterwards. The setup failure was not repaired and no private setup log or sign-in link is published.

## Product changes

- deploy.json explicitly selects the existing workerd engine. The declared runtime still has one DB and the existing per-minute Cron pass, with no new storage or queue binding. A 1 GiB memory limit is documented as a qualification target, not a tested capacity. The pinned deployment command does not set a memory limit; documentation names the inspected post-install Docker control and its replacement caveat.
- Native inbound-email creation and rotation reject with HTTP 409 before alias or audit writes when the maintained container launcher's runtime image identity is present. Email delivery also refuses on that platform. Workers behavior, owner checks, alias revocation and existing receipt inspection remain. No sending-domain scope was changed.
- Existing Settings components show the named platform requirement, omit the creation form and label retained addresses as unavailable for receiving. The screen introduces no icon-only controls. Existing shell tooltips and minimum text size passed in the browser proof at 1440; matching 390 proof is included.
- OPERATIONS.md and RUN-LOCALLY.md explain SSH host prerequisites, private mode-0600 settings, Caddy TLS, exact image health, same-identity upgrades, one-writer custody and local-volume backup and restore. They explicitly state that this CLI has no SSH-host export implementation, that local-volume export is not a remote server backup, and that disk snapshots are not portable archives.
- The existing tests/runtime.mjs registration now proves the platform guard through the emitted application's native HTTP doors. It creates a Workers alias, restarts the Worker with the same installation-only marker the container launchers set, attempts both creation and rotation, compares unchanged alias and receipt state, inspects Settings and revokes the old alias. This marker regression is not container qualification. Existing health, homepage, 404 and BASE-003 recovery assertions remain and pass.

No CONTRACT.md row or acceptance text changed. No generated contract view was committed. No Base copy, package pin, runtime pin, migration or workflow file changed. All product changes are limited to the brief's files plus the required generated source lock. Two preservation commits carry skip ci; their author and committer identities and messages were inspected before their pushes. Published history was not rewritten. Fetch and merge of main reported already up to date.

## Acceptance and evidence map

1. Clean macOS one-line start and signed-in app: NOT PROVEN. No clean macOS device supplied. Existing local emitted Worker authentication is a route regression, not that acceptance.
2. Clean Linux own-server install, owned HTTPS, five-minute Cron, host reboot, exactly-once due occurrences and persistent workflows, connections and history: NOT PROVEN. The image build stopped before deployment. Disposable-host qualification would still not meet the clean-host acceptance.
3. Same-checkout owner Cloudflare test-account deploy and health: NOT PROVEN. No authorized test-account receipt was supplied for this task.
4. Export SSH server installation and import into an empty Cloudflare deployment, paused under DATA-001: NOT PROVEN. Hosted export lacks an implementation in the pinned CLI; owner account authorization and destination proof are also absent.
5. This planner slice additionally requested a disposable SSH deployment, process kill, daemon restart, same-volume redeploy, real container preview, local-container export and empty local Workers import: NOT PROVEN because image build failed. Do not infer any of these from the public-route guard test.
6. Container native-email refusal: PASSED for the route and Settings behavior using the maintained launcher's binding. Actual image deployment refusal remains unqualified. Workers alias creation is the positive control; both unsupported mutations leave the existing aliases and receipts identical. Browser proof covers the changed Settings screen at 1440 and 390.

## DONE riders and pre-ready checks

No DONE claim is made. Row 1 FAIL: full BASE-005 outcomes are unreached. Row 2 PASS for the changed guard's supported and refused public routes, but no server acceptance claim. Row 3 FAIL: no exact-SHA green Verify; preservation commits intentionally skip CI. Row 4 PASS for the final local runtime and screenshots bound to the recorded product SHA in checks.json. Row 5 INSPECTED: no new inheritance claim. Row 6 PASS for generator write and check; views restored, no Status edits. Row 7 PASS: acceptance unchanged. Row 8 PASS for the touched native-owner route and unchanged-state refusal; broader authority duties unclaimed. Row 9 PASS: no provider, reboot or account boundary claimed proven. Row 10 NOT APPLICABLE: platform refusal follows the explicit brief, no new policy default. Row 11 PENDING: no landing or publication scan receipt, no main equality or Run site claim.

Pre-ready: existing assertions retained; new guard runs against real seeded state, not an empty list. Erasure, replay and restored authority code are unchanged; existing BASE-003 custody recovery passes. Touched Settings text and existing tooltips pass; screenshot proof covers both widths. Source lock is fresh using the installed pinned tool. Publication scanning is a fleet duty and was not run in cloud. No new email literal or provider-shaped key fixture was added; the touched runtime owner's address is assembled from synthetic parts. The known Base build failure binds this run as BLOCKED. No READY line is appropriate.

## Checks and custody

Actual commands and outcomes are in checks.json, provenance.json, runtime.txt and mechanical.txt. Screens are explicit regular PNG files. Source lock is regenerated and checked with `node node_modules/@runeditrun/rer/edition-authoring/cli.mjs`; using the older checked-in tool initially changed its tool hash, which was corrected with the installed tool before either push.

Exact-SHA Verify discovery returned no runs; no workflow was dispatched for the blocked preservation save. CI run IDs: none. Both product pushes returned PUSH_OK and the remote branch was verified at the full product SHA.

The product and evidence refs are independent. Evidence publication is not product readiness, acceptance or landing. Product saves must remain branch-only pending the maintained container trust fix and the full requested qualification. No INBOX or STATE file was read or written. Plan source rows were not edited; proposed BASE-005 plan update: qualification blocked at the maintained Dockerfile's registry trust boundary; engine and native-email guard saved, all owner-host, device, account and hosted-export holds remain.

CLAIM BASE-005 PARTIAL points=none tests=tests/runtime.mjs#TRIG-006 runtime platform guard
GAP BASE-005: Container image build requires a maintained cloud CA-trust door; disposable SSH and memory qualification, crash and daemon restart, same-volume redeploy, preview and local transfer are unproved. Clean macOS start, clean owned Linux reboot and HTTPS, authorized Cloudflare deploy, and SSH-host export into Cloudflare remain required.
PROBE BASE-005 image build: maintained container build command -> npm SELF_SIGNED_CERT_IN_CHAIN, exit 1; no image or service qualification.
PROBE TRIG-006 receiving: Workers alias creation -> 201; runtime container identity creation and rotation -> 409 with named Workers requirement and unchanged aliases and receipts; revocation -> 200.
BLOCKED BASE-005: Base container Dockerfile cannot trust this cloud's registry certificate chain through its maintained build door.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and check exit=0; views=node src/base/contract-docs.mjs write and check exit=0, generated views restored; ledger=none exit=0.
