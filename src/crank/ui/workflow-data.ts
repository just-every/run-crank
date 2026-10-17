import type { Graph } from '../engine/graph'
import type { RunDetail, Version } from './editor/model'

type Read = (path: string) => Promise<any>

/** Everything the Flow editor reads, through the same API an agent uses. */
export async function workflowData(read: Read, id: string, params: URLSearchParams, actor: any) {
  const base = `/api/crank/workflows/${encodeURIComponent(id)}`
  const workflow = await read(base)
  const numberOf = new Map<string, number>(workflow.versions.map((v: any) => [v.id, v.number]))
  const published = workflow.published_version_id ? numberOf.get(workflow.published_version_id) ?? null : null
  const versionCache = new Map<number, Promise<Version>>()
  const version = (n: number) => { if (!versionCache.has(n)) versionCache.set(n, read(`${base}/versions/${n}`)); return versionCache.get(n)! }
  const search = new URLSearchParams({ workflow: id, limit: '8' })
  for (const key of ['q', 'status']) { const value = params.get(key); if (value) search.set(key, value) }
  const [current, previous, today, list, connections] = await Promise.all([
    published ? version(published) : null,
    published && published > 1 ? version(published - 1) : null,
    read(`${base}/today`),
    read('/api/crank/workflow-runs?' + search),
    read('/api/crank/connections'),
  ])
  const runs: RunDetail[] = await Promise.all(list.runs.map((r: any) => read(`/api/crank/workflow-runs/${encodeURIComponent(r.id)}`)))
  const graphs = new Map<string, Graph>()
  await Promise.all([...new Set(runs.map(r => r.version_id))].map(async versionId => { const n = numberOf.get(versionId); if (n) graphs.set(versionId, (await version(n)).graph) }))
  return { workflow, current, previous, graphs, runs, connections, today, actor, params }
}
