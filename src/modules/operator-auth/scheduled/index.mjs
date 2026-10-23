import { AuthError, deny } from '../errors.mjs';
import { requirePost } from '../http.mjs';
import { emailAllowed } from '../accounts/roles.mjs';
import { readPolicy, policyVersion } from './definition.mjs';
import { approvalFence } from './fence.mjs';
import { policyRunner } from './runner.mjs';
import { runHistory } from './history.mjs';
const approvalColumns = 'id,policy_id AS policyId,version_hash AS versionHash,owner_id AS ownerId,owner_version AS ownerVersion,approved_at AS approvedAt,revoked_at AS revokedAt,session_kind AS sessionKind,revoke_reason AS revokeReason';
export function scheduledPolicies({ definitions, store, config, clock, authenticate, requireFreshProof, rolePolicy }) {
  if (typeof definitions !== 'function') throw new AuthError('invalid_policy', 503);
  async function owner(request, mutation = false) {
    if (mutation) requirePost(request, config);
    const actor = await authenticate(request);
    if (!actor) deny('unauthenticated', 401);
    if (actor.operator.role !== 'owner') deny();
    return actor;
  }
  function ownerFence(actor, now) {
    const session = store.actorFence(actor, now);
    return { sql: `${session.sql} AND EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND role='owner')`, args: [...session.args, actor.operator.id] };
  }
  async function currentApproval(id) {
    return store.first(`SELECT ${approvalColumns},actions FROM oa_policy_approvals WHERE policy_id=? ORDER BY approved_at DESC,rowid DESC LIMIT 1`, [id]);
  }
  async function check(policy, approval) {
    if (!approval) deny('policy_approval_required', 403);
    const live = await store.first('SELECT revoked_at AS revokedAt FROM oa_policy_approvals WHERE id=?', [approval.id]);
    if (!live) deny('policy_approval_required', 403);
    if (live.revokedAt !== null) deny('policy_revoked', 403);
    if (!['native', 'oidc', 'password'].includes(approval.sessionKind)) deny('policy_session_denied', 403);
    if (approval.versionHash !== policy.versionHash || approval.actions !== policy.actionsJson) deny('policy_changed', 409);
    const fence = approvalFence(approval);
    if (!await store.first(`SELECT 1 AS valid WHERE ${fence.sql}`, fence.args)) deny('policy_owner_changed', 403);
    const approvingOwner = await store.operator(approval.ownerId);
    if (!emailAllowed(approvingOwner?.email, config.allowList)) deny('policy_owner_changed', 403);
    return approvingOwner;
  }
  return Object.freeze({
    async list(request) {
      const actor = await owner(request);
      const fence = ownerFence(actor, clock());
      const records = (await store.statement(`SELECT ${approvalColumns},actions FROM oa_policy_approvals WHERE ${fence.sql} ORDER BY approved_at DESC,rowid DESC`, fence.args).all()).results;
      const approvals = records.map(({ actions, ...approval }) => approval);
      const policies = await Promise.all(definitions().map(async input => {
        const policy = await policyVersion(input), approval = approvals.find(row => row.policyId === input.id) ?? null;
        let state = 'approval required';
        try { await check(policy, records.find(row => row.policyId === input.id)); state = 'approved'; } catch (error) { if (!(error instanceof AuthError)) throw error; state = error.code; }
        return { definition: policy.definition, versionHash: policy.versionHash, approval, state };
      }));
      return { policies, approvals };
    },
    async runs(request) {
      const actor = await owner(request), fence = ownerFence(actor, clock());
      return runHistory(store, request, fence);
    },
    async approve(request, { policyId, versionHash }) {
      const actor = await owner(request, true), policy = await readPolicy(definitions, policyId);
      if (!['native', 'oidc', 'password'].includes(actor.kind)) deny('policy_session_denied', 403);
      await requireFreshProof(actor);
      for (const grant of policy.definition.actions) if (!await rolePolicy({ actor: actor.operator, action: grant.action })) deny('policy_action_denied', 403);
      if (versionHash !== policy.versionHash) deny('policy_changed', 409);
      const id = crypto.randomUUID(), now = clock(), fence = ownerFence(actor, now);
      await store.batch([
        [`UPDATE oa_policy_approvals SET revoked_at=?,revoke_reason='superseded_by_approval' WHERE policy_id=? AND revoked_at IS NULL AND ${fence.sql}`, [now, policyId, ...fence.args]],
        [`INSERT INTO oa_policy_approvals(id,policy_id,version_hash,definition,actions,owner_id,owner_version,approved_at,session_kind)
          SELECT ?,?,?,?,?,?,?,?,? WHERE ${fence.sql}`, [id, policyId, policy.versionHash, policy.json, policy.actionsJson, actor.operator.id, actor.operator.version, now, actor.kind, ...fence.args]],
        [`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,?,'policy:approve',?,? WHERE EXISTS(SELECT 1 FROM oa_policy_approvals WHERE id=?)`, [crypto.randomUUID(), actor.operator.id, JSON.stringify({ approvalId: id, policyId, versionHash }), now, id]],
      ]);
      const approval = await store.first(`SELECT ${approvalColumns} FROM oa_policy_approvals WHERE id=?`, [id]);
      if (!approval) deny('authority_changed', 409);
      return approval;
    },
    async revoke(request, { approvalId }) {
      const actor = await owner(request, true), now = clock(), fence = ownerFence(actor, now);
      const [result] = await store.batch([
        [`UPDATE oa_policy_approvals SET revoked_at=COALESCE(revoked_at,?),revoke_reason=COALESCE(revoke_reason,'owner_revoked') WHERE id=? AND ${fence.sql} RETURNING id`, [now, approvalId, ...fence.args]],
        [`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,?,'policy:revoke',?,? WHERE changes()>0`, [crypto.randomUUID(), actor.operator.id, JSON.stringify({ approvalId }), now]],
      ]);
      if (!result.results.length) deny('authority_changed', 409);
    },
    run: policyRunner({ definitions, store, clock, currentApproval, check, rolePolicy }),
  });
}
