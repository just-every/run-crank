import type { CallResult, Runtime, ToolContext } from './types.ts'
import { ToolRefusal } from './errors.ts'
import { retiredDigest } from './retired-refs.ts'

// The fixed replay window also bounds installation-private erasure aliases.
export const REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Call deletion and its alias-delete trigger execute in the same transaction. */
export async function expireReplayCalls(rt: { options: { db: D1Database }; now(): number }) {
  await rt.options.db.prepare('DELETE FROM agent_door_calls WHERE expires_at<=?').bind(rt.now()).run()
}

export interface Tombstone { erasure_id: string; at: string }
type Cell = string | number | null
type Row = Record<string, Cell>
/** SQL is seed-owned, bound to one native subject's identifiers. Never accept it from a request. */
export interface AgentArtifact {
  table: string
  columns: readonly string[]
  match?: { sql: string; params: readonly string[] }
  unrelated?: string
  retire?: { refs: string }
}
export interface AgentArtifactMap { artifacts: readonly AgentArtifact[] }
export interface AgentErasureOptions {
  secret: string
  /** The existing native subject/installation fence. Native effects must enforce it in their transaction too. */
  fenced(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<boolean>
}
const quote = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('agent_erasure_identifier')
  return '"' + name + '"'
}
const parse = (value: Cell | undefined): any => typeof value === 'string' ? JSON.parse(value) : null
export const erasedResult = (tombstone: Tombstone): CallResult => ({ outcome: 'refused', code: 'subject_erased', decision: null, fields: { tombstone } })
export async function replayAlias(secret: string, key: string) {
  if (secret.length < 32) throw new Error('agent_erasure_secret_required')
  const encoder = new TextEncoder()
  const signing = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', signing, encoder.encode(key))), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function erasedReplay(rt: Runtime, agent: string, key: string, operationId?: string): Promise<CallResult | null> {
  if (!rt.options.erasure) return null
  const row = await rt.options.db.prepare('SELECT aliases.tombstone FROM agent_door_replay_aliases aliases JOIN agent_door_calls calls ON calls.agent=aliases.agent AND calls.decision_id=aliases.call_id WHERE aliases.agent=? AND aliases.alias=? AND calls.expires_at>?')
    .bind(agent, await replayAlias(rt.options.erasure.secret, key), rt.now()).first<{ tombstone: string }>()
  if (row) return erasedResult(JSON.parse(row.tombstone))
  if (operationId !== undefined) {
    const operation = await rt.options.db.prepare("SELECT json_extract(row,'$.tombstone') AS tombstone FROM agent_door_audit WHERE id=? AND agent=?").bind(operationId, agent).first<{ tombstone: string | null }>()
    if (operation?.tombstone) return erasedResult(JSON.parse(operation.tombstone))
  }
  return null
}
export async function captureFence(rt: Runtime, name: string, args: Record<string, unknown>, ctx: ToolContext) {
  if (await rt.options.erasure?.fenced(name, args, ctx)) throw new ToolRefusal('subject_erasure_in_progress')
}
/** Check every installed agent table and every column, including future migrations. */
export async function checkAgentArtifacts(db: D1Database, map: AgentArtifactMap) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'agent_door_*' ORDER BY name").all<{ name: string }>()).results
  const declared = new Map(map.artifacts.map(item => [item.table, item]))
  if (declared.size !== map.artifacts.length) throw new Error('agent_erasure_duplicate_table')
  for (const { name } of tables) {
    const item = declared.get(name)
    if (!item || [item.match, item.unrelated, item.retire].filter(Boolean).length !== 1 || item.retire && name !== 'agent_door_state') throw new Error('agent_erasure_undeclared_table:' + name)
    const columns = (await db.prepare('PRAGMA table_info(' + quote(name) + ')').all<{ name: string }>()).results.map(column => column.name)
    if (JSON.stringify([...columns].sort()) !== JSON.stringify([...item.columns].sort())) throw new Error('agent_erasure_undeclared_column:' + name)
  }
  for (const item of map.artifacts) if (!tables.some(table => table.name === item.table)) throw new Error('agent_erasure_missing_table:' + item.table)
}
const classNames = (value: any): string[] => Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item.class).filter(item => typeof item === 'string') : []
const outcome = (state: string) => ({ done: 'executed', refused: 'denied', pending: 'held', running: 'held', replayed: 'executed', rejected: 'denied', open: 'executed', reviewed: 'executed', flagged: 'executed', undone: 'executed', executing: 'held', undoing: 'held' }[state] ?? state)
function retained(value: any, tombstone: Tombstone) {
  return { tool: value?.tool ?? null, classes: classNames(value?.classes), outcome: outcome(value?.outcome ?? value?.state ?? 'held'),
    code: value?.code ?? null, role: value?.principal?.person?.role ?? value?.role ?? null,
    organisation_id: value?.principal?.person?.organisationId ?? value?.organisation_id ?? null,
    agent: { id: value?.principal?.agent?.id ?? value?.agent?.id ?? value?.actor?.agent?.id ?? null }, tombstone }
}
function replacements(table: string, row: Row, tombstone: Tombstone): Row {
  const marker = JSON.stringify(tombstone), refusal = JSON.stringify(erasedResult(tombstone))
  if (table === 'agent_door_calls') return { key: 'erased:' + row.decision_id, digest: '', state: outcome(String(row.state)), outcome: refusal, expires_at: row.expires_at ?? Date.parse(tombstone.at) + REPLAY_WINDOW_MS }
  if (table === 'agent_door_audit') {
    const old = parse(row.row)
    return { classes: JSON.stringify(classNames(parse(row.classes))), row: JSON.stringify({ ...retained(old, tombstone), classes: classNames(old.classes).map(value => ({ class: value })), id: row.id, at: row.at,
      // Empty structural fields keep old readers safe; no original personal values survive.
      sponsor: { id: '', name: '' }, scopes: [], rules: [], decision: old.decision, approval: null, review: null,
      resource: null, idempotency_key: null, trace: null, ignored_arguments: [], replay_of: null }), evidence: null }
  }
  if (table === 'agent_door_approvals') {
    const old = parse(row.saved)
    const marks = (parse(row.approvals) ?? []).map((mark: any) => ({ decision: row.state === 'rejected' ? 'denied' : 'allowed', role: mark.ref === 'sponsor' ? old.principal?.person?.role ?? null : mark.ref?.startsWith('role:') ? mark.ref.slice(5) : null, at: mark.at }))
    return { state: outcome(String(row.state)), saved: JSON.stringify({ ...retained(old, tombstone), expires_at: old.expires_at }), approvals: JSON.stringify(marks), result: refusal, version: 0 }
  }
  if (table === 'agent_door_reviews') return { state: outcome(String(row.state)), saved: JSON.stringify(retained(parse(row.saved), tombstone)), marked_by: null }
  if (table === 'agent_door_events') {
    const old = parse(row.event)
    return { uri: '', event: JSON.stringify({ id: row.id, at: old.at, ...retained(old, tombstone) }) }
  }
  if (table === 'agent_door_usage') return { classes: JSON.stringify((parse(row.classes) ?? []).map((item: any) => ({
    class: item.class,
    // Keep the non-personal accounting dimensions used by usage()/scopeMatches.
    // Open text facts (kind, provider, step, setting, service) can name a person.
    facts: { measure: item.facts.measure,
      .../^[A-Z]{3}$/.test(item.facts.currency ?? '') ? { currency: item.facts.currency } : {},
      ...['internal', 'known', 'new', 'public'].includes(item.facts.counterparty) ? { counterparty: item.facts.counterparty } : {},
      ...['widens', 'narrows'].includes(item.facts.direction) ? { direction: item.facts.direction } : {},
    },
  }))) }
  if (table === 'agent_door_agents') return { name: '', specialist: null, sponsor: '', sponsor_name: '', revoked: 1, window: 0, requests: 0, tombstone: marker }
  throw new Error('agent_erasure_unsupported_table:' + table)
}
/** Compile redaction into the seed's EXISTING native-erasure transaction.
 * The snapshot guard refuses a changed selection, rather than erasing a stale read.
 * Checkpoints come from BASE-DATA-003's existing portability custody.
 */
