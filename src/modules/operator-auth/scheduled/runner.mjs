import { AuthError, deny } from '../errors.mjs';
import { writeOperatorStatus } from '../accounts/status.mjs';
import { readPolicy } from './definition.mjs';
import { actionFence, bindPolicyActor } from './fence.mjs';
import { finishRun } from './history.mjs';
import { expireRuns } from './expiry.mjs';
// Expiry is reserved for the audited sweeper, never a callback result.
function runFailure(error) {
  return error instanceof AuthError && error.code !== 'policy_expired'
    ? { status: 'refused', code: error.code } : { status: 'failed', code: 'policy_failed' };
}
const actionStatuses = Object.freeze({ 'operators:deactivate': 'inactive', 'operators:reactivate': 'active' });

export function policyRunner({ definitions, store, clock, currentApproval, check, rolePolicy }) {
  return async function run(policyId, execute) {
    const id = crypto.randomUUID(), startedAt = clock();
    await store.run("INSERT INTO oa_policy_runs(id,policy_id,started_at,status) VALUES(?,?,?,'running')", [id, policyId, startedAt]);
    let open = true, approval, policy;
    async function verify(current) {
      try { return await check(current, approval); } catch (error) {
        if (error instanceof AuthError && error.code === 'policy_changed' && approval) {
          await store.batch([
            ["UPDATE oa_policy_approvals SET revoked_at=?,revoke_reason='superseded_by_change' WHERE id=? AND revoked_at IS NULL", [clock(), approval.id]],
            ["UPDATE oa_policy_runs SET status='refused',error='policy_changed',finished_at=? WHERE id=? AND status='running'", [clock(), id]],
          ]);
        }
        throw error;
      }
    }
    try {
      await expireRuns(store, policyId, startedAt);
      policy = await readPolicy(definitions, policyId); approval = await currentApproval(policyId);
      await store.run('UPDATE oa_policy_runs SET version_hash=?,approval_id=?,approved_by=? WHERE id=?', [policy.versionHash, approval?.id ?? null, approval?.ownerId ?? null, id]);
      await verify(policy);
      const admission = await store.first(`UPDATE oa_policy_runs SET admitted=1 WHERE id=? AND NOT EXISTS(
        SELECT 1 FROM oa_policy_runs prior WHERE policy_id=? AND id!=? AND admitted=1
        AND (status='running' OR COALESCE(CASE WHEN EXISTS(
          SELECT 1 FROM oa_auth_audit WHERE action='policy:expired'
          AND CASE WHEN json_valid(value) THEN json_extract(value,'$.runId') END=prior.id
        ) THEN started_at ELSE finished_at END,started_at)>?)) RETURNING id`,
      [id, policyId, id, startedAt - policy.definition.minIntervalMinutes * 60000]);
      if (!admission) deny('policy_interval', 429);
      let pending = null, actionError = null, committed = 0;
      const capability = Object.freeze({ id, actor: `policy:${policyId}@${policy.versionHash}`, async execute(action, operatorId) {
        if (!open || pending) deny('policy_run_closed', 409);
        const operation = (async () => {
          const current = await readPolicy(definitions, policyId), owner = await verify(current);
          if (!Object.hasOwn(actionStatuses, action) || !current.definition.actions.some(grant => grant.action === action)) deny('policy_action_denied', 403);
          if (committed >= current.definition.maxActionsPerRun) deny('policy_action_limit', 429);
          const target = await store.operator(operatorId);
          if (!target) deny('operator_not_found', 404);
          if (!await rolePolicy({ actor: owner, action, target })) deny('policy_action_denied', 403);
          const actor = Object.freeze({});
          bindPolicyActor(actor, () => actionFence(approval, id, action, target, clock(), current.definition.maxActionsPerRun));
          const result = await writeOperatorStatus(store, actor, target, actionStatuses[action], clock(), {
            actor: capability.actor, action, value: { policyId, versionHash: policy.versionHash, approvalId: approval.id, approvedBy: approval.ownerId, runId: id, operatorId },
          });
          committed++; return result;
        })();
        pending = operation;
        try { return await operation; } catch (error) {
          actionError = error;
          await store.run('INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) VALUES(?,?,?,?,?)', [crypto.randomUUID(), capability.actor, 'policy:refused', JSON.stringify({ policyId, versionHash: policy.versionHash, approvalId: approval.id, approvedBy: approval.ownerId, runId: id, operatorId, attemptedAction: action, error: runFailure(error).code }), clock()]);
          throw error;
        } finally { pending = null; }
      } });
      try { await execute(capability); } finally { open = false; if (pending) await pending; }
      if (actionError) throw actionError;
      await finishRun(store, id, null, clock());
      return { id };
    } catch (error) {
      await finishRun(store, id, runFailure(error), clock());
      throw error;
    } finally { open = false; }
  };
}
