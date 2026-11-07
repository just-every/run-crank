import type { JsonSchema } from './types.ts'

type ObjectSchema = Record<string, unknown>
const object = (value: unknown): value is ObjectSchema =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const formats = new Set(['date-time', 'date', 'time', 'email', 'uuid', 'uri', 'uri-reference', 'hostname', 'ipv4', 'ipv6', 'regex'])
const annotations = new Set(['title', 'description', '$comment', '$schema', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'])
const keywords = new Set([
  ...annotations, '$defs', '$ref', 'type', 'properties', 'patternProperties', 'required', 'additionalProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'pattern', 'format', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'not',
])
const natural = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const regexValid = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try { new RegExp(value, 'u'); return true } catch { return false }
}

function jsonValue(value: unknown, visiting = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || visiting.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  visiting.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => jsonValue(item, visiting)) && Object.keys(value).length === value.length
    : Object.values(value).every(item => jsonValue(item, visiting))
  visiting.delete(value)
  return valid
}

function reference(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === '#') return root
  if (!ref.startsWith('#/$defs/')) return undefined
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (/~(?:[^01]|$)/.test(part)) return undefined
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!object(node) || !owns(node, key)) return undefined
    node = node[key]
  }
  return typeof node === 'boolean' || object(node) ? node : undefined
}

/** Unsupported assertion keywords and formats are rejected at registration. */
export function schemaValid(schema: unknown): schema is JsonSchema {
  const seen = new Set<object>()
  const check = (node: unknown): node is JsonSchema => {
    if (typeof node === 'boolean') return true
    if (!object(node)) return false
    if (seen.has(node)) return true
    seen.add(node)
    for (const [key, value] of Object.entries(node)) {
      if (!keywords.has(key)) return false
      if (['title', 'description', '$comment', '$schema', '$ref'].includes(key) && typeof value !== 'string') return false
      if (['deprecated', 'readOnly', 'writeOnly', 'uniqueItems'].includes(key) && typeof value !== 'boolean') return false
      if (key === 'examples' && (!Array.isArray(value) || !jsonValue(value))) return false
      if (['default', 'const'].includes(key) && !jsonValue(value)) return false
      if (key === 'type') {
        const entries = Array.isArray(value) ? value : [value]
        if (!entries.length || new Set(entries).size !== entries.length || entries.some(item => typeof item !== 'string' || !types.has(item))) return false
      }
      if (['$defs', 'properties', 'patternProperties'].includes(key)) {
        if (!object(value) || Object.entries(value).some(([name, item]) =>
          (key === 'patternProperties' && !regexValid(name)) || !check(item))) return false
      }
      if (['additionalProperties', 'items', 'not'].includes(key) && !check(value)) return false
      if (['prefixItems', 'oneOf', 'anyOf', 'allOf'].includes(key)) {
        if (!Array.isArray(value) || !value.length || !value.every(check)) return false
      }
      if (key === 'required' && (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length)) return false
      if (['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties'].includes(key) && !natural(value)) return false
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key) && !finite(value)) return false
      if (key === 'multipleOf' && (value as number) <= 0) return false
      if (key === 'pattern' && !regexValid(value)) return false
      if (key === 'format' && (typeof value !== 'string' || !formats.has(value))) return false
      if (key === 'enum' && (!Array.isArray(value) || !value.length || !jsonValue(value) || value.some((item, index) => value.slice(0, index).some(other => equal(item, other))))) return false
    }
    if ('$ref' in node) {
      const target = reference(schema as JsonSchema, node.$ref as string)
      if (target === undefined || !check(target)) return false
    }
    return true
  }
  try { return jsonValue(schema) && check(schema) } catch { return false }
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]))
  if (object(left) && object(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => owns(right, key) && equal(left[key], right[key]))
  return false
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null
    case 'object': return object(value)
    case 'array': return Array.isArray(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    default: return typeof value === type
  }
}

