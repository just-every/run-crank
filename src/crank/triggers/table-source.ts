import { StepError } from '../engine/errors'
import { stmt, type CrankEnv } from '../model'
import { stateValue } from '../tables/state'
import type { AppRecord } from './app-source'
import { RESTORED_OWNER } from '../restore-policy.mjs'

export interface TableSourceScope { workflowId: string; versionId?: string; adoptingOwnerId?: string }
export interface TableSourceGuard { sql: string; params: (string | number | null)[] }
interface TableAuthority { owner_id: string; owner_version: number }
interface StateRecord {
  id: string; table_id: string; record_key: string; value_json: string
  revision: number; mutation_id: string; updated_at: string
}

export const isTableSource = (trigger: Record<string, any>) => trigger.type === 'app_poll' && trigger.provider === 'crank_table'
const fieldNames = ['key', 'value', 'revision']
const unavailable = () => new StepError('authority', 'The operational table must be active and owned by this workflow’s current active owner. Restored tables require explicit owner adoption.')

function tableId(trigger: Record<string, any>) {
  if (!isTableSource(trigger) || trigger.resource !== 'records' || typeof trigger.table_id !== 'string' || !trigger.table_id.trim() || trigger.table_id.length > 200 || trigger.connection_id !== undefined)
    throw new StepError('validation', 'Operational table polling needs records and a fixed table_id, without an app connection')
  return trigger.table_id as string
}

/** Draft discovery and publication checks also require the native table owner.
 * Production additionally binds the immutable current publication. */
function authorityQuery(trigger: Record<string, any>, scope: TableSourceScope): TableSourceGuard {
  const table = tableId(trigger)
  if (!scope.workflowId) throw unavailable()
  return {
    sql: `EXISTS(SELECT 1 FROM crank_state_tables t
      JOIN oa_operators o ON o.id=t.owner_id JOIN crank_workflows w ON w.id=?
      ${scope.versionId ? 'JOIN crank_workflow_versions v ON v.id=? AND v.workflow_id=w.id' : ''}
      WHERE t.id=? AND t.active=1 AND o.role='owner' AND o.status='active'
        AND (w.owner_id=o.id ${!scope.versionId && scope.adoptingOwnerId ? 'OR (w.owner_id=? AND o.id=?)' : ''}) AND w.data_class='none'
        ${scope.versionId ? `AND w.status IN ('published','paused') AND w.published_version_id=v.id
          AND v.mode='production' AND v.retired_at IS NULL AND v.published_by=o.id
          AND json_extract(v.declared_json,'$.publisher_version')=o.version
          AND json_extract(v.graph_json,'$.trigger.type')='app_poll'
          AND json_extract(v.graph_json,'$.trigger.provider')='crank_table'
          AND json_extract(v.graph_json,'$.trigger.resource')='records'
          AND json_extract(v.graph_json,'$.trigger.table_id')=t.id
          AND json_type(v.graph_json,'$.trigger.connection_id') IS NULL` : ''})`,
    params: [scope.workflowId, ...(scope.versionId ? [scope.versionId] : []), table, ...(!scope.versionId && scope.adoptingOwnerId ? [RESTORED_OWNER, scope.adoptingOwnerId] : [])],
  }
}

function frozenGuard(base: TableSourceGuard, table: string, authority: TableAuthority): TableSourceGuard {
  return {
    sql: `${base.sql} AND EXISTS(SELECT 1 FROM crank_state_tables t JOIN oa_operators o ON o.id=t.owner_id
      WHERE t.id=? AND t.owner_id=? AND t.active=1 AND o.role='owner' AND o.status='active' AND o.version=?)`,
    params: [...base.params, table, authority.owner_id, authority.owner_version],
  }
}

