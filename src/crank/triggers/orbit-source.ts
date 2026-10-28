import { orbitAccount, orbitRecord } from '../connectors/orbit'
import { StepError } from '../engine/errors'
import { canonical, type CrankEnv } from '../model'
import { appRequest, type AppRecord } from './app-source'

/** Orbit exposes current scoped deals, not a provider event or modification clock. */
export async function orbitRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const binding = await orbitAccount(env, trigger.connection_id), records = new Map<string, AppRecord>(), cursors = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; ; page++) {
    if (page >= 10) throw new StepError('validation', 'Orbit polling did not complete within ten pages')
    const url = new URL('/api/rest/v1/deals', binding.origin)
    url.searchParams.set('fields', binding.fields.join(',')); url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const body = await appRequest(env, trigger.connection_id, url, 'GET', undefined, true)
    if (!Array.isArray(body?.deals) || body.deals.length > 100 || !Object.hasOwn(body, 'nextCursor')) throw new StepError('validation', 'Orbit polling needs a complete deal page')
    for (const value of body.deals) {
      const record = orbitRecord(value, binding), { id, ...fields } = record, key = String(id)
      if (records.has(key) && canonical(records.get(key)!.fields) !== canonical(fields)) throw new StepError('validation', 'Orbit returned conflicting deal snapshots')
      if ((trigger.watched_fields ?? []).some((field: string) => !Object.hasOwn(fields, field))) throw new StepError('validation', 'An Orbit watched field is outside the current connection projection')
      records.set(key, { id: key, fields, at: null, payload: { id, properties: fields, source_kind: 'current_snapshot', history_available: false } })
    }
    if (body.nextCursor === null) break
    if (typeof body.nextCursor !== 'string' || !binding.record_ids.includes(body.nextCursor) || cursors.has(body.nextCursor)) throw new StepError('validation', 'Orbit returned an invalid or repeated deal cursor')
    const next = body.nextCursor as string; cursor = next; cursors.add(next)
  }
  await orbitAccount(env, trigger.connection_id)
  return [...records.values()]
}
