import { id, now, stmt, type CrankEnv } from '../model'

/** Append-only, value-free audit rows; callers add them to the same batch as the change. */
export function auditStatement(env: CrankEnv, actorId: string, action: string, subjectKind: string, subjectId: string, detail: Record<string, unknown> = {}, versionId: string | null = null) {
  return stmt(env, 'INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json) VALUES(?,?,?,?,?,?,?,?)', id(), now(), actorId, action, subjectKind, subjectId, versionId, JSON.stringify(detail))
}
export async function readAudit(env: CrankEnv, subjectKind?: string, subjectId?: string) {
  const rows = subjectKind
    ? await stmt(env, 'SELECT * FROM crank_audit WHERE subject_kind=? AND subject_id=? ORDER BY at,id', subjectKind, subjectId).all()
    : await stmt(env, 'SELECT * FROM crank_audit ORDER BY at DESC,id LIMIT 500').all()
  return rows.results.map((row: any) => ({ ...row, detail: JSON.parse(row.detail_json), detail_json: undefined }))
}
