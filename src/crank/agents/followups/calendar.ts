import { requireValue } from '../../model'

export interface ContactCalendar {
 timezone: string; weekdays: number[]; start: string; end: string; holiday_dates: string[]
 interval_minutes: number; daily_limit: number
}
/** ISO weekdays: Monday=1..Sunday=7. All cadence intervals are elapsed minutes.
 * Windows are recipient-local wall clock, start inclusive/end exclusive. An
 * overnight window belongs to its starting weekday. Holidays suppress both
 * that local date and shifts starting on a holiday. DST follows IANA mapping:
 * absent wall minutes never occur; repeated minutes remain subject to elapsed
 * cadence and one aggregate cap per local YYYY-MM-DD, across every obligation.
 */
export function validateCalendar(input: Record<string, unknown>): ContactCalendar {
 requireValue(typeof input.timezone === 'string' && input.timezone.length <= 100 && !/^[+-]/.test(input.timezone), 'Choose an explicit IANA timezone', 422)
 try { new Intl.DateTimeFormat('en', {timeZone:input.timezone}).format(0) } catch { requireValue(false, 'Choose a valid IANA timezone', 422) }
 requireValue(Array.isArray(input.weekdays) && input.weekdays.length > 0 && input.weekdays.every(d=>Number.isInteger(d) && d>=1 && d<=7), 'Choose working weekdays (Monday=1 through Sunday=7)', 422)
 const validClock = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)
 requireValue(validClock(input.start) && validClock(input.end) && input.start !== input.end, 'Choose distinct start and end times in HH:mm', 422)
 const holidays = input.holiday_dates ?? []
 requireValue(Array.isArray(holidays) && holidays.every(d=>typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d), 'Holiday dates must be real YYYY-MM-DD dates', 422)
 const interval = input.interval_minutes ?? 1440, limit = input.daily_limit ?? 1
 requireValue(Number.isSafeInteger(interval) && Number(interval)>=1 && Number.isSafeInteger(limit) && Number(limit)>=1, 'Cadence and daily limit must be positive whole numbers', 422)
 return {timezone:input.timezone,weekdays:[...new Set(input.weekdays as number[])].sort(),start:input.start,end:input.end,holiday_dates:[...new Set(holidays as string[])].sort(),interval_minutes:Number(interval),daily_limit:Number(limit)}
}
export function workingWindow(calendar: ContactCalendar, time: number): {open:boolean;local_day:string} {
 const parts = new Intl.DateTimeFormat('en-CA',{timeZone:calendar.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time))
 const part = (name:string)=>parts.find(p=>p.type===name)!.value
 const day = `${part('year')}-${part('month')}-${part('day')}`, minute = Number(part('hour'))*60+Number(part('minute'))
 const clock = (value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3))
 const start=clock(calendar.start), end=clock(calendar.end), overnight=start>end
 const anchor = overnight && minute<end ? new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10) : day
 const weekday = new Date(anchor+'T12:00:00Z').getUTCDay() || 7
 const inside = overnight ? minute>=start || minute<end : minute>=start && minute<end
 return {local_day:day,open:inside && calendar.weekdays.includes(weekday) && !calendar.holiday_dates.includes(day) && !calendar.holiday_dates.includes(anchor)}
}
export function readCalendar(row: {timezone:string;weekdays_json:string;start:string;end:string;holiday_dates_json:string;interval_minutes:number;daily_limit:number}): ContactCalendar {
 return {timezone:row.timezone,weekdays:JSON.parse(row.weekdays_json),start:row.start,end:row.end,holiday_dates:JSON.parse(row.holiday_dates_json),interval_minutes:row.interval_minutes,daily_limit:row.daily_limit}
}
