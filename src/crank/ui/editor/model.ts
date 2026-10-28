// What the Flow editor shows, read from a workflow's real graph, versions, connections and runs.
import { branchesOf, type Graph } from '../../engine/graph'
import type { Step } from '../../engine/types'
import { canonical } from '../../model'

export interface Connection { purpose?: string; id: string; app: string; label: string; status: string; domains: string[]; account_name: string }
export interface StepRecord { path: string; step_id: string; type: string; status: string; started_at: string; finished_at: string | null; input?: unknown; output?: unknown; error?: any; trace?: unknown; operation_key?: string }
export interface RunDetail {
  gateway_tasks?: {id:string;path:string;ordinal:number;status:string;expires_at:string}[]; executor_tasks?: {id:string;path:string;status:string;active:number}[]; grant_id?: string | null; escalations?: {path:string;escalated_at:string;recipient_ids_json:string}[]; mode?: 'production' | 'test'; repair_of?: string | null; repairs?: { id: string; status: string }[]; id: string; workflow_id: string; version_id: string; status: string; trigger_kind: string; business_key: string | null; received_at: string; started_at: string | null; finished_at: string | null; error: any; trigger?: unknown; steps: StepRecord[]; attempts?: any[]; waits: any[]; business_outcome?: string; source_id?: string | null; source_time?: string | null; version: { number: number; published_by?: string; published_at?: string; authority?: string; declared?: unknown } | null }
export interface Version { number: number; graph: Graph; published_at: string; published_by: string }

/** One card on the canvas: the trigger, a step, or a path group with its branches. */
export interface Node { path: string; step: Step | null; trigger?: Record<string, unknown>; branches?: { id: string; name: string; kind: string; nodes: Node[] }[] }

export function nodes(graph: Graph): Node[] {
  const walk = (steps: Step[], prefix: string): Node[] => steps.map(step => {
    const path = prefix + step.id
    return step.type === 'paths'
      ? { path, step, branches: branchesOf(step).map(branch => ({ id: branch.id, name: branch.name, kind: branch.kind, nodes: walk(branch.steps, `${path}/${branch.id}/`) })) }
      : step.type === 'loop'
        ? {path,step,branches:[{id:'items',name:'Each item',kind:'loop',nodes:walk(step.steps as Step[],`${path}/items/*/`)}]}
        : { path, step }
  })
  return [{ path: 'trigger', step: null, trigger: graph.trigger }, ...walk(graph.steps, '')]
}
export function flatten(list: Node[]): Node[] {
  return list.flatMap(node => [node, ...(node.branches ?? []).flatMap(branch => flatten(branch.nodes))])
}
export const findNode = (graph: Graph, path: string) => flatten(nodes(graph)).find(node => node.path === path) ?? null

const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const TRIGGERS: Record<string, string> = { email: 'Inbound email', webhook: 'Webhooks', schedule: 'Schedule', feed: 'RSS, Atom and JSON Feed', url_poll: 'URL poll', app_poll: 'App records', slack_event: 'Slack', manual: 'Manual start' }
const STEPS: Record<string, string> = { 'ai.classify':'AI classification', 'custom.request':'Custom connector', code: 'Code executor', filter: 'Filter', paths: 'Paths', transform: 'Formatter', map: 'Formatter', delay: 'Delay', wait_for_callback: 'Delay', approval: 'Approval', 'file.fetch': 'Files', respond: 'Webhooks', http: 'Webhooks' }

/** The app or tool a card names: the connection's label for API requests, Slack for Slack steps,
 * the signing preset for a signed webhook, otherwise the built-in tool. */
