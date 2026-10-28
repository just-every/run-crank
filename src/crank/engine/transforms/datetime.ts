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
    const calendarUnit = ['years', 'months', 'weeks', 'days'].includes(unit), start = wallTime(ms, tz)
    const rangeError = () => new StepError('validation', 'Source date arithmetic is outside the supported calendar range')
    if (start.year < 100 || start.year > 9999) throw rangeError()
    let localTarget: number | undefined
    if (calendarUnit) {
      // The native calendar uses Date.UTC, which interprets years below 100
      // as twentieth-century years. Refuse a crossing before that conversion.
      const target = new Date(0)
      if (unit === 'years' || unit === 'months') target.setUTCFullYear(start.year, start.month - 1 + amount * (unit === 'years' ? 12 : 1), 1)
      else target.setUTCFullYear(start.year, start.month - 1, start.day + amount * (unit === 'weeks' ? 7 : 1))
      if (target.getUTCFullYear() < 100 || target.getUTCFullYear() > 9999) throw rangeError()
      if (unit === 'years' || unit === 'months') target.setUTCDate(Math.min(start.day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()))
      target.setUTCHours(start.hour, start.minute, start.second, start.millisecond)
      localTarget = target.getTime()
    }
    const wholeMinuteOffset = (value: number) => {
      const w = wallTime(value, tz)
      return (Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond) - value) % 60000 === 0
    }
    if (!wholeMinuteOffset(ms)) throw new StepError('validation', 'Source date arithmetic does not support historical sub-minute timezone offsets')
    let next: number
    if (localTarget !== undefined) {
      // Resolve the target wall time with the source offset as the initial
      // guess, following Luxon's fixOffset. A third historical offset may
      // select either occurrence; skipped times move forward by the gap.
      const initialOffset = offsetMinutes(ms, tz)
      next = localTarget - initialOffset * 60000
      const guessedOffset = offsetMinutes(next, tz)
      if (guessedOffset !== initialOffset) {
        next -= (guessedOffset - initialOffset) * 60000
        const adjustedOffset = offsetMinutes(next, tz)
        if (guessedOffset !== adjustedOffset) next = localTarget - Math.min(guessedOffset, adjustedOffset) * 60000
      }
    } else next = addTime(ms, amount, unit, tz)
    if (!Number.isFinite(next) || new Date(next).getUTCFullYear() < 100 || new Date(next).getUTCFullYear() > 9999 || wallTime(next, tz).year < 100 || wallTime(next, tz).year > 9999) throw rangeError()
    if (!wholeMinuteOffset(next)) throw new StepError('validation', 'Source date arithmetic does not support historical sub-minute timezone offsets')
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
