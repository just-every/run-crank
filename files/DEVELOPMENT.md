# Development checks and corrections

The original BASE-003 DATA-001 journey passed unchanged after first wiring the shared replay provider.

The added migration scenario initially passed the additive restore and inventory/default checks, then its full-database snapshot attempted to read Cloudflare's protected _cf_METADATA table. D1 returned SQLITE_AUTH. The snapshot now excludes only protected _cf_ runtime internals, retaining every readable application, authority, audit and transfer table plus their SQL definitions.

A subsequent run exposed an incorrect expectation in the new fixture: the existing shared importer returns 409, rather than 400, for a newer migration absent from the destination. The new scenario now strictly expects 409 for that case and 400 for a non-additive column change, and requires schema_mismatch plus exact before/after database equality in both cases. Existing assertions were unchanged.

A manual check of the two existing standalone source bundles found that their dependency closure could not resolve a virtual module. The integration now uses an ordinary typed source placeholder, replaced with replay data by the Worker build plugins. Both standalone registry/documentation bundle probes pass unchanged. An intermediate test run that had loaded the earlier resolver before the files changed failed closed on its later dynamically rebuilt fixture. Final verification runs use the stable final module path.

Replay generation was measured at about one minute for a cold bundle. A content-addressed ignored cache avoids repeating identical replay generation in each test process. The final build and focused restore proof run on pinned Node 22.20.0; the final full touched-file rerun passed all 18 tests with zero failures, skips or cancellations. No publication scan was run.

The final replay provider also retains the shared rowImages contract for migration-seeded destination defaults. The additive fixture seeds one synthetic record using its column default and verifies that exact initial state alongside the restored records. This avoids treating a freshly migrated destination as occupied.
