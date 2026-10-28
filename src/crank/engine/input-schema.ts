import { normalize, parseDecimal } from './decimal'
import { StepError } from './errors'
import { isObject, kindOf } from './values'

/** Installation-owned declarations; validation never coerces or removes fields. */
export interface InputSchema {
  type: 'object' | 'array' | 'string' | 'boolean' | 'decimal'
  required?: boolean
  nonempty?: boolean
  maxLength?: number
  pattern?: RegExp
  enum?: readonly string[]
  properties?: Record<string, InputSchema>
  items?: InputSchema
  minItems?: number
  decimalPlaces?: number
  discriminator?: { field: string; variants: Record<string, Record<string, InputSchema>> }
}

/** Read definite literals without evaluating transforms or inventing sample values. */
export function inputLiteral(value: unknown, depth = 0): { known: boolean; value?: unknown } {
  if (depth > 32) return { known: false }
  if (typeof value === 'string' && value.includes('{{')) return { known: false }
  if (isObject(value)) {
    if ('$literal' in value) return { known: true, value: value.$literal }
    if (typeof value.$ref === 'string' || typeof value.$fn === 'string') return { known: false }
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const literal = inputLiteral(child, depth + 1)
      if (!literal.known) return { known: false }
      result[key] = literal.value
    }
    return { known: true, value: result }
  }
  if (Array.isArray(value)) {
    const result = value.map(child => inputLiteral(child, depth + 1))
    return result.every(child => child.known) ? { known: true, value: result.map(child => child.value) } : { known: false }
  }
  return { known: true, value }
}

/** Defer mapped leaves on save, but still refuse definite errors beside them.
 * Literal wrappers disable mapping interpretation throughout their contents. */
export function validateInput(schema: InputSchema, input: unknown, step: string, mapped = false) {
  let remaining = 50000
  const visit = (rule: InputSchema, value: unknown, field: string, mappings: boolean, depth: number): void => {
    const fail = (reason: string, kind = kindOf(value !== undefined, value)): never => {
      throw new StepError('validation', `Step "${step}": field "${field}" ${reason}`, { field, kind, input_schema: true })
    }
    if (--remaining < 0 || depth > 32) fail('exceeds input validation bounds')
    if (mappings) {
      if (isObject(value) && '$literal' in value) { visit(rule, value.$literal, field, false, depth + 1); return }
      if ((typeof value === 'string' && value.includes('{{')) || (isObject(value) && (typeof value.$ref === 'string' || typeof value.$fn === 'string'))) return
    }
    const kind = kindOf(value !== undefined, value)
    if (kind === 'missing') { if (rule.required) fail('is missing'); return }
    if (kind === 'null') fail('is null')
    if (rule.nonempty && kind === 'empty') fail('is empty')
    if (rule.type === 'object') {
      if (!isObject(value)) fail('must be an object')
      const object = value as Record<string, unknown>
      for (const [key, child] of Object.entries(rule.properties ?? {})) visit(child, object[key], `${field}.${key}`, mappings, depth + 1)
      if (rule.discriminator) {
        const { field: tag, variants } = rule.discriminator
        let selected = object[tag], dynamic = mappings
        if (mappings && isObject(selected) && '$literal' in selected) { selected = selected.$literal; dynamic = false }
        if (typeof selected === 'string' && Object.hasOwn(variants, selected)) {
          for (const [key, child] of Object.entries(variants[selected])) visit(child, object[key], `${field}.${key}`, mappings, depth + 1)
        } else if (!dynamic || !(typeof selected === 'string' && selected.includes('{{') || isObject(selected) && (typeof selected.$ref === 'string' || typeof selected.$fn === 'string'))) {
          fail(`requires a supported ${tag}`)
        }
      }
    } else if (rule.type === 'array') {
      if (!Array.isArray(value)) fail('must be an array')
      const list = value as unknown[]
      if (list.length < (rule.minItems ?? 0)) fail('is empty; add at least one line')
      if (rule.items) list.forEach((item, index) => visit(rule.items!, item, `${field}[${index}]`, mappings, depth + 1))
    } else if (rule.type === 'string') {
      if (typeof value !== 'string') fail('must be text')
      const text = value as string
      if (rule.maxLength && text.length > rule.maxLength) fail(`must have at most ${rule.maxLength} characters`)
      if (rule.pattern && !rule.pattern.test(text)) fail('has an invalid format')
      if (rule.enum && !rule.enum.includes(text)) fail(`must be one of ${rule.enum.join(', ')}`)
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') fail('must be a boolean')
    } else {
      const decimal = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? parseDecimal(value) : null
      if (!decimal || decimal.units < 0n) fail('must be a nonnegative exact decimal')
      if (rule.decimalPlaces !== undefined && decimal && normalize(decimal).scale > rule.decimalPlaces) fail('must be exact USD cents')
    }
  }
  visit(schema, input, 'input', mapped, 0)
}
