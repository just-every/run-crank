import { StepError } from '../errors'
import { isObject, lookup } from '../values'
import type { Transform } from './args'

type Row = Record<string, unknown>
type Scalar = string | number | boolean | null | undefined
const fail = (message: string): never => { throw new StepError('validation', message) }
const poison = new Set(['__proto__', 'prototype', 'constructor'])

/** Only declarative, own-property data paths are accepted. */
export function n8nStreamField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160
    || !/^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z0-9_]+)|(?:\[\d+\]))*$/.test(value)
    || value.replace(/\[(\d+)\]/g, '.$1').split('.').some(part => poison.has(part)))
    return fail('n8n stream fields require a safe declarative data path')
  return value
}

function read(row: Row, field: string, literal: boolean): unknown {
  if (Object.hasOwn(row, field)) return row[field]
  return literal ? undefined : lookup(row, field).value
}
function scalar(value: unknown): Scalar {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value as Scalar
  return fail('n8n sorting and duplicate comparison require scalar field values')
}
// lodash lt compares two strings lexically and otherwise converts JSON scalars to numbers.
const less = (a: Scalar, b: Scalar) => typeof a === 'string' && typeof b === 'string' ? a < b : Number(a) < Number(b)
function compare(a: Row, b: Row, fields: { field: string; direction: number }[], literal: boolean, lower: boolean) {
  for (const { field, direction } of fields) {
    let left = scalar(read(a, field, literal)), right = scalar(read(b, field, literal))
    if (lower && typeof left === 'string') left = left.toLowerCase()
    if (lower && typeof right === 'string') right = right.toLowerCase()
    if (left !== right) return (less(left, right) ? -1 : 1) * direction
  }
  return 0
}
function flattenedFields(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 32) return fail('n8n duplicate comparison exceeds the nesting bound')
  if (value === null || typeof value !== 'object') return [prefix]
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? prefix + '.' + key : key
    n8nStreamField(path)
    return flattenedFields(child, path, depth + 1)
  })
}
function dedupe(items: Row[], settings: Row): Row[] {
  const literal = settings.literal === true, mode = settings.compare
  if (items.some(row => Object.hasOwn(row, '__INDEX'))) return fail('n8n duplicate comparison reserves its source index field')
  const fieldsOf = (row: Row) => literal ? Object.keys(row).map(n8nStreamField) : flattenedFields(row)
  let keys = [...new Set(items.flatMap(fieldsOf))]
  if (mode === 'selectedFields') keys = settings.fields as string[]
  else if (mode === 'allFieldsExcept') {
    // The source uses the first item's flattened keys for this operation.
    if (!literal) keys = fieldsOf(items[0])
    keys = keys.filter(key => !(settings.fields as string[]).includes(key))
  }
  const fields = keys.map(field => ({ field, direction: 1 }))
  const ordered = items.map((row, index) => ({ row, index })).sort((a, b) => compare(a.row, b.row, fields, literal, false))
  for (const key of keys) {
    let type: string | undefined
    for (const { row } of ordered) {
      const value = scalar(read(row, key, literal))
      if (value === null && Number(settings.version) > 1) continue
      if (value === undefined) return fail('n8n duplicate comparison field is missing from an input item')
      if (type !== undefined && type !== typeof value) return fail('n8n duplicate comparison field types differ between items')
      type = typeof value
    }
  }
  const removed = new Set<number>()
  let previous = ordered[0]
  for (const candidate of ordered.slice(1)) {
    if (keys.every(key => read(candidate.row, key, literal) === read(previous.row, key, literal))) removed.add(candidate.index)
    else previous = candidate
  }
  return items.filter((_, index) => !removed.has(index))
}

/** Reviewed Aggregate v1 JSON semantics:
 * https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Transform/Aggregate/Aggregate.node.ts
 * Array-index output paths and overlapping destinations require manual conversion. */
export function n8nAggregateFields(value: unknown, literal: boolean): { field: string; output: string }[] {
  if (!Array.isArray(value) || !value.length || value.length > 25) return fail('n8n aggregation requires 1 to 25 individual fields')
  const outputs: string[] = []
  return value.map(raw => {
    if (!isObject(raw)) return fail('n8n aggregation requires reviewed individual field settings')
    const field = n8nStreamField(raw.field), output = n8nStreamField(raw.output)
    if ((!literal && (output.includes('[') || output.split('.').some(part => /^\d+$/.test(part))))
      || outputs.some(other => other === output || (!literal && (other.startsWith(output + '.') || output.startsWith(other + '.')))))
      return fail('n8n aggregation array-index outputs or overlapping field paths require manual conversion')
    outputs.push(output)
    return { field, output }
  })
}

