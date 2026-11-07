import { StepError } from '../engine/errors'
import type { RunRow } from '../engine/types'
import { isObject } from '../engine/values'
import { CrankError, stmt, type Actor, type CrankEnv } from '../model'
import { stateGuard, stateValue } from './state'

/** A table reference is data, never an expression or an external request. */
export function mappingTableIds(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 128) throw new StepError('mapping', 'Mapping nests too deeply')
  if (Array.isArray(value)) for (const item of value) mappingTableIds(item, found, depth + 1)
  else if (isObject(value) && !('$literal' in value)) {
    if ('$table' in value) {
      if (Object.keys(value).length !== 1 || typeof value.$table !== 'string' || !value.$table || value.$table.length > 200) throw new StepError('validation', 'Choose a fixed native lookup table')
      found.add(value.$table)
    } else for (const item of Object.values(value)) mappingTableIds(item, found, depth + 1)
  }
  return found
}

type Reader = { run: RunRow } | { actor: Actor; workflowId: string }
/** Only the existing non-sensitive operational tables are exposed. Each read
 * binds its complete inventory to the same current native authority in D1. */
export async function mappingTables(env: CrankEnv, value: unknown, reader: Reader) {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const tableId of mappingTableIds(value)) {
    if ('actor' in reader) {
      const workflow = await stmt(env, 'SELECT data_class FROM crank_workflows WHERE id=?', reader.workflowId).first<{data_class:string}>()
      if (!workflow || workflow.data_class !== 'none') throw new StepError('authority', 'Operational lookup previews require a non-sensitive workflow')
    }
    let guard
    try { guard = await stateGuard(env, tableId, 'actor' in reader ? reader.actor : undefined, 'run' in reader ? { run: reader.run } : undefined) }
    catch (error) {
      if (error instanceof CrankError) throw new StepError([403,409].includes(error.status) ? 'authority' : 'validation', error.message)
      throw error
    }
    const read = await env.DB.batch([
      stmt(env, 'SELECT 1 AS allowed WHERE ' + guard.sql, ...guard.args),
      stmt(env, 'SELECT record_key,value_json FROM crank_state_records WHERE table_id=? AND ' + guard.sql + ' ORDER BY record_key LIMIT 101', tableId, ...guard.args),
    ])
    if (!read[0].results.length) throw new StepError('authority', 'Lookup table authority changed; no values were read')
    const rows = read[1].results as {record_key:string;value_json:string}[]
    if (rows.length > 100) throw new StepError('validation', 'Lookup requires a complete operational table')
    tables[tableId] = Object.fromEntries(rows.map(row => {
      const value: unknown = JSON.parse(row.value_json); stateValue(value)
      return [row.record_key, value]
    }))
  }
  return tables
}
