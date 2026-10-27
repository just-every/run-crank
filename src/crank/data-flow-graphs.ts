import { branchesOf, type Graph } from './engine/graph'
import type { Step } from './engine/types'
import { isObject } from './engine/values'
import { stmt, type CrankEnv } from './model'
import { type DataFlow, fields, recipient, queryFields, providerFlow } from './data-flow-types'

/** Project graph request declarations without exposing input values. */
export async function graphDataFlows(env: CrankEnv, credential: (id: unknown) => string) {
  const flows: DataFlow[] = []
  const siblings = (await stmt(env, "SELECT id,sibling_binding_json FROM crank_connections WHERE app='nook'").all<{ id: string; sibling_binding_json: string | null }>()).results
  const siblingOrigin = (connectionId: unknown) => { const row = siblings.find(c => c.id === connectionId); return row?.sibling_binding_json ? JSON.parse(row.sibling_binding_json).origin : 'Unbound Nook installation' }
  // Include old versions still retained by nonterminal work, not just the latest graph.
  const stored = await stmt(env, `SELECT v.id,v.graph_json,w.name,w.status,v.mode FROM crank_workflow_versions v JOIN crank_workflows w ON w.id=v.workflow_id
    WHERE v.id=w.published_version_id OR EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.version_id=v.id AND r.status IN ('queued','running','waiting','awaiting_approval','paused')) ORDER BY v.id`).all<{ id: string; graph_json: string; name: string; status: string; mode: string }>()
  const drafts = await stmt(env, 'SELECT id,draft_json AS graph_json,name,status FROM crank_workflows ORDER BY id').all<{ id: string; graph_json: string; name: string; status: string }>()
  const versions = [...stored.results.map(v => ({ ...v, state: `${v.status}; retained ${v.mode} version` })), ...drafts.results.map(v => ({ ...v, id: `draft:${v.id}`, state: 'draft; tests require explicit owner authority and account bindings' }))]
  for (const v of versions) {
    const graph = JSON.parse(v.graph_json) as Graph, trigger = graph.trigger
    const emit = (path: string, kind: string, input: Record<string, unknown>, connectionId: unknown, urls: unknown[]) => flows.push(providerFlow({
      id: `version:${v.id}:${path}`, kind, label: `${v.name} · ${path}`, state: v.state, recipients: [...new Set(urls.map(recipient))],
      purpose: kind === 'poll' ? 'Read new feed/URL items; query mappings and pagination may be sent' : `Declared ${kind} operation (including retries, pagination and declared readback)`,
      fields: [...fields(input), ...urls.flatMap(queryFields), ...(kind === 'http' ? ['multipart file names, content types and bytes when mapped', 'pagination and readback query'] : kind === 'file.fetch' ? ['URL query; download request (no uploaded file bytes)'] : [])], credentials: credential(connectionId),
    }))
    if (trigger.type === 'feed') emit('trigger', 'poll', { headers: 'feed content negotiation' }, undefined, trigger.urls as unknown[])
    if (trigger.type === 'url_poll') emit('trigger', 'poll', { query: trigger.query, headers: trigger.headers, pagination: trigger.pagination }, trigger.connection_id, [trigger.url])
    const walk = (steps: Step[], prefix = '') => {
      for (const step of steps) {
        const path = prefix + step.id, input = isObject(step.input) ? step.input : {}
        if (step.type === 'paths') for (const b of branchesOf(step)) walk(b.steps, `${path}/${b.id}/`)
        else if (step.type === 'loop') walk(step.steps as Step[], `${path}/items/*/`)
        else if (step.type === 'code') emit(path,'code',{source:step.source,language:step.language,input},step.connection_id,[step.executor_url])
        else if (step.type.startsWith('nook.')) emit(path,step.type,input,step.connection_id,[siblingOrigin(step.connection_id)])
        else if (step.type.startsWith('quickbooks.')) emit(path,step.type,input,step.connection_id,['https://sandbox-quickbooks.api.intuit.com'])
        else if (step.type.startsWith('gusto.')) emit(path,step.type,input,step.connection_id,['https://api.gusto-demo.com','https://api.gusto.com'])
        else if (step.type.startsWith('google_calendar.')) emit(path,step.type,input,step.connection_id,['https://www.googleapis.com'])
        else if (step.type === 'http' || step.type === 'file.fetch' || step.type.startsWith('slack.')) {
          const readback = isObject(step.readback) ? step.readback : {}
          emit(path, step.type, input, step.connection_id, step.type.startsWith('slack.') ? ['https://slack.com'] : [input.url, ...(readback.url ? [readback.url] : [])])
        }
      }
    }
    walk(graph.steps)
  }
  return flows
}
