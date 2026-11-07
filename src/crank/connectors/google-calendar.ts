import { googleCalendarSearchEvents } from './google-calendar-search'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical, digest, stmt } from '../model'
import { calendarInput, googleCalendarAccount, validateGoogleCalendar, type CalendarInput } from './google-calendar-policy'
import { retryRequest } from './retry'
import { RetryWait } from './retry-wait'
import { sendRequest } from './request-transport'

export { GOOGLE_CALENDAR_SCOPE, calendarInput, validateGoogleCalendar } from './google-calendar-policy'
const uncertain = (message: string, detail: Record<string, unknown> = {}) => new StepError('uncertain', `Google Calendar: ${message}; inspect the event before starting new work`, { uncertain: true, ...detail })
function decode(response: BoundedResponse): Record<string, unknown> | null {
  try { const value = JSON.parse(utf8(response.bytes)); return isObject(value) ? value : null } catch { return null }
}
function failure(response: BoundedResponse) {
  const status = response.status
  if (status >= 200 && status < 300) return
  throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider', `Google Calendar refused the request with status ${status}`, { status })
}
function matches(value: Record<string, any> | null, expected: Record<string, any>) {
  if (!value || value.id !== expected.id || value.status === 'cancelled' || value.extendedProperties?.private?.crank_input_digest !== expected.extendedProperties.private.crank_input_digest) return false
  if (value.summary !== expected.summary || (value.description ?? '') !== (expected.description ?? '') || (value.location ?? '') !== (expected.location ?? '')) return false
  if (['start', 'end'].some(key => !isObject(value[key]) || typeof value[key].dateTime !== 'string' || Date.parse(value[key].dateTime) !== Date.parse(expected[key].dateTime) || value[key].timeZone !== expected[key].timeZone)) return false
  const recipients = (items: any) => Array.isArray(items) ? items.map(item => String(item?.email ?? '').toLowerCase()).sort() : []
  return canonical(recipients(value.attendees)) === canonical(recipients(expected.attendees))
}
function output(value: Record<string, any>, input: CalendarInput, reconciled: boolean) {
  return { calendar_id: input.calendar_id, id: value.id, event_id: value.id, summary: value.summary, start: value.start, end: value.end, attendees: (value.attendees ?? []).map((item: any) => ({ email: item.email })), html_link: value.htmlLink ?? null, status: value.status ?? 'confirmed', reconciled }
}

/** Every physical request uses shared admission, current authority and bounded checkpoints. */
export const googleCalendarCreateEvent: StepType = {
  mutating: true, reconciles: true, connection: 'required', required: ['calendar_id', 'summary', 'start', 'end'], validate: validateGoogleCalendar,
  async execute(step, ctx) {
    const input = calendarInput(ctx.input), connectionId = String(step.connection_id)
    await googleCalendarAccount(ctx.env, connectionId)
    const beforeRequest = async () => { await googleCalendarAccount(ctx.env, connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = { ...ctx, beforeRequest }
    const operation = await digest(ctx.operationKey), eventId = 'crank' + operation
    const { calendar_id, ...event } = input
    const payload = { ...event, id: eventId, extendedProperties: { private: { crank_input_digest: await digest(canonical(input)) } } }
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events`)
    // Guests are explicit recipients. This action never opts into sending update emails.
    url.searchParams.set('sendUpdates', 'none')
    const body = new TextEncoder().encode(JSON.stringify(payload)), timeout = Number(step.timeout_ms ?? 15000)
    let reconciled = false
    try {
      const result = await retryRequest(context, { method: 'POST', url, body, idempotent: false }, async policy => {
        // A response may reach the attempts ledger just before a process dies,
        // without reaching its checkpoint. Any earlier physical POST means readback.
        const previous = await stmt(ctx.env, 'SELECT id FROM crank_wf_attempts WHERE run_id=? AND path=? AND request_key=? LIMIT 1', ctx.run.id, ctx.path, policy.requestKey).first()
        if (previous) throw new StepError('network', 'The Calendar write was already attempted; continue only by event readback', { uncertain: true })
        return sendRequest(context, { url, method: 'POST', headers: new Headers({ accept: 'application'+'/'+'json', 'content-type': 'application'+'/'+'json' }), body, timeout, maxBytes: 1024 * 1024, follow: 0 }, connectionId, policy)
      })
      if (result.response.status === 409 || result.response.status >= 500) reconciled = true
      else { failure(result.response); reconciled = !matches(decode(result.response), payload) }
    } catch (error) {
      if (error instanceof RetryWait) throw error
      if (!(error instanceof StepError) || !['network', 'provider', 'uncertain'].includes(error.category)) throw error
      if (error.category === 'provider' && typeof error.detail.status === 'number' && error.detail.status < 500) throw error
      reconciled = true
    }
    const readUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events/${eventId}`)
    try {
      // Verification is deliberately a GET, also after a successful acknowledgement.
      const result = await retryRequest(context, { method: 'GET', url: readUrl, body: null, idempotent: false }, policy => sendRequest(context, { url: readUrl, method: 'GET', headers: new Headers({ accept: 'application'+'/'+'json' }), body: null, timeout, maxBytes: 1024 * 1024, follow: 0 }, connectionId, policy))
      const value = decode(result.response)
      if (result.response.status !== 200 || !matches(value, payload)) throw uncertain('the exact created event could not be verified', { readback_http_status: result.response.status, event_id: eventId, ...(result.exhausted ? { exhausted: true } : {}) })
      return { status: 'succeeded', output: output(value!, input, reconciled) }
    } catch (error) {
      if (error instanceof RetryWait || error instanceof StepError && ['connection', 'authority', 'uncertain'].includes(error.category)) throw error
      throw uncertain('event readback failed after the write attempt', { event_id: eventId, readback_error_category: error instanceof StepError ? error.category : 'provider', ...(error instanceof StepError && error.detail.exhausted ? { exhausted: true, next_owner_action: error.detail.next_owner_action } : {}) })
    }
  },
}

export const googleCalendarSteps: Record<string, StepType> = { 'google_calendar.create_event': googleCalendarCreateEvent, 'google_calendar.search_events': googleCalendarSearchEvents }
