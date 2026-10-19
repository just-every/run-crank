import { id, now, stmt, type CrankEnv } from '../model'

/** Append-only, value-free audit rows; callers add them to the same batch as the change. */
export function auditStatement(env: CrankEnv, actorId: string, action: string, subjectKind: string, subjectId: string, detail: Record<string, unknown> = {}, versionId: string | null = null) {
  return stmt(env, 'INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) VALUES(?,?,?,?,?,?,?,?)', id(), now(), actorId, action, subjectKind, subjectId, versionId, JSON.stringify(detail))
}
/** The same row, written only when `condition` holds inside the batch (for claims that may lose a race). */
export function auditStatementWhen(env: CrankEnv, condition: string, conditionArgs: unknown[], actorId: string, action: string, subjectKind: string, subjectId: string, detail: Record<string, unknown> = {}, versionId: string | null = null) {
  return stmt(env, `INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) SELECT ?,?,?,?,?,?,?,? WHERE ${condition}`, id(), now(), actorId, action, subjectKind, subjectId, versionId, JSON.stringify(detail), ...conditionArgs)
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
