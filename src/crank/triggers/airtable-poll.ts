import { StepError } from '../engine/errors'
import { canonical, type CrankEnv } from '../model'
import { appRequest, type AppRecord } from './app-source'

/** Airtable supplies creation time, so updates use labeled observation time. */
export async function airtableRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const base = new URL(`https://api.airtable.com/v0/${encodeURIComponent(trigger.base_id)}/${encodeURIComponent(trigger.table_id)}`)
  base.searchParams.set('pageSize', '100')
  if (trigger.view_id) base.searchParams.set('view', trigger.view_id)
  const records = new Map<string, AppRecord>(), cursors = new Set<string>()
  let url = base
  for (let page = 0; ; page++) {
    if (page >= 10 || cursors.has(url.href)) throw new StepError('validation', 'Airtable pagination did not complete within ten distinct pages')
    cursors.add(url.href)
    const body = await appRequest(env, trigger.connection_id, url)
    if (!Array.isArray(body.records)) throw new StepError('validation', 'Airtable response has no record list')
    for (const record of body.records) {
      if (typeof record.id !== 'string' || !record.id || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) throw new StepError('validation', 'Airtable record needs an id and named fields')
      const prior = records.get(record.id)
      if (prior && canonical(prior.fields) !== canonical(record.fields)) throw new StepError('validation', 'Airtable returned conflicting versions; retry the complete source')
      const modified = trigger.modified_field ? record.fields[trigger.modified_field] : null
      if (trigger.modified_field && (typeof modified !== 'string' || !Number.isFinite(Date.parse(modified)))) throw new StepError('validation', 'Airtable modified_field must hold a valid modification timestamp')
      records.set(record.id, { id: record.id, fields: record.fields, at: modified ? new Date(String(modified)).toISOString() : null, payload: record })
      if (records.size > 1000) throw new StepError('validation', 'Airtable source exceeds 1000 records; narrow the view')
    }
    if (!body.offset) break
    if (typeof body.offset !== 'string') throw new StepError('validation', 'Airtable returned an invalid page cursor')
    url = new URL(base); url.searchParams.set('offset', body.offset)
  }
  return [...records.values()]
}

export async function airtableFields(env: CrankEnv, trigger: Record<string, any>) {
  const body = await appRequest(env, trigger.connection_id, new URL(`https://api.airtable.com/v0/meta/bases/${encodeURIComponent(trigger.base_id)}/tables`))
  const table = Array.isArray(body.tables) && body.tables.find((table: any) => table.id === trigger.table_id || table.name === trigger.table_id)
  if (!table || !Array.isArray(table.fields) || table.fields.some((field: any) => typeof field.name !== 'string' || !field.name)) throw new StepError('validation', 'Airtable table field names could not be loaded completely')
  return table.fields.map((field: any) => ({ name: field.name, label: field.name })) as { name: string; label: string }[]
}
