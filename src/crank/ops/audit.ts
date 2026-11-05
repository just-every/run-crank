import { id, now, stmt, type CrankEnv } from '../model'

function attributedDetail(env: CrankEnv, actorId: string, detail: Record<string, unknown>) {
  const attribution = env.CRANK_AGENT_ATTRIBUTION
  return attribution?.for.id === actorId ? { ...detail, agent_door: attribution } : detail
}

/** Append-only, value-free audit rows; callers add them to the same batch as the change. */
export function auditStatement(env: CrankEnv, actorId: string, action: string, subjectKind: string, subjectId: string, detail: Record<string, unknown> = {}, versionId: string | null = null) {
  return stmt(env, 'INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) VALUES(?,?,?,?,?,?,?,?)', id(), now(), actorId, action, subjectKind, subjectId, versionId, JSON.stringify(attributedDetail(env, actorId, detail)))
}
/** The same row, written only when `condition` holds inside the batch (for claims that may lose a race). */
export function auditStatementWhen(env: CrankEnv, condition: string, conditionArgs: unknown[], actorId: string, action: string, subjectKind: string, subjectId: string, detail: Record<string, unknown> = {}, versionId: string | null = null) {
  return stmt(env, `INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) SELECT ?,?,?,?,?,?,?,? WHERE ${condition}`, id(), now(), actorId, action, subjectKind, subjectId, versionId, JSON.stringify(attributedDetail(env, actorId, detail)), ...conditionArgs)
}
/** The whole audit, oldest first, as one JSON object per line. */
export async function exportAudit(env: CrankEnv) {
  const rows = await stmt(env, 'SELECT id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json FROM crank_audit ORDER BY at,id').all<Record<string, string | null>>()
  return rows.results.map(row => JSON.stringify({ ...row, detail: JSON.parse(row.detail_json ?? '{}'), detail_json: undefined })).join('\n') + (rows.results.length ? '\n' : '')
}
export async function readAudit(env: CrankEnv, subjectKind?: string, subjectId?: string) {
  const rows = subjectKind
    ? await stmt(env, 'SELECT * FROM crank_audit WHERE subject_kind=? AND subject_id=? ORDER BY at,id', subjectKind, subjectId).all()
    : await stmt(env, 'SELECT * FROM crank_audit ORDER BY at DESC,id LIMIT 500').all()
  return rows.results.map((row: any) => ({ ...row, detail: JSON.parse(row.detail_json), detail_json: undefined }))
}

export interface NativeAgentAudit {
  id: string; at: string; actor_id: string; action: string; subject_kind: string; subject_id: string; version_id: string | null; operation_id: string
  review_id: string | null; reviewed_by: string | null
}
/** Closed metadata projection: native graph values, arguments and credentials stay out. */
export async function readAgentOperationAudit(env: CrankEnv, operations: string[]): Promise<NativeAgentAudit[]> {
  if (!operations.length) return []
  const rows = await stmt(env, `SELECT a.id,a.at,a.actor_id,a.action,a.subject_kind,a.subject_id,a.version_id,
    coalesce(json_extract(a.detail_json,'$.agent_door.operation_id'),json_extract(a.detail_json,'$.agent_review.operation_id')) AS operation_id,
    json_extract(a.detail_json,'$.agent_review.review_id') AS review_id,
    CASE WHEN a.action='workflow.agent_undo' THEN coalesce(p.display_name,'Removed person') ELSE NULL END AS reviewed_by
    FROM crank_audit a LEFT JOIN oa_operators p ON p.id=a.actor_id
    WHERE coalesce(json_extract(a.detail_json,'$.agent_door.operation_id'),json_extract(a.detail_json,'$.agent_review.operation_id')) IN (SELECT value FROM json_each(?)) ORDER BY a.rowid`,
  JSON.stringify([...new Set(operations)])).all<NativeAgentAudit>()
  return rows.results
}
