import { credential } from '../connections/store'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const SHEETS_READ_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive']
export const SHEETS_BOUNDS = { rows: 1000, columns: 50, window: 100, response_bytes: 1024 * 1024 }
const invalid = (message: string): never => { throw new StepError('validation', `Google Sheets: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Google Sheets: ${message}`) }
const fields = ['spreadsheet_id', 'range', 'column', 'value']
const columnNumber = (letters: string) => [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')

/** Only a named worksheet and an explicit rectangular A1 range, with its first row as headers. */
function rangeOf(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) return invalid('range needs a named worksheet and bounded A1 rectangle')
  const match = /^(?:'((?:[^'\x00-\x1f]|'')+)'|([A-Za-z_][A-Za-z0-9_ .-]*))!([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value)
  if (!match) return invalid('range needs a named worksheet and bounded A1 rectangle')
  const first = Number(match[4]), last = Number(match[6]), width = columnNumber(match[5]) - columnNumber(match[3]) + 1
  if (first >= last || last > 1000000 || last - first > SHEETS_BOUNDS.rows || width < 1 || width > SHEETS_BOUNDS.columns || columnNumber(match[5]) > 18278) return invalid('range exceeds 1000 data rows or 50 columns, or is reversed')
  const sheet = "'" + (match[1] ?? match[2]).replaceAll("''", "'").replaceAll("'", "''") + "'"
  return { first, last, width, window: (from: number, to: number) => `${sheet}!${match[3]}${from}:${match[5]}${to}` }
}
function inputOf(input: Record<string, unknown>, dynamic = false) {
  if (Object.keys(input).some(key => !fields.includes(key))) return invalid('only spreadsheet_id, range, column and an exact typed value are supported')
  if (typeof input.spreadsheet_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.spreadsheet_id)) return invalid('spreadsheet_id must be one fixed resource identifier')
  const range = rangeOf(input.range)
  if (typeof input.column !== 'string' || !input.column.trim() || input.column.length > 200 || mapped(input.column)) return invalid('column must name one fixed header')
  if (!(dynamic && mapped(input.value)) && !(typeof input.value === 'string' && input.value.length <= 8192 || typeof input.value === 'boolean' || typeof input.value === 'number' && Number.isFinite(input.value))) return invalid('value must be exact text, a finite number or a boolean; missing and null are not empty text')
  return range
}
function validate(step: Step) {
  validateSearch(step)
  if (step.create_if_not_found !== undefined || step.comparison !== undefined || step.operator !== undefined) return invalid('create settings and other comparisons are unsupported; this is a read-only exact lookup')
  if (step.sort !== undefined && (!isObject(step.sort) || step.sort.field !== 'row_number')) return invalid('sort supports row_number only')
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) return invalid('choose one fixed managed Google connection')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) return invalid('timeout_ms must be 100 to 30000')
  if (!isObject(step.input)) return invalid('input must declare the worksheet lookup')
  inputOf(step.input, true)
}
async function account(env: CrankEnv, connectionId: string) {
  const { row } = await credential(env, connectionId)
  if (row.app !== 'google' || row.auth_kind !== 'oauth2' || !row.consented_at || !SHEETS_READ_SCOPES.some(scope => JSON.parse(row.scopes_json).includes(scope))) throw new StepError('authority', 'Google Sheets requires an already-consented managed Google connection with spreadsheet read scope', { connection_id: connectionId })
}
function decode(response: BoundedResponse, height: number, width: number, expectedRange: string) {
  let body: unknown
  try { body = JSON.parse(utf8(response.bytes)) } catch { return malformed('the provider returned malformed JSON') }
  if (!isObject(body) || typeof body.range !== 'string' || body.majorDimension !== 'ROWS' || body.values !== undefined && !Array.isArray(body.values)) return malformed('the provider returned an invalid row window')
  const normalize = (range: string) => { const at = range.lastIndexOf('!'); let name = range.slice(0, at); if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replaceAll("''", "'"); return JSON.stringify([name, range.slice(at + 1)]) }
  if (normalize(body.range) !== normalize(expectedRange)) return malformed('the provider returned a different worksheet window')
  const values = (body.values ?? []) as unknown[][]
  if (values.length > height || values.some(row => !Array.isArray(row) || row.length > width || row.some(value => value !== null && !(typeof value === 'string' && value.length <= 32768 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))))) return malformed('the provider returned malformed or oversized cells')
  return values
}

