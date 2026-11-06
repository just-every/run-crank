# Exact-candidate Verify result

Head: d8623c31cf359634b9516a57754ede47e02fa8e8
Run: 42151249698
Event: push
URL: https://github.com/just-every/run-crank/actions/runs/42151249698
Actual conclusion: failure
READY classification: permitted generated-view exception

The sole originating failure is build job 127674942894, step "Build once and check the edition". Its output shows application build, site build, typecheck and first-party check succeeding, followed by:

```
> node src/base/contract-docs.mjs check
Error: ACCEPTANCE.md is stale; run node src/base/contract-docs.mjs write
Process completed with exit code 1.
```

The source-lock plan job 127674747304 succeeded. Job 127675251160 is the dependent verifier: it requires a successful build and shards, sees build failure and skipped shards, and exits 1. It reports no independent product assertion failure. The remaining jobs skip because the build did not complete.

Both failed-job archives were fetched once using the required gh run view command; each fetch exited 0. No direct blob download, rerun or workflow edit was attempted. The local stale-view check reproduces exactly and is recorded in generated-view-check.json. The generator write and check succeed before restoring both generated views from origin/main. Those files are deliberately absent from product commits. The guarded lander must regenerate them and enforce the resulting exact-SHA Verify, publication scan and Run site.

Actual log-fetch commands:

```
gh run view 42151249698 --repo just-every/run-crank --job 127674942894 --log-failed
gh run view 42151249698 --repo just-every/run-crank --job 127675251160 --log-failed
```

Workflow environment dumps are not part of the evidence selection.