function date(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}
function time(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
}
function format(value: string, name: string): boolean {
  switch (name) {
    case 'date': return date(value)
    case 'time': return time(value)
    case 'date-time': {
      const parts = value.split(/[tT]/)
      return parts.length === 2 && date(parts[0]!) && time(parts[1]!)
    }
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    case 'uuid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    case 'hostname': return value.length <= 253 && value.replace(/\.$/, '').split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    case 'ipv4': return /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255)
    case 'ipv6': try { return value.includes(':') && new URL(`http://[${value}]/`).hostname.startsWith('[') } catch { return false }
    case 'regex': return regexValid(value)
    case 'uri': try { return !/[\s<>]/.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value) && !!new URL(value) } catch { return false }
    case 'uri-reference': try { return !/[\s<>]/.test(value) && !!new URL(value, 'https://schema.invalid/') } catch { return false }
    default: return false
  }
}

export function validateSchema(schema: JsonSchema, value: unknown): boolean {
  if (!schemaValid(schema) || !jsonValue(value)) return false
  // Fail closed on reference cycles that do not consume a child instance.
  const active = new Map<JsonSchema, Set<unknown>>()
  const check = (node: JsonSchema, item: unknown): boolean => {
    if (typeof node === 'boolean') return node
    let instances = active.get(node)
    if (instances?.has(item)) return false
    if (!instances) { instances = new Set(); active.set(node, instances) }
    instances.add(item)
    try {
      if (typeof node.$ref === 'string' && !check(reference(schema, node.$ref)!, item)) return false
      if (node.type !== undefined && !(Array.isArray(node.type) ? node.type : [node.type]).some(type => hasType(item, type as string))) return false
      if (owns(node, 'const') && !equal(item, node.const)) return false
      if (Array.isArray(node.enum) && !node.enum.some(option => equal(option, item))) return false
      if (Array.isArray(node.allOf) && !node.allOf.every(child => check(child as JsonSchema, item))) return false
      if (Array.isArray(node.anyOf) && !node.anyOf.some(child => check(child as JsonSchema, item))) return false
      if (Array.isArray(node.oneOf) && node.oneOf.filter(child => check(child as JsonSchema, item)).length !== 1) return false
      if (node.not !== undefined && check(node.not as JsonSchema, item)) return false
      if (typeof item === 'number') {
        if (typeof node.minimum === 'number' && item < node.minimum) return false
        if (typeof node.maximum === 'number' && item > node.maximum) return false
        if (typeof node.exclusiveMinimum === 'number' && item <= node.exclusiveMinimum) return false
        if (typeof node.exclusiveMaximum === 'number' && item >= node.exclusiveMaximum) return false
        if (typeof node.multipleOf === 'number') {
          const quotient = item / node.multipleOf
          if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4) return false
        }
      }
      if (typeof item === 'string') {
        const length = Array.from(item).length
        if (typeof node.minLength === 'number' && length < node.minLength) return false
        if (typeof node.maxLength === 'number' && length > node.maxLength) return false
        if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(item)) return false
        if (typeof node.format === 'string' && !format(item, node.format)) return false
      }
      if (Array.isArray(item)) {
        if (typeof node.minItems === 'number' && item.length < node.minItems) return false
        if (typeof node.maxItems === 'number' && item.length > node.maxItems) return false
        if (node.uniqueItems === true && item.some((entry, index) => item.slice(0, index).some(other => equal(entry, other)))) return false
        const prefix = Array.isArray(node.prefixItems) ? node.prefixItems as JsonSchema[] : []
        if (!item.every((entry, index) => index < prefix.length ? check(prefix[index]!, entry) : node.items === undefined || check(node.items as JsonSchema, entry))) return false
      }
      if (object(item)) {
        const keys = Object.keys(item)
        if (typeof node.minProperties === 'number' && keys.length < node.minProperties) return false
        if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) return false
        if (Array.isArray(node.required) && node.required.some(key => !owns(item, key as string))) return false
        const properties = object(node.properties) ? node.properties : {}
        const patterns = object(node.patternProperties) ? Object.entries(node.patternProperties) : []
        for (const key of keys) {
          let covered = false
          if (owns(properties, key)) { covered = true; if (!check(properties[key] as JsonSchema, item[key])) return false }
          for (const [pattern, child] of patterns) if (new RegExp(pattern, 'u').test(key)) {
            covered = true
            if (!check(child as JsonSchema, item[key])) return false
          }
          if (!covered && node.additionalProperties !== undefined && !check(node.additionalProperties as JsonSchema, item[key])) return false
        }
      }
      return true
    } finally { instances.delete(item) }
  }
  try { return check(schema, value) } catch { return false }
}
