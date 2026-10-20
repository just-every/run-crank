import { guardedBatch, requireOwner } from '../access'
import { interruptedWrites } from '../engine/interruption'
import { validateGraph } from '../engine/graph'
import { auditStatement, auditStatementWhen } from '../ops/audit'
import { digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { type GrantRow } from './authority'
import { validateGrantPolicy } from './policy'

const columns = 'id,label,workflow_id,version_id,owner_id,owner_version,session_kind,policy_json,expires_at,revoked_at,created_at'
function present(row: Omit<GrantRow, 'token_hash'>) {
  const { policy_json, ...fields } = row
  return { ...fields, policy: JSON.parse(policy_json) }
}

export async function readGrants(env: CrankEnv, actor: Actor) {
  requireOwner(actor)
  return (await stmt(env, `SELECT ${columns} FROM crank_grants ORDER BY created_at DESC,id`).all<GrantRow>()).results.map(present)
}

/** The credential is returned once, and only its SHA-256 digest is retained. */
export async function issueGrant(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const workflowId = text(input.workflow_id, 'workflow_id'), versionId = text(input.version_id, 'version_id')
  const version = await stmt(env, `SELECT v.graph_json FROM crank_workflow_versions v JOIN crank_workflows w ON w.id=v.workflow_id
    WHERE v.id=? AND w.id=? AND w.owner_id=? AND w.status='published' AND w.published_version_id=v.id AND v.retired_at IS NULL AND v.mode='production'`, versionId, workflowId, actor.id).first<{ graph_json: string }>()
  requireValue(version, 'The grant must bind the current published workflow version', 409)
  const { graph } = validateGraph(JSON.parse(version.graph_json)), policy = await validateGrantPolicy(env, graph, input.policy)
  const expires = typeof input.expires_at === 'string' && input.expires_at.includes('T') && input.expires_at.endsWith('Z') ? Date.parse(input.expires_at) : NaN
  requireValue(Number.isFinite(expires) && expires > Date.now(), 'expires_at must be a future ISO timestamp')
  const expiresAt = new Date(expires).toISOString(), grantId = id(), at = now(), label = text(input.label, 'label')
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const credential = 'crg_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const result = await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_grants(id,label,workflow_id,version_id,token_hash,owner_id,owner_version,session_kind,policy_json,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id
        WHERE w.id=? AND v.id=? AND w.owner_id=? AND w.status='published' AND v.retired_at IS NULL AND v.mode='production')`,
      grantId, label, workflowId, versionId, await digest(credential), actor.id, actor.version, actor.kind, JSON.stringify(policy), expiresAt, at, workflowId, versionId, actor.id),
    auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_grants WHERE id=?)', [grantId], actor.id, 'grant.create', 'grant', grantId, { workflow_id: workflowId, version_id: versionId }, versionId),
  ])
  requireValue(result[0].meta.changes === 1, 'The publication changed before the grant was saved', 409)
  return { ...present((await stmt(env, `SELECT ${columns} FROM crank_grants WHERE id=?`, grantId).first<GrantRow>())!), credential }
}

/** Revocation fences leases and keeps already-started writes explicitly uncertain. */
export async function revokeGrant(env: CrankEnv, actor: Actor, grantId: string) {
  requireOwner(actor)
  const grant = await stmt(env, `SELECT ${columns} FROM crank_grants WHERE id=?`, grantId).first<GrantRow>()
  requireValue(grant, 'Grant not found', 404)
  const at = now(), active = "SELECT id FROM crank_wf_runs WHERE grant_id=? AND status IN ('queued','running','waiting','awaiting_approval','paused')"
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', at, grantId),
    interruptedWrites(env, active, [grantId], 'Execution grant revoked during a remote write; reconcile the destination before replaying', at),
    stmt(env, `UPDATE crank_wf_attempts SET finished_at=?,error_category='uncertain' WHERE finished_at IS NULL AND run_id IN (${active}) AND method NOT IN ('GET','HEAD')`, at, grantId),
    stmt(env, `UPDATE crank_wf_runs SET status='paused',lease_id=NULL,lease_expires_at=NULL,error_json=? WHERE id IN (${active})`,
      JSON.stringify({ category: 'authority', message: 'Execution grant revoked; no further dispatch is authorized', grant_id: grantId }), grantId),
    auditStatement(env, actor.id, 'grant.revoke', 'grant', grantId, {}, grant.version_id),
  ])
  return present({ ...grant, revoked_at: grant.revoked_at ?? at })
}
