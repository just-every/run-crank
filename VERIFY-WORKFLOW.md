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
selected shard succeed; a failed or cancelled shard cannot produce a green
aggregate.

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
