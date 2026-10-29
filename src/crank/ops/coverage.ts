import { CATALOG, PLANNED } from '../connections/catalog'
import { isObject } from '../engine/values'
import { requireValue } from '../model'

/** CONN-001 coverage: each app and operation an inventory uses is native (named connector
 * and operation exist here), agent-buildable (public API, supported auth; CONN-011) or blocked. */
export interface InventoryItem { app: string; operation: string; source?: string; public_api?: 'openapi' | 'rest' | 'partner' | 'none' }
const normal = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export function assess(item: InventoryItem) {
  const app = normal(item.app), operation = normal(item.operation)
  const entry = CATALOG.find(c => c.app === app)
  if (entry) {
    const operations = [...entry.triggers, ...entry.actions, ...entry.searches] as { id: string; step?: string; trigger?: string }[]
    const match = operations.find(o => normal(o.id) === operation || (o.step && normal(o.step) === operation))
    if (match) return { ...item, status: 'native', clause: entry.clauses.join(', '), operation_id: match.id }
    return { ...item, status: 'agent-buildable', clause: 'CONN-011', reason: `${entry.name} is native, but "${item.operation}" is not one of its built operations` }
  }
  const planned = Object.hasOwn(PLANNED, app) ? PLANNED[app] : undefined
  if (planned) return { ...item, status: 'agent-buildable', clause: 'CONN-011', reason: `${planned.name} has a public ${planned.api === 'openapi' ? 'OpenAPI-described' : 'REST'} API; its native connector (${planned.clause}) is not built in this installation yet` }
  if (item.public_api === 'openapi' || item.public_api === 'rest') return { ...item, status: 'agent-buildable', clause: 'CONN-011', reason: `Public ${item.public_api === 'openapi' ? 'OpenAPI description' : 'REST documentation'}; an agent can build the connector` }
  if (item.public_api === 'partner') return { ...item, status: 'blocked', reason: 'Partner-only API: use an HTTP-002 request with partner access, or ask the provider for partner enrolment' }
  if (item.public_api === 'none') return { ...item, status: 'blocked', reason: 'No public API: use the provider’s export or an HTTP-002 request to an endpoint it offers' }
  return { ...item, status: 'blocked', reason: 'Unknown app: supply its public API documentation to assess it' }
}

const N8N: Record<string, [string, string]> = {
  'n8n-nodes-base.webhook': ['webhooks', 'catch_hook'], 'n8n-nodes-base.httpRequest': ['webhooks', 'request'],
  'n8n-nodes-base.scheduleTrigger': ['schedule', 'daily'], 'n8n-nodes-base.cron': ['schedule', 'daily'], 'n8n-nodes-base.interval': ['schedule', 'every'],
  'n8n-nodes-base.rssFeedReadTrigger': ['rss', 'new_item'], 'n8n-nodes-base.rssFeedRead': ['rss', 'new_item'],
  'n8n-nodes-base.if': ['filter_paths', 'filter'], 'n8n-nodes-base.filter': ['filter_paths', 'filter'], 'n8n-nodes-base.switch': ['filter_paths', 'paths'],
  'n8n-nodes-base.wait': ['delay', 'delay_for'], 'n8n-nodes-base.set': ['formatter', 'map'],
}
const N8N_SLACK: Record<string, string> = { 'message.post': 'send_channel_message', 'message.update': 'update_message', 'message.delete': 'delete_message', 'reaction.add': 'add_reaction', 'user.getByEmail': 'find_user_by_email', 'channel.create': 'find_channel_by_name' }
const MAKE: Record<string, [string, string]> = {
  'gateway:CustomWebHook': ['webhooks', 'catch_hook'], 'http:ActionSendData': ['webhooks', 'request'], 'http:ActionSendDataBasicAuth': ['webhooks', 'request'],
  'builtin:BasicRouter': ['filter_paths', 'paths'], 'rss:TriggerWatchArticles': ['rss', 'new_item'], 'rss:ActionReadArticles': ['rss', 'new_item'],
  'util:FunctionSleep': ['delay', 'delay_for'], 'slack:CreateMessage': ['slack', 'send_channel_message'], 'slack:EditMessage': ['slack', 'update_message'],
  'slack:DeleteMessage': ['slack', 'delete_message'], 'slack:WatchMessages': ['slack', 'new_message'], 'slack:CreateReaction': ['slack', 'add_reaction'],
}

/** Accepts a typed list of apps and operations, an n8n workflow export or a Make blueprint. */
export function inventory(input: Record<string, unknown>): InventoryItem[] {
  if (Array.isArray(input.items)) return input.items.map((raw, i) => {
    requireValue(isObject(raw) && typeof raw.app === 'string' && typeof raw.operation === 'string', `items[${i}] needs app and operation`)
    return { app: raw.app as string, operation: raw.operation as string, ...(typeof raw.public_api === 'string' ? { public_api: raw.public_api as InventoryItem['public_api'] } : {}), source: typeof raw.source === 'string' ? raw.source : 'typed list' }
  })
  if (input.n8n !== undefined) {
    const workflows = Array.isArray(input.n8n) ? input.n8n : [input.n8n]
    return workflows.flatMap((workflow: any) => (Array.isArray(workflow?.nodes) ? workflow.nodes : []).map((node: any) => {
      const type = String(node.type ?? ''), params = node.parameters ?? {}
      if (type === 'n8n-nodes-base.slack') return { app: 'slack', operation: N8N_SLACK[`${params.resource ?? 'message'}.${params.operation ?? 'post'}`] ?? `${params.resource}.${params.operation}`, source: `n8n ${workflow.name ?? ''}`.trim() }
      if (type === 'n8n-nodes-base.slackTrigger') return { app: 'slack', operation: params.trigger?.includes?.('reaction_added') ? 'new_reaction' : params.trigger?.includes?.('app_mention') ? 'app_mention' : 'new_message', source: `n8n ${workflow.name ?? ''}`.trim() }
      const known = Object.hasOwn(N8N, type) ? N8N[type] : undefined
      if (known) return { app: known[0], operation: known[1], source: `n8n ${workflow.name ?? ''}`.trim() }
      const app = type.replace(/^n8n-nodes-base\./, '').replace(/Trigger$/, '').replace(/([a-z])([A-Z])/g, '$1_$2')
      return { app, operation: `${params.resource ?? ''}${params.resource ? '.' : ''}${params.operation ?? (type.endsWith('Trigger') ? 'trigger' : 'action')}`, source: `n8n ${workflow.name ?? ''}`.trim() }
    }))
  }
  if (isObject(input.make)) {
    const modules: any[] = []
    const walk = (flow: unknown) => { if (Array.isArray(flow)) for (const m of flow) { modules.push(m); for (const route of m?.routes ?? []) walk(route.flow) } }
    walk((input.make as any).flow)
    return modules.map(m => {
      const key = String(m.module), known = Object.hasOwn(MAKE, key) ? MAKE[key] : undefined
      if (known) return { app: known[0], operation: known[1], source: 'Make blueprint' }
      const [app, action] = String(m.module ?? 'unknown:unknown').split(':')
      return { app, operation: action ?? 'unknown', source: 'Make blueprint' }
    })
  }
  requireValue(false, 'Send items (a typed list), n8n (a workflow export) or make (a blueprint)')
  return []
}

export function coverageReport(input: Record<string, unknown>) {
  const items = inventory(input).map(assess)
  const summary = { native: 0, 'agent-buildable': 0, blocked: 0 } as Record<string, number>
  for (const item of items) summary[item.status]++
  return { summary, items }
}
