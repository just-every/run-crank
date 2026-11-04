# CONN-021 frozen rubric

Frozen by ct on 2026-11-04 under [RL-104](../../RULINGS.md#rl-104--additive-asana-pagination-and-task-permalink-split). This Core target extends CONN-014 and starts missing, with no implementation evidence.

| Rider | Required observable outcome |
| --- | --- |
| R1 — permitted relative continuation | Through the Asana read door, a permitted API-relative `next_page.path` retrieves page two and at least one later page within the existing bounds. The accepted results from all pages remain available under the same connected workspace and account. |
| R2 — bounded/off-host refusal | Exercise an off-host continuation and continuation that would exceed or evade the existing bounds. Each is refused before dispatch or application: no request follows the refused continuation, accepted results remain unchanged and no provider write occurs. A valid relative path never removes the bounds. |

Asana's [Pagination guide](https://developers.asana.com/docs/pagination) defines `next_page.path` as API-relative and supplies `/tasks?project=...&limit=...&offset=...` alongside a full `uri` under `https://app.asana.com/api/1.0`. Resolve the relative path against that API base, not the web origin root. Preserve the documented continuation query, connected scope and existing request, page and result bounds; this ruling grants no larger limits. `next_page: null` ends pagination. R1 must exercise the relative `path` itself, rather than proving only a full `uri` alternative.

The seed can prove both riders through its public door with an official-schema provider edge. A first-page-only result, an off-host request or an unapplied refusal without the permitted continuation does not meet this rubric. No new tests or code are supplied by this contract-only pass.
