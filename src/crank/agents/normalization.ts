import { runTransform } from '../engine/transforms'
import { isObject, lookup, pathParts } from '../engine/values'
import type { Step } from '../engine/types'
import { branchesOf, type Graph } from '../engine/graph'
import { canonical, requireValue } from '../model'

export interface Operation { fn: string; args: Record<string, unknown> }
// Search existing pure operations, with no customer values embedded in the skill.
export const NORMALIZERS: Operation[] = [
  { fn: 'text.trim', args: { collapse: false } }, { fn: 'text.trim', args: {} },
  ...['upper', 'lower', 'title', 'sentence'].map(to => ({ fn: 'text.case', args: { to } })),
  { fn: 'text.strip_html', args: {} }, { fn: 'text.url_decode', args: {} },
]
export function normalize(value: unknown, pipeline: Operation[]) {
  return pipeline.reduce((v, op) => runTransform(op.fn, { ...op.args, value: v }), value)
}
export function expression(value: unknown, pipeline: Operation[]): unknown {
  return pipeline.reduce((v, op) => ({ $fn: op.fn, args: { ...op.args, value: v } }), value)
}
export function stepIn(graph: Graph, stepId: string): Step | undefined {
  for (const step of graph.steps) {
    if (step.id === stepId) return step
    const children = step.type === 'paths' ? branchesOf(step).flatMap(b => b.steps) : Array.isArray(step.steps) ? step.steps as Step[] : []
    const nested = stepIn({ ...graph, steps: children }, stepId)
    if (nested) return nested
  }
}
export function fieldValue(input: unknown, field: string) {
  const found = lookup(input, field)
  requireValue(found.found && typeof found.value === 'string', 'Choose a retained text input field; missing, sealed or expired values cannot be used', 409)
  return found.value as string
}
export function improvedGraph(graph: Graph, stepId: string, field: string, pipeline: Operation[]) {
  const copy = structuredClone(graph), step = stepIn(copy, stepId)
  requireValue(step && isObject(step.input), 'The selected step has no input mapping', 422)
  const parts = pathParts(field), leaf = parts.pop()!
  let parent: any = step.input
  for (const part of parts) { requireValue(parent && Object.hasOwn(parent, part), 'Mapped field not found', 422); parent = parent[part] }
  requireValue(parent && Object.hasOwn(parent, leaf), 'Mapped field not found', 422)
  parent[leaf] = expression(parent[leaf], pipeline)
  return copy
}
export function infer(cases: { input: unknown; expected: unknown }[]): Operation[] | null {
  const candidates = [...NORMALIZERS.map(op => [op]), ...NORMALIZERS.flatMap(a => NORMALIZERS.map(b => [a, b]))]
  return candidates.find(pipeline => cases.every(c => {
    try { return canonical(normalize(c.input, pipeline)) === canonical(c.expected) } catch { return false }
  })) ?? null
}
