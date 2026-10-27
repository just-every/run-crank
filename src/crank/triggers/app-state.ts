import { digest, stmt, type CrankEnv } from '../model'
import type { AppRecord } from './app-source'

/** Read only this complete page set's identities, independent of retained history size. */
export async function appState(env: CrankEnv, workflow: string, version: string, records: AppRecord[]) {
  const keys = new Map(await Promise.all(records.map(async record => [record.id, await digest(record.id)] as const)))
  const retained = new Map<string, { fields_json: string; changed_at: string }>(), erased = new Set<string>(), pending = new Set<string>()
  const values = [...keys.values()]
  for (let i = 0; i < values.length; i += 80) {
    const ids = values.slice(i, i + 80), placeholders = ids.map(() => '?').join(',')
    const results = await env.DB.batch([
      stmt(env, `SELECT record_id,fields_json,changed_at FROM crank_app_snapshots WHERE workflow_id=? AND version_id=? AND record_id IN (${placeholders})`, workflow, version, ...ids),
      stmt(env, `SELECT record_id FROM crank_app_erased_records WHERE workflow_id=? AND record_id IN (${placeholders})`, workflow, ...ids),
      stmt(env, `SELECT record_id FROM crank_app_pending_rows WHERE workflow_id=? AND version_id=? AND record_id IN (${placeholders})`, workflow, version, ...ids),
    ])
    for (const row of results[0].results as { record_id: string; fields_json: string; changed_at: string }[]) retained.set(row.record_id, row)
    for (const row of results[1].results as { record_id: string }[]) erased.add(row.record_id)
    for (const row of results[2].results as { record_id: string }[]) pending.add(row.record_id)
  }
  return { keys, retained, erased, pending }
}
