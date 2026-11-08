import { branchesOf, validateGraph, type Graph } from '../engine/graph'
import type { Step } from '../engine/types'
import { canonical, digest, type CrankEnv } from '../model'
import { snapshotBindings } from './snapshot'

/** Schema identity carries no credential, account payload or execution authority. */
export async function sampleSchema(env: CrankEnv, graph: Graph, path: string, bindings?: {id:string;schema_digest:string}[]) {
  let node: Record<string, unknown> = graph.trigger
  if (path !== 'trigger') {
    const declared = validateGraph(graph).declared.steps.find(step => step.path === path)
    const find = (steps: Step[]): Step | undefined => {
      for (const step of steps) {
        if (step.id === declared?.id) return step
        const children = step.type === 'loop' ? step.steps as Step[] : branchesOf(step).flatMap(branch => branch.steps)
        const found = find(children)
        if (found) return found
      }
    }
    node = find(graph.steps) ?? {}
  }
  const ids = typeof node.connection_id === 'string' ? [node.connection_id] : []
  const schemas = bindings ?? await snapshotBindings(env, ids)
  const shape = Object.fromEntries(['type','fn','connector_id','connector_version','operation','resource','output_schema'].filter(key => node[key] !== undefined).map(key => [key,node[key]]))
  return digest(canonical({shape, connections: ids.map(id => schemas.find(schema => schema.id === id)?.schema_digest ?? null)}))
}
