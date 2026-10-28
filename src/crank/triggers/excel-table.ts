import { StepError } from '../engine/errors'
import { canonical, type CrankEnv } from '../model'
import { appRequest } from './app-source'

const fail = (message: string): never => { throw new StepError('validation', message) }

/** Table row indexes are positions; the caller uses an explicit business-key column. */
export async function excelTableValues(env: CrankEnv, trigger: Record<string, any>): Promise<unknown[][]> {
  const base = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(trigger.workbook_id)}/workbook/tables/${encodeURIComponent(trigger.table_id)}`
  let bytes = 0
  const read = async (url: URL) => {
    const body = await appRequest(env, trigger.connection_id, url)
    bytes += new TextEncoder().encode(JSON.stringify(body)).byteLength
    if (bytes > 2 * 1024 * 1024) fail('Excel table exceeds the 2 MiB complete-source limit')
    if (!Array.isArray(body.value)) fail('Excel table response needs a complete collection')
    return body
  }
  const columns = async () => {
    const body = await read(new URL(base + '/columns?$top=1001'))
    if (body['@odata.nextLink'] || body.value.length > 1000) fail('Excel table has too many columns')
    const ordered = [...body.value].sort((a, b) => a.index - b.index)
    if (ordered.some((column, i) => column.index !== i || typeof column.name !== 'string' || !column.name.trim())) fail('Excel table columns need consecutive indexes and names')
    return ordered.map(column => column.name) as string[]
  }
  const names = await columns(), rows: unknown[][] = []
  for (let offset = 0; ; offset += 100) {
    const url = new URL(base + '/rows'); url.searchParams.set('$top', '100'); url.searchParams.set('$skip', String(offset))
    const body = await read(url)
    if (body.value.length > 100 || offset > 1000) fail('Excel table pagination exceeded its row bound')
    for (const [i, row] of body.value.entries()) {
      if (row.index !== offset + i || !Array.isArray(row.values) || row.values.length !== 1 || !Array.isArray(row.values[0])) fail('Excel table returned inconsistent row positions')
      rows.push(row.values[0])
    }
    if (rows.length > 1000) fail('Excel table exceeds 1000 rows; narrow the table')
    if (body.value.length < 100 && !body['@odata.nextLink']) break
    if (offset === 1000) fail('Excel table pagination did not complete')
  }
  if (canonical(names) !== canonical(await columns())) fail('Excel table columns changed during the read; retry the complete source')
  return [names, ...rows]
}
