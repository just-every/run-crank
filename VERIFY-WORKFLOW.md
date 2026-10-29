# Crank verification

Crank adopts rer 0.2.86's verification lifecycle while keeping its own
`verification.json`: eight push partitions, every existing assertion, and the
separate `Long retry journey` workflow. The complementary connection filters
keep the regulated Gusto, managed Calendar and native Nook journeys together;
the other connection registrations stay in `connections`.

| Entry | Coverage |
| --- | --- |
| Branch push, pull request, Verify dispatch | Push shards, unless qualified reuse or light coverage applies |
| Monday and Thursday at 03:47 UTC | Nightly shards only |
| Release tag beginning with `v` | Every push and nightly shard, always |
| Nightly journeys dispatch | Every push and nightly shard |

The 03:47 schedule is Base's SHA-256 seed-name schedule rendered for `crank`.
Crank currently declares no nightly shards, so that scheduled selection is
empty and starts no build or shard jobs. Existing long manual and scheduled
journeys remain in `retry-backoff.yml`, including its Monday and Thursday
03:37 UTC schedule and manual selections.

All executing jobs use Ubuntu 24.04, Node 22.20.0 and pnpm 10.12.4 with frozen
installs. Push shards retain their 12-minute timeout and `app-comparisons` keeps
its existing 16-minute ceiling, including when invoked by Nightly journeys.
The latter permits 45 minutes for other full-tier shards. The final `verify`
aggregate is the stable required check.

## Shared build and assertions

The `build` array runs once: production Worker build, run-site build,
typecheck, first-party check, contract-document consistency and deployment-spec
check. The build stamps `dist/.ci-sha`; every Actions shard restores that run's
artifact and refuses a stamp that differs from its exact `GITHUB_SHA`.

Each shard keeps `npm ci --prefix gateways/node --ignore-scripts`.
`runtime-authority` still enters `rer verify`, retaining hosted-output and
hydration checks on the shared production output. Browser evidence is uploaded
per shard. Only `agent-executor` prepares bubblewrap and the Linux user-namespace
setting. No assertion or browser journey was moved out of its existing partition.

Inspect and run the actual manifest selections:

```sh
node scripts/verify-ci.mjs --matrix push
node scripts/verify-ci.mjs --matrix nightly
node scripts/verify-ci.mjs --matrix all
node scripts/verify-ci.mjs --build
node scripts/verify-ci.mjs NAME
```

Shard names are unique across both arrays. Each declares boolean `browser` and
`hosted` fields plus nonempty shell commands; exactly one push shard is hosted.
Unknown or malformed selections fail. Without `SEED_VERIFY_SHARD`, local
`rer verify` retains the build and every command in both arrays. Stop managed
servers before local verification as described in `RUN-LOCALLY.md`.

## Full, light and reused coverage

`node scripts/verify-ci.mjs --plan` emits the coverage, tier, selected readers
and matrix. Full branch push coverage emits `full-push-proof` only after the
shared build and every push shard succeed. Light runs, reused runs, tags, PRs
and subset dispatches cannot produce that push proof.

Reuse checks the numeric workflow ID, workflow name, repository ID and name,
exact commit SHA, newest eligible run and its latest attempt. Required jobs
must all succeed: plan, build, every selected shard, proof and aggregate. A
newer failed, cancelled or incomplete eligible run defeats older success.
Incomplete or unstable API listings and unavailable evidence select full work.

Another branch's full push can prove the exact SHA. A commit with one direct
parent can reuse that parent's full push proof only when their Git trees are
identical; no earlier ancestors are searched. Same-repository PRs wait briefly
for their head branch's push, and compare the head and tested merge-ref trees
before accepting proof. Forks, different merge trees and ambiguous identities
run fully.

Light coverage requires a verified direct parent and a complete local Git diff,
including both rename sides, limited to these inputs:

```text
sources.lock.json
CONTRACT.md
ACCEPTANCE.md
CLAIMS.md
docs/CLAIMS.md
HANDOVER.md
STATUS.md
evidence/**
.artifacts/**
```

Evidence formats are Markdown, text, PNG, JPEG and PDF. Code, configuration,
unknown formats, missing authoring prerequisites and unknown reader commands
select full coverage. The reviewed Crank reader table covers the existing
commands, including their connection filters, browser environment prefixes and
package-script entry points. Contract changes select the existing site reader;
generated contract documents retain their consistency check. Unknown tests do
not acquire an implicit exemption.

An edition can declare reviewed test dependencies in the manifest's `readers`
object. Each key is an existing test path and each value is an array of files
that test reads semantically. An empty array explicitly declares no dependency
on the allowed light inputs. Malformed or undeclared readers select full work.
The table cannot expand the allowed change paths or command forms.

Light jobs validate the edition source lock, typecheck, run the first-party
check, build the run site and execute selected existing readers. Chromium is
prepared when a selected reader requires it. Source locks are never rewritten
in CI. The aggregate rejects failed, cancelled or unauthorized skipped jobs;
empty nightly selections succeed without manufacturing nightly proof.

Source-lock checks use the installed pinned package after frozen dependency
installation, matching the tool that writes the lock. The retained authoring
copy is a sparse runtime closure; its unused vendored parser files and licenses
can differ from the complete package's tool identity. The complete installed
tool still checks every declared source and the full tool identity; CI does not
rewrite or relax the lock.

## Nightly proof and runner caches

Main's complete scheduled or manual nightly coverage can save
`nightly-green-<full-sha>` only when nightly shards exist and all selected work
succeeds. Branches, PRs, empty selections and reused coverage cannot create it.
The marker lookup is a hint: reuse still requires the newest eligible main run's
successful latest attempt, all nightly shards, build, proof and aggregate.
Release tags bypass reuse and always run all coverage.

The pnpm store, Chromium cache and apt archives live under runner temp. Browser
and apt directories are created as the runner before cache restore or sudo.
Browser jobs install Chromium, launch and close it, then invoke the pinned
bounded system-dependency helper only if launch fails. Permission errors fail
explicitly without apt repair. Disk reclaim for native browser journeys stops
once 20 GiB is free and checks before each deletion.

Main concurrency groups contain their run IDs. Superseded runs on other refs
are cancelled; distinct event types keep push, PR and dispatch producers apart.

## Maintain the adopted files

Crank owns its merged workflows and adaptations. Refresh their recorded Base
origins with the installed edition-authoring tool, preserving the manifest's
assertions, shared-build guard, gateway install and executor preparation.
Deliver `verify-ci.mjs`, `verify-app.mjs`, `verify-plan.mjs`,
`verify-evidence.mjs`, `verify-light.mjs` and `install-chromium-deps.py` together
from the pinned revision, retaining reviewed edition adaptations.

Run actionlint on both Verify workflows and
`node scripts/verify-ci.mjs --check-workflows`. The job calling reusable Verify
must grant `contents: read` and `actions: read`; actionlint alone does not check
that permission ceiling.

Before committing, stage new files, inspect
`node node_modules/@runeditrun/rer/edition-authoring/cli.mjs changes`, regenerate
with `node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock`, and run
`node node_modules/@runeditrun/rer/edition-authoring/cli.mjs check`. Never edit
lock hashes manually.
