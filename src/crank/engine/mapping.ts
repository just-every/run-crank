import { StepError } from './errors'
import { runTransform } from './transforms'
import { isObject, kindOf, lookup, textOf } from './values'

/** What a mapping can read: the trigger payload, earlier step outputs and run facts. */
export interface Scope { trigger: unknown; steps: Record<string, unknown>; run: Record<string, unknown>; item?: unknown }
const TOKEN = /\{\{\s*([A-Za-z_][\w.\-[\]]*)\s*\}\}/g

export function read(scope: Scope, path: string) { return lookup(scope, path) }

/** Mapped values: `{{path}}` text (a lone token keeps its type), `{"$ref":path}`,
 * `{"$fn":name,"args":{…}}` built-in transforms and `{"$literal":value}`.
 * A missing reference stays missing (the key is omitted); null and "" pass through. */
export function resolve(value: unknown, scope: Scope, depth = 0): unknown {
  if (depth > 32) throw new StepError('mapping', 'Mapping nests too deeply')
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z_][\w.\-[\]]*)\s*\}\}$/.exec(value)
    if (whole) return read(scope, whole[1]).value
    if (!value.includes('{{')) return value
    return value.replace(TOKEN, (_, path: string) => {
      const found = read(scope, path)
      if (!found.found || found.value === null || found.value === undefined) return ''
      const text = textOf(found.value)
      return text ?? JSON.stringify(found.value)
    })
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, scope, depth + 1)).filter(item => item !== undefined)
  if (isObject(value)) {
    if ('$literal' in value) return value.$literal
    if (typeof value.$ref === 'string') return read(scope, value.$ref).value
    if (typeof value.$fn === 'string') return runTransform(value.$fn, resolve(value.args ?? {}, scope, depth + 1) as Record<string, unknown>)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolve(item, scope, depth + 1)
      if (resolved !== undefined) out[key] = resolved
    }
    return out
  }
  return value
}

/** Names the first required field that resolved missing, null or empty. */
export function requireFields(input: Record<string, unknown>, fields: string[], step: string) {
  for (const field of fields) {
    const found = lookup(input, field), kind = kindOf(found.found, found.value)
    if (kind !== 'value') throw new StepError('validation', `Step "${step}": required field "${field}" is ${kind}`, { field, kind })
  }
}
