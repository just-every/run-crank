import { businessCalendar } from './calendar'
import { StepError } from './errors'

/** IANA timezone arithmetic on Intl, so DST and wall times stay exact in Workers. */
export interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond?: number }
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string) {
  let value = formatters.get(zone)
  if (!value) {
    try {
      value = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch { throw new StepError('validation', `Unknown timezone: ${zone}`) }
    formatters.set(zone, value)
  }
  return value
}
export function requireZone(zone: unknown, fallback = 'America/New_York'): string {
  const value = zone === undefined || zone === null || zone === '' ? fallback : zone
  if (typeof value !== 'string') throw new StepError('validation', 'Timezone must be an IANA name')
  formatter(value)
  return value
}
export function wallTime(ms: number, zone: string): WallTime & { weekday: number } {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map(part => [part.type, part.value]))
  const wall = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), millisecond: ((ms % 1000) + 1000) % 1000 }
  return { ...wall, weekday: new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() }
}
export function offsetMinutes(ms: number, zone: string): number {
  const w = wallTime(ms, zone)
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond) - ms) / 60000)
}
/** Local wall time to an instant. A time skipped by DST moves forward by the gap;
 * a repeated time resolves to its first occurrence. */
export function fromWallTime(wall: WallTime, zone: string): number {
  const local = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond ?? 0)
  const offsets = [...new Set([offsetMinutes(local - 86400000, zone), offsetMinutes(local, zone), offsetMinutes(local + 86400000, zone)])]
  const matches = offsets.map(offset => local - offset * 60000).filter(ms => {
    const w = wallTime(ms, zone)
    return w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute
  }).sort((a, b) => a - b)
  if (matches.length) return matches[0]
  return local - offsetMinutes(local - 86400000, zone) * 60000
}
export const dateKey = (wall: { year: number; month: number; day: number }) => `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function monthNumber(name: string): number {
  const index = MONTHS.findIndex(month => month.startsWith(name.toLowerCase().replace(/\.$/, '')) && name.length >= 3)
  return index + 1
}
function clock(hourText?: string, minuteText?: string, secondText?: string, meridiem?: string) {
  let hour = Number(hourText ?? 0)
  const minute = Number(minuteText ?? 0), second = Number(secondText ?? 0)
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    const pm = /^p/i.test(meridiem)
    hour = hour % 12 + (pm ? 12 : 0)
  }
  if (hour > 23 || minute > 59 || second > 59) return null
  return { hour, minute, second }
}
function validDate(year: number, month: number, day: number) {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** ISO 8601, Unix seconds or milliseconds, and common US formats, read in `zone`. */
export function parseDate(value: unknown, zone: string): { ms: number; dateOnly: boolean } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { ms: value > 1e11 ? value : value * 1000, dateOnly: false }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (/^\d{9,10}$/.test(text)) return { ms: Number(text) * 1000, dateOnly: false }
  if (/^\d{12,13}$/.test(text)) return { ms: Number(text), dateOnly: false }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(text)
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!validDate(year, month, day)) return null
    const time = clock(m[4], m[5], m[6]); if (!time) return null
    const millisecond = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0
    if (m[8]) {
      const offset = m[8].toUpperCase() === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].replace(':', '').slice(3, 5) || 0))
      return { ms: Date.UTC(year, month - 1, day, time.hour, time.minute, time.second, millisecond) - offset * 60000, dateOnly: false }
    }
    return { ms: fromWallTime({ year, month, day, ...time, millisecond }, zone), dateOnly: !m[4] }
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?)?$/.exec(text)
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), month = Number(m[1]), day = Number(m[2])
    if (!validDate(year, month, day)) return null
    const time = clock(m[4], m[5], m[6], m[7]); if (!time) return null
    return { ms: fromWallTime({ year, month, day, ...time }, zone), dateOnly: !m[4] }
  }
  m = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:(?:\s+at)?[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?)?$/.exec(text)
  if (m) {
    const month = monthNumber(m[1]), year = Number(m[3]), day = Number(m[2])
    if (!month || !validDate(year, month, day)) return null
    const time = clock(m[4], m[5], m[6], m[7]); if (!time) return null
    return { ms: fromWallTime({ year, month, day, ...time }, zone), dateOnly: !m[4] }
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9}\.?)\s+(\d{4})$/.exec(text)
  if (m) {
    const month = monthNumber(m[2]), year = Number(m[3]), day = Number(m[1])
    if (!month || !validDate(year, month, day)) return null
    return { ms: fromWallTime({ year, month, day, hour: 0, minute: 0, second: 0 }, zone), dateOnly: true }
  }
  return null
}
export function requireDate(value: unknown, zone: string, label = 'date'): number {
  const parsed = parseDate(value, zone)
  if (!parsed) throw new StepError('validation', `${label} could not be parsed: ${JSON.stringify(value)}`)
  return parsed.ms
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Pattern tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a Z; `iso` and `date` presets. */
export function formatDate(ms: number, pattern: string, zone: string): string {
  const w = wallTime(ms, zone), offset = offsetMinutes(ms, zone)
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  const zoneText = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
  if (pattern === 'iso') return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${zoneText}`
  if (pattern === 'date') return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
  const hour12 = w.hour % 12 || 12
  const tokens: Record<string, string> = {
    YYYY: pad(w.year, 4), YY: pad(w.year % 100), MMMM: MONTHS[w.month - 1][0].toUpperCase() + MONTHS[w.month - 1].slice(1),
    MMM: MONTHS[w.month - 1].slice(0, 1).toUpperCase() + MONTHS[w.month - 1].slice(1, 3), MM: pad(w.month), M: String(w.month),
    DD: pad(w.day), D: String(w.day), dddd: DAYS[w.weekday], ddd: DAYS[w.weekday].slice(0, 3),
    HH: pad(w.hour), H: String(w.hour), hh: pad(hour12), h: String(hour12), mm: pad(w.minute), ss: pad(w.second),
    A: w.hour < 12 ? 'AM' : 'PM', a: w.hour < 12 ? 'am' : 'pm', Z: zoneText,
  }
  return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A|a|Z/g, (token, literal) => literal ?? tokens[token])
}

