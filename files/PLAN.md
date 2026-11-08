# Plan: sx-crank-restore-bridge-fix1

1. Start from full-history bridge head 0b8655204eeba01ba499becbfc727763a1e356de and preserve all existing assertions.
2. Extend the existing DATA-001 journey with one additive migration sorting between archived files; apply fixture migrations in order and capture the prefix-cache failure.
3. Replay the exact chosen set of destination-owned migration statements in isolated SQLite, matching the shared importer's ordered ledger comparison. Preserve statement/hash evidence and seeded-row images, and retain all importer validation.
4. Commit and immediately push the first real change with fleet identity, hooks and push guard.
5. Run the touched restore journey and typecheck. Merge current main, taking its contract, generated views and ID map whole. Validate document generation, restore generated views, regenerate the source lock last and check it.
6. Push the final candidate. Discover and watch exact-SHA Verify through REST within ten calls, with at most one call per run per 300 seconds. Run no cloud publication scan.
7. Publish complete non-secret reports and actual receipts only to the separate evidence ref. Report branch/SHA, CI IDs, unchanged clause judgments/counts and the lane POST line.
