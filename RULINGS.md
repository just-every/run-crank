# Crank contract rulings

### RL-104 — Additive Asana pagination and task-permalink split

- Date: 2026-11-04.
- Ruled by: ct, under the 4 November split scope ruling.
- Clauses: CONN-014, CONN-021 and CONN-022.

CONN-021 and CONN-022 are separate Core targets, both From new and missing with empty Evidence cells. They extend CONN-014; its acceptance, status, Evidence and Gap remain unchanged. No existing clause is rejudged, narrowed or promoted, and no homepage claim changes. RL-104 is above the existing RL-103 references; this additive pass leaves those references and earlier embedded rulings intact.

The frozen pagination rubric is [CONN-021-rubric.md](docs/contract/CONN-021-rubric.md): R1 permits API-relative continuation through page two and beyond within existing bounds; R2 refuses bounded-limit violations, unbounded continuation and off-host destinations before applying the refused continuation. The frozen permalink rubric is [CONN-022-rubric.md](docs/contract/CONN-022-rubric.md): R1 permits canonical same-workspace task lookup and stable URL mapping; R2 refuses non-task and foreign-workspace URLs without changes. Both capabilities can be proved by the seed and receive no field-proof exclusion.

Official Asana documentation checked on 2026-11-04:

- [Pagination](https://developers.asana.com/docs/pagination) defines `next_page`, `offset`, relative `path` and full `uri`. Its example uses `/tasks?...` relative to `https://app.asana.com/api/1.0`, rather than to the web origin root. The existing operation's bounds remain in force.
- [Tasks](https://developers.asana.com/reference/tasks) defines `permalink_url` and `workspace.gid`, and shows `https://app.asana.com/1/12345/task/123456789` as a task permalink.
- [Get a task](https://developers.asana.com/reference/gettask) specifies `GET https://app.asana.com/api/1.0/tasks/{task_gid}` for task lookup. The web permalink and API lookup URL serve distinct purposes; lookup must retain the same task identity and workspace scope.

These sources agree with the requested field and path spellings. The API-relative base is made explicit in the rubric; no acceptance outcome is cut or weakened. Workspace refusal and existing bounds are Crank requirements, not a claim that Asana documents Crank's policy.

The sx-crank-c-f55 carrier `167c3fa2` remains gated for its other obligations. This contract pass does not fix its `asana-policy.ts:48` or `asana-policy.ts:83` blockers, release the supported hold, submit a landing or establish implementation proof. The independent Opus review of these exact additive clauses remains required.
