import { now, stmt, type CrankEnv } from '../model'
import { StepError } from './errors'
import type { Step, StepResult } from './types'
import { isObject, lookup } from './values'

/** WORK-011 settings shared by every search operation. */
export function validateSearch(step: Step) {
  if (step.no_match !== undefined && !['halt', 'continue'].includes(step.no_match as string)) throw new StepError('validation', `Search ${step.id}: no_match must be halt or continue`)
  if (step.multi_match !== undefined && !['first', 'stop', 'all'].includes(step.multi_match as string)) throw new StepError('validation', `Search ${step.id}: multi_match must be first, stop or all`)
  if (step.on_multiple !== undefined && !['halt', 'continue'].includes(step.on_multiple as string)) throw new StepError('validation', `Search ${step.id}: on_multiple must be halt or continue`)
  if (step.create_if_not_found !== undefined && !isObject(step.create_if_not_found)) throw new StepError('validation', `Search ${step.id}: create_if_not_found must hold the create step's mapped input`)
}
/** Keys are typed; an empty key is a validation error, never a match-all. */
export function searchKey(value: unknown, label: string, kind: 'email' | 'text' = 'text'): string {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (!text) throw new StepError('validation', `Search key ${label} is empty`, { field: label })
  return kind === 'email' ? text.toLowerCase() : text
}

function sortRecords(records: Record<string, unknown>[], step: Step) {
  if (!isObject(step.sort) || typeof step.sort.field !== 'string') return records
  const field = step.sort.field, direction = step.sort.direction === 'asc' ? 1 : -1
  return [...records].sort((a, b) => {
    const x = lookup(a, field).value as any, y = lookup(b, field).value as any
    return x === y ? 0 : (x > y ? 1 : -1) * direction
  })
}

/** Applies the declared no-match and multi-match outcomes to a completed provider search. */
export function searchOutcome(step: Step, records: Record<string, unknown>[], truncated = false): StepResult {
  const count = records.length
  if (count === 0) {
    if (step.no_match === 'halt') return { status: 'stopped', reason: 'search', output: { outcome: 'not found', count: 0 } }
    return { status: 'succeeded', output: { outcome: 'not found', record: null, records: [], count: 0 } }
  }
  if (count === 1) return { status: 'succeeded', output: { outcome: 'found', record: records[0], records, count } }
  const mode = step.multi_match ?? 'first'
  if (mode === 'all') {
    const limit = Math.min(Number(step.limit ?? 100), 500), list = sortRecords(records, step).slice(0, limit)
    return { status: 'succeeded', output: { outcome: 'found', record: list[0], records: list, count: list.length, truncated: truncated || records.length > limit } }
  }
  if (mode === 'stop') {
    if (step.on_multiple === 'continue') return { status: 'succeeded', output: { outcome: 'multiple matches', record: null, records, count } }
    return { status: 'stopped', reason: 'search', output: { outcome: 'multiple matches', count } }
  }
  const sorted = sortRecords(records, step)
  return { status: 'succeeded', output: { outcome: 'found', record: sorted[0], records: [sorted[0]], count } }
}

/** Serializes find-or-create for one connection and normalized key, so concurrent runs
 * produce one record: one reports `created`, the others `found`. */
export async function withKeyLock<T>(env: CrankEnv, name: string, holder: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 20000
  for (;;) {
    const at = now()
    const taken = await stmt(env, 'INSERT INTO crank_locks(name,holder,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at WHERE crank_locks.expires_at<?',
      name, holder, new Date(Date.now() + 30000).toISOString(), at).run()
    if (taken.meta.changes === 1) break
    if (Date.now() > deadline) throw new StepError('rate_limit', 'Another run is creating the same record; try again')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  try { return await work() } finally { await stmt(env, 'DELETE FROM crank_locks WHERE name=? AND holder=?', name, holder).run() }
}