/** Reuse this guard in the same D1 batch as every retained event or snapshot. */
export async function tableSourceGuard(env: CrankEnv, trigger: Record<string, any>, scope: TableSourceScope): Promise<TableSourceGuard> {
  const base = authorityQuery(trigger, scope)
  const authority = await stmt(env, `SELECT t.owner_id,o.version AS owner_version FROM crank_state_tables t
    JOIN oa_operators o ON o.id=t.owner_id WHERE t.id=? AND ${base.sql}`, tableId(trigger), ...base.params).first<TableAuthority>()
  if (!authority) throw unavailable()
  return frozenGuard(base, trigger.table_id, authority)
}

/** Native values keep WORK-007's exact safe-integer and integer-list boundary.
 * A 101st row is an error, never a silently truncated successful baseline. */
export async function tableRecords(env: CrankEnv, trigger: Record<string, any>, scope: TableSourceScope): Promise<{ records: AppRecord[]; guard: TableSourceGuard }> {
  if (!scope.versionId) throw unavailable()
  const table = tableId(trigger), base = authorityQuery(trigger, scope)
  const read = await env.DB.batch([
    stmt(env, `SELECT t.owner_id,o.version AS owner_version FROM crank_state_tables t
      JOIN oa_operators o ON o.id=t.owner_id WHERE t.id=? AND ${base.sql}`, table, ...base.params),
    stmt(env, 'SELECT id,table_id,record_key,value_json,revision,mutation_id,updated_at FROM crank_state_records WHERE table_id=? ORDER BY record_key,id LIMIT 101', table),
  ])
  const authority = read[0].results[0] as TableAuthority | undefined
  if (!authority) throw unavailable()
  const rows = read[1].results as unknown as StateRecord[]
  if (rows.length > 100) throw new StepError('validation', 'Operational table polling requires a complete table of at most 100 records')
  const ids = new Set<string>(), keys = new Set<string>()
  const records = rows.map(row => {
    let value: unknown
    try { value = JSON.parse(row.value_json); stateValue(value) }
    catch { throw new StepError('validation', 'Operational table values must remain safe integers or lists of at most 1000 safe integers') }
    if (!row.id || ids.has(row.id) || !/^[a-z][a-z0-9_]{0,59}$/.test(row.record_key) || keys.has(row.record_key)
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || !row.mutation_id || !Number.isFinite(Date.parse(row.updated_at)))
      throw new StepError('validation', 'Operational table records need unique stable ids and keys, a revision and an update timestamp')
    ids.add(row.id); keys.add(row.record_key)
    const fields = { key: row.record_key, value, revision: row.revision }
    return { id: row.id, fields, at: row.updated_at, payload: { id: row.id, table_id: table, ...fields, updated_at: row.updated_at, properties: fields } }
  })
  const authorityGuard = frozenGuard(base, table, authority)
  // Mutation ids and revisions freeze the inventory without copying all values
  // into a SQL parameter. Every existing mutation changes both metadata fields.
  const inventory = JSON.stringify(rows.map(row => ({ id: row.id, key: row.record_key, revision: row.revision, mutation: row.mutation_id, at: row.updated_at })))
  const guard = {
    sql: `${authorityGuard.sql} AND (SELECT COUNT(*) FROM crank_state_records WHERE table_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN crank_state_records r ON r.id=json_extract(e.value,'$.id')
        WHERE r.id IS NULL OR r.table_id!=? OR r.record_key!=json_extract(e.value,'$.key')
          OR r.revision!=json_extract(e.value,'$.revision') OR r.mutation_id!=json_extract(e.value,'$.mutation')
          OR r.updated_at!=json_extract(e.value,'$.at'))`,
    params: [...authorityGuard.params, table, rows.length, inventory, table],
  }
  if (!await stmt(env, `SELECT 1 WHERE ${guard.sql}`, ...guard.params).first()) throw unavailable()
  return { records, guard }
}

/** Fixed schema names require no credential and never read operational values. */
export async function tableFieldNames(env: CrankEnv, trigger: Record<string, any>, scope: TableSourceScope) {
  await tableSourceGuard(env, trigger, scope)
  return fieldNames.map(name => ({ name, label: name }))
}
