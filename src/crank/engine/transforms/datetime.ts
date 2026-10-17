import { addTime, diffTime, formatDate, requireDate, requireUnit, requireZone, startOfDay } from '../dates'
import { integer, text, type Args, type Transform } from './args'

const zone = (args: Args, name = 'timezone') => requireZone(args[name])
/** Input is read in `input_timezone` (default `timezone`); output is shown in `timezone`. */
const instant = (args: Args, name = 'value') => requireDate(args[name], requireZone(args.input_timezone ?? args.timezone), name)

export const dateTransforms: Record<string, Transform> = {
  'date.parse': args => {
    const ms = instant(args), tz = zone(args)
    return { iso: new Date(ms).toISOString(), local: formatDate(ms, 'iso', tz), date: formatDate(ms, 'date', tz), unix: Math.floor(ms / 1000), timezone: tz }
  },
  'date.format': args => formatDate(instant(args), typeof args.pattern === 'string' ? args.pattern : 'iso', zone(args)),
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