export async function agentErasureStatements(input: {
  db: D1Database; map: AgentArtifactMap; subject: Record<string, Cell>; secret: string; tombstone: Tombstone
  checkpoint(): Promise<D1PreparedStatement[]>
}): Promise<D1PreparedStatement[]> {
  const { db, map, subject, secret, tombstone } = input
  await checkAgentArtifacts(db, map)
  const refs: string[] = []
  for (const item of map.artifacts.filter(item => item.retire)) {
    const key = item.retire!.refs
    if (!(key in subject)) throw new Error('agent_erasure_subject_value:' + key)
    let values: unknown
    try { values = typeof subject[key] === 'string' ? JSON.parse(subject[key] as string) : null } catch { throw new Error('agent_erasure_policy_ref') }
    if (!Array.isArray(values) || values.length > 200 || values.some(ref => typeof ref !== 'string' || !/^person:[^\s:]{1,200}$/.test(ref))) throw new Error('agent_erasure_policy_ref')
    refs.push(...values)
  }
  const out: D1PreparedStatement[] = []
  // Materialize every selection before changing a table another selection joins.
  const selections = await Promise.all(map.artifacts.filter(item => item.match).map(async item => {
    const params = item.match!.params.map(key => {
      if (!(key in subject)) throw new Error('agent_erasure_subject_value:' + key)
      return subject[key]!
    })
    const rows = (await db.prepare('SELECT rowid AS _rowid,* FROM ' + quote(item.table) + ' WHERE ' + item.match!.sql).bind(...params).all<Row>()).results
    return { item, params, rows }
  }))
  // No new guard table: use SQLite's malformed-JSON assertion inside the native batch.
  for (const { item, params, rows } of selections) {
    out.push(db.prepare('SELECT CASE WHEN (SELECT json_group_array(rowid) FROM (SELECT rowid FROM ' + quote(item.table) + ' WHERE ' + item.match!.sql + ' ORDER BY rowid))=? THEN 1 ELSE json_extract(\'[]\', \'$[agent_erasure_scope_changed\') END')
      .bind(...params, JSON.stringify(rows.map(row => row._rowid).sort((a, b) => Number(a) - Number(b)))))
    for (const row of rows) {
      const equal = item.columns.map(column => quote(column) + ' IS ?').join(' AND ')
      out.push(db.prepare('SELECT CASE WHEN EXISTS(SELECT 1 FROM ' + quote(item.table) + ' WHERE rowid=? AND ' + equal + ') THEN 1 ELSE json_extract(\'[]\', \'$[agent_erasure_scope_changed\') END')
        .bind(row._rowid!, ...item.columns.map(column => row[column]!)))
    }
  }
  if (refs.length || selections.some(selection => selection.rows.length)) out.push(...await input.checkpoint())
  for (const { item, rows } of selections) for (const row of rows) {
    const oldMarker = item.table === 'agent_door_calls' ? parse(row.outcome)?.fields?.tombstone
      : parse(row.row ?? row.saved ?? row.event ?? row.tombstone)?.tombstone ?? (item.table === 'agent_door_agents' ? parse(row.tombstone) : null)
    if (oldMarker) continue
    if (item.table === 'agent_door_calls') out.push(db.prepare('INSERT INTO agent_door_replay_aliases(agent,alias,call_id,tombstone) VALUES(?,?,?,?) ON CONFLICT(agent,alias) DO NOTHING')
      .bind(row.agent!, await replayAlias(secret, String(row.key)), row.decision_id!, JSON.stringify(tombstone)))
    const set = replacements(item.table, row, tombstone)
    out.push(db.prepare('UPDATE ' + quote(item.table) + ' SET ' + Object.keys(set).map(column => quote(column) + '=?').join(',') + ' WHERE rowid=?')
      .bind(...Object.values(set), row._rowid!))
    if (item.table === 'agent_door_calls') out.push(db.prepare('DELETE FROM agent_door_calls WHERE rowid=? AND expires_at<=?').bind(row._rowid!, Date.parse(tombstone.at)))
  }
  for (const ref of new Set(refs)) {
    const digest = await retiredDigest(ref)
    out.push(db.prepare('INSERT INTO agent_door_retired_refs(digest,marker) VALUES(?,?) ON CONFLICT(digest) DO NOTHING').bind(digest, 'person:erased:' + tombstone.erasure_id))
    for (const [table, columns] of [
      ['agent_door_state', ['local_document']], ['agent_door_audit', ['row', 'evidence']],
      ['agent_door_approvals', ['saved', 'approvals', 'result']], ['agent_door_reviews', ['saved']],
      ['agent_door_calls', ['outcome']], ['agent_door_events', ['event']],
    ] as const) for (const column of columns) out.push(db.prepare('UPDATE ' + quote(table) + ' SET ' + quote(column) + '=replace(' + quote(column) + ',?,(SELECT json_quote(marker) FROM agent_door_retired_refs WHERE digest=?)) WHERE instr(' + quote(column) + ',?)>0')
      .bind(JSON.stringify(ref), digest, JSON.stringify(ref)))
  }
  return out
}
