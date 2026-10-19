import { evaluate, validateGroups } from '../engine/conditions'
import { parseDate, requireZone } from '../engine/dates'
import { StepError } from '../engine/errors'
import { isObject, lookup } from '../engine/values'

export interface HistoricalRecord { id: string; payload: unknown }

function bound(value: unknown, end: boolean): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T.+(?:Z|[+-]\d\d:\d\d))?$/.test(value)) throw new StepError('validation', 'Historical date bounds must be ISO dates or timestamps with an explicit timezone')
  const parsed = parseDate(value, 'UTC')
  if (!parsed || (value.length > 10 && !Number.isFinite(Date.parse(value)))) throw new StepError('validation', 'A historical date bound could not be parsed')
  return parsed.ms + (end && value.length === 10 ? 86400000 - 1 : 0)
}

/** Relative filter operands use the preview clock; date-only bounds cover
 * whole UTC days, inclusively at either end. */
export function selectHistorical(records: HistoricalRecord[], input: Record<string, unknown>, defaultZone: string, time = Date.now()) {
  const zone = requireZone(input.timezone ?? defaultZone)
  const filter = input.filter === undefined ? null : validateGroups(input.filter, 'Historical filter')
  let range: { field: string; from: number; to: number } | null = null
  if (input.date_range !== undefined) {
    const value = input.date_range
    if (!isObject(value) || typeof value.field !== 'string' || !value.field.trim() || value.field.length > 256 || (value.from === undefined && value.to === undefined)) throw new StepError('validation', 'Historical date_range needs field and from or to')
    const from = value.from === undefined ? -Infinity : bound(value.from, false), to = value.to === undefined ? Infinity : bound(value.to, true)
    if (from > to) throw new StepError('validation', 'Historical from must not be after to')
    range = { field: value.field, from, to }
  }
  const selected = records.filter(record => {
    if (filter) {
      const result = evaluate(filter, { trigger: record.payload, steps: {}, run: {} }, zone, time)
      if (result.mismatch) throw new StepError('validation', `Historical filter type mismatch at ${result.mismatch.field}`)
      if (!result.pass) return false
    }
    if (range) {
      const parsed = parseDate(lookup(record.payload, range.field).value, 'UTC')
      if (!parsed) throw new StepError('validation', `Historical source date could not be parsed at ${range.field}`)
      if (parsed.ms < range.from || parsed.ms > range.to) return false
    }
    return true
  })
  return { selected, selection: { filter, date_range: range ? { field: range.field, from: Number.isFinite(range.from) ? new Date(range.from).toISOString() : null, to: Number.isFinite(range.to) ? new Date(range.to).toISOString() : null, inclusive: true, timezone: 'UTC' } : null, timezone: zone, evaluated_at: new Date(time).toISOString() } }
}
