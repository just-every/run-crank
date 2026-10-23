# Owner-approved scheduled policies

Design · 19 October 2026

A seed declares trusted server-side definitions through OA `createOperatorAuth`'s
`scheduledPolicies: () => definitions` option. Only trusted Worker code calls
`run`; there is no HTTP run endpoint or caller-supplied actor granting scheduled
authority. Native-account adapters need an equivalent transaction fence before
adopting this door.

## Definition and approval

A definition contains an id, job kind, JSON parameters, allowed actions/scopes,
and two required integer bounds: `maxActionsPerRun` (1–100) and
`minIntervalMinutes` (1–525600). Supported actions are `operators:deactivate`
and `operators:reactivate`. Scopes require non-owner roles and may restrict exact
operator ids or require inactivity for `inactiveDays`. Owners and invitations
cannot be targets.

Inactivity uses `oa_operators.last_signin_at`, retained when sessions are deleted.
An insert trigger advances it when an OA session is created. For new accounts
that have never signed in, account creation is used; both the account creation
and sign-in cutoffs must pass. This measures sign-in, not activity in the seed's
domain. Legacy accounts receive a conservative timestamp at migration time,
retaining any later known sign-in, so missing historical sessions never establish
immediate inactivity.

Canonical JSON sorts object keys, preserves array order and rejects non-JSON
values. The definition is snapshotted once; validation, action grants and SHA-256
all use that same snapshot, including both bounds. The owner
reviews that exact hash; approval rereads the definition and rejects stale hashes.
Approval stores the definition, actions, hash, owner id/authority version, session
kind, approval time and revocation details. Reapproval atomically revokes its
predecessor. When the runner first observes a changed definition, it revokes the
old approval with `superseded_by_change`; reverting the source cannot revive it.

Standing approval requires a native, OIDC or password owner session and the
existing `requireFreshProof` check, as well as origin/session transaction fences.
Development and review sessions are refused outright: cron cannot repeat their
request gate. The seed's `rolePolicy` must allow every declared action at approval.
Approval survives sign-out and session expiry; it is an explicit delegation.
Owner authority-version changes invalidate it, including demotion then promotion.

## Scheduled authority and bounds

A scheduled handler calls `auth.scheduledPolicies.run(policyId, async run => {
await run.execute('operators:deactivate', operatorId) })`. The callback receives a
bounded capability, never a simulated owner session. The door rereads the current
definition and live approval at admission and before each action. Before acting,
it evaluates the seed's current `rolePolicy` with the approving owner and target.

An internal policy actor selects an unforgeable store fence. The status mutation
and committed-action audit share a D1 transaction that rechecks approval
id/hash/actions, revocation, accepted approval session kind, active owner role and
authority version, admitted live run, action count and target scope. Sequential
capability use and the transaction count enforce `maxActionsPerRun`; the reference
selector also limits its candidates to that bound. Stale or overbroad selection
does not widen the approved scope. Closed run capabilities cannot act again.
Revocation stops subsequent writes at the transaction boundary; committed actions
remain committed. Existing final-owner and invitation/version triggers still apply.

Admission is serialized per policy: another admitted run cannot overlap, and the
minimum interval starts at the last admitted run's finish, including failed or
refused admitted runs. An admitted run still running beyond Cloudflare's
[15-minute scheduled-handler limit](https://developers.cloudflare.com/workers/platform/limits/#duration)
is atomically marked failed with `policy_expired` and a `policy:expired` audit
bound to its original run id. Its minimum interval is measured from admission,
so recovery cannot exceed the approved tick frequency; live runs still block
overlap. Expired capabilities cannot write or overwrite the expiry outcome.
Early ticks are refused with `policy_interval`. Consecutive
identical unadmitted refusals for the same policy/version/approval/outcome coalesce
into one history row with `repeats` occurrences and `lastSeenAt`. Admitted runs
retain separate rows and action history.

Runs record outcome, timestamps and refusal/error codes. Action audits bind
`policy:<id>@<sha256>`, approving owner, approval id, unique run id, action and
target. Refused target attempts also record the attempted action and error code.
Other auth audit values may be opaque identifiers; policy queries and the run index only extract run ids from valid JSON. Partial failures retain earlier committed-action audits. The reference handler
attempts every policy despite prior failures, and attempts recording, policies
and pending erasures independently. Durable policy `AuthError` refusals remain
recorded; unexpected failures aggregate only after the jobs have been attempted.
Storage failures can prevent durable history and are surfaced as failures.

Worker code and the raw DB binding remain trusted. These fences bound authority
through operator-auth; they do not restrict arbitrary SQL in a compromised seed.
Version a job kind when changing its semantics and put all security-relevant
bounds in the hashed definition and enforcing implementation.

## Adoption, history and portability

For a deployment that applied the original scheduled-policy schema, apply
`scheduled-policy-hardening.sql` and `last-signin.sql` as new numbered migrations.
When first adding policies to an older OA store, apply the current
`accounts/schema/scheduled-policy.sql` instead of the hardening migration, plus
`last-signin.sql` if the sign-in column is absent. Preserve applied migration
history. Base upgrades its original `0029` with `0030` and `0031`. The hardening migration revokes existing approvals with
`fresh_approval_required`; owners must approve again with fresh proof. Apply the
last-sign-in migration after any `oa_sessions` rebuild so its trigger survives.
Fresh OA schemas include the current tables and trigger.

Declare definitions in trusted source, wire cron to `run`, select real candidates
and call `run.execute` for each. The default reference starts unapproved at
`/app/policies`. Its owner screen shows complete parameters/scopes, bounds, current
hash, approving owner/session kind, approval history and revocation reasons. Run
history exposes outcomes, tick occurrences, committed actions and refused targets,
including target ids, actor, approving owner, approval id, run id and timestamps.
Owners can navigate to older pages rather than losing history after a fixed cap.

Owner APIs are `GET /auth/policies`, `GET /auth/policy-runs`,
`POST /auth/policy/approve` with `{policyId, versionHash}`, and
`POST /auth/policy/revoke` with `{approvalId}`. `list` returns approval history and
each current definition's state. `runs` returns `{runs, nextCursor}` with up to 25
runs, newest first, including their action audits; pass `?before=<nextCursor>` for
the next page. Occurrences include the first tick. Retain `oa_policy_runs` and
`oa_auth_audit` for durable history.

Portable exports preserve approval provenance but revoke approvals in the export
snapshot, leaving the source installation unchanged. Import refuses an archive
containing any live policy approval. Restoring records does not transfer standing
authority; the destination owner must review and approve its current definitions.

```ts
const definitions = () => [{
  id: 'inactive-members', kind: 'deactivate-members-without-recent-signin.v1',
  parameters: { inactiveDays: 90 },
  maxActionsPerRun: 25, minIntervalMinutes: 10,
  actions: [{ action: 'operators:deactivate',
    scope: { roles: ['member'], inactiveDays: 90 } }],
}];
const auth = createOperatorAuth({ ...authOptions, scheduledPolicies: definitions });
// Inside Worker.scheduled; select real candidates within the declared run limit.
await auth.scheduledPolicies.run('inactive-members', async run => {
  for (const candidate of candidates) {
    await run.execute('operators:deactivate', candidate.id);
  }
});
```
