# Exact-SHA CI result

Candidate: 60fb60c691440430e2c0bcd7f8aee3461e954edd
Verify: 42165704318, event push, completed with conclusion failure.
URL: https://github.com/just-every/run-crank/actions/runs/42165704318

Plan job 127721577552 succeeded, including the installed-tool source lock check. Build job 127721717098 failed solely at contract-docs check: “Error: ACCEPTANCE.md is stale; run node src/base/contract-docs.mjs write”. The verify aggregation job 127721998601 then failed its required-dependency guard. Remaining dependent jobs were skipped. Logs for both failed jobs were retrieved once through the requested gh run view archive command, both exit 0. No transport failure, rerun or dispatch occurred.

This is the brief's explicit generated-view exception: generated views were locally written and checked, then restored from origin/main before the product commit. The Mac lander regenerates them and requires its fresh exact-SHA Verify before landing. No generated views were committed to make this branch green. No successful CI conclusion is fabricated; this candidate is READY under that exception, with its platform proof, typecheck and other local touched gates passed.

Six counted GitHub invocations: one erroneous initial discovery request, corrected exact-SHA discovery, one status poll after 301 seconds, one jobs request, and one archive command for each of the two failed jobs. No further polls were needed. Publication scanning and Run site remain unperformed cloud-side and required at guarded landing.
