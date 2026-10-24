# Adopt the seed Verify workflow

New foundation compositions and standalone reference exports receive
`.github/workflows/verify.yml` and `.github/workflows/verify-nightly.yml` from
Base's matching `export/` templates. They also receive the seed's
`verification.json`, `scripts/verify-ci.mjs` and `scripts/verify-app.mjs`.
Existing editions own their workflows: copy or merge these files, preserving
their product-specific checks and supported Node and package-manager versions.

The two workflows use the same declared shards:

| Workflow | Triggers | Coverage |
| --- | --- | --- |
| Verify | Pushes to every branch, pull requests and manual dispatch | `push` shards |
| Nightly journeys | Nightly schedule, `v*` release-tag pushes and manual dispatch | Both `push` and `nightly` shards |

Release tags use Nightly journeys' full coverage. The nightly workflow calls Verify with the full tier. Verify plans its matrix
from `verification.json`, then runs the shards in parallel on Ubuntu 24.04.
Push shards have a 12-minute timeout; the nightly workflow allows longer for the
full installation journeys. The final `verify` aggregate remains the stable
required check as shard names change. It succeeds only when planning and every
selected shard succeed, or when a successful plan explicitly authorizes reusing
exact-SHA branch verification and the shards are skipped. A failed or cancelled
shard, or an unauthorized skip, cannot produce a green aggregate.

Shard jobs restore the pnpm dependency store and, for browser shards, the
Chromium cache. They install frozen dependencies and run the seed's `deps`
script to prepare its declared RER tools. Browser shards install Chromium and
its system dependencies; other shards do not need a browser installation.
Caches reduce setup time without replacing the frozen install or verification.
These package scripts work with both contained and packaged RER.

The template's application Node version remains 22.20.0 and pnpm remains
10.12.4. Preserve the seed's exact package pins and lockfile. The pinned checkout
and setup-node v7 actions run their own code on Node 24; action runtime upgrades
do not change application engines.

## Declare and run shards

`verification.json` has two arrays, `push` and `nightly`. Each entry declares:

- `name`: a unique shard name across both arrays.
- `browser`: a boolean saying whether the job needs Chromium.
- `hosted`: a boolean selecting the RER hosted-output verification path.
- `commands`: a nonempty array of shell commands, run in order from the seed
  checkout root. A failure stops the shard and fails the job.

For example, this fragment describes a typecheck shard using the reference
seed's existing package scripts:

```json
{
  "name": "typecheck",
  "browser": false,
  "hosted": false,
  "commands": ["pnpm typecheck", "pnpm test:typecheck"]
}
```

Inspect the actual checkout's CI selections with:

```sh
node scripts/verify-ci.mjs --matrix push
node scripts/verify-ci.mjs --matrix all
```

CI runs `node scripts/verify-ci.mjs NAME`, where `NAME` is an entry's exact
declared name. The helper sets `SEED_VERIFY_SHARD` and runs `pnpm verify` for
`hosted: true`, or `pnpm verify:app` for `hosted: false`. The hosted path retains
RER's hosted-output and hydration checks after the selected commands build the production Worker.
The `verify:app` package script must invoke `node scripts/verify-app.mjs`; that
runner reads `SEED_VERIFY_SHARD` and executes the selected entry's commands.
Missing, unknown or duplicate shard declarations fail explicitly. There is no
catch-all successful skip for an unrecognised selection.

With no `SEED_VERIFY_SHARD`, `verify:app` executes every command in both arrays.
The normal local `rer verify` therefore keeps full verification, including the
nightly journeys. Stop managed dev and preview servers first, as described in
`RUN-LOCALLY.md`. Moving work to `nightly` changes push CI scheduling; it does
not remove it from full local or release verification.

## Keep coverage while splitting work

The reference seed's push shards cover typechecking, local setup, the emitted
Worker and browser checks, and the remaining local-journey files. Split browser
journeys by test file so each job has a bounded, understandable unit of work.
The reference seed explicitly places these complete slow journey files in
`nightly`:

- `tests/local-journey/installer.test.mjs`
- `tests/local-journey/installer-browser.test.mjs`
- `tests/local-journey/journey.test.mjs` (the README fresh-copy journey)

An edition declares its own real commands and paths in the manifest. When
moving a slow installer or README journey, move the whole file to the nightly
list and retain its coverage. Account for every existing verification command
when adopting the split. Do not drop tests, add retries, or silently skip work
to fit the push timeout.

## Preserve edition source locks

