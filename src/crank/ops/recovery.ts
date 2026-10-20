import { id, stmt, type CrankEnv } from '../model'
import { auditStatement, auditStatementWhen } from './audit'

// Audit entries are already portable, value-free and append-only. They carry no continuation authority.
const ACTIVE = `SELECT s.subject_id FROM crank_audit s WHERE s.action='operation.started'
 AND json_extract(s.detail_json,'$.deadline')<=? AND NOT EXISTS(SELECT 1 FROM crank_audit t WHERE t.subject_kind='operation' AND t.subject_id=s.subject_id AND t.action!='operation.started')`
export async function recoverOperations(env: CrankEnv, time = Date.now()) {
  const at = new Date(time).toISOString()
  await stmt(env, `INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,detail_json)
    SELECT 'interrupted:'||s.subject_id,?,'system:recovery','operation.interrupted','operation',s.subject_id,'{"result":"interrupted; inspect retained state before retrying"}'
    FROM crank_audit s WHERE s.subject_id IN (${ACTIVE}) ON CONFLICT(id) DO NOTHING`, at, at).run()
}
export async function operation<T>(env: CrankEnv, kind: string, work: () => Promise<T>, actor = 'system:cron'): Promise<T> {
  const job = id()
  await recoverOperations(env)
  await auditStatement(env, actor, 'operation.started', 'operation', job, { kind, deadline: new Date(Date.now() + 15 * 60000).toISOString() }).run()
  try {
    const result = await work()
    await auditStatementWhen(env, "NOT EXISTS(SELECT 1 FROM crank_audit WHERE subject_kind='operation' AND subject_id=? AND action!='operation.started')", [job], actor, 'operation.finished', 'operation', job, { kind }).run()
    return result
  } catch (error) {
    await auditStatementWhen(env, "NOT EXISTS(SELECT 1 FROM crank_audit WHERE subject_kind='operation' AND subject_id=? AND action!='operation.started')", [job], actor, 'operation.failed', 'operation', job, { kind, result: 'unconfirmed; inspect retained state before retrying' }).run()
    throw error
  }
}
export async function archiveTransfers(env: CrankEnv) {
  const exists = await stmt(env, "SELECT name FROM sqlite_master WHERE type='table' AND name='rer_portability_jobs'").first()
  return exists ? (await stmt(env, 'SELECT id,kind,phase,completed FROM rer_portability_jobs ORDER BY rowid DESC LIMIT 30').all<{ id: string; kind: string; phase: string; completed: number }>()).results : []
}
export async function recoveryReport(env: CrankEnv, time = Date.now()) {
  await recoverOperations(env, time)
  const [jobs, size, cron] = await Promise.all([
    stmt(env, `SELECT s.subject_id AS id,s.at AS started_at,json_extract(s.detail_json,'$.kind') AS kind,
      COALESCE((SELECT substr(t.action,11) FROM crank_audit t WHERE t.subject_kind='operation' AND t.subject_id=s.subject_id AND t.action!='operation.started' ORDER BY t.at LIMIT 1),'running') AS status
      FROM crank_audit s WHERE s.action='operation.started' ORDER BY s.at DESC,s.id LIMIT 30`).all(),
    stmt(env, "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table'").all(),
    stmt(env, "SELECT MAX(at) AS at FROM crank_audit WHERE action='operation.finished' AND json_extract(detail_json,'$.kind')='scheduler'").first<{ at: string | null }>(),
  ])
  const generated = await stmt(env, "SELECT MAX(at) AS at FROM crank_audit WHERE action='data.export'").first<{ at: string | null }>()
  return { provider_outages: (await stmt(env, `SELECT p.workflow_id,w.name,p.last_started_at,p.last_cause,p.last_error,p.next_due_at
      FROM crank_polls p JOIN crank_workflows w ON w.id=p.workflow_id WHERE p.last_status='error' ORDER BY p.last_started_at DESC LIMIT 30`).all()).results,
    operations: jobs.results, transfers: await archiveTransfers(env), storage: { allocated_bytes: size.meta.size_after ?? null, capacity_bytes: null, capacity_basis: 'Provider capacity is not measured by Crank.' },
    executor: { last_completed_at: cron?.at ?? null, status: cron?.at ? 'observed' : 'unobserved', basis: 'Last completed Cron pass only; current executor availability is not established.' },
    backup: { last_generated_at: generated?.at ?? null, verified_external_copy: false, basis: 'Archive generation is observed; receipt and off-installation backup custody are not verified.' } }
}
