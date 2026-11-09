# Hosted container qualification

The **Container qualification** workflow is manual only. After this workflow
lands on main, the lane dispatches it once from the Actions page and retains the
run ID and `container-qualification-RUN_ID-ATTEMPT` artifact. The builder must
not dispatch it. Push, PR, nightly and reusable Verify behavior is unchanged.

The job uses an Ubuntu 24.04 hosted runner, read-only repository contents,
the checkout's exact Node and pnpm pins and frozen dependencies. In particular,
the rer version comes from `package.json` and must match the installed package;
the workflow never installs a newer rer to make qualification pass. Docker is
supplied by the hosted runner. There are no repository secrets, provider
credentials, customer requests, SSH targets or account deployments. Runtime
keys and the native owner session are disposable synthetic values, kept out of
the uploaded logs.

## Commands and results

`scripts/container-qualify.mjs` wraps the public commands supplied by the
installed `@runeditrun/rer`. It does not modify Base, its generated Dockerfile,
the image runtime, migrations or Crank's archive policy.

| Receipt row | Operation and assertion |
| --- | --- |
| install | Install the pinned pnpm and frozen dependencies; verify the installed rer version and Docker prerequisite; refuse an existing checkout installation. |
| build | `rer build --platform container`; inspect the resulting immutable image ID. |
| run | `rer preview --platform container` on loopback with its own new persistent volume; check native health, workerd engine and image ID; create and publish a synthetic map-only workflow through native HTTP. |
| recover | Kill the actual container with SIGKILL; relaunch through Base preview using the same volume and settings; check the same native workflow and image identity. Apply a 1 GiB runtime limit to each inspected app container. |
| export | Stop the owned preview and run `rer export --platform container --output exports/container-qualification-backup.rer`. Base owns the exclusive transfer lock and archive policy. |
| restore | Use a separate empty checkout and volume, the exact same image ID and `rer import --platform container --input FILE --yes`; launch through Base preview, establish a fresh native owner and verify the previously published workflow is paused with no connection authority. |

The driver has a 22-minute overall budget inside the job's 25-minute timeout,
leaving time for cleanup, summary and artifact upload. A failed command prints
its output and records FAIL. Dependent rows become NOT RUN with the reason;
they never become PASS. Interruption is recorded as failure. Any failed or
unrun row makes the qualification job fail. The finalizer and artifact upload
run even after a failed qualification step.

`result.json` includes source SHA, rer version, image ID, every covered row's
status and duration, and overall timing. Command output is in `logs/ROW_ID.log`.
`summary.md` reports the same result and includes the exact sanitized command
output for a failed export. Path/usage errors in the qualification command are
labeled separately from an observed `container_policy_module_unsupported` Base
refusal. Restore stays NOT RUN after either failure; a policy refusal is never
inferred from the export exit code alone. Uploads select only
these two files and the sanitized `logs/*.log`; settings, cookies, archive bytes,
image contents, private inputs and environment dumps are not artifacts.

## Current boundaries

Read `CONTRACT.md` BASE-005 and its status/Gap before interpreting a run.
Current main has prose acceptance, rather than a numbered container-row table.
This workflow covers the build, local container execution, process-death
persistence and local archive recovery portions of implementation qualification.
A published map is synthetic stored state, not a complete customer workflow or
pending-effect/Cron-recovery journey.

Crank pins `@runeditrun/rer@0.2.104` and refreshes maintained Base copies to
`96045612467d5e752c668e8557b4bf6e906edfb1`. The seed-owned declaration in
`scripts/installer/local.mjs` uses
`localPortability({ database: 'foundation', policyModule: 'src/crank/archive-policy.mjs', ... })`
for both native and container transfers. The module's default export preserves
Crank's executable row fences and staged validation; `restore-policy.mjs` keeps
workflows paused and unowned, credentials excluded, connections disconnected,
agent policy/approval state installation-local, and passive audit history
portable. The adoption does not grant receiving execution authority.

Base 0.2.104 validates that default export before data access and bundles the
seed module and its imports for the private container transfer worker. Archive
metadata cannot select executable code. No policy is serialized, removed or
replaced to obtain a passing result. The earlier 0.2.91 refusal
`container_policy_module_unsupported` is historical; a new hosted run is still
required to qualify the export and restore rows on this pin.

See the installed package's `modules/container/README.md`,
`cli/container.mjs`, `cli/container-transfer.mjs` and `cli/portability.mjs` for
the maintained operations. The source-only Base conformance suite accepts
default-seed, Lamp and Uptime, not Crank; its npm package does not ship that
entry point. This workflow does not pretend Crank is one of those seeds.

This job does not prove the clause's clean macOS start, supervised owned-server
boot or Docker-daemon restart, owned HTTPS, exactly-once five-minute schedules,
same-identity production upgrade, active-effect recovery, Cloudflare account
deployment or server-to-Cloudflare archive transfer. Base's local container
export targets the checkout's volume and cannot export an SSH-host installation.
Applying the memory limit after launch is not proof of cold startup at that limit.
Those duties and the live Gap remain unchanged; a passing implementation row
is never a BASE-005 DONE claim.

For edits, run `node --check scripts/container-qualify.mjs`, actionlint on the
workflow, `node scripts/verify-ci.mjs --check-workflows`, typecheck and the
first-party check. Stage new sources, then regenerate and check
`sources.lock.json` using the installed edition-authoring CLI as documented in
`VERIFY-WORKFLOW.md`. No generated acceptance view is committed.
