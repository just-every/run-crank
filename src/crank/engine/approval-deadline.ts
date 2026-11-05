import { businessCalendar } from './calendar'
import { addTime, isBusinessDay, requireUnit, requireZone } from './dates'
import { StepError } from './errors'
import type { Step } from './types'
import { isObject } from './values'

const maximum = 366 * 86400000
/** Explicit offsets only; there is no default reminder or automatic decision. */
export function validateApprovalDeadlines(step: Step) {
  if (step.timeout === undefined && step.reminders === undefined && step.on_timeout === undefined) return
  requireZone(step.timezone)
  const calendar = businessCalendar(step.calendar)
  if (new Set(calendar.weekend).size === 7) throw new StepError('validation', 'Approval calendar needs a working day')
  if (step.on_timeout !== undefined && (!['stop', 'continue'].includes(String(step.on_timeout)) || step.timeout === undefined)) throw new StepError('validation', 'Approval on_timeout needs a timeout and must be stop or continue')
  if (step.reminders !== undefined && (!Array.isArray(step.reminders) || step.reminders.length > 12)) throw new StepError('validation', 'Approval reminders must be a list of at most 12 offsets')
  for (const offset of [step.timeout, ...(Array.isArray(step.reminders) ? step.reminders : [])].filter(value => value !== undefined)) {
    if (!isObject(offset) || !Number.isSafeInteger(offset.amount) || Number(offset.amount) < 1) throw new StepError('validation', 'Approval deadline offsets need a positive whole amount')
    const unit = requireUnit(offset.unit)
    const bounds = { seconds: 31622400, minutes: 527040, hours: 8784, days: 366, weeks: 52, months: 12, years: 1, business_days: 262 }
    if (Number(offset.amount) > bounds[unit]) throw new StepError('validation', 'Approval deadlines are limited to 366 days')
  }
}

export function approvalDeadlines(step: Step, from: number, fallbackZone: string) {
  validateApprovalDeadlines(step)
  const zone = requireZone(step.timezone, fallbackZone)
  const due = (offset: unknown) => {
    const value = offset as Record<string, unknown>
    let time = addTime(from, Number(value.amount), requireUnit(value.unit), zone, step.calendar)
    // A nonworking date moves forward at the same local wall time, including DST.
    for (let days = 0; !isBusinessDay(time, zone, step.calendar); days++) {
      if (days >= 366) throw new StepError('validation', 'Approval calendar has no reachable working date')
      time = addTime(time, 1, 'days', zone)
    }
    if (time <= from || time - from > maximum) throw new StepError('validation', 'Approval deadlines are limited to the next 366 days')
    return new Date(time).toISOString()
  }
  const expiresAt = step.timeout === undefined ? null : due(step.timeout)
  const reminders = (Array.isArray(step.reminders) ? step.reminders : []).map(due)
  if (reminders.some((at, i) => (i > 0 && at <= reminders[i - 1]) || (expiresAt !== null && at >= expiresAt))) throw new StepError('validation', 'Approval reminders must increase and precede the timeout')
  return { expiresAt, deadlines: [...reminders.map(at => ({ kind: 'reminder' as const, at })), ...(expiresAt ? [{ kind: 'timeout' as const, at: expiresAt }] : [])] }
}
