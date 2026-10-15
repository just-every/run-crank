import type { D1Sql, D1TargetAdapter } from '../modules/import-kit/d1/types.ts'
import type { Json, TargetRow } from '../modules/import-kit/types.ts'

export interface ImportTargetEnv { AUTH_LOCAL?: string; CRANK_TARGET_ORIGIN?: string }
export const IMPORT_DESTINATION = 'crank-flows'

/** Preview and apply share this exact-origin policy; importing makes no requests. */
export function validateImportTargetUrl(env: ImportTargetEnv, value: unknown): string {
  const local = env.AUTH_LOCAL === 'true'
  const declared = env.CRANK_TARGET_ORIGIN ?? (local ? 'http://127.0.0.1:9051' : undefined)
  if (!declared) throw new Error('CRANK_TARGET_ORIGIN_REQUIRED')
  const parse = (input: unknown): URL => {
    if (typeof input !== 'string' || input.length > 2048 || input !== input.trim() || /[\s\\?#]/u.test(input)) throw new Error('IMPORT_TARGET_URL_INVALID')
    let url: URL
    try { url = new URL(input) } catch { throw new Error('IMPORT_TARGET_URL_INVALID') }
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('IMPORT_TARGET_URL_INVALID')
    return url
  }
  const origin = parse(declared)
  if (declared !== origin.origin || origin.pathname !== '/' || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw new Error('CRANK_TARGET_ORIGIN_INVALID')
  const target = parse(value)
  if (target.origin !== origin.origin) throw new Error('IMPORT_TARGET_ORIGIN_FORBIDDEN')
  return target.href
}

const sql = (sql: string, ...params: unknown[]): D1Sql => ({ sql, params })
function scope(destination: string, kind: string) {
  if (destination !== IMPORT_DESTINATION || kind !== 'flow') throw new Error('IMPORT_TARGET_SCOPE_INVALID')
}
type FlowValue = { name: string; source_app: string; destination_app: string; target_url: string; created_by: string; status: string; revision: number }
function value(input: Json): FlowValue {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('IMPORT_FLOW_VALUE_INVALID')
  const row = input as unknown as FlowValue
  if (typeof row.name !== 'string' || typeof row.target_url !== 'string' || typeof row.created_by !== 'string' || row.source_app !== 'n8n' || row.destination_app !== 'HTTP inbox' || row.status !== 'draft' || row.revision !== 1) throw new Error('IMPORT_FLOW_MUST_BE_DRAFT')
  return row
}
function nativeRow(row: Record<string, any>): TargetRow {
  return {
    destination: IMPORT_DESTINATION, targetKind: 'flow', targetId: row.id, revision: row.kit_revision,
    value: { name: row.name, source_app: row.source_app, destination_app: row.destination_app, target_url: row.target_url, created_by: row.created_by, status: row.status, revision: row.revision },
  }
}

/** Inert native SQL only. The sidecar translates Base's opaque revision into
 * Crank's integer revision and snapshots the server-generated creation time. */
export const importFlowTargets: D1TargetAdapter = {
  async read(db, destination, kind, id) {
    scope(destination, kind)
    const row = await db.prepare('SELECT f.*,s.kit_revision FROM crank_flows f LEFT JOIN crank_import_flow_state s ON s.flow_id=f.id WHERE f.id=?').bind(id).first()
    if (!row) return undefined
    // A collision with a native flow cannot be treated as an importable absence.
    if (row.kit_revision === null) throw new Error('IMPORT_TARGET_COLLISION')
    return nativeRow(row)
  },
  matches(row, destination, kind, id) {
    scope(destination, kind)
    if (!row) return sql('NOT EXISTS(SELECT 1 FROM crank_flows WHERE id=?) AND NOT EXISTS(SELECT 1 FROM crank_import_flow_state WHERE flow_id=?)', id, id)
    const v = row.value as unknown as FlowValue
    return sql(`EXISTS(SELECT 1 FROM crank_flows f JOIN crank_import_flow_state s ON s.flow_id=f.id
      WHERE f.id=? AND s.kit_revision=? AND f.name=? AND f.source_app=? AND f.destination_app=?
      AND f.target_url=? AND f.created_by=? AND f.status=? AND f.revision=? AND f.created_at=s.created_at)
      AND NOT EXISTS(SELECT 1 FROM crank_runs WHERE flow_id=?)`,
      id, row.revision, v.name, v.source_app, v.destination_app, v.target_url, v.created_by, v.status, v.revision, id)
  },
  matchesCount(count, destination) {
    scope(destination, 'flow')
    return sql('(SELECT COUNT(*) FROM crank_flows f JOIN crank_import_flow_state s ON s.flow_id=f.id)=?', count)
  },
  write(row) {
    scope(row.destination, row.targetKind)
    const v = value(row.value)
    return [
      sql("INSERT INTO crank_import_flow_state(flow_id,kit_revision,created_at) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", row.targetId, row.revision),
      sql('INSERT INTO crank_flows(id,name,source_app,destination_app,target_url,revision,created_by,created_at,status) SELECT ?,?,?,?,?,?,?,created_at,? FROM crank_import_flow_state WHERE flow_id=?', row.targetId, v.name, v.source_app, v.destination_app, v.target_url, v.revision, v.created_by, v.status, row.targetId),
    ]
  },
  remove(destination, kind, id) {
    scope(destination, kind)
    return [sql('DELETE FROM crank_flows WHERE id=?', id), sql('DELETE FROM crank_import_flow_state WHERE flow_id=?', id)]
  },
  async list(db, destination) {
    scope(destination, 'flow')
    const { results } = await db.prepare('SELECT f.*,s.kit_revision FROM crank_flows f JOIN crank_import_flow_state s ON s.flow_id=f.id ORDER BY f.id').all()
    return results.map(nativeRow)
  },
}
