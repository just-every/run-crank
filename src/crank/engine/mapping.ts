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
    if (typeof value.$fn === 'string') {
      const args = resolve(value.args ?? {}, scope, depth + 1) as Record<string, unknown>
      try { return runTransform(value.$fn, args) } catch (error) { throw missingField(value.args, scope, error) ?? error }
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolve(item, scope, depth + 1)
      if (resolved !== undefined) out[key] = resolved
    }
    return out
  }
  return value
}

const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean)

/** A transform that failed on an input its mapping could not read reports that field instead: the
 * path, and the keys beside it that share a word with it (`amount` → `amount_total`). Only an input
 * the transform's own error names counts ("a is not a number"), so other failures keep their message. */
export function missingField(args: unknown, scope: Scope, error: unknown): StepError | null {
  if (!(error instanceof StepError) || !isObject(args)) return null
  const refs = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') { const whole = /^\{\{\s*([A-Za-z_][\w.\-[\]]*)\s*\}\}$/.exec(value); if (whole) out.push(whole[1]) }
    else if (Array.isArray(value)) value.forEach(item => refs(item, out))
    else if (isObject(value)) { if (typeof value.$ref === 'string') out.push(value.$ref); else if (!('$literal' in value) && typeof value.$fn !== 'string') Object.values(value).forEach(item => refs(item, out)) }
    return out
  }
  const named = Object.entries(args).filter(([key]) => new RegExp(`(^|[^\\w])${key.replace(/[^\w]/g, '')}([^\\w]|$)`).test(error.message))
  const path = named.flatMap(([, value]) => refs(value)).find(ref => !read(scope, ref).found)
  if (!path) return null
  const parts = path.split('.'), name = parts.at(-1)!
  let parent = parts.length - 1
  while (parent > 0 && !read(scope, parts.slice(0, parent).join('.')).found) parent--
  const at = parts.slice(0, parent).join('.'), holder = parent ? read(scope, at).value : null
  const wanted = words(name.replace(/\[\d+\]$/, ''))
  const similar = parent === parts.length - 1 && isObject(holder) ? Object.keys(holder).filter(key => key !== name && words(key).some(w => wanted.includes(w))).slice(0, 3) : []
  const missing = parent === parts.length - 1 ? name : parts.slice(parent).join('.')
  return new StepError('mapping', `Field ${missing} not found${at ? ` in ${at}` : ''}${similar.length ? `; it has ${similar.join(', ')}` : ''}`, { field: path, ...(similar.length ? { similar } : {}) })
}

/** Names the first required field that resolved missing, null or empty. */
export function requireFields(input: Record<string, unknown>, fields: string[], step: string) {
  for (const field of fields) {
    const found = lookup(input, field), kind = kindOf(found.found, found.value)
    if (kind !== 'value') throw new StepError('validation', `Step "${step}": required field "${field}" is ${kind}`, { field, kind })
  }
}
