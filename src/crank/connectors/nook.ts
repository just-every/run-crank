import { credential } from '../connections/store'
import { siblingBinding } from '../connections/sibling-binding'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { digest } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

/** Nook's documented integration-token door; no session, arbitrary URL or app impersonation. */
export const nookSendMessage: StepType = {
  mutating: true, connection: 'required', required: ['body'],
  validate(step) {
    if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000))
      throw new StepError('validation', 'Nook timeout_ms must be a whole number between 100 and 30000')
  },
  async execute(step, ctx) {
    const connectionId = String(step.connection_id)
    const current = async () => {
      const { row } = await credential(ctx.env, connectionId)
      if (row.app !== 'nook') throw new StepError('auth', 'Choose a native Nook connection')
      if (!JSON.parse(row.scopes_json).includes('messages:write')) throw new StepError('connection', 'Nook posting requires messages:write on the current connection', { connection_id: connectionId, reconnect: true })
      return siblingBinding(JSON.parse(row.sibling_binding_json ?? 'null'))
    }
    const binding = await current()
    if (Object.keys(ctx.input).some(key => key !== 'body') || typeof ctx.input.body !== 'string' || !ctx.input.body.trim())
      throw new StepError('validation', 'Nook accepts only a nonempty body; the connection fixes its destination')
    const context = { ...ctx, beforeRequest: async () => { await current(); await ctx.beforeRequest?.() } }
    const url = new URL(`/api/conversations/${binding.conversation_id}/messages`, binding.origin)
    const body = new TextEncoder().encode(JSON.stringify({ body: ctx.input.body }))
    // Nook retains this key across token rotations. A lost acknowledgement may be
    // retried only as the same operation and body, never as a new message.
    const key = await digest(ctx.operationKey)
    let result
    try { result = await retryRequest(context, { method: 'POST', url, body, idempotent: true }, policy =>
      sendRequest(context, { url, method: 'POST', body, timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0,
        headers: new Headers({ 'content-type': 'application'+'/'+'json', accept: 'application'+'/'+'json', 'idempotency-key': key }) }, connectionId, policy)) }
    catch (error) {
      if (error instanceof StepError && ['network', 'provider'].includes(error.category)) throw new StepError('uncertain', 'Nook acknowledgement was lost after bounded same-operation retries; inspect the destination', { ...error.detail, uncertain: true })
      throw error
    }
    const response = result.response
    if (response.status === 401 || response.status === 403) throw new StepError('connection', 'Reconnect Nook: the provider refused the current integration token or conversation grant', { connection_id: connectionId, reconnect: true, status: response.status })
    if (response.status === 429) throw new StepError('rate_limit', 'Nook posting is rate limited; inspect the retained attempt before resuming', { status: 429 })
    if (response.status < 200 || response.status >= 300) throw new StepError(response.status >= 500 ? 'uncertain' : 'provider', 'Nook did not acknowledge the message', { status: response.status, ...(response.status >= 500 ? { uncertain: true } : {}) })
    let record: unknown
    try { record = JSON.parse(utf8(response.bytes)) } catch { record = null }
    if (!isObject(record) || typeof record.id !== 'string' || !record.id || record.body !== ctx.input.body || record.conversation !== undefined && record.conversation !== binding.conversation_id)
      throw new StepError('uncertain', 'Nook returned no matching message acknowledgement; inspect the destination before new work', { uncertain: true })
    return { status: 'succeeded', output: { id: record.id, conversation_id: binding.conversation_id, body: record.body,
      origin: binding.origin, acknowledgement: 'provider_response', independently_read_back: false } }
  },
}
