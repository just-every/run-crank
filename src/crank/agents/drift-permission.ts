import { guardedBatch, requireOwner } from '../access'
import { authorizeRequest } from '../connections/auth'
import { getConnection } from '../connections/store'
import { assertDispatchAuthority } from '../engine/authority'
import { boundedFetch } from '../engine/egress'
import { executeRun } from '../engine/executor'
import { getWfRun, loadRecords } from '../engine/records'
import { isObject } from '../engine/values'
import { canonical, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { runDetail } from '../workflows/runs'
import { driftIncident } from './drift-store'

/** A real safe read can establish restoration of the original permission. A
 * stored scope string, speculative write or successful unrelated URL cannot. */
export async function recheckDriftPermission(env: CrankEnv, actor: Actor, incidentId: string) {
  requireOwner(actor)
  const incident = await driftIncident(env, incidentId), run = await getWfRun(env, incident.run_id)
  requireValue(incident.kind === 'permission' && incident.state === 'open' && run?.status === 'paused'
    && run.mode === 'production' && run.version_id === incident.version_id && !run.lease_id,
  'Only the current paused permission incident can be rechecked', 409)
  const version = await stmt(env, 'SELECT graph_json,declared_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ graph_json: string; declared_json: string }>()
  const step = JSON.parse(version!.graph_json).steps.find((step: Record<string, unknown>) => step.id === incident.path)
  const checkpoint = (await loadRecords(env, run.id)).get(incident.path)
  const input = checkpoint?.input_json ? JSON.parse(checkpoint.input_json) : null
  const method = String(input?.method ?? 'GET').toUpperCase()
  requireValue(step?.type === 'http' && typeof step.connection_id === 'string' && checkpoint && ['waiting', 'failed'].includes(checkpoint.status)
    && isObject(input) && typeof input.url === 'string' && ['GET', 'HEAD'].includes(method),
  'Permission recovery requires the original failed HTTP GET or HEAD checkpoint; reconcile writes separately', 409)
  const binding = JSON.parse(version!.declared_json).bindings?.find((binding: { id: string }) => binding.id === step.connection_id)
  const connection = await getConnection(env, step.connection_id)
  requireValue(binding && connection.status === 'active' && canonical(JSON.parse(connection.scopes_json)) === canonical(binding.scopes),
    'Restore only the originally reviewed connection permissions before rechecking; new scopes require new consent', 409)
  await assertDispatchAuthority(env, run.id)
  const url = new URL(input.url), headers = new Headers({ accept: 'application/json' })
  await authorizeRequest(env, connection.id, url, headers, null)
  const response = await boundedFetch(url.href, { method, headers, timeoutMs: 15000, maxBytes: 1048576, follow: 0 })
  requireValue(response.status >= 200 && response.status < 300, 'The original provider read still refuses permission; writes remain held', 409)
  await assertDispatchAuthority(env, run.id)
  const guard = id(), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_drift_incidents WHERE id=? AND state='open')
      AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND version_id=? AND status='paused' AND lease_id IS NULL AND payload_expired_at IS NULL)
      AND EXISTS(SELECT 1 FROM crank_connections WHERE id=? AND status='active' AND scopes_json=? AND consented_at IS ? AND rotated_at IS ?)
      AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=?) THEN 1 ELSE 0 END`,
    guard, incidentId, run.id, incident.version_id, connection.id, connection.scopes_json, connection.consented_at, connection.rotated_at, run.workflow_id, incident.version_id),
    stmt(env, `INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
      SELECT run_id,path,COALESCE((SELECT MAX(revision) FROM crank_wf_step_revisions WHERE run_id=s.run_id AND path=s.path),0)+1,
      input_json,error_json,operation_key,input_json,operation_key,0,?,? FROM crank_wf_steps s WHERE run_id=? AND path=? AND status IN ('waiting','failed')`, actor.id, at, run.id, incident.path),
    stmt(env, "DELETE FROM crank_wf_steps WHERE run_id=? AND path=? AND status IN ('waiting','failed')", run.id, incident.path),
    stmt(env, "UPDATE crank_drift_incidents SET state='repaired' WHERE id=?", incidentId),
    stmt(env, "UPDATE crank_wf_runs SET status='queued',error_json=NULL,finished_at=NULL WHERE id=?", run.id),
    auditStatement(env, actor.id, 'drift.permission_readback', 'run', run.id,
      { incident_id: incidentId, path: incident.path, connection_id: connection.id, method, http_status: response.status, restored_original_scopes: true }, run.version_id),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  await executeRun(env, run.id)
  return { incident_id: incidentId, http_status: response.status, restored_original_scopes: true, run: await runDetail(env, actor, run.id) }
}
