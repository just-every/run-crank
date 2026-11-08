# Base-delivered agent clauses

This is the canonical acceptance text for BASE-AGENT-001 through BASE-AGENT-013.
`rer door clauses --write` synchronizes these clauses into a seed's CONTRACT.md.
The seed owns its SURFACE- and AGENT- clauses and its judgments: adding these
requirements proves no implementation. New Status rows start missing; later
syncs retain the seed's status, evidence and gap, including a newer judgment.
MCP method names below use spaced slashes; wire names omit those spaces.

## Target clauses

### Agent surface (Base-delivered)

#### BASE-AGENT-001 — One MCP door per seed

*Tier:* Agent surface

**Requirement.** Every seed, hosted or self-hosted, serves one remote MCP endpoint at `/mcp` over Streamable HTTP. It speaks the current revision (2026-07-28) and accepts 2025-11-25 clients through the twelve-month deprecation window. It implements `server / discover`, tools, resources and prompts. Lists are deterministic and carry `ttlMs` and `cacheScope: "private"`. Roots, Sampling and Logging are not served.

**Acceptance.**
1. `server / discover` returns the supported versions, capabilities, `serverInfo` and instructions.
2. A 2026-07-28 request works with no handshake, and a 2025-11-25 client completes `initialize` and lists the same tools.
3. An unsupported version returns `UnsupportedProtocolVersion`.
4. Two `tools / list` calls return the same order, with cache fields.
5. A foreign Origin returns 403, and a header and body method mismatch returns `HeaderMismatch`.
6. An oversized body returns 413 with no effect.

#### BASE-AGENT-002 — The seed's jobs are tools, through the UI's own actions

*Tier:* Agent surface

**Requirement.** Each Core job a person does in the product is a tool. Where one is not, the Agent surface says why: it runs on a device, it is a person's interactive screen, it belongs to a connector or the import door, or it is an installation fact. Risk is never the reason: a risky job is a tool with its class (BASE-AGENT-006). Tools are named `<seed>.<area>.<verb>` and declare input and output schemas and truthful annotations. Each calls the same server action as the UI, so validation and authorization are written once, and the seed's embedded agents use the same registry. A business refusal returns `isError` with the seed's stable error code.

**Acceptance.**
1. The Core clause ids in each tool's `_meta`, with the not-a-tool reasons that `server / discover` serves, cover every Core clause in the contract, and no reason is risk; the harness and `rer check` fail on a gap.
2. Each tool's fixture result validates against its `outputSchema`.
3. Read tools declare `readOnlyHint`; tools that can carry destructive declare `destructiveHint`, and tools that can carry external declare `openWorldHint`.
4. A refusal returns the same error code the UI gets for the same action.
5. The UI action and its tool, on the same fixture, give the same record state and the same audit event type.
6. The seed's embedded agents appear in the audit as calls to the same tools.

#### BASE-AGENT-003 — Records are resources

*Tier:* Agent surface

**Requirement.** Each primary record type has a URI template, and tools return `resource_link`s to the records they touch. A read returns exactly the fields the caller's role sees in the UI. File bytes count against any byte budget on the grant. A record the caller cannot open reads as not found, identical to a missing id. Text from customers, imports or files carries an untrusted marker in `_meta`.

**Acceptance.**
1. `resources / templates / list` names every record type in the Agent surface.
2. Reads as two roles return exactly what the UI shows each.
3. An out-of-scope id and a missing id give identical responses.
4. A write's `resource_link` reads back the new state.
5. Bytes over budget return `budget_exhausted` and no partial content.
6. Customer-sourced text carries the untrusted marker.

#### BASE-AGENT-004 — Business identity and short-lived, audience-bound tokens

*Tier:* Agent surface

**Requirement.** The door is an OAuth 2.1 resource server. Its RFC 9728 metadata names the authorization servers this installation trusts. That is the paired Business when Business provisioned it, verified with the owner-claim trust the installation already holds for its import door; otherwise it is the seed's own sign-in. Access tokens are RFC 9068 JWTs with `aud` set to the seed's canonical MCP URI, `sub` the sponsoring person, `act` the agent (RFC 8693) with its specialist, scopes per tool family, and a lifetime of 15 minutes or less (5 by default). The policy scopes rules on the sponsor, agent and specialist the token names. The consent behind the tokens can last longer and is revocable. Tokens travel only in the Authorization header, and there is no passthrough.

