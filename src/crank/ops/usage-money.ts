import { requireValue } from '../model'

/** SQLite owns 64-bit integer arithmetic; D1 binds/returns strings to avoid JS rounding. */
export const USD_SCALE = 100_000_000n
export function usdUnits(value: unknown, label = 'USD amount'): string {
  requireValue(typeof value === 'string' && /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(value), `${label} must be a nonnegative USD decimal string with at most eight decimal places`)
  const [whole, fraction = ''] = (value as string).split('.')
  const units = BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(8, '0'))
  requireValue(units <= 4_000_000_000n * USD_SCALE, `${label} must not exceed USD 4 billion`)
  return String(units)
}
export function unitsUsd(value: string | number | bigint): string {
  const units = BigInt(value), sign = units < 0n ? '-' : '', magnitude = units < 0n ? -units : units
  const fraction = String(magnitude % USD_SCALE).padStart(8, '0').replace(/0+$/, '')
  return sign + String(magnitude / USD_SCALE) + (fraction ? '.' + fraction : '')
}
export const utcMonth = () => new Date().toISOString().slice(0, 7)
export function usageMonth(value: string | null = null): string {
  const month = value ?? utcMonth()
  requireValue(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month), 'month must be YYYY-MM in UTC')
  return month
}