export type DateUnit = 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds' | 'business_days'
const UNITS: DateUnit[] = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'business_days']
export function requireUnit(value: unknown): DateUnit {
  const unit = typeof value === 'string' ? (value.endsWith('s') ? value : value + 's') : ''
  if (!UNITS.includes(unit as DateUnit)) throw new StepError('validation', `Unknown time unit: ${JSON.stringify(value)}`)
  return unit as DateUnit
}
/** Calendar units keep the wall time in `zone`; business days skip the calendar's weekends and holidays. */
export function addTime(ms: number, amount: number, unit: DateUnit, zone: string, calendar?: unknown): number {
  if (!Number.isInteger(amount)) throw new StepError('validation', 'Time amounts must be whole numbers')
  if (unit === 'seconds') return ms + amount * 1000
  if (unit === 'minutes') return ms + amount * 60000
  if (unit === 'hours') return ms + amount * 3600000
  const w = wallTime(ms, zone)
  if (unit === 'business_days') {
    const cal = businessCalendar(calendar), step = amount < 0 ? -1 : 1
    let remaining = Math.abs(amount), cursor = { year: w.year, month: w.month, day: w.day }
    while (remaining > 0) {
      const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + step))
      cursor = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
      if (!cal.weekend.includes(next.getUTCDay()) && !cal.isHoliday(dateKey(cursor))) remaining--
    }
    return fromWallTime({ ...w, ...cursor }, zone)
  }
  if (unit === 'days' || unit === 'weeks') {
    const next = new Date(Date.UTC(w.year, w.month - 1, w.day + amount * (unit === 'weeks' ? 7 : 1)))
    return fromWallTime({ ...w, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, zone)
  }
  const months = w.month - 1 + amount * (unit === 'years' ? 12 : 1)
  const year = w.year + Math.floor(months / 12), month = ((months % 12) + 12) % 12 + 1
  const day = Math.min(w.day, new Date(Date.UTC(year, month, 0)).getUTCDate())
  return fromWallTime({ ...w, year, month, day }, zone)
}
export function startOfDay(ms: number, zone: string): number {
  const w = wallTime(ms, zone)
  return fromWallTime({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0, second: 0 }, zone)
}
export function isBusinessDay(ms: number, zone: string, calendar?: unknown): boolean {
  const w = wallTime(ms, zone), cal = businessCalendar(calendar)
  return !cal.weekend.includes(w.weekday) && !cal.isHoliday(dateKey(w))
}
/** Whole units from `a` to `b` (truncated toward zero); days compare calendar dates in `zone`. */
export function diffTime(a: number, b: number, unit: DateUnit, zone: string, calendar?: unknown): number {
  const sign = b < a ? -1 : 1, [from, to] = b < a ? [b, a] : [a, b]
  if (unit === 'seconds') return sign * Math.floor((to - from) / 1000)
  if (unit === 'minutes') return sign * Math.floor((to - from) / 60000)
  if (unit === 'hours') return sign * Math.floor((to - from) / 3600000)
  const x = wallTime(from, zone), y = wallTime(to, zone)
  const days = Math.round((Date.UTC(y.year, y.month - 1, y.day) - Date.UTC(x.year, x.month - 1, x.day)) / 86400000)
  if (unit === 'days') return sign * days
  if (unit === 'weeks') return sign * Math.floor(days / 7)
  if (unit === 'business_days') {
    let count = 0
    for (let d = 1; d <= days; d++) if (isBusinessDay(addTime(from, d, 'days', zone), zone, calendar)) count++
    return sign * count
  }
  let months = (y.year - x.year) * 12 + (y.month - x.month)
  if (y.day < x.day || (y.day === x.day && y.hour * 3600 + y.minute * 60 + y.second < x.hour * 3600 + x.minute * 60 + x.second)) months--
  return sign * (unit === 'years' ? Math.floor(months / 12) : months)
}