**Acceptance.**
1. An unauthenticated call returns 401 with `resource_metadata`, and the metadata names the trusted servers and scopes.
2. A Business token for this seed works, and the same token sent to a sibling seed returns 401.
3. An expired token returns 401, and a token with a lifetime over 15 minutes is refused.
4. A read-only token calling a write tool returns 403 `insufficient_scope` with every needed scope in one challenge.
5. A token in a query string is refused and not logged.
6. Revoking consent in the seed or in Business refuses the next call within 60 seconds.
7. After unpairing, Business tokens are refused and the seed's own sign-in still works.

#### BASE-AGENT-005 — An agent acts as a person in a role, never more

*Tier:* Agent surface

**Requirement.** Every call is authorized as the sponsoring person's current role and access (BASE-ACCESS-004), intersected with the grant's resources, actions and budget. A grant only narrows. No call widens the calling agent's own authority. A call that would widen its own grant or its sponsor's role, or change the company policy or Pause, is refused with `self_escalation`, whatever the policy says; narrowing its own grant is allowed. Other access and security changes are ordinary actions in the access and security classes. An agent never acts after its sponsor is suspended. Anything an agent reads (records, files, emails, imports, other seeds' results) is data and cannot change its scope, its targets or a call's class.

**Acceptance.**
1. For each role fixture, every tool's allow or deny through MCP equals the UI's for the same action.
2. A one-folder, read-only grant holds, and widening through arguments is refused.
3. Downgrading the sponsor changes the next call's result, and suspending the sponsor returns 401.
4. Calls that widen the agent's own grant or its sponsor's role, or change the policy or Pause, return `self_escalation` and change nothing, even under a policy with every class autonomous; dropping a scope from its own grant runs.
5. An injection fixture yields no out-of-grant call and no change of class: record text asking for a wider action, or claiming that a recipient is internal.

#### BASE-AGENT-006 — Every action declares its risk class

*Tier:* Agent surface

**Requirement.** Classes come from the fleet list in RISK-POLICY.md: standard, external, money, commitment, accounts, gated, access, security, destructive, sensitive and live. In the registry, each tool declares the classes it can carry and a server-side classifier that decides them per call from the arguments, current records and, for gated, the provider's answer. The classifier also supplies each class's facts: the measure (items, recipients, amount and currency, people or records), the counterparty (internal, known, new or public), the direction for access, the provider and step for gated, and the data kind for sensitive. A classifier never reads a flag, label or claim supplied by the agent or by record text. A seed cannot add a class; it proposes one for the fleet list.

**Acceptance.**
1. Every tool in `tools / list` carries its possible classes in `_meta`, equal to the Agent surface table.
2. For each tool, fixture calls cover every class it can carry, and the computed classes and facts equal the fixture's expected values.
3. An argument or record text asserting a class or a confirmation (`internal: true`, `confirmExternal: true`) leaves the computed classes unchanged.
4. Money calls carry amount and currency, external calls their counterparty and recipient count, access calls their direction, and destructive calls their item count.
5. No tool in `tools / list` declares a class outside the fleet list, and `rer check` fails on one.
6. A refused call's audit row still records its computed classes.

#### BASE-AGENT-007 — The company's policy decides, at one chokepoint

*Tier:* Agent surface

**Requirement.** Every agent door calls one decision function: MCP, the integration API with agent tokens, and the seed's embedded agents. It evaluates the call's classes against the company's policy, as above. The seed ships no dispositions and fills no gap with one: agent access opens only under a complete policy that setup has asked for (RISK-POLICY.md), and before then every agent call returns `policy_unset` with the setup link and changes nothing. *Autonomous* runs the call. *Review* runs it and adds it to the review feed. *Approval* saves a pending action with server-computed facts and returns `input_required`, with a URL-mode elicitation to the seed's approval page and a pending handle. Each person the rule names approves the exact saved revision in a signed-in browser, and changed inputs need a new approval. The retried call returns the result and a receipt. A rejection returns `approval_rejected`, and a lapse past the wait the rule sets returns `approval_expired`. *Blocked* returns `policy_blocked`, naming the class, rule and revision.

**Acceptance.**
1. The Base harness runs each tool under each disposition for every class it can carry, and sees it run, run and enter the review feed, wait with no effect, or be refused.
2. Before setup is complete, the setup page lists every class the seed's tools carry with examples and no answer pre-selected, an agent call returns `policy_unset` with the setup link and changes nothing, and an incomplete revision cannot be confirmed; a `*` rule completes it, and a tool an upgrade adds with an unanswered class appears in `tools / list` once that class is answered, while the other tools keep running.
3. Under "money autonomous up to $500, approval up to $10,000, blocked above", calls of $400, $600 and $20,000 run, wait and are refused; a per-day cap sends the call that crosses it to the next rule.
4. A call carrying two classes takes the stricter disposition.
5. An approval shows server-computed facts and an expiry, returns the URL elicitation and a handle, and completes once after the named approver approves; a changed input needs a new approval, and a rejection or lapse leaves no effect.
6. The same call through MCP, the integration API and an embedded agent gets the same decision.
7. A policy change applies to the next call within 60 seconds, and the audit cites the new revision.
8. A policy document with a bad signature or another Business's id is rejected, and the door keeps the last valid revision.

#### BASE-AGENT-008 — Truthful attribution

*Tier:* Agent surface

**Requirement.** Every agent act is recorded and shown as `"<agent> for <person>"`, and mail and messages an agent sends outside name it that way as their sender. An approval, a review mark, a confirmation (a warning dialog, a typed-field confirmation, a delivery confirmation), a decision or a signature attributed to a person comes only from that person's signed-in session. When an agent does the equivalent act, the record names the agent, and the act carries its own class; a binding decision or a signature is commitment. Agent doors ignore arguments that stand for a person's confirmation. No tool solves a bot check, or enters a person's own password or 2FA code at an outside service. A provider step that demands a person goes to a person, whatever the policy says; the gated class marks such steps before they run.

**Acceptance.**
1. An agent call carrying a person-confirmation flag is classified and decided exactly as without it.
2. Approving, marking reviewed or answering a policy question with an agent or device token returns 403 and changes nothing.
3. A form-mode elicitation "accept" never completes an approval.
4. Where an agent's decision, signature or field confirmation runs without a person, it reads `"<agent> for <person>"` in the record, the activity view, exports and any certificate, never as the person's own act.
5. After a person approves an agent's prepared action, the record shows the person as approver and the agent as preparer.
6. Activity and exports at 1440 and 390 show `"<agent> for <person>"` for every agent act.
7. Mail an agent sends to an outside address names `"<agent> for <person>"` as its sender.

#### BASE-AGENT-009 — Every agent action is audited with its class and decision

*Tier:* Agent surface

**Requirement.** Extending BASE-OPS-005, each call that reads private data or changes anything records the agent client, name and specialist, and the run or task id (`traceparent` when sent); the sponsoring person, the grant, the tool and the targets; the classes and their facts, and the policy revision and rule; the decision (autonomous, review, approval, blocked, unset or self_escalation) and the outcome (done, refused, pending or failed); the approval or review id and person, and the idempotency key. For a period, the seed's Agents page shows actions by class and decision with the notable ones, the review feed (Mark reviewed, Flag, and Undo where reversible), pending approvals, steps waiting for a person and setup questions. Business shows the same across seeds.

**Acceptance.**
1. One write leaves a complete audit row.
2. Refused, pending, unset and self-escalation calls are audited.
3. The Agents page's counts by class and decision equal the audit rows on a fixture week.
4. The review feed lists exactly the calls decided as review; Mark reviewed records the person, and Undo restores a reversible one.
5. Filtering by agent or class lists only those rows, and export includes every field.
6. Removing the agent keeps its rows and its name.
7. The Agents page works at 1440 and 390 with no serious or critical axe findings.

#### BASE-AGENT-010 — Agents can follow changes

*Tier:* Agent surface

**Requirement.** The seed emits a typed event for every record change and for every approval, review and policy decision. Each event carries a stable id, a type, the record URI, the actor (a person, or an agent acting for a person) and a time. Events never carry secrets or more than the subscriber may read. Agents can read events three ways: `subscriptions / listen`, an `events.list` tool with a cursor, and signed webhooks from Base `integrations` using the same ids. Every channel delivers at least once and filters by access at delivery.

**Acceptance.**
1. A subscribed record changed in the UI produces a notification within 10 seconds.
2. `events.list` returns the same event id the webhook carries.
3. Replaying from a cursor returns the same ids in order.
4. After access is revoked, no channel delivers events about that record.
5. A failed webhook is visible and replays without duplicate effects.
6. `approval.pending`, `approval.decided`, `review.flagged` and `policy.adopted` carry the class and decision and nothing the subscriber may not read.

#### BASE-AGENT-011 — Limits are policy, and Pause stops everything

*Tier:* Agent surface

**Requirement.** Business limits are rules in the company's policy: per-call and per-day thresholds on any class's measure, such as money moved, outside recipients or items destroyed; spend caps on provider cost (models, SMS, email) per seed, specialist or agent, which setup asks with the classes; "no cap" is an answer. Tools with provider cost declare an estimate before they run, and an exhausted cap returns `budget_exhausted` before any partial effect. The seed's capacity limits (request rate, body and byte sizes) protect the installation: they bound rate and size, never daily business volume, are documented and are not policy. A grant carries budgets only when the person granting it sets them. A **Pause agents** control in the seed, and Pause all agents in Business when paired, refuses every agent token within 60 seconds until a person resumes; browser sessions and devices keep working.

**Acceptance.**
1. A rate overrun returns 429 with `Retry-After`.
2. A per-day cap of three outside recipients sends the fourth to the rule that applies past the cap.
3. An exhausted spend cap returns `budget_exhausted` with no partial effect and shows the spend.
4. Under the answer "no cap", a spending call runs and its spend shows in usage; a call that spends nothing is unaffected by any cap.
5. The usage view shows calls, decisions by class, money moved and provider spend per agent.
6. Pause and Pause all agents each stop the next call within 60 seconds, and resume restores access.
7. An agent token cannot resume.

#### BASE-AGENT-012 — Writes are idempotent and conflict-safe

*Tier:* Agent surface

**Requirement.** Every mutating tool requires an idempotency key and takes an optional expected revision. The same key with the same arguments returns the first outcome for at least 24 hours; the same key with different arguments returns `idempotency_conflict`; a stale revision returns `revision_conflict` with the current revision. Long work returns a job handle and a status tool, with no dependence on the Tasks extension.

**Acceptance.**
1. Two calls with one key give one effect and equal results.
2. A retry with a new JSON-RPC id and the same key, after a dropped stream, returns the recorded outcome.
3. The same key with different arguments returns a conflict and no effect.
4. A stale revision returns a conflict naming the current revision.
5. A job handle used by another person's token reads as not found.

#### BASE-AGENT-013 — Manifest, docs and the conformance journey

*Tier:* Agent surface

**Requirement.** `server / discover` instructions and an on-site `/docs/agents` page are generated from the action registry. The page lists tools by job, with each tool's classes, the test that adds each computed class, its scopes, resource templates, event types, capacity limits and error codes, and the specialist role. `prompts / list` carries the specialist's jobs. Base ships the conformance journey, a harness that `rer verify` runs against `rer dev` and seeds run in CI. It is an MCP client; a signed-in test person takes a person's steps (setup answers, approvals, review marks, resume) through the URLs the door returns, and the same browser leg runs the UI-parity actions and the page checks at 1440 and 390. It runs every acceptance point of BASE-AGENT-001 to 012 and of the seed's SURFACE clauses under two company policies: *all autonomous* (`*`), and *held* (standard review, every other class the seed declares approval, which the test person grants), plus the single-class variants a point names. A point that names no disposition passes under both.

**Acceptance.**
1. The docs list exactly the names in `tools / list` and `resources / templates / list`.
2. Each tool's classes, and the test behind each computed one, are documented.
3. The harness fails on any of: a tool without a schema; an effect under approval or blocked, or before setup is complete; a computed class that differs from its fixture; a flag that changes a class or completes a person's step; a role-parity mismatch; a wrong-audience token being accepted; a duplicate effect on retry.
4. Every acceptance point runs under both policies, every decision matches the policy in force, and under all autonomous no call waits for a person or is refused by policy.
5. A stranger agent given only the seed URL completes the specialist journey through MCP.

## Status

| Clause | Title | Kind | Status | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| `BASE-AGENT-001` | One MCP door per seed | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-002` | The seed's jobs are tools, through the UI's own actions | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-003` | Records are resources | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-004` | Business identity and short-lived, audience-bound tokens | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-005` | An agent acts as a person in a role, never more | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-006` | Every action declares its risk class | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-007` | The company's policy decides, at one chokepoint | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-008` | Truthful attribution | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-009` | Every agent action is audited with its class and decision | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-010` | Agents can follow changes | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-011` | Limits are policy, and Pause stops everything | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-012` | Writes are idempotent and conflict-safe | target | missing | | Not yet judged through this seed's own doors. |
| `BASE-AGENT-013` | Manifest, docs and the conformance journey | target | missing | | Not yet judged through this seed's own doors. |