export const googleSheetsFindRow: StepType = {
  mutating: false, connection: 'required', required: ['spreadsheet_id', 'range', 'column'], validate,
  async execute(step, ctx) {
    const bounds = inputOf(ctx.input), connectionId = String(step.connection_id)
    await account(ctx.env, connectionId)
    const context: StepContext = { ...ctx, beforeRequest: async () => { await account(ctx.env, connectionId); await ctx.beforeRequest?.() } }
    const spreadsheet = String(ctx.input.spreadsheet_id), records: Record<string, unknown>[] = []
    const read = async (from: number, to: number, headers?: string[]) => {
      // Authority is checked even when this window is reconstructed from a checkpoint.
      await account(ctx.env, connectionId); await ctx.beforeRequest?.()
      const range = bounds.window(from, to)
      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet)}/values/${encodeURIComponent(range)}`)
      url.searchParams.set('majorDimension', 'ROWS'); url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE'); url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER')
      const result = await retryRequest(context, { method: 'GET', url, body: null, idempotent: true }, policy => sendRequest(context, {
        url, method: 'GET', headers: new Headers({ accept: 'application' + '/' + 'json' }), body: null, follow: 0, timeout: Number(step.timeout_ms ?? 15000), maxBytes: SHEETS_BOUNDS.response_bytes,
        sanitizeResponse: async response => {
          // No provider header values enter the private continuation except content negotiation.
          const safe = { ...response, headers: new Headers({ 'content-type': 'application' + '/' + 'json' }) }
          if (response.status !== 200) return { ...safe, bytes: new TextEncoder().encode('{}') }
          const values = decode(response, to - from + 1, bounds.width, range)
          // Named rows let DATA-003 index declared identifiers in unfinished windows, before a later 429.
          return { ...safe, bytes: new TextEncoder().encode(JSON.stringify({ range, majorDimension: 'ROWS', values, named_rows: headers ? values.map(row => Object.fromEntries(headers.flatMap((name, i) => i < row.length && row[i] !== null ? [[name, row[i]]] : []))) : [] })) }
        },
      }, connectionId, policy))
      if (result.response.status !== 200) throw new StepError([401,403,404].includes(result.response.status) ? 'auth' : result.response.status === 429 ? 'rate_limit' : 'provider', `Google Sheets refused the worksheet read with status ${result.response.status}`, { status: result.response.status, ...(result.exhausted ? { exhausted: true } : {}) })
      return decode(result.response, to - from + 1, bounds.width, range)
    }
    const headerRows = await read(bounds.first, bounds.first), headers = headerRows[0]
    if (!headers || headers.length !== bounds.width || headers.some(name => typeof name !== 'string' || !name.trim() || name.length > 200) || new Set(headers).size !== headers.length) return malformed('worksheet headers must be complete, nonempty and unique')
    const names = headers as string[], selected = names.indexOf(String(ctx.input.column))
    if (selected < 0) return invalid('the selected column is absent from the worksheet headers')
    for (let from = bounds.first + 1; from <= bounds.last; from += SHEETS_BOUNDS.window) {
      const to = Math.min(bounds.last, from + SHEETS_BOUNDS.window - 1), rows = await read(from, to, names)
      for (const [offset, row] of rows.entries()) {
        if (selected >= row.length || row[selected] === null || row[selected] !== ctx.input.value) continue
        const fields = Object.fromEntries(names.flatMap((name, i) => i < row.length && row[i] !== null ? [[name, row[i]]] : []))
        const cells = Object.fromEntries(names.map((name, i) => [name, i >= row.length || row[i] === null ? { state: 'missing' } : row[i] === '' ? { state: 'empty', value: '' } : { state: 'value', value: row[i] }]))
        records.push({ spreadsheet_id: spreadsheet, range: String(ctx.input.range), row_number: from + offset, row_range: bounds.window(from + offset, from + offset), fields, cells })
      }
    }
    await account(ctx.env, connectionId); await ctx.beforeRequest?.()
    return searchOutcome(step, records)
  },
}
