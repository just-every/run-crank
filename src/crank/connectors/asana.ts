import { credential } from '../connections/store'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { asanaInput, asanaNextPage, asanaPageUrl, asanaTask, ASANA_CHECKPOINT_URL, malformedAsana } from './asana-policy'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const invalid = (message: string): never => { throw new StepError('validation', `Asana search: ${message}`) }
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || step.connection_id.includes('{{')) invalid('choose one fixed native Asana connection')
  if (step.create_if_not_found !== undefined) invalid('read-only search cannot create tasks')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 20)) invalid('max_pages must be 1 to 20')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
  if (!isObject(step.sort) || step.sort.field !== 'id') invalid('declare sorting by id with a direction')
  if (!isObject(step.input)) return invalid('input must select one project and exact task name')
  // The project selection is literal; only the task name may come from earlier data.
  asanaInput({ ...step.input, name: typeof step.input.name === 'string' && step.input.name.includes('{{') ? 'mapped name' : step.input.name })
}
async function readAccount(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'asana' || row.auth_kind !== 'bearer' || !JSON.parse(row.scopes_json).includes('tasks:read')) throw new StepError('authority', 'Choose a native Asana bearer connection with explicit current tasks:read consent')
}

/** Complete bounded exact-name lookup. Provider pages are sealed shared request
 * checkpoints, not an independently replayable cache or a workspace identity. */
export const asanaFindTask: StepType = {
  mutating: false, connection: 'required', required: ['project_id', 'name'], validate,
  async execute(step, ctx) {
    validate(step)
    const input = asanaInput(ctx.input), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await readAccount(ctx, connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = { ...ctx, beforeRequest }
    const records = new Map<string, ReturnType<typeof asanaTask>>(), offsets = new Set<string>()
    let offset = '', pages = 0
    do {
      await beforeRequest()
      const url = asanaPageUrl(input.project_id, offset)
      const result = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401, 403] }, policy => sendRequest(context, {
        url, method: 'GET', body: null, headers: new Headers({ accept: 'application' + '/' + 'json' }), timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0,
        sanitizeResponse: async response => ({ ...response, url: ASANA_CHECKPOINT_URL, headers: new Headers([...response.headers].filter(([name]) => ['content-type', 'retry-after'].includes(name))) }),
      }, connectionId, policy))
      const status = result.response.status
      if (status !== 200) throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider', `Asana search refused the request with status ${status}`, { status, ...(result.exhausted ? { exhausted: true } : {}) })
      let page: unknown
      try { page = JSON.parse(utf8(result.response.bytes)) } catch { return malformedAsana() }
      if (!isObject(page) || !Array.isArray(page.data) || page.data.length > 100 || !('next_page' in page)) return malformedAsana()
      for (const item of page.data) {
        const record = asanaTask(item, input.project_id), previous = records.get(record.id)
        if (previous && canonical(previous) !== canonical(record)) return malformedAsana()
        records.set(record.id, record)
      }
      offset = asanaNextPage(page.next_page, input.project_id, offsets)
      if (offset) offsets.add(offset)
      pages++
    } while (offset && pages < Number(step.max_pages ?? 20))
    // Even all mode must not release a partial set as an exact-name answer.
    if (offset) throw new StepError('provider', 'Asana search is incomplete; no search outcome was decided', { outcome: 'search incomplete' })
    const direction = (step.sort as Record<string, unknown>).direction === 'desc' ? -1 : 1
    const matches = [...records.values()].filter(record => record.name === input.name).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction)
    const result = searchOutcome({ ...step, sort: undefined }, matches)
    if (!('output' in result)) return result
    return { ...result, output: { ...(result.output as object), project_id: input.project_id, pages, complete: true } }
  },
}
