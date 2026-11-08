# sx-crank-c-f102 report

BASE-005 stays PARTIAL. The predecessor's finished adoption work is preserved on cloud/sx-crank-c-f102 at 5d4c2784ba44da64911b1df5702d202c4400c8da. The maintained container build reproduces SELF_SIGNED_CERT_IN_CHAIN at its npm installation step, so this continuation stops at the explicitly named Base blocker. No product bytes were changed in this continuation, no new product commit was made, and no DONE or READY claim is made.

## Product custody and scope

A fresh full-history clone was created, fleet identity and hooks installed, and the predecessor's two commits were based onto origin/main. Git reported the branch already up to date: current main 4da29fb0d18db5b317e43fb4a6ef9f9419f1c99b is already their ancestor. No published history was rewritten and no other writer's commit was dropped. The preserved commits are 8ba64e81147e438cea04eaf7a0c1af7d570b631b and 5d4c2784ba44da64911b1df5702d202c4400c8da. Both retain skip-CI save messages. Every candidate author, committer, trailer and complete message was audited before the fleet push guard successfully created only the named cloud branch.

The preserved diff selects the workerd engine, refuses undeliverable inbound alias creation and rotation, shows the platform requirement under existing Settings, extends the existing runtime script, and documents private production settings, SSH install, upgrade, memory control, backup and restore boundaries. Sending-domain scope is untouched. Base copies, package and runtime pins, workflow configuration, CONTRACT.md and its Status rows are unchanged. Generated views are restored from main and are not committed. No test registration was added or existing assertion weakened. Recorded registrations remain 200. Counts remain 32 DONE, 50 PARTIAL and 17 MISSING across all 99 clauses. BASE-005 and TRIG-006 both remain PARTIAL, with no Status, Gap or Evidence edit.

## Actual blocker

Command: npx -y @runeditrun/rer build --platform container, run through cloud_run with a 1200-second timeout. Actual exit: 1, without timeout.

The maintained build passed Crank's source and emitted import boundary and emitted a real container manifest selecting workerd, one D1 DB binding, the * * * * * Cron schedule, and no KV, R2, Queue or Durable Object binding. Docker 28.4.0 was available through the managed local socket. The image build reached Dockerfile line 6:

    RUN npm install --omit=dev --no-audit --no-fund
    npm error code SELF_SIGNED_CERT_IN_CHAIN
    npm error request to https://registry.npmjs.org/miniflare failed, reason: self-signed certificate in certificate chain

The generated Dockerfile is owned by node_modules/@runeditrun/rer/modules/container/build.mjs:97. The maintained command at node_modules/@runeditrun/rer/cli/container.mjs:53 invokes Docker with the image tag and context only. Neither provides a CA secret input or dependency-install trust configuration. The cloud runtime's supported pattern requires mounting the supplied CA and enabling tool-specific trust with certificate validation still active. That needs a supported Base door here. The brief explicitly requires stopping on Base-owned findings and preserving all copies and pins. No generated Dockerfile patch, alternate image, dependency cache substitution, TLS-verification bypass or non-container qualification was used.

This prevents the real disposable loopback SSH install, HTTPS, unexpected app death, Docker daemon restart, exactly-once five-minute schedule recovery, persistent records, same-identity redeploy and local container transfer proof. Those steps remain unimplemented in tests/runtime.mjs. The 1 GiB memory limit remains a qualification target, not a tested result. verification.json was left unchanged because there is no completed long container leg to place in another tier.

An additional setup failure was recorded: the temporary app listened on ports 37003, 41707 and 44065 but not the expected internal port 61450. Setup exited 1 with a readiness handshake failure. That result is retained honestly; later emitted-Worker tests pass and do not establish setup success. No unrequested Base setup repair was attempted.

## Checks and public-door probes