function aggregateFields(items: Row[], settings: Row): Row[] {
  const literal = settings.literal === true, fields = n8nAggregateFields(settings.fields, literal)
  if (!items.length) return []
  const result: Row = {}
  for (const { field, output } of fields) {
    const values: unknown[] = []
    for (const item of items) {
      let value: unknown = item
      // lodash get prefers an exact own key, then follows object or array keys.
      const parts = literal || Object.hasOwn(item, field) ? [field] : field.replace(/\[(\d+)\]/g, '.$1').split('.')
      for (const part of parts) value = value !== null && typeof value === 'object' && Object.hasOwn(value, part)
        ? (value as Row)[part] : undefined
      if (settings.keepMissing !== true) {
        if (Array.isArray(value)) value = value.filter(entry => entry !== null)
        else if (value === null || value === undefined) continue
      }
      if (Array.isArray(value) && settings.mergeLists === true) for (const entry of value) values.push(entry)
      else values.push(value ?? null)
    }
    const parts = literal ? [output] : output.split('.'), leaf = parts.pop()!
    let target = result
    for (const part of parts) {
      if (!Object.hasOwn(target, part)) target[part] = {}
      target = target[part] as Row
    }
    target[leaf] = values
  }
  return [result]
}

/** Bounded JSON item streams; native mappings admit only the reviewed settings.
 * Empty streams propagate because n8n does not invoke a downstream node without items.
 * Official node implementations: https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/Transform
 * Sort and dedupe deliberately reject non-scalar comparison values rather than emulate object coercion. */
export const n8nStream: Transform = args => {
  const max = args.max_items ?? 1000, items = args.items, settings = args.settings
  if (!Number.isSafeInteger(max) || Number(max) < 1 || Number(max) > 1000) return fail('n8n stream item bound must be from 1 to 1000')
  if (!Array.isArray(items) || items.some(item => !isObject(item))) return fail('n8n stream requires JSON object items')
  if (!isObject(settings)) return fail('n8n stream requires reviewed settings')
  const checked = (rows: Row[]) => {
    if (rows.length > Number(max) || new TextEncoder().encode(JSON.stringify(rows)).length > 1024 * 1024)
      return fail('n8n stream exceeds the retained item or byte bound')
    return rows
  }
  checked(items)
  let result: Row[]
  switch (args.operation) {
    case 'limit': {
      const count = settings.count
      if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 1000
        || !['firstItems', 'lastItems'].includes(String(settings.keep))) return fail('n8n limit requires a positive bounded count and a keep policy')
      result = settings.keep === 'firstItems' ? items.slice(0, Number(count)) : items.slice(Math.max(0, items.length - Number(count)))
      break
    }
    case 'sort': {
      if (!Array.isArray(settings.fields) || !settings.fields.length) return fail('n8n sort requires fields')
      const fields = settings.fields.map(raw => {
        if (!isObject(raw) || ![1, -1].includes(Number(raw.direction))) return fail('n8n sort requires a field direction')
        return { field: n8nStreamField(raw.field), direction: Number(raw.direction) }
      })
      if (!items.length) return []
      for (const { field } of fields) {
        if (!items.some(item => read(item, field, settings.literal === true) !== undefined)) return fail('n8n sort field is absent from every input item')
        items.forEach(item => scalar(read(item, field, settings.literal === true)))
      }
      result = [...items].sort((a, b) => compare(a, b, fields, settings.literal === true, true))
      break
    }
    case 'dedupe':
      if (!['allFields', 'selectedFields', 'allFieldsExcept'].includes(String(settings.compare))
        || ![1, 1.1, 2].includes(Number(settings.version))) return fail('n8n duplicate comparison requires a supported mode and version')
      if (settings.compare !== 'allFields' && (!Array.isArray(settings.fields) || !settings.fields.length)) return fail('n8n duplicate comparison requires fields')
      if (Array.isArray(settings.fields)) settings.fields.forEach(n8nStreamField)
      result = items.length ? dedupe(items, settings) : []
      break
    case 'aggregate': {
      const field = n8nStreamField(settings.field)
      if (field.includes('.') || field.includes('[')) return fail('n8n aggregation requires a simple output field')
      const include = settings.include ?? 'allFields', fields = settings.fields ?? []
      if (!['allFields', 'specifiedFields', 'allFieldsExcept'].includes(String(include)) || !Array.isArray(fields) || fields.length > 25
        || (include === 'allFields' && fields.length)) return fail('n8n aggregation requires reviewed field selectors')
      fields.forEach(n8nStreamField)
      // Source selectors match literal top-level keys and omit empty projections.
      const selected = !fields.length ? items : items.flatMap(item => {
        const row = Object.fromEntries(Object.entries(item).filter(([key]) => include === 'specifiedFields' ? fields.includes(key) : !fields.includes(key)))
        return Object.keys(row).length ? [row] : []
      })
      result = items.length ? [{ [field]: selected }] : []
      break
    }
    case 'aggregateFields':
      result = aggregateFields(items, settings)
      break
    default: return fail('n8n stream operation has no reviewed native mapping')
  }
  return checked(result)
}
