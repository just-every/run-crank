# Penny agent erasure adoption

`penny-map.ts` is the complete map used with Penny's scratch snapshot on
branch `refs/heads/cloud/sd-door-adopt-penny-1`. Its native subjects
are customer records, not operators; operator erasure and restore custody keep
their independent holds. `0106_agent_erasure_custody.sql` is additive after 0105.
Do not change applied migrations.

Copy this runtime and map into Penny's existing `base/modules/agent-door` tree.
Apply the migration and update Penny's schema inventory for the new agents
`tombstone` and calls `expires_at` columns. Use the matching portability runtime:
its mandatory bookkeeping exclusion removes aliases from every archive/export
and omits alias tables from restore, even with an explicit include policy.

Use the native erasure plan's selected row IDs plus `plan.literals` as a unique,
nonempty JSON array in `subject.values`. The map links native audit
`door_operation_id` to calls, audit, approvals, reviews, events and usage. Add
`agentErasureStatements` to `applyErasure`'s existing statement batch before
native deletes, with `{erasure_id: operation.id, at: operation.created_at}` and
the existing portability redaction checkpoint. Keep transfer invalidation once.
Replace only the customer-erasure blanket custody refusal after this wiring;
retain operator and restore holds. Native `data_state` guards fence captures.
Set `erasure.fenced` to refuse non-idle native data state at door admission.

## Secret propagation to existing runners

1. Reuse the installation's existing private `AUTH_SECRET` (configuration
   `authSecret`) for both `createAgentDoor({erasure:{secret,fenced}})` and the
   erasure statement builder. Never persist it in D1, work payloads or archives.
2. Pass it from the authenticated request's runtime to `runOperation`, then
   `operationStep` and `applyErasure`. The inline execution and Resume must use
   this same path. Missing or short secrets refuse before erasure writes.
3. In `advanceDataWork(bindings)`, read the same `AUTH_SECRET` binding and pass
   it through `operationStep` for every claimed step. Both the queue and Cron
   already call this runner, including work admitted before deployment. No
   secret is saved with a claim, so an already-running install acquires it
   from the new invocation's bindings after the runtime upgrade. Quiesce old
   invocations before upgrading; finish or safely stop claimed old work using
   the existing runner recovery procedure, then Resume with the new runtime.
4. Preserve that installation secret while any replay alias is live. Rotating
   it early loses alias lookup; do not rotate as part of this migration. Use
   the existing private settings/deployment binding lifecycle, never a new
   per-seed setting or replay-window override.

`REPLAY_WINDOW_MS` is the Base runtime's fixed 30-day completion window. Replay
and erasure never extend an existing `expires_at`. Call cleanup deletes its
aliases atomically; invoke `expireReplayCalls({options:{db},now:Date.now})` from
Penny's existing Cron as well as the built-in door admission cleanup. After
expiry the old key is a new request under current authorization. This map and
scratch proof do not promote Penny contract judgments or claim operator erasure.
