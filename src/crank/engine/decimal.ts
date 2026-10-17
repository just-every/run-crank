import { StepError } from './errors'

/** Exact decimal arithmetic for amounts: a BigInt count of 10^-scale units. */
export interface Decimal { units: bigint; scale: number }
export type Rounding = 'half_up' | 'half_even' | 'up' | 'down'

const pow = (n: number) => 10n ** BigInt(n)

/** Parses `$1,234.50`, `-3`, `1234.5`, `(12.00)` and ISO currency prefixes; never guesses. */
export function parseDecimal(value: unknown): Decimal | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const number = value
    value = /e/i.test(String(number)) ? number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : String(number)
  }
  if (typeof value !== 'string') return null
  let text = value.trim()
  let negative = false
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim() }
  text = text.replace(/^(USD|US\$|[A-Z]{3})\s*/, '').replace(/\s*(USD|[A-Z]{3})$/, '')
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1).trim() }
  else if (text.startsWith('+')) text = text.slice(1).trim()
  text = text.replace(/^[$€£¥]\s*/, '')
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1).trim() }
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(text) || text === '' || text === '.') return null
  const [whole, fraction = ''] = text.replace(/,/g, '').split('.')
  const units = BigInt((whole || '0') + fraction) * (negative ? -1n : 1n)
  return { units, scale: fraction.length }
}

export function requireDecimal(value: unknown, label: string): Decimal {
  const parsed = parseDecimal(value)
  if (!parsed) throw new StepError('validation', `${label} is not a number: ${JSON.stringify(value)}`)
  return parsed
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [a.units * pow(scale - a.scale), b.units * pow(scale - b.scale), scale]
}
export const add = (a: Decimal, b: Decimal): Decimal => { const [x, y, scale] = align(a, b); return { units: x + y, scale } }
export const subtract = (a: Decimal, b: Decimal): Decimal => { const [x, y, scale] = align(a, b); return { units: x - y, scale } }
export const multiply = (a: Decimal, b: Decimal): Decimal => ({ units: a.units * b.units, scale: a.scale + b.scale })
export const negate = (a: Decimal): Decimal => ({ units: -a.units, scale: a.scale })
export const abs = (a: Decimal): Decimal => ({ units: a.units < 0n ? -a.units : a.units, scale: a.scale })
export function compare(a: Decimal, b: Decimal): number { const [x, y] = align(a, b); return x === y ? 0 : x < y ? -1 : 1 }

function divideUnits(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n)
  const n = numerator < 0n ? -numerator : numerator, d = denominator < 0n ? -denominator : denominator
  let q = n / d
  const r = n % d
  if (r !== 0n) {
    const twice = r * 2n
    if (mode === 'up') q += 1n
    else if (mode === 'half_up' && twice >= d) q += 1n
    else if (mode === 'half_even' && (twice > d || (twice === d && q % 2n === 1n))) q += 1n
  }
  return negative ? -q : q
}
export function round(a: Decimal, scale: number, mode: Rounding = 'half_up'): Decimal {
  if (scale >= a.scale) return { units: a.units * pow(scale - a.scale), scale }
  return { units: divideUnits(a.units, pow(a.scale - scale), mode), scale }
}
export function divide(a: Decimal, b: Decimal, scale = 10, mode: Rounding = 'half_up'): Decimal {
  if (b.units === 0n) throw new StepError('validation', 'Division by zero')
  // a/b = (a.units/10^as)/(b.units/10^bs); result units at `scale`.
  const numerator = a.units * pow(scale + b.scale), denominator = b.units * pow(a.scale)
  return { units: divideUnits(numerator, denominator, mode), scale }
}
export function toText(a: Decimal): string {
  const negative = a.units < 0n, digits = (negative ? -a.units : a.units).toString().padStart(a.scale + 1, '0')
  const whole = digits.slice(0, digits.length - a.scale), fraction = a.scale ? '.' + digits.slice(-a.scale) : ''
  return (negative ? '-' : '') + whole + fraction
}
/** Drops trailing zeros beyond `minScale` so `64.9200` stays `64.92`. */
export function normalize(a: Decimal, minScale = 0): Decimal {
  let { units, scale } = a
  while (scale > minScale && units % 10n === 0n) { units /= 10n; scale-- }
  return { units, scale }
}
/** A JSON number when it round-trips exactly; otherwise the exact decimal text. */
export function toJson(a: Decimal): number | string {
  const text = toText(normalize(a)), number = Number(text)
  return Number.isSafeInteger(Math.trunc(number)) && String(number) === text ? number : text
}
export const isZero = (a: Decimal) => a.units === 0n
export const fromInt = (n: number): Decimal => ({ units: BigInt(n), scale: 0 })
