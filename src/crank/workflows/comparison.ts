import { requireValue, stmt, type CrankEnv } from '../model'
import { getWorkflow, versionGraph } from './store'

type Selector = 'draft' | 'published' | number
interface Change {
  /** RFC 6901 JSON Pointer into the returned before/after graphs. */
  path: string
  kind: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
}

function selector(params: URLSearchParams, key: string, fallback: Selector): Selector {
  const values = params.getAll(key)
  requireValue(values.length <= 1, `Choose one ${key} version`, 422)
  if (!values.length) return fallback
  const value = values[0]
  if (value === 'draft' || value === 'published') return value
  requireValue(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), `${key} must be draft, published or a positive version number`, 422)
  return Number(value)
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

/** Walk JSON values rather than their serialization: object key order is immaterial,
 * while array order (including step execution order) remains meaningful. */
function differences(before: unknown, after: unknown, path = '', changes: Change[] = []): Change[] {
  if (before === after) return changes
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      const child = `${path}/${index}`
      if (index >= before.length) changes.push({ path: child, kind: 'added', after: after[index] })
      else if (index >= after.length) changes.push({ path: child, kind: 'removed', before: before[index] })
      else differences(before[index], after[index], child, changes)
    }
  } else if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const child = `${path}/${pointer(key)}`
      if (!Object.hasOwn(before, key)) changes.push({ path: child, kind: 'added', after: after[key] })
      else if (!Object.hasOwn(after, key)) changes.push({ path: child, kind: 'removed', before: before[key] })
      else differences(before[key], after[key], child, changes)
    }
  } else changes.push({ path, kind: 'changed', before, after })
  return changes
}

/** Read-only WORK-008 comparison. The HTTP caller supplies its normal read
 * authorization. Settings here are graph.settings, frozen with each publication;
 * mutable workflow metadata is not part of a retained graph. */
export async function compareWorkflow(env: CrankEnv, workflowId: string, params: URLSearchParams) {
  const from = selector(params, 'from', 'published'), to = selector(params, 'to', 'draft')
  const workflow = await getWorkflow(env, workflowId)
  const resolve = async (ref: Selector) => {
    if (ref === 'draft') return { ref, number: null, graph: JSON.parse(workflow.draft_json) }
    let number: number
    if (ref === 'published') {
      requireValue(workflow.published_version_id, 'This workflow has no published version', 404)
      const published = await stmt(env, 'SELECT number FROM crank_workflow_versions WHERE workflow_id=? AND id=?', workflowId, workflow.published_version_id).first<{ number: number }>()
      requireValue(published, 'Published version not found', 404)
      number = published.number
    } else number = ref
    return { ref, number, graph: (await versionGraph(env, workflowId, number)).graph }
  }
  const [source, target] = await Promise.all([resolve(from), resolve(to)])
  const changes = differences(source.graph, target.graph)
  return {
    workflow_id: workflowId,
    from: { ref: source.ref, number: source.number },
    to: { ref: target.ref, number: target.number },
    before: source.graph,
    after: target.graph,
    changed_fields: changes.map(change => change.path),
    changes,
  }
}
