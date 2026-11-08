# Plan — sx-crank-f86fix1

Scope: fix only BLOCKING B for BASE-AGENT-012 / DATA-001: restoring a current-main export on the f86 resolver. No acceptance status edits, generated views, publication scan, UI changes, Base refresh or release.

1. Initialize fleet credentials, identity and hooks; clone full history and start at f86 6f6dcc7defff54a5111ca851f9fdfe621090a051.
2. Export a synthetic installation through current main public HTTP API; demonstrate its restore succeeds on main and fails on unchanged f86. Retain exact archive hash and public-door receipts.
3. Preserve installation-local agent authority exclusions. Normalize only the five formerly portable agent tables out of an already verified archive, recomputing checksums while leaving all other content, journals, schema objects and strict destination validation intact. No browser migration replay.
4. Fold exactly this compatibility behaviour into the existing restore journey, preserving every assertion and registration count. Run touched restore and agent recovery checks plus typecheck.
5. Merge latest main before publication, retaining its newer tests and contract judgments. Regenerate source lock last, check it, commit with fleet identity/hooks, inspect every candidate identity/trailer and push the named branch through cloud-push.py.
6. Observe exact-SHA Verify within ten GitHub calls and at least 300 seconds between polls. Save full non-secret report and actual receipts, publish explicit evidence packet to evidence/sx-crank-f86fix1, and relay the required lane POST and final custody line.
