import { parseDate, requireZone } from '../engine/dates'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { calendarSearchInput, googleCalendarReadAccount } from './google-calendar-policy'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const invalid = (message: string): never => { throw new StepError('validation', `Google Calendar search: ${message}`) }
const malformed = (): never => { throw new StepError('provider', 'Google Calendar search returned malformed or inconsistent event data') }
const dynamic = (value: unknown): boolean => typeof value === 'string' && value.includes('{{') || isObject(value) && Object.values(value).some(dynamic)
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || dynamic(step.connection_id)) invalid('choose one fixed managed Google connection')
  if (step.create_if_not_found !== undefined) invalid('read-only search cannot create events')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 20)) invalid('max_pages must be 1 to 20')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
  if (!isObject(step.sort) || !['id','start_at'].includes(String(step.sort.field))) invalid('declare sorting by id or start_at with a direction')
  if (!isObject(step.input)) invalid('input must describe one calendar and explicit zoned interval')
  if (!dynamic(step.input)) calendarSearchInput(step.input as Record<string, unknown>)
  else if (Object.keys(step.input as object).some(key => !['calendar_id','time_min','time_max','time_zone','query'].includes(key))) invalid('unsupported search field')
}
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
function eventTime(value: unknown, zone: string): {value: Record<string,string>; ms: number} {
  if (!isObject(value) || (value.date === undefined) === (value.dateTime === undefined)) return malformed()
  const timeZone = value.timeZone === undefined ? zone : value.timeZone
  if (!boundedText(timeZone, 100)) return malformed()
  try { requireZone(timeZone) } catch { return malformed() }
  const date = value.date ?? value.dateTime
  if (!boundedText(date,40) || (value.date !== undefined ? !/^\d{4}-\d{2}-\d{2}$/.test(date) : !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(date))) return malformed()
  const parsed = parseDate(date,timeZone)
  if (!parsed || !Number.isFinite(parsed.ms)) return malformed()
  return {value:{[value.date !== undefined ? 'date' : 'dateTime']:date,...(value.timeZone === undefined ? {} : {timeZone})},ms:parsed.ms}
}
function event(value: unknown, calendar: string, zone: string) {
  if (!isObject(value) || !boundedText(value.id,1024) || !['confirmed','tentative','cancelled'].includes(String(value.status))) return malformed()
  const start = value.start === undefined ? null : eventTime(value.start,zone), end = value.end === undefined ? null : eventTime(value.end,zone)
  if (value.status !== 'cancelled' && (!start || !end) || start && end && (end.ms <= start.ms || ('date' in start.value) !== ('date' in end.value))) return malformed()
  if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 8192)) return malformed()
  if (value.recurringEventId !== undefined && !boundedText(value.recurringEventId,1024)) return malformed()
  const original = value.originalStartTime === undefined ? null : eventTime(value.originalStartTime,zone)
  if (!!value.recurringEventId !== !!original) return malformed()
  return {calendar_id:calendar,id:value.id,event_id:value.id,status:value.status,summary:value.summary ?? null,start:start?.value ?? null,end:end?.value ?? null,start_at:start ? new Date(start.ms).toISOString() : null,time_zone:zone,recurring_event_id:value.recurringEventId ?? null,original_start_time:original?.value ?? null}
}

/** Read-only events.list; the exact interval, account and opaque page token remain
 * part of each immutable shared request checkpoint. No scope acquisition occurs. */
export const googleCalendarSearchEvents: StepType = {
  mutating:false,connection:'required',required:['calendar_id','time_min','time_max','time_zone'],validate,
  async execute(step,ctx) {
    validate(step)
    const input = calendarSearchInput(ctx.input), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await googleCalendarReadAccount(ctx.env,connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = {...ctx,beforeRequest}
    await beforeRequest()
    const records = new Map<string,ReturnType<typeof event>>(), tokens = new Set<string>()
    let token = '', pages = 0
    do {
      // Recheck even when this page will be reconstructed without a physical request.
      await beforeRequest()
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendar_id)}/events`)
      for (const [name,value] of Object.entries({timeMin:input.time_min,timeMax:input.time_max,timeZone:input.time_zone,singleEvents:'true',showDeleted:'true',maxResults:'100',...(input.query === undefined ? {} : {q:input.query}),...(token ? {pageToken:token} : {})})) url.searchParams.set(name,value)
      const result = await retryRequest(context,{method:'GET',url,body:null,idempotent:false},policy => sendRequest(context,{url,method:'GET',body:null,headers:new Headers({accept:'application'+'/'+'json'}),timeout:Number(step.timeout_ms ?? 15000),maxBytes:1024*1024,follow:0,
        // Keep calendar identifiers and opaque cursors out of plaintext metadata.
        // The immutable request digest binds the real URL; reads use only these bytes.
        sanitizeResponse:async response => ({...response,url:'https://www.googleapis.com/calendar/v3/events',headers:new Headers([...response.headers].filter(([name]) => ['content-type','retry-after'].includes(name)))}),
      },connectionId,policy))
      const status = result.response.status
      if (status !== 200) throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider',`Google Calendar search refused the request with status ${status}`,{status,...(result.exhausted ? {exhausted:true} : {})})
      let page: unknown
      try { page = JSON.parse(utf8(result.response.bytes)) } catch { return malformed() }
      if (!isObject(page) || !Array.isArray(page.items) || page.items.length > 100 || page.timeZone !== undefined && page.timeZone !== input.time_zone) return malformed()
      for (const item of page.items) {
        const record = event(item,input.calendar_id,input.time_zone), prior = records.get(record.id)
        if (prior && canonical(prior) !== canonical(record)) return malformed()
        records.set(record.id,record)
      }
      if (page.nextPageToken !== undefined && (!boundedText(page.nextPageToken,2048) || tokens.has(page.nextPageToken))) throw new StepError('provider','Google Calendar search returned an invalid or repeated page token')
      token = page.nextPageToken as string ?? ''
      if (token) tokens.add(token)
      pages++
    } while (token && pages < Number(step.max_pages ?? 20))
    // ID tie ordering makes a first result stable when the declared times coincide.
    const field = String((step.sort as Record<string,unknown>).field) as 'id' | 'start_at', direction = (step.sort as Record<string,unknown>).direction === 'desc' ? -1 : 1
    const ordered = [...records.values()].sort((a,b) => { const x = a[field] ?? '', y = b[field] ?? ''; return x === y ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (x < y ? -1 : 1) * direction })
    const result = searchOutcome({...step,sort:undefined},ordered,!!token)
    if (!('output' in result)) return result
    return {...result,output:{...(result.output as object),calendar_id:input.calendar_id,time_zone:input.time_zone,time_min:input.time_min,time_max:input.time_max,pages,complete:!token}}
  },
}