export function appOf(node: Node, connections: Connection[]): { title: string; tile: string; glyph: string } {
  const connection = (id: unknown) => connections.find(c => c.id === id)
  if (node.trigger) {
    const t = node.trigger as any, preset = t.signature?.preset
    if (t.type === 'webhook' && preset && preset !== 'hmac') return { title: titleCase(preset), tile: preset, glyph: 'hook' }
    return { title: TRIGGERS[t.type] ?? titleCase(String(t.type)), tile: t.type === 'slack_event' ? 'slack' : 'tool', glyph: ({ schedule: 'schedule', feed: 'feed', url_poll: 'http', manual: 'play' } as Record<string, string>)[t.type] ?? 'hook' }
  }
  const step = node.step!, c = connection(step.connection_id)
  if (step.type === 'gmail.search_threads') return { title: 'Gmail', tile: 'google', glyph: 'search' }
  if (step.type.startsWith('quickbooks.')) return { title: 'QuickBooks sandbox', tile: 'quickbooks', glyph: 'invoice' }
  if (step.type.startsWith('gusto.')) return { title: 'Gusto', tile: 'tool', glyph: 'account' }
  if (step.type === 'nook.send_message') return { title: 'Nook', tile: 'tool', glyph: 'chat' }
  if (step.type.startsWith('slack.')) return { title: 'Slack', tile: 'slack', glyph: 'chat' }
  if (step.type === 'http' && c) {
    const domains = [...c.domains, ...(c.app === 'google' ? [] : [])], url = String((step.input as any)?.url ?? '')
    const tile = /sheets\.googleapis\.com/.test(url) ? 'sheets' : domains.some(d => /intuit\.com$/.test(d)) ? 'quickbooks' : c.app === 'hubspot' ? 'hubspot' : c.app === 'google' ? 'google' : 'tool'
    return { title: c.label, tile, glyph: tile === 'sheets' ? 'sheet' : tile === 'quickbooks' ? 'invoice' : 'http' }
  }
  const glyph = ({ filter: 'filter', paths: 'paths', approval: 'approval', delay: 'delay', wait_for_callback: 'delay', transform: 'transform', map: 'transform', 'file.fetch': 'file', respond: 'respond', http: 'http' } as Record<string, string>)[step.type] ?? 'http'
  return { title: STEPS[step.type] ?? titleCase(step.type), tile: 'tool', glyph }
}

/** How a run started, in words: "Stripe webhook", "Run now", "Schedule". */
export function triggerWords(kind: string, graph: Graph | undefined, connections: Connection[]) {
  const words: Record<string, string> = { webhook: 'Webhook', manual: 'Run now', test: 'Draft test', historical: 'Historical run', schedule: 'Schedule', feed: 'New feed item', url_poll: 'URL poll', app_poll: 'App records', slack_event: 'Slack event' }
  const app = graph ? appOf({ path: 'trigger', step: null, trigger: graph.trigger }, connections).title : ''
  if (kind === 'webhook' && app && app !== TRIGGERS.webhook) return `${app} webhook`
  return words[kind] ?? titleCase(kind.replace(/_/g, ' '))
}

/** The card's second line: the step's own name, or what its type does. */
export function summaryOf(node: Node): string {
  if (node.trigger) return String((node.trigger as any).name ?? ({ webhook: 'Catch hook', schedule: 'On a schedule', feed: 'New feed item', url_poll: 'New record', slack_event: 'New Slack event', manual: 'Started by hand' } as Record<string, string>)[String(node.trigger.type)] ?? '')
  const step = node.step!
  if (step.type === 'gmail.search_threads') return 'Search thread metadata'
  if (typeof step.name === 'string') return step.name
  if (step.type.startsWith('slack.')) return titleCase(step.type.slice(6).replace(/_/g, ' '))
  const native: Record<string,string> = { 'ai.classify':'Classify text into a category', 'nook.send_message':'Post message to the connected conversation', 'quickbooks.invoice_outcome':'Verify invoice outcome', 'quickbooks.create_invoice':'Create invoice', 'quickbooks.create_refund_receipt':'Record refund receipt', 'quickbooks.void_invoice':'Void invoice after approval', 'gusto.contractor_1099_handoff':'Send contractor data for 1099 preparation', 'gusto.employee_w2_handoff':'Send employee data for W-2 preparation', 'gusto.contractor_payment':'Pay contractor by ACH', 'gusto.contractor_forms':'Read contractor tax forms', 'gusto.employee_forms':'Read employee tax forms', 'gusto.payment_readback':'Read contractor payment' }
  if (native[step.type]) return native[step.type]
  if (step.type === 'http') return `${String((step.input as any)?.method ?? 'GET').toUpperCase()} request`
  if (step.type === 'paths') return `${node.branches?.length ?? 0} paths`
  return step.id.replace(/_/g, ' ')
}

