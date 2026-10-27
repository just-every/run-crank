import { addTime, diffTime, formatDate, offsetMinutes, requireDate, requireUnit, requireZone, startOfDay, wallTime } from '../dates'
import { integer, text, type Args, type Transform } from './args'
import { n8nDateValue } from './n8n-date-value'
import { StepError } from '../errors'

const zone = (args: Args, name = 'timezone') => requireZone(args[name])
/** Input is read in `input_timezone` (default `timezone`); output is shown in `timezone`. */
const instant = (args: Args, name = 'value') => requireDate(args[name], requireZone(args.input_timezone ?? args.timezone), name)

export const dateTransforms: Record<string, Transform> = {
  'date.n8n_arithmetic': args => {
    const ms = n8nDateValue(args.value), tz = zone(args), amount = integer(args, 'amount'), unit = requireUnit(args.unit)
    const field = args.field
    if (ms === null || ms === undefined || new Date(ms).getUTCFullYear() < 100 || Math.abs(amount) > 10000 || unit === 'business_days' || typeof field !== 'string' || !/^[_A-Za-z][_A-Za-z0-9]*$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field) || typeof args.include_input_fields !== 'boolean') throw new StepError('validation', 'Source date arithmetic requires a bounded ISO date, duration and output field')
    let next = addTime(ms, amount, unit, tz)
    if (['years', 'months', 'weeks', 'days'].includes(unit)) {
      // At an autumn overlap the source keeps the starting offset when that
      // offset still describes the target wall time, including a zero duration.
      const preferred = next + (offsetMinutes(next, tz) - offsetMinutes(ms, tz)) * 60000
      const a = wallTime(next, tz), b = wallTime(preferred, tz)
      if (a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second) next = preferred
    }
    if (!Number.isFinite(next) || new Date(next).getUTCFullYear() < 100 || new Date(next).getUTCFullYear() > 9999) throw new StepError('validation', 'Source date arithmetic is outside the supported calendar range')
    // Source DateTime stringification always retains milliseconds. Calendar
    // units use the workflow zone; hours and smaller units use elapsed time.
    const iso = formatDate(next, 'iso', tz), milliseconds = String(((next % 1000) + 1000) % 1000).padStart(3, '0')
    const value = iso.slice(0, -6) + '.' + milliseconds + (['UTC', 'GMT'].includes(tz.toUpperCase()) ? 'Z' : iso.slice(-6))
    if (args.include_input_fields && (!args.input || typeof args.input !== 'object' || Array.isArray(args.input))) throw new StepError('validation', 'Source input retention requires a JSON object')
    return { ...(args.include_input_fields ? args.input as Record<string, unknown> : {}), [field]: value }
  },
  'date.parse': args => {
    const ms = instant(args), tz = zone(args)
    return { iso: new Date(ms).toISOString(), local: formatDate(ms, 'iso', tz), date: formatDate(ms, 'date', tz), unix: Math.floor(ms / 1000), timezone: tz }
  },
  'date.format': args => args.nullable === true && (args.value === null || args.value === undefined) ? args.value : formatDate(instant(args), typeof args.pattern === 'string' ? args.pattern : 'iso', zone(args)),
  'date.add': args => formatDate(addTime(instant(args), integer(args, 'amount'), requireUnit(args.unit), zone(args), args.calendar), typeof args.pattern === 'string' ? args.pattern : 'iso', zone(args)),
  'date.subtract': args => formatDate(addTime(instant(args), -integer(args, 'amount'), requireUnit(args.unit), zone(args), args.calendar), typeof args.pattern === 'string' ? args.pattern : 'iso', zone(args)),
  'date.compare': args => {
    const tz = zone(args), day = args.precision === 'day'
    let a = instant(args, 'a'), b = instant(args, 'b')
    if (day) { a = startOfDay(a, tz); b = startOfDay(b, tz) }
    return { result: a < b ? 'earlier' : a > b ? 'later' : 'equal' }
  },
  'date.diff': args => diffTime(instant(args, 'a'), instant(args, 'b'), requireUnit(args.unit ?? 'days'), zone(args), args.calendar),
  'date.start_of_day': args => formatDate(startOfDay(instant(args), zone(args)), 'iso', zone(args)),
  'date.to_unix': args => Math.floor(instant(args) / 1000),
  'date.from_text': args => formatDate(requireDate(text(args), zone(args)), 'iso', zone(args)),
}
