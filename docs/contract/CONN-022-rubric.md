# CONN-022 frozen rubric

Frozen by ct on 2026-11-04 under [RL-104](../../RULINGS.md#rl-104--additive-asana-pagination-and-task-permalink-split). This Core target extends CONN-014 and starts missing, with no implementation evidence.

| Rider | Required observable outcome |
| --- | --- |
| R1 — canonical permitted lookup | Through the Asana lookup door, supply `https://app.asana.com/1/<workspace>/task/<id>` for the connected workspace. It maps to the stable task URL and lookup returns that same task identity; accepting the URL without successful lookup is insufficient. |
| R2 — non-task/foreign-workspace refusal | Supply a non-task Asana URL and a canonical task URL whose workspace differs from the connected workspace. Both are refused without changing the selection, retained results or provider data. A task-shaped path alone grants no access to another workspace. |

The official [Tasks reference](https://developers.asana.com/reference/tasks) defines `permalink_url` and `workspace.gid` and gives `https://app.asana.com/1/12345/task/123456789` as a task-permalink example. The official [Get a task reference](https://developers.asana.com/reference/gettask) defines API lookup as `GET https://app.asana.com/api/1.0/tasks/{task_gid}`. The canonical web permalink, stable mapped task URL and API read must identify the same task; the API URL is not a replacement web permalink. Workspace matching is a Crank scope requirement.

The seed can prove both riders through its public door with an official-schema provider edge. URL parsing alone, a legacy URL alone or refusals without a permitted canonical lookup do not meet this rubric. No new tests or code are supplied by this contract-only pass.
