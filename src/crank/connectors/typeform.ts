import { credential } from '../connections/store'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const TYPEFORM_READ_SCOPE = 'responses:read'
export const TYPEFORM_FRESHNESS = 'The Responses API can delay recently submitted responses; not found does not establish that a submission never occurred. This lookup does not detect submissions instantly.'
const MAX_BYTES = 262144
const fail = (message: string): never => { throw new StepError('validation', `Typeform lookup: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Typeform lookup: malformed ${message}`) }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const dynamic = (value: unknown) => typeof value === 'string' && value.includes('{{')
type Field = { id: string; type: 'text' | 'number' | 'boolean' }
function projection(step: Step) {
  if (!Array.isArray(step.fields) || step.fields.length > 64 || step.fields.some(field => !isObject(field) || Object.keys(field).some(key => !['id','type'].includes(key)) || !identity(field.id) || !['text','number','boolean'].includes(String(field.type)))) return fail('fields must declare at most 64 stable field IDs with text, number or boolean types')
  if (!Array.isArray(step.hidden_fields) || step.hidden_fields.length > 32 || step.hidden_fields.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name))) return fail('hidden_fields must declare at most 32 hidden string names')
  const fields = step.fields as Field[], hidden = step.hidden_fields as string[]
  if (!fields.length && !hidden.length || new Set(fields.map(field => field.id)).size !== fields.length || new Set(hidden).size !== hidden.length) return fail('declare a nonempty unique projection')
  return { fields, hidden }
}
function responseId(value: unknown): string {
  if (!identity(value)) return fail('response_id must be one exact nonempty response ID')
  return value
}
function validate(step: Step) {
  validateSearch(step)
  if (!identity(step.form_id)) fail('choose one fixed form_id')
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || dynamic(step.connection_id)) fail('choose one fixed managed Typeform connection')
  if (step.create_if_not_found !== undefined) fail('response lookup is read only')
  if (step.sort !== undefined && (!isObject(step.sort) || step.sort.field !== 'id')) fail('only stable response ID sorting is supported')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) fail('timeout_ms must be 100 to 30000')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'response_id')) return fail('input accepts only response_id; discovery and file inputs are unsupported')
  if (!dynamic(step.input.response_id)) responseId(step.input.response_id)
  projection(step)
}
async function readConsent(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'typeform' || row.auth_kind !== 'bearer' || !JSON.parse(row.scopes_json).includes(TYPEFORM_READ_SCOPE)) throw new StepError('authority', 'Typeform lookup requires current responses:read consent on the selected managed bearer connection', { connection_id: connectionId })
}
function decode(bytes: Uint8Array<ArrayBuffer>) {
  try { const value = JSON.parse(utf8(bytes)); if (isObject(value)) return value } catch { /* never retain the provider's error body */ }
  return malformed('JSON response')
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,19) !== value.slice(0,19)) return malformed('completion time')
  return value
}
function project(value: Record<string, unknown>, step: Step, expected: string) {
  if (!Array.isArray(value.items) || value.items.length > 1 || value.total_items !== value.items.length || value.page_count !== value.items.length) return malformed('response counts; exact lookup requires zero or one complete result')
  const { fields, hidden } = projection(step)
  return { records: value.items.map(item => {
    if (!isObject(item) || item.response_id !== expected || item.response_type !== 'completed' || !Array.isArray(item.answers) || item.answers.length > 128 || !isObject(item.hidden ?? {})) return malformed('completed response or response ID binding')
    if (item.form_id !== undefined && item.form_id !== step.form_id) return malformed('form binding')
    const answers: Record<string, unknown>[] = [], seen = new Set<string>()
    for (const answer of item.answers) {
      if (!isObject(answer) || !isObject(answer.field) || !identity(answer.field.id) || seen.has(answer.field.id)) return malformed('answer field identity')
      seen.add(answer.field.id)
      const selected = fields.find(field => field.id === (answer.field as Record<string, unknown>).id)
      if (!selected) continue
      if (answer.type !== selected.type || !Object.hasOwn(answer, selected.type)) return malformed('selected answer type or missing value')
      const result = answer[selected.type]
      if (result !== null && (typeof result !== (selected.type === 'text' ? 'string' : selected.type) || selected.type === 'text' && (result as string).length > 16384 || selected.type === 'number' && !Number.isFinite(result))) return malformed('selected answer value')
      if (answer.field.ref !== undefined && !identity(answer.field.ref)) return malformed('field reference')
      answers.push({ field: { id: selected.id, ...(answer.field.ref === undefined ? {} : { ref: answer.field.ref }) }, type: selected.type, value: result })
    }
    const hiddenValues: Record<string, string | null> = Object.create(null), source = (item.hidden ?? {}) as Record<string, unknown>
    for (const name of hidden) if (Object.hasOwn(source, name)) {
      const result = source[name]
      if (result !== null && (typeof result !== 'string' || result.length > 16384)) return malformed('declared hidden string')
      hiddenValues[name] = result as string | null
    }
    return { id: expected, response_id: expected, form_id: step.form_id, submitted_at: time(item.submitted_at), ...(item.landed_at === undefined ? {} : { landed_at: time(item.landed_at) }), answers, hidden: hiddenValues }
  }) }
}

/** Fixed completed-response read. Only validated selected values enter custody;
 * unsolicited uploads, metadata and provider error bodies are discarded. */
export const typeformFindResponse: StepType = {
  mutating: false, connection: 'required', required: ['response_id'], validate,
  async execute(step, ctx) {
    validate({ ...step, input: ctx.input })
    const connectionId = String(step.connection_id), expected = responseId(ctx.input.response_id)
    const beforeRequest = async () => { await readConsent(ctx, connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = { ...ctx, beforeRequest }
    // Cached consumption and physical dispatch both require current consent.
    await beforeRequest()
    const url = new URL(`https://api.typeform.com/forms/${encodeURIComponent(String(step.form_id))}/responses`)
    url.searchParams.set('included_response_ids', expected)
    url.searchParams.set('page_size', '1')
    url.searchParams.set('response_type', 'completed')
    const { response } = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401,403] }, policy => sendRequest(context, {
      url, method: 'GET', body: null, headers: new Headers({ accept: 'application' + '/' + 'json' }), timeout: Number(step.timeout_ms ?? 15000), maxBytes: MAX_BYTES, follow: 0,
      sanitizeResponse: async response => ({ ...response, url: 'https://api.typeform.com/responses', headers: new Headers([...response.headers].filter(([name]) => ['content-type','retry-after'].includes(name))), bytes: new TextEncoder().encode(JSON.stringify(response.status === 200 ? project(decode(response.bytes), step, expected) : {})) }),
    }, connectionId, policy))
    if (response.status !== 200) throw new StepError([401,403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'provider', `Typeform lookup refused with status ${response.status}`, { status: response.status })
    await beforeRequest()
    const result = searchOutcome(step, decode(response.bytes).records as Record<string, unknown>[])
    if ('output' in result && isObject(result.output)) result.output = { ...result.output, freshness: TYPEFORM_FRESHNESS }
    return result
  },
}
