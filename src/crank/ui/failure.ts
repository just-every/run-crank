// A failed run's cause in plain words. The engine names a field its mapping could not read
// (`field`, with the keys beside it that share a word, `similar`); when a newer version of the
// same step reads one of those keys instead, the field was renamed and that version reads it.
import type { Graph } from '../engine/graph'
import { esc } from './document'
import { findNode } from './editor/model'

export interface Rename { from: string; to: string; version: number }

/** Every field a step reads: `{{path}}` tokens, `$ref`s and condition fields. */
export const refsOf = (value: unknown) => new Set([...JSON.stringify(value ?? null).matchAll(/\{\{\s*([A-Za-z_][\w.\-[\]]*)\s*\}\}|"\$ref":"([^"]+)"|"field":"([^"]+)"/g)].map(m => m[1] ?? m[2] ?? m[3]))
const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/).filter(Boolean)

/** Fields one version stopped reading and the next read instead, beside them and sharing a word
 * (`…object.amount` → `…object.amount_total`), with how many steps made that change. */
export function renamesBetween(before: Graph, after: Graph, paths: Iterable<string>) {
  const out = new Map<string, { from: string; to: string; steps: number }>()
  for (const path of paths) {
    const old = findNode(before, path)?.step, now = findNode(after, path)?.step
    if (!old || !now) continue
    const own = (step: typeof old) => refsOf(step.type === 'paths' ? (step.branches as any[] ?? []).map(b => b.when) : step)
    const a = own(old), b = own(now)
    for (const gone of [...a].filter(r => !b.has(r))) {
      const parent = gone.split('.').slice(0, -1).join('.'), name = gone.split('.').at(-1)!
      const added = [...b].find(r => !a.has(r) && r.split('.').slice(0, -1).join('.') === parent && words(r.split('.').at(-1)!).some(w => words(name).includes(w)))
      if (!added) continue
      const to = added.split('.').at(-1)!, key = `${name}→${to}`
      out.set(key, { from: name, to, steps: (out.get(key)?.steps ?? 0) + 1 })
    }
  }
  return [...out.values()]
}

/** The rename a newer version made for the field this step could not read, if it made one. */
export function renameOf(error: any, path: string | undefined, newer: { graph: Graph; number: number } | null): Rename | null {
  if (!error || typeof error.field !== 'string' || !path || !newer) return null
  const step = findNode(newer.graph, path)?.step
  if (!step) return null
  const refs = refsOf(step.input), parent = error.field.split('.').slice(0, -1).join('.')
  if (refs.has(error.field)) return null
  const to = (Array.isArray(error.similar) ? error.similar as string[] : []).find(key => refs.has(parent ? `${parent}.${key}` : key))
  return to ? { from: error.field.split('.').at(-1)!, to, version: newer.number } : null
}

/** The cause as HTML: `Field amount not found (renamed to amount_total; version 2 reads it)`. */
export function causeHtml(error: any, rename: Rename | null) {
  if (!error) return ''
  if (typeof error.field !== 'string') return esc(error.message ?? 'Failed')
  const name = error.field.split('.').at(-1)!, similar = Array.isArray(error.similar) ? error.similar as string[] : []
  const words = rename ? ` (renamed to <code>${esc(rename.to)}</code>; version ${rename.version} reads it)`
    : similar.length ? ` (${error.field.startsWith('trigger.') ? 'the event' : 'the step'} has ${similar.map(k => `<code>${esc(k)}</code>`).join(', ')})` : ''
  return `Field <code>${esc(name)}</code> not found${words}`
}
