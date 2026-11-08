import { StepError } from '../engine/errors'
import { canonical } from '../model'
import type { AppRecord } from './app-source'

/** Replay supplied property history after the retained baseline, grouping one edit.
 * Initial activation deliberately seeds the current record, never its old history. */
export function appTimeline(record: AppRecord, previous: Record<string, unknown> | null, since: string | null, watched: string[] | undefined): AppRecord[] {
  const history = record.payload.propertiesWithHistory
  if (!previous || !since || !history) return [record]
  if (typeof history !== 'object' || Array.isArray(history)) throw new StepError('validation', 'App property history must name fields')
  const changes = new Map<string, Record<string, unknown>>()
  let count = 0
  for (const field of watched ?? Object.keys(record.fields)) {
    const versions = (history as Record<string, unknown>)[field]
    if (versions === undefined) continue
    if (!Array.isArray(versions)) throw new StepError('validation', `Invalid property history for ${field}`)
    for (const version of versions) {
      if (++count > 10000 || !version || typeof version !== 'object' || !Object.hasOwn(version, 'value') || typeof version.timestamp !== 'string' || !Number.isFinite(Date.parse(version.timestamp))) throw new StepError('validation', `Invalid or excessive property history for ${field}`)
      const time = new Date(version.timestamp).toISOString()
      if (Date.parse(time) > Date.parse(record.at!)) throw new StepError('validation', 'Property history is newer than the source record; retry the complete source')
      if (time <= since) continue
      const fields = changes.get(time) ?? {}
      if (Object.hasOwn(fields, field) && canonical(fields[field]) !== canonical(version.value)) throw new StepError('validation', 'Property history conflicts at one change time')
      Object.defineProperty(fields, field, { value: version.value, enumerable: true, configurable: true })
      changes.set(time, fields)
    }
  }
  const result: AppRecord[] = []
  let fields = { ...previous }
  for (const [at, changed] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    fields = { ...fields, ...changed }
    result.push({ ...record, at, fields, payload: { id: record.id, updatedAt: at, properties: fields } })
  }
  const latest = result.at(-1)
  const selected = watched ? Object.fromEntries(watched.filter(name => Object.hasOwn(record.fields, name)).map(name => [name, record.fields[name]])) : record.fields
  if (latest?.at === record.at && canonical(latest.fields) !== canonical(selected)) throw new StepError('validation', 'Property history disagrees with the current watched values')
  if (!latest || latest.at !== record.at) result.push(record)
  return result
}