/** Steps whose definition differs from the previous published version. */
export function changedPaths(current: Graph, previous: Graph | null): Set<string> {
  const out = new Set<string>()
  if (!previous) return out
  const before = new Map(flatten(nodes(previous)).map(n => [n.path, n]))
  const shape = (n: Node) => n.trigger ? canonical(n.trigger) : canonical({ ...n.step, branches: undefined, fallback: undefined, always: undefined })
  for (const node of flatten(nodes(current))) {
    const old = before.get(node.path)
    if (!old || shape(old) !== shape(node) || (node.step?.type === 'paths' && canonical((node.step.branches as any[] ?? []).map(b => b.when)) !== canonical((old.step?.branches as any[] ?? []).map(b => b.when)))) out.add(node.path)
  }
  return out
}

/** Leaves of a mapping as [dotted field, value] rows; built-in transforms are kept whole. */
export function mappingRows(value: unknown, prefix = ''): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value) && !value.some(v => v && typeof v === 'object')) return [[prefix, value]]
  if (!Array.isArray(value) && ('$fn' in value || '$ref' in value || '$literal' in value)) return [[prefix, value]]
  return Object.entries(value).flatMap(([key, item]) => mappingRows(item, prefix ? `${prefix}${Array.isArray(value) ? `[${key}]` : `.${key}`}` : key))
}
/** Long `{{a.b.c.d}}` paths shortened to their last two parts, for narrow columns (a word joiner keeps `…` on the path's line). */
export const shortPaths = (text: string) => text.replace(/\{\{\s*([\w.\-[\]]+)\s*\}\}/g, (whole, path: string) => { const parts = path.split('.'); return parts.length > 3 ? `{{…\u2060${parts.slice(-2).join('.')}}}` : whole })
/** A mapped field's key as a label: its last meaningful part, words split ("CustomerRef.name" → "Customer ref"). */
export function fieldLabel(key: string) {
  const parts = key.replace(/^(body|input|query|headers)\./, '').split('.')
  let part = parts.at(-1)!
  if (/^(name|value|id)$/.test(part.replace(/\[\d+\]/g, '')) && parts.length > 1) part = parts.at(-2)!
  const index = [...part.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])).at(-1), base = part.replace(/\[\d+\]/g, '')
  const words = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
  const text = words.charAt(0).toUpperCase() + words.slice(1)
  return index === undefined || /^Line$/.test(text) ? text : `${text} ${index + 1}`
}
/** A mapped row's label: Sheets' `values` cells by their column letter, a condition's parts by rule
 * number ("Rule 1 field"), any other key in words. */
export const rowLabel = (key: string) => {
  const cell = /(?:^|\.)values\[\d+\]\[(\d+)\]$/.exec(key), rule = /^when(?:\[\d+\])+\[(\d+)\]\.(\w+)$/.exec(key)
  return cell ? `Column ${String.fromCharCode(65 + Number(cell[1]) % 26)}` : rule ? `Rule ${Number(rule[1]) + 1} ${rule[2]}` : fieldLabel(key)
}
/** A mapped value as one line: `{{path}}` text, or `fn(arg: …)` for built-in transforms. */
export function mappingText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, any>
    if (typeof v.$fn === 'string') return `${v.$fn}(${Object.entries(v.args ?? {}).map(([k, a]) => `${k}: ${mappingText(a)}`).join(', ')})`
    if (typeof v.$ref === 'string') return `{{${v.$ref}}}`
    if ('$literal' in v) return JSON.stringify(v.$literal)
  }
  return JSON.stringify(value)
}

/** The newest record of a step across the newest runs, for its card's last-run status. */
export function lastRecord(runs: RunDetail[], path: string) {
  const parts=path.split('/')
  const matches=(candidate:string)=>{const actual=candidate.split('/');return actual.length===parts.length&&parts.every((part,index)=>part==='*'?/^\d+$/.test(actual[index]):part===actual[index])}
  for (const run of runs) {
    const candidates=run.steps.filter(step=>matches(step.path))
    const record=candidates.sort((a,b)=>(b.finished_at??b.started_at).localeCompare(a.finished_at??a.started_at))[0]
    if(record)return {run,record}
  }
  return null
}
export function triggerRecord(runs: RunDetail[]) { return runs[0] ?? null }
