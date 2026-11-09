# sx-crank-flake-1 plan

Scope: just-every/run-crank, tests/** browser journeys/helpers and the generated source lock only. Product branch cloud/sx-crank-flake-1; no source, contract, generated acceptance views, release or deployment changes.

1. Configure fleet identity, launcher credentials, Git guard, commit hooks, pinned toolchain and full-history clone from main.
2. Inspect both reported failures and sweep tooltip assertions. Preserve delayed hover, immediate focus, hidden without interaction and actual visible hover behavior using the native CSS transition timeline rather than host wall-clock sleeps.
3. Correct the table disclosure assertion according to its actual cause. Opaque UUID substrings are permitted identity, and every other disclosure field must still omit the stored record value.
4. Save the first real change on the named cloud branch with [skip ci], after refreshing/checking sources.lock.json and validating commit identities/trailers.
5. Run Verify's touched browser entry points and pnpm run typecheck. Run inbound-email-browser.mjs and sample-browser.mjs ten consecutive times, including a browser-only 6x CPU-throttled pass (no machine stress).
6. Merge updated main if needed after the save, preserve published ancestry, regenerate the lock last and push a final candidate after touched checks pass.
7. Use one exact-SHA Verify watcher within ten GitHub calls, at least 300 seconds between polls. Record actual provenance, counts, limitations and receipts. Publish the explicitly selected non-secret packet only to evidence/sx-crank-flake-1; relay lane lines in the final response.
