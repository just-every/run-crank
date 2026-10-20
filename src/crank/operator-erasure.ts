import { guardedBatch } from './access'
import { requireValue, stmt, type Actor, type CrankEnv } from './model'
import { auditStatement } from './ops/audit'

/** Every Crank column that records which person acted or created something. */
const ATTRIBUTION: [table: string, column: string][] = [
  ['crank_skills', 'created_by'],
  ['crank_usage_workflow_estimates', 'quoted_by'], ['crank_usage_version_estimates', 'quoted_by'], ['crank_usage_budgets', 'updated_by'], ['crank_usage_allowances', 'created_by'],
  ['crank_audit', 'actor_id'], ['crank_approvals', 'actor_id'], ['crank_waits', 'decided_by'], ['crank_hold_items', 'decided_by'],
  ['crank_flows', 'created_by'], ['crank_runs', 'created_by'], ['crank_workflows', 'owner_id'], ['crank_workflows', 'created_by'],
  ['crank_workflow_versions', 'published_by'], ['crank_workflow_drafts', 'created_by'], ['crank_wf_runs', 'created_by'], ['crank_wf_step_revisions', 'created_by'],
  ['crank_tokens', 'created_by'], ['crank_hooks', 'created_by'], ['crank_connections', 'created_by'], ['crank_oauth_apps', 'updated_by'],
  ['crank_oauth_states', 'actor_id'], ['crank_obligations', 'verified_by'], ['crank_ops_events', 'actor_id'], ['crank_historical_batches', 'created_by'],
  ['crank_hold_cost_estimates', 'quoted_by'], ['crank_import_approvals', 'approved_by'], ['crank_settings', 'updated_by'],
]

/** DATA-002 operator erasure: a deactivated non-owner's id becomes one stable
 * random label everywhere Crank attributes work, their sessions are revoked, and
 * their email address and display name are removed. Chronology and actions stay. */
export async function eraseOperator(env: CrankEnv, actor: Actor, operatorId: string) {
  const person = await stmt(env, 'SELECT id,email,role,status FROM oa_operators WHERE id=?', operatorId).first<{ id: string; email: string; role: string; status: string }>()
  requireValue(person, 'Person not found.', 404)
  requireValue(person.role !== 'owner' && person.status === 'inactive', 'Deactivate this person (never the owner) before erasing them.', 409)
  requireValue(!person.email.endsWith('@removed.invalid'), 'This person has already been erased.', 409)
  const label = `erased-operator-${crypto.randomUUID()}`, guard = `erase-operator:${person.id}:${label}`, at = Date.now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND email=? AND role!='owner' AND status='inactive') THEN 1 ELSE 0 END`, guard, person.id, person.email),
    ...ATTRIBUTION.map(([table, column]) => stmt(env, `UPDATE ${table} SET ${column}=? WHERE ${column}=?`, label, person.id)),
    stmt(env, 'DELETE FROM crank_workflow_idempotency WHERE actor_id=?', person.id),
    stmt(env, "UPDATE crank_audit SET subject_id=? WHERE subject_kind='operator' AND subject_id=?", label, person.id),
    stmt(env, 'UPDATE oa_auth_audit SET actor_id=CASE WHEN actor_id=?1 THEN ?2 ELSE actor_id END,value=CASE WHEN value IN (?1,?3) THEN ?2 ELSE value END WHERE actor_id=?1 OR value IN (?1,?3)', person.id, label, person.email),
    stmt(env, 'UPDATE oa_sessions SET revoked_at=? WHERE operator_id=? AND revoked_at IS NULL', at, person.id),
    stmt(env, 'DELETE FROM oa_external_identities WHERE operator_id=?', person.id),
    stmt(env, "UPDATE oa_operators SET email=?,display_name='Removed person' WHERE id=?", `${label}@removed.invalid`, person.id),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    auditStatement(env, actor.id, 'operator.erase', 'operator', label),
  ])
  return { label, operator: label }
}
