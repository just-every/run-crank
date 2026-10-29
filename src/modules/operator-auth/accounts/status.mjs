import { auditMutation, operatorWitness } from './audit.mjs';
import { deny } from '../errors.mjs';
// One persistence door for session and policy actors. The caller authorizes the
// action; the actor fence repeats live authority in this atomic write/audit.
export async function writeOperatorStatus(store, actor, target, status, now, audit, adminAudit) {
  const fence = store.actorFence(actor, now);
  try {
    const statements = [[`UPDATE oa_operators SET status=? WHERE id=? AND version=? AND ${fence.sql} RETURNING id`, [status, target.id, target.version, ...fence.args]]];
    if (audit) statements.push([`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at)
      SELECT ?,?,?,?,? WHERE changes()>0`, [crypto.randomUUID(), audit.actor, audit.action, JSON.stringify(audit.value), now]]);
    const [result] = await (adminAudit && target.status !== status ? auditMutation(store, { audit: adminAudit,
      event: { action: status === 'active' ? 'operators.reactivate' : 'operators.deactivate', actorId: actor.operator.id, subjectId: target.id, detail: status, now },
      before: { sql: `${fence.sql} AND EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND version=?)`, args: [...fence.args, target.id, target.version] },
      after: operatorWitness(target, 'status', status), statements,
    }) : store.batch(statements));
    if (!result.results.some(row => row.id === target.id)) deny('authority_changed', 409);
  } catch (error) {
    if (String(error).includes('last_owner')) deny('last_owner', 409);
    if (String(error).includes('invitation_required')) deny('invitation_required', 409);
    throw error;
  }
  return store.operator(target.id);
}
