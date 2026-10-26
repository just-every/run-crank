import { StepError } from '../errors'

const mismatch = (): never => { throw new StepError('type_mismatch', 'Condition operand cannot be converted to its declared type') }

/** Source defaults are loose validation and condition version 1. Null, missing
 * values and any-typed operands pass through before all conversion rules. */
export function normalizeN8nConditionValue(value: unknown, type: string, strict = false, version = 1): unknown {
  if (type === 'any' || value === null || value === undefined) return value
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
        return mismatch()
      default:
        throw new StepError('validation', 'Condition operand type requires an explicit native conversion')
    }
  } catch {
    return mismatch()
  }
}