- PASS: three existing inbound-email sanity journeys in tests/triggers.test.mjs, covering forwarded fields and files, current sender and alias authority, bounded MIME, in-flight revocation, complete inactive custody, erasure and replay refusal. Exact command and output are in checks.json and inbound-tests.log.
- PASS: tests/runtime.mjs, including owner bootstrap, Workers address creation, container-binding creation and rotation refusal with 409 and the named requirement, unchanged alias and receipt records, real first-run completion, hidden creation controls, revocation and the existing emitted-service recovery journey. This is the native Worker route door with a platform binding; it is explicitly not container implementation evidence.
- PASS: changed Settings screen at 1440 and 390, with assertions at 1440 for font sizes, hidden creation form and delayed-hover and immediate-focus tooltips. Both screenshots were visually inspected; neither contains address secrets, credentials or a session link.
- PASS: pnpm typecheck; rer check --profile first-party; contract generator write and check for 99 clauses; source-lock regeneration and check with the installed tool used by Verify. Views restored whole from main. No migration changed, so ledger check is not applicable.
- FAIL: maintained container image build, as quoted above. This is a local reproduced build failure, not a CI repair round.
- FAIL: setup readiness handshake, with its bounded actual diagnostic in setup-failure.log.

PROBE BASE-005 container-build: maintained build command -> source boundary and manifest complete, Docker npm installation exit 1 with SELF_SIGNED_CERT_IN_CHAIN.
PROBE BASE-005 receiving: owner POST to the native workflow alias route -> Workers 201; same installation with container image identity returns 409 for creation and rotation with unchanged aliases and receipts.
PROBE BASE-005 Settings: installed Settings route at 1440 and 390 -> visible Workers requirement, no Create address button, existing alias inspectable and revocable.
PROBE BASE-005 recovery: existing native emitted-service journey -> process-loss, Cron, queue and archive recovery pass; no container equivalence claimed.

MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock, then check exit=0; views=node src/base/contract-docs.mjs write, then check exit=0, views restored from main; ledger=none exit=0.

The legacy source CLI was also inspected and reports a different toolchain fingerprint. The lock was generated and verified only with the installed package command that Verify actually invokes; no tool bytes or hashes were hand-edited.

## Acceptance, riders and remaining work

The complete outcome map, each DONE-RIDERS row and the pre-READY self-check are in acceptance-and-riders.md. All four acceptance legs remain unproved as full sentences. The required clean macOS signed-in start, rebootable owned Linux VM with owned HTTPS and persistent scheduled operation, authorized Cloudflare deployment, and remote-server archive import into empty Cloudflare are not supplied by this environment. The pinned CLI also lacks SSH-host archive export. No live-provider or owner-account receipt is claimed, no new policy default was adopted, and no Workers enforcing-egress hold is released for SEC-002, HTTP-002, TRIG-007, PLATFORM-001 or WORK-005.

Plan row: BASE-005 remains held by the maintained container build CA-trust door and the original device, account and hosted-export obligations. No full plan was rebuilt. PLAN.md records this continuation's full intended sequence and where it stopped.

## CI and publication

One GitHub REST discovery call was made for the exact preserved head and returned no workflow runs. CI run IDs: none. No PR was created and no workflow was dispatched for this known-blocked save. Main remains unchanged; no Run site result or publication-scan receipt is claimed. A cloud scan was not required for the branch save. The maintained landing gates remain required for a later candidate. This continuation is BLOCKED, not READY or proof of landing.

The full relevant non-secret packet contains this report, plan, provenance and check receipts, acceptance and rider map, actual build and native test output, bounded setup failure, product push receipt, CI discovery and the two screenshots. It is published only through the report-only evidence ref, separately from the product branch. The fully pushed clone is removed only after that transfer succeeds; report files remain outside the clone.

CLAIM BASE-005 PARTIAL points=none tests=tests/runtime.mjs#TRIG-006 runtime platform guard; tests/triggers.test.mjs#Inbound email admits forwarded fields and files once and refuses sender, authentication and alias authority failures; tests/triggers.test.mjs#Inbound email bounds raw streams and MIME and fences in-flight revocation and stale owner authority; tests/triggers.test.mjs#Inbound email restores complete inactive custody and erases files without replay or archive resurrection
GAP BASE-005: Maintained container qualification needs Base CA-trust support; clean owned-host reboot, clean macOS start, authorized Cloudflare deploy and remote-server archive transfer remain unproved.
BLOCKED BASE-005: Base-generated Dockerfile cannot install Miniflare through the cloud CA chain using a supported trust input.