Edition-owned seeds retain `edition.json`, `sources.lock.json`,
`.edition/sources/` and their pinned `scripts/edition-authoring/` tools. The
workflow runs `node scripts/edition-authoring/cli.mjs check` before installing
dependencies whenever either edition manifest or source lock is present. A
missing counterpart or tool fails the job. Intentional source or workflow edits
require staging new files, inspecting `changes`, and running `lock` locally;
commit the resulting lock and retained snapshots. CI never rewrites the lock.

Technical foundation/reference exports have composition or reference provenance
instead of an edition-owned source lock, so this authoring check becomes active
when they adopt the edition-owned protocol. Read Base's
`edition-authoring/README.md` for that adoption; the workflow does not convert an
existing product or create a source recipe.

The action pins were checked against the official
[checkout v7.0.1 release](https://github.com/actions/checkout/releases/tag/v7.0.1)
and [setup-node v7.1.0 release](https://github.com/actions/setup-node/releases/tag/v7.1.0).
Their pinned `action.yml` files declare `runs.using: node24`.

## Cancel superseded runs and reuse branch verification

Adopt this with the next rer patch after 0.2.79 (target **0.2.80**, assigned by
the Base release owner) in each seed's next landing commit; no seed waits for
another. Preserve the seed's checks, triggers, pins, matrices and stable
required-check names. The change has three parts:

1. **Concurrency.** A newer run of the same branch, pull request or dispatched
   ref cancels the older one. Main runs are never cancelled or replaced. Push,
   pull request and dispatch runs use separate groups, so a dispatch never
   cancels the push run of the same SHA.
2. **Main short-circuit.** On a push to main, the plan job (or a `main-verify`
   gate) asks GitHub whether a push of the same SHA to another branch or tag
   already passed this workflow. If it did, the shards are skipped and the
   stable `verify` aggregate passes on that authorized skip. Any doubt runs
   everything.
3. **Callers grant `actions: read`.** The lookup reads Actions runs, and a
   called workflow can only keep or reduce its caller's token permissions.
   Every workflow that calls `verify.yml` must grant `actions: read`.

### What counts as evidence

Only a push to main looks for evidence; no other event makes a request. The
helper lists this workflow's runs for `GITHUB_SHA`, matching the current run's
numeric workflow ID, workflow name, repository and head repository. It reads
complete pages only, up to GitHub's 1,000-run filtered-search limit, and then
decides:

- **Push runs only.** Evidence is a `push` run of the SHA on another branch or
  a tag. A pull request run tests GitHub's merge ref rather than the SHA: a pull
  request into a non-main base can pass while the SHA alone fails. A dispatch
  may run a different job set: nook's and slate's dispatches run only their
  slow journeys. Neither counts, and neither does a main or scheduled run.
- **The newest run decides.** The newest push run (highest run ID) must have
  completed successfully, and so must every newer run of this workflow for the
  SHA, whatever its event or branch. An older green run never outweighs a newer
  failure, a cancellation or a run still in progress.
- **Every job ran.** Every job in that run's latest attempt must have
  succeeded. The only skipped jobs allowed are the job running the lookup (the
  template's `plan`, or `main-verify`) and jobs this main run has already
  skipped by their own condition, such as a dispatch-only job with no `needs`.
  A branch run that skipped a job because a gate upstream of it was skipped
  (see [downstream jobs](#gate-every-job-a-main-push-runs)) is never evidence.
- **Failures run everything.** A missing token, an API error (403, 404, 429 or
  5xx), a timeout, a redirect, or a malformed, changing or duplicated listing
  gives `skip=false`, and every shard runs.

Only a seed whose Verify runs on pushes of its candidate branches gains the
short-circuit. Fourteen seeds run Verify on pushes to main (and tags or release
branches) only, so pushing a candidate branch produces no evidence: blotter,
chest, easel, evidence, happytohelp, inkwell, lamp, linen, pane, pencil,
platter, satchel, slate and vector. Their main runs stay complete until their
candidates run Verify on branch pushes; they adopt the concurrency block now.
Base's own Verify follows the same rules. Base verifies candidates by dispatch,
so its main runs are skipped only after a tag push of the same SHA.

### 1. Concurrency block

Replace the seed's Verify concurrency block with this one, or insert it before
`jobs` if there is none:

```yaml
concurrency:
  group: seed-verify-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

Main gets a unique run ID, so even a pending main run is never replaced;
conditional cancellation alone would not protect a pending run in a shared
group. The event name keeps push, pull request and dispatch runs of one ref in
separate groups. No other workflow in any seed uses these keys.

The census of all 57 `just-every/run-*` seeds on 23 Oct found ten existing
variants:

| Existing Verify block | Seeds | Replacement |
| --- | --- | --- |
| None | auth, barrow, beam, buoy, chest, coaster, crank, dial, easel, evidence, gasket, gauge, glove, inkwell, lanyard, larder, locket, lodge, nectar, nook, oncall, orbit, pantry, pier, plinth, purse, satchel, slate, spool, vane, willow | Insert the block. |
| `seed-verify-${{ github.workflow }}-${{ github.event.pull_request.number \|\| github.ref }}`, cancel `true` | balm, bifocal, cabin, coffer, cradle, envelope, handset, mallet, mango, pegboard, penny, placemat, porthole, stall, strap, terrace | The block. |
| `seed-verify-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number \|\| github.ref }}`, cancel `true` | latchkey | The block. It keeps latchkey's per-event groups and adds main run IDs. |
| `verify-${{ github.workflow }}-${{ github.event.pull_request.number \|\| github.ref }}`, cancel `true` | lamp | The block. |
| `verify-${{ github.event.pull_request.number \|\| github.ref }}`, cancel `true` | blotter | The block. Main runs stop cancelling each other. |
| `verify-${{ github.ref }}`, cancel `true` | linen, pane, platter | The block. Main runs stop cancelling each other. |
| `uptime-verify-${{ github.workflow }}-${{ github.event.pull_request.number \|\| github.ref }}`, cancel `true` | uptime | The block. |
| `verify-${{ github.ref }}-${{ github.sha }}`, cancel `false` | pencil | The block. Superseded pull request and dispatch runs now cancel; main runs keep unique keys. |
| `vector-ci-${{ github.event_name == 'workflow_dispatch' && github.sha \|\| github.ref }}`, cancel `true` | vector | Vector's block below, which keeps dispatches keyed by SHA. |
| `verify-${{ github.ref }}`, cancel only for pull requests | happytohelp | HappyToHelp's block below, which never cancels or replaces a main or release-branch push run. |

Vector dispatches verification of particular SHAs. With its block, two
dispatches of different SHAs on one branch both finish, as they do today:

```yaml
concurrency:
  group: vector-ci-${{ github.event_name }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.event_name == 'workflow_dispatch' && github.sha || github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

HappyToHelp keeps every main and `release/*` push run:

```yaml
concurrency:
  group: seed-verify-${{ github.workflow }}-${{ github.event_name }}-${{ (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')) && github.run_id || github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/release/') }}
```

### 2. Helper and callers

Copy `export/verify-ci.mjs` from the accepted Base release to the seed's
`scripts/verify-ci.mjs`; uptime keeps its own path,
`.github/scripts/verify-ci.mjs`. The `--main-skip` and `--check-workflows`
modes read no shard manifest, so they work in seeds with custom shard commands.
Keep `verify-app.mjs` where the seed uses the template's `--matrix` and shard
modes.

Every workflow that calls `./.github/workflows/verify.yml` grants
`actions: read`, beside `contents: read`, on the calling job. Otherwise GitHub
refuses to start the run (`startup_failure`). The
[reusable workflows reference](https://docs.github.com/en/actions/reference/workflows-and-actions/reusable-workflows)
states both rules:

- "The `GITHUB_TOKEN` permissions passed from the caller workflow can be only
  downgraded (not elevated) by the called workflow."
- "If `jobs.<job_id>.permissions` is not specified in the calling job, the
  called workflow will have the default permissions for the `GITHUB_TOKEN`."

Seventeen seeds call Verify from `verify-nightly.yml`: balm, bifocal, cabin,
coffer, cradle, envelope, handset, latchkey, mallet, mango, pegboard, penny,
placemat, porthole, stall, strap and terrace. Apply this diff to each one in
the same commit that adopts the plan job or gate:

```diff
 jobs:
   verify:
+    # A called workflow can only keep or reduce its caller's token permissions,
+    # and Verify's plan job reads Actions runs for the main short-circuit.
+    permissions:
+      contents: read
+      actions: read
     uses: ./.github/workflows/verify.yml
```

actionlint does not report a missing grant, but
`node scripts/verify-ci.mjs --check-workflows` does. It fails when a job that
calls a local reusable workflow grants less than a job of the called workflow
requests, and it names both jobs and the permission. Run it in a job that runs
on every event, as the template's plan job does.

### 3a. Seeds with a plan job

Apply this diff to the template's plan job, using the seed's existing matrix
step ID if it differs. Keep the job ID `plan` and its existing job
permissions, and add `actions: read` only here.

```diff
 jobs:
   plan:
+    permissions:
+      contents: read
+      actions: read
     outputs:
       matrix: ${{ steps.plan.outputs.matrix }}
+      skip: ${{ steps.duplicate.outputs.skip }}
     steps:
       # Existing checkout stays here.
+      - name: Check reusable workflow permissions
+        run: node scripts/verify-ci.mjs --check-workflows
+      - name: Reuse successful branch verification on main
+        id: duplicate
+        if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
+        env:
+          GITHUB_TOKEN: ${{ github.token }}
+        run: node scripts/verify-ci.mjs --main-skip
       # Existing matrix/planning steps stay here.
   shards:
     needs: plan
+    if: ${{ needs.plan.outputs.skip != 'true' }}
   verify:
     needs: [plan, shards]
     if: ${{ always() }}
     steps:
       - name: Require every shard
         env:
           PLAN: ${{ needs.plan.result }}
           SHARDS: ${{ needs.shards.result }}
+          SKIP: ${{ needs.plan.outputs.skip }}
-        run: test "$PLAN" = success && test "$SHARDS" = success
+        run: |
+          test "$PLAN" = success && {
+            test "$SHARDS" = success || { test "$SKIP" = true && test "$SHARDS" = skipped; }
+          }
```

Apply the shard condition to **every** job that depends on the plan, including
separately named browser or OS jobs, and keep an existing condition with `&&`.
With several shard jobs, keep them all in the aggregate's `needs` and apply the
success-or-authorized-skip test to each result.

| Seeds | Adoption |
| --- | --- |
| balm, bifocal, cabin, coffer, envelope, handset, latchkey, mallet, mango, pegboard, placemat, porthole, stall, strap, terrace | The diff as written, plus the caller diff in `verify-nightly.yml`. |
| penny | The diff without its aggregate part, because penny has no aggregate, plus the caller diff. |
| uptime | The diff, run from `.github/scripts/verify-ci.mjs`. Leave `prepare` ungated, because it builds main's controller artifact. Its aggregate test becomes `test "$PLAN" = success && test "$PREPARE" = success && { test "$SHARDS" = success \|\| { test "$SKIP" = true && test "$SHARDS" = skipped; }; }`. |
| orbit | Concurrency only. Its dispatch-only `release` job needs `verify`, so a main run has not yet listed it as skipped when the plan looks, and the lookup would always run everything. |
| lamp, vector | Concurrency only: their Verify runs on pushes to main only. |

### 3b. Seeds without a plan job

Add this main-only gate job. Keep its ID `main-verify` and give it no `name`:
a branch run lists it as skipped under that name, and the helper accepts that
one skip. The checkout pin below is the seed template's current pin; keep the
seed's supported checkout pin if it differs.

```yaml
  main-verify:
    if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    permissions:
      contents: read
      actions: read
    outputs:
      skip: ${{ steps.duplicate.outputs.skip }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - id: duplicate
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: node scripts/verify-ci.mjs --main-skip
```

#### Gate every job a main push runs

Every job that a main push runs must either need the gate or depend on a job
that does. Give each job without `needs` the gate. Append `main-verify` to an
existing `needs` list rather than replacing it, and keep an existing condition
with `&&`:

```diff
   app:
+    needs: main-verify
+    if: ${{ !cancelled() && (needs.main-verify.result == 'skipped' || needs.main-verify.result == 'success') && needs.main-verify.outputs.skip != 'true' }}
```

A job downstream of a gated job tests its own `needs` explicitly. For slate's
`contract`:

```diff
   contract:
     needs: [workers, app]
+    if: ${{ !cancelled() && needs.workers.result == 'success' && needs.app.result == 'success' }}
```

Without that line the job keeps GitHub's implicit `success()`, which is false
when any job upstream of it was skipped, here `main-verify`. The job would be
skipped silently on every branch, pull request and dispatch run, and those runs
would still be green. With the line, the job runs whenever its `needs`
succeeded. A short-circuited main run skips it, because its gated `needs` were
skipped. The helper never accepts a branch run that skipped such a job.

Leave jobs that a main push never runs as they are: dispatch-, schedule- or
tag-only journeys, for example. A main run lists such a job as skipped from its
start when it has no `needs`, and the helper accepts its skip in a branch run
only when the main run shows the same job skipped. A job that waits on another
is not listed yet when the gate looks, so its skip in a branch run makes the
lookup run everything.

#### Aggregate

An aggregate needs the gate and every gated or downstream job. It accepts each
result only when the job succeeded, or when the job was skipped and the gate
authorized the skip. Name every result in `RESULTS`:

```yaml
  verify:
    needs: [main-verify, build, shards]
    if: ${{ always() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 1
    steps:
      - name: Require every job or the authorized main skip
        env:
          GATE: ${{ needs.main-verify.result }}
          SKIP: ${{ needs.main-verify.outputs.skip }}
          RESULTS: ${{ needs.build.result }} ${{ needs.shards.result }}
        run: |
          test "$GATE" = success || test "$GATE" = skipped || exit 1
          for result in $RESULTS; do
            test "$result" = success || { test "$GATE" = success && test "$SKIP" = true && test "$result" = skipped; } || exit 1
          done
```

Never accept `failure` or `cancelled`, and never accept a skipped job only
because the gate was skipped on another event. Seeds whose job checks are
themselves required keep those names; GitHub reports a conditional skip as a
successful check.

| Seed | Adoption |
| --- | --- |
| cradle | Gate `build`. `shards` takes the downstream condition on `build`, and the aggregate becomes the block above. Apply the caller diff to `verify-nightly.yml`, and add the `--check-workflows` step to `build`, which runs on every event. |
| dial | Gate its `verify` matrix job; it has no aggregate. |
| coaster | Gate each of `app`, `coaster_flows`, `browser`, `capture`, `accessibility`, `cash_drafts`, `policy_signals`, `card_matching`, `policy_review` and `receipt_agents`. Its aggregate also needs `main-verify` and tests every result as above. Leave the dispatch-only `receipt_agent_corpus` as it is. |
| nook | Gate `fast`, keeping its condition: `if: ${{ !cancelled() && (needs.main-verify.result == 'skipped' \|\| needs.main-verify.result == 'success') && needs.main-verify.outputs.skip != 'true' && (github.event_name == 'push' \|\| github.event_name == 'pull_request') }}`. Leave `slow` and `installer`. |
| pencil | Concurrency only for now; see below. |
| slate | Concurrency only. Its Verify runs on pushes to main and `v*` tags only, and its dispatch runs only `local-journeys`. If its candidates later run Verify on branch pushes, gate `app`, `workers` and `verify` (keeping `github.event_name != 'workflow_dispatch'` with `&&`) and give `contract` the downstream condition above. |
| happytohelp | See below. |
| auth, barrow, beam, buoy, crank, gasket, gauge, glove, lanyard, larder, locket, lodge, nectar, oncall, pantry, pier, plinth, purse, spool, vane, willow | The gate, conditions and aggregate rules above. |
| blotter, chest, easel, evidence, inkwell, linen, pane, platter, satchel | Concurrency only: their Verify runs on pushes to main (and tags) only. |

The short-circuit is safe for nook. Its dispatch, which runs only `slow` and
`installer`, is never evidence, and it no longer shares a concurrency group
with nook's push run. A candidate push runs all 20 `fast` legs that a main push
runs. `slow` and `installer` have no `needs`, so a main run lists them as
skipped from its start.

#### Pencil

Pencil's Verify runs on pushes to main and `v*` tags only, so its only
evidence would be a tag push of the same SHA. Adopt the concurrency block now.
If pencil's candidates later run Verify on branch pushes, gate `checks`,
`runtime`, `browser`, `admission` and `hosted`, and leave `journeys` as it is.
Its aggregate keeps the `verify:contract` evaluation. A short-circuited main
run skips that evaluation, because the evidence run's own `verify` job, which
the helper requires to have succeeded, already ran it on that SHA's lanes:

```yaml
  verify:
    if: always()
    needs: [main-verify, checks, runtime, browser, admission, hosted, journeys]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Require every verification lane or the authorized main skip
        id: lanes
        env:
          VERIFICATION_RESULTS: ${{ toJSON(needs) }}
        run: |
          node -e '
            const { "main-verify": gate, ...lanes } = JSON.parse(process.env.VERIFICATION_RESULTS);
            const reused = gate.result === "success" && gate.outputs.skip === "true";
            if (!["success", "skipped"].includes(gate.result)) process.exit(1);
            for (const [name, lane] of Object.entries(lanes)) {
              if (lane.result !== "success" && !(lane.result === "skipped" && (reused || name === "journeys"))) process.exit(1);
            }
            console.log("reused=" + reused);
          ' >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        if: steps.lanes.outputs.reused != 'true'
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        if: steps.lanes.outputs.reused != 'true'
        with:
          node-version: 22.20.0
      - if: steps.lanes.outputs.reused != 'true'
        run: npm install --global pnpm@10.12.4
      - if: steps.lanes.outputs.reused != 'true'
        run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        if: steps.lanes.outputs.reused != 'true'
        with:
          pattern: contract-*
          path: ${{ runner.temp }}/contract-evidence
          merge-multiple: true
      - name: Evaluate the complete existing contract wall from this run
        if: steps.lanes.outputs.reused != 'true'
        run: pnpm verify:contract
        env:
          PENCIL_CONTRACT_EVIDENCE_DIR: ${{ runner.temp }}/contract-evidence
```

#### HappyToHelp

HappyToHelp has no plan job and no aggregate. Its Verify runs on pushes to
`main`, `release/0.3.x` and `release/0.4.x`, so its evidence is a release-branch
push of the same SHA. Candidates verified by dispatch or pull request are not
evidence; to skip their main runs too, HappyToHelp's candidates must run Verify
on branch pushes instead. Adopt its concurrency block, the gate job above, and:

```diff
   build:
+    needs: main-verify
+    if: ${{ !cancelled() && (needs.main-verify.result == 'skipped' || needs.main-verify.result == 'success') && needs.main-verify.outputs.skip != 'true' }}
   checks:
     needs: build
+    if: ${{ !cancelled() && needs.build.result == 'success' }}
   public-preview:
     needs: build
+    if: ${{ !cancelled() && needs.build.result == 'success' }}
   legacy-export:
+    needs: main-verify
+    if: ${{ !cancelled() && (needs.main-verify.result == 'skipped' || needs.main-verify.result == 'success') && needs.main-verify.outputs.skip != 'true' }}
```

### Required checks and adoption checks

The API permission is scoped to the plan or gate job; checkout still needs
`contents: read`. No request is made for a non-main push, pull request,
dispatch or schedule, and a missing or empty `skip` output runs the shards
normally.

In the template, the job-level shard `if` is evaluated before the matrix
expands. A successful plan with `skip=true` skips the whole matrix, and the
final `always()` job still runs because it directly needs both the plan and the
shards. It accepts `PLAN=success, SKIP=true, SHARDS=skipped`, or a successful
plan and successful shards. A failed, cancelled or skipped plan fails; a failed
or cancelled shard fails even with `SKIP=true`; and a skipped shard with an
empty or false skip fails. When the lookup finds no evidence, the plan succeeds
with `skip=false` and the original matrix runs. Base's separate macOS job also
depends on the plan and uses the shard condition.

A short-circuited main run has a successful plan or gate, grey **skipped**
shard jobs (GitHub shows "This check was skipped"), and a green final `verify`
check and workflow. GitHub treats conditionally skipped jobs as successful for
required checks. The duplicate main run is not a source of new test evidence.

After adopting, push twice quickly to one candidate branch: the first Verify
is cancelled and the second runs. Dispatch Verify on that branch: the push run
keeps running. Fast-forward main to the branch's green SHA: after runner
admission, only the light plan or gate and the aggregate execute, finishing in
seconds (queue time remains). An unverified main SHA, or one whose newest push
run failed, must run every shard.

For release adoption, update the installed CLI with `rer update --version
0.2.80` once that release exists; package-mode seeds update their exact pin with
`pnpm add -D -E @runeditrun/rer@0.2.80`. This checkout has **no bare `rer refresh`
command**, and an npm update alone does not copy seed-owned workflow files.
For files already tracked in `base-copies.json`, the supported source refresh is:

```sh
node scripts/edition-authoring/cli.mjs refresh-base <release-commit> --base <base-checkout>
```

Copy or merge the workflows and helper above in that same adoption commit,
preserving product adaptations and updating the existing copy and source-lock
records. New foundation compositions and standalone reference exports take
`export/verify.yml`, `export/verify-nightly.yml` and the maintained helper
copies automatically. The Base release owner ships these source templates with
the next rer release; this change does not bump, publish or release rer.

Official semantics: [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
[workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run),
[reusable workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusable-workflows),
[concurrency and pending replacement](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[skipped required jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions),
and [job dependency conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).
