import { StepError } from '../errors'
import { n8nDateValue } from './n8n-date-value'

const mismatch = (): never => { throw new StepError('type_mismatch', 'Condition operand cannot be converted to its declared type') }

/** Data grammar v1: JSON values plus single-quoted strings, identifier keys and
 * trailing commas. No source expression, property access or code is evaluated. */
export function parseN8nConditionObject(source: string): Record<string, unknown> | null {
  if (source.length > 16384) return mismatch()
  let at = 0, values = 0
  const fail = (): never => mismatch()
  const space = () => { while (/[ \t\r\n]/.test(source[at] ?? '') && at < source.length) at++ }
  const take = (token: string) => { space(); if (source[at] !== token) return false; at++; return true }
  const string = (): string => {
    const quote = source[at++]; let result = ''
    while (at < source.length) {
      const char = source[at++]
      if (char === quote) return result
      if (char.charCodeAt(0) < 32) return fail()
      if (char !== '\\') { result += char; continue }
      const escaped = source[at++]
      if (escaped === 'u') {
        const hex = source.slice(at, at + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail()
        result += String.fromCharCode(parseInt(hex, 16)); at += 4
      } else {
        const escapes: Record<string, string> = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (!Object.hasOwn(escapes, escaped)) return fail()
        result += escapes[escaped]
      }
    }
    return fail()
  }
  const value = (depth: number): unknown => {
    if (depth > 16 || ++values > 1000) return fail()
    space()
    const char = source[at]
    if (char === '"' || char === "'") return string()
    if (char === '{') {
      at++; const result: Record<string, unknown> = {}
      if (take('}')) return result
      do {
        space(); let key: string
        if (source[at] === '"' || source[at] === "'") key = string()
        else {
          const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(at))
          if (!identifier) return fail()
          key = identifier[0]; at += key.length
        }
        if (!take(':')) return fail()
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true })
        if (take('}')) return result
        if (!take(',')) return fail()
        if (take('}')) return result
      } while (at < source.length)
      return fail()
    }
    if (char === '[') {
      at++; const result: unknown[] = []
      if (take(']')) return result
      do {
        result.push(value(depth + 1))
        if (take(']')) return result
        if (!take(',')) return fail()
        if (take(']')) return result
      } while (at < source.length)
      return fail()
    }
    for (const [token, literal] of [['null', null], ['true', true], ['false', false]] as const) {
      if (source.startsWith(token, at)) { at += token.length; return literal }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at))
    if (!number || !Number.isFinite(Number(number[0]))) return fail()
    at += number[0].length; return Number(number[0])
  }
  const result = value(0); space()
  if (at !== source.length || result !== null && (typeof result !== 'object' || Array.isArray(result))) return fail()
  return result as Record<string, unknown> | null
}

/** Source defaults are loose validation and condition version 1. Null, missing
 * values and any-typed operands pass through before all conversion rules. */
export function normalizeN8nConditionValue(value: unknown, type: string, strict = false, version = 1): unknown {
  if (type === 'any' || value === null || value === undefined) return value
  if(type==='dateTime')return n8nDateValue(value)
  if (type === 'boolean' && !strict) {
    if (version >= 2) {
      try {
        if (typeof value === 'boolean') return value
        if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) return value.toLowerCase() === 'true'
        if (!(typeof value === 'string' && value.trim() === '')) {
          const number = Number(value)
          if (number === 0) return false
          if (number === 1) return true
        }
      } catch {
        // The source treats a failed boolean conversion as a truthiness check.
      }
    }
    return Boolean(value)
  }
  if (type === 'number') {
    if (Number.isNaN(value)) return value
    if (version >= 3 && ((typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0))) return null
  }
  if (!['number', 'string', 'boolean', 'array', 'object'].includes(type)) throw new StepError('validation', 'Condition operand type requires an explicit native conversion')
  try {
    switch (type) {
      case 'number':
        if (strict && typeof value !== 'number') return mismatch()
        if (Number.isNaN(Number(value))) return mismatch()
        return Number(value)
      case 'string':
        if (strict && typeof value !== 'string') return mismatch()
        if (typeof value === 'object') return JSON.stringify(value)
        if (['string', 'bigint', 'boolean', 'number'].includes(typeof value)) return value.toString()
        return String(value)
      case 'boolean':
        if (typeof value !== 'boolean') return mismatch()
        return value
      case 'array': {
        if (Array.isArray(value)) return value
        if (strict) return mismatch()
        let parsed: unknown
        try { parsed = JSON.parse(String(value)) }
        catch { parsed = JSON.parse(String(value).replace(/'/g, '"')) }
        return Array.isArray(parsed) ? parsed : mismatch()
      }
      case 'object':
        if (typeof value === 'object' && !Array.isArray(value)) return value
        if (!strict && typeof value === 'string') return parseN8nConditionObject(value)
        return mismatch()
      default:
        throw new StepError('validation', 'Condition operand type requires an explicit native conversion')
    }
  } catch {
    return mismatch()
  }
}
