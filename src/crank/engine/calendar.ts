import { StepError } from './errors'
import { isObject } from './values'

/** A business calendar: weekend days (0=Sunday) and holiday dates (YYYY-MM-DD). */
export interface BusinessCalendar { weekend: number[]; isHoliday(date: string): boolean; name: string }

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()
function nth(y: number, m: number, day: number, n: number): number {
  const first = weekday(y, m, 1)
  return 1 + ((day - first + 7) % 7) + (n - 1) * 7
}
function last(y: number, m: number, day: number): number {
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate(), end = weekday(y, m, length)
  return length - ((end - day + 7) % 7)
}
/** Fixed-date holidays move to Friday when on Saturday and Monday when on Sunday (5 U.S.C. 6103). */
function observed(y: number, m: number, d: number): string[] {
  const day = weekday(y, m, d)
  if (day === 6) { const t = new Date(Date.UTC(y, m - 1, d - 1)); return [iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())] }
  if (day === 0) { const t = new Date(Date.UTC(y, m - 1, d + 1)); return [iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())] }
  return [iso(y, m, d)]
}
const federalCache = new Map<number, Set<string>>()
export function usFederalHolidays(year: number): Set<string> {
  let days = federalCache.get(year)
  if (days) return days
  days = new Set([
    ...observed(year, 1, 1), iso(year, 1, nth(year, 1, 1, 3)), iso(year, 2, nth(year, 2, 1, 3)),
    iso(year, 5, last(year, 5, 1)), ...observed(year, 6, 19), ...observed(year, 7, 4),
    iso(year, 9, nth(year, 9, 1, 1)), iso(year, 10, nth(year, 10, 1, 2)), ...observed(year, 11, 11),
    iso(year, 11, nth(year, 11, 4, 4)), ...observed(year, 12, 25),
    // New Year's Day of the next year can be observed on 31 December.
    ...observed(year + 1, 1, 1).filter(date => date.startsWith(String(year))),
  ])
  federalCache.set(year, days)
  return days
}

/** `us_federal` (default), `weekends`, or `{holidays:[dates], weekend:[days], federal?:true}`. */
export function businessCalendar(value: unknown): BusinessCalendar {
  if (value === undefined || value === null || value === 'us_federal') return { name: 'us_federal', weekend: [0, 6], isHoliday: date => usFederalHolidays(Number(date.slice(0, 4))).has(date) }
  if (value === 'weekends') return { name: 'weekends', weekend: [0, 6], isHoliday: () => false }
  if (isObject(value)) {
    const holidays = Array.isArray(value.holidays) ? value.holidays : []
    if (holidays.some(day => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new StepError('validation', 'Calendar holidays must be YYYY-MM-DD dates')
    const weekend = Array.isArray(value.weekend) ? value.weekend : [0, 6]
    if (weekend.some(day => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) throw new StepError('validation', 'Calendar weekend days must be 0 (Sunday) to 6')
    const set = new Set(holidays as string[]), federal = value.federal === true
    return { name: 'custom', weekend: weekend as number[], isHoliday: date => set.has(date) || (federal && usFederalHolidays(Number(date.slice(0, 4))).has(date)) }
  }
  throw new StepError('validation', 'Unknown business calendar')
}
