import { credential } from '../connections/store'
import { requireZone, wallTime } from '../engine/dates'
import { StepError } from '../engine/errors'
import type { Step } from '../engine/types'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const writeScopes = [GOOGLE_CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.owned', 'https://www.googleapis.com/auth/calendar.app.created']
const fields = ['calendar_id', 'summary', 'start', 'end', 'description', 'location', 'attendees']
export interface CalendarTime { dateTime: string; timeZone: string }
export interface CalendarInput {
  calendar_id: string; summary: string; start: CalendarTime; end: CalendarTime
  description?: string; location?: string; attendees?: { email: string }[]
}
const invalid = (message: string): never => { throw new StepError('validation', `Google Calendar: ${message}`) }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
function text(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) return invalid(`${name} must be nonempty text of at most ${max} characters`)
  return value
}
function time(value: unknown, name: string): CalendarTime {
  if (!isObject(value) || Object.keys(value).some(key => !['dateTime', 'timeZone'].includes(key))) return invalid(`${name} needs dateTime and timeZone`)
  const dateTime = text(value.dateTime, `${name}.dateTime`, 40), timeZone = text(value.timeZone, `${name}.timeZone`, 100)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(dateTime)
  if (!match || !Number.isFinite(Date.parse(dateTime))) return invalid(`${name}.dateTime needs an RFC3339 timestamp with an explicit offset`)
  requireZone(timeZone)
  const local = wallTime(Date.parse(dateTime), timeZone)
  if ([local.year, local.month, local.day, local.hour, local.minute, local.second].some((part, index) => part !== Number(match[index + 1]))) return invalid(`${name}.dateTime must be a real wall time with the correct offset for its timezone`)
  return { dateTime, timeZone }
}
export function calendarInput(value: Record<string, unknown>): CalendarInput {
  if (Object.keys(value).some(key => !fields.includes(key))) return invalid('unsupported event field')
  const calendar_id = text(value.calendar_id, 'calendar_id', 1024)
  if (calendar_id === 'primary' || /[\s\x00-\x1f\x7f]/.test(calendar_id) || ['.', '..'].includes(calendar_id)) return invalid('calendar_id must be an exact calendar identifier, not the primary alias')
  const result: CalendarInput = { calendar_id, summary: text(value.summary, 'summary', 1024), start: time(value.start, 'start'), end: time(value.end, 'end') }
  if (Date.parse(result.end.dateTime) <= Date.parse(result.start.dateTime)) return invalid('end must be after start')
  for (const field of ['description', 'location'] as const) if (value[field] !== undefined) result[field] = text(value[field], field, field === 'description' ? 8192 : 1024)
  if (value.attendees !== undefined) {
    if (!Array.isArray(value.attendees) || value.attendees.length > 100) return invalid('attendees must list at most 100 email recipients')
    result.attendees = value.attendees.map(item => {
      if (!isObject(item) || Object.keys(item).some(key => key !== 'email')) return invalid('each attendee needs only an email')
      const email = text(item.email, 'attendee email', 254)
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) return invalid('attendee email is invalid')
      return { email }
    })
    if (new Set(result.attendees.map(item => item.email.toLowerCase())).size !== result.attendees.length) return invalid('attendees must not repeat recipients')
  }
  return result
}

/** Static inputs fail at graph validation; mapped values are checked after resolution. */
export function validateGoogleCalendar(step: Step) {
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) return invalid('choose one fixed managed Google connection')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) return invalid('timeout_ms must be 100 to 30000')
  if (!isObject(step.input)) return invalid('input must be an event object')
  if (Object.keys(step.input).some(key => !fields.includes(key))) return invalid('unsupported event field')
  const dynamic = (value: unknown): boolean => mapped(value) || Array.isArray(value) && value.some(dynamic) || isObject(value) && Object.values(value).some(dynamic)
  if (!dynamic(step.input)) calendarInput(step.input)
}

/** This action shares the existing Google credential, never an arbitrary HTTP credential. */
export async function googleCalendarAccount(env: CrankEnv, connectionId: string) {
  const { row } = await credential(env, connectionId)
  const scopes: string[] = JSON.parse(row.scopes_json)
  if (row.app !== 'google' || row.auth_kind !== 'oauth2' || !writeScopes.some(scope => scopes.includes(scope))) throw new StepError('authority', 'Choose a managed Google OAuth connection with Calendar event write scope', { connection_id: connectionId })
}
