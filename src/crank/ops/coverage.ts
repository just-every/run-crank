import { CATALOG, PLANNED } from '../connections/catalog'
import { isObject } from '../engine/values'
import { requireValue } from '../model'
import { configurationCoverage, COVERAGE_LIMITS, type InventoryItem } from './coverage-capabilities'
export type { InventoryItem } from './coverage-capabilities'

/** CONN-001 coverage: each app and operation an inventory uses is native (named connector
 * and operation exist here), agent-buildable (public API, supported auth; CONN-011) or blocked. */
const normal = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export function assess(item: InventoryItem) {
  const scope = item.source_kind !== 'typed' || item.settings !== undefined || item.selected_resources !== undefined || item.source_version !== undefined || item.extra_settings && Object.keys(item.extra_settings).length ? 'configuration' : 'operation'
  const operationItem = { ...item, coverage_scope: scope, configuration_status: scope === 'configuration' ? 'unsupported' : 'not_assessed', operation_status: 'unavailable' }
  const app = normal(item.app), operation = normal(item.operation)
  const entry = CATALOG.find(c => c.app === app)
  if (entry) {
    const operations = [...entry.triggers, ...entry.actions, ...entry.searches] as { id: string; step?: string; trigger?: string }[]
    const match = operations.find(o => normal(o.id) === operation || (o.step && normal(o.step) === operation))
    if (match) {
      if (scope === 'operation') return { ...operationItem, operation_status: 'native', status: 'native', clause: entry.clauses.join(', '), operation_id: match.id }
      const configuration = configurationCoverage({ ...item, app }, match.id)
      return { ...operationItem, operation_status: 'native', status: configuration.supported ? 'native' : 'agent-buildable',
        configuration_status: configuration.supported ? 'supported' : 'unsupported', clause: entry.clauses.join(', '), operation_id: match.id,
        reason: configuration.reason, diagnostics: [{ code: configuration.code, field: 'settings', reason: configuration.reason }] }
    }
    return { ...operationItem, status: 'agent-buildable', clause: 'CONN-011', reason: `${entry.name} is native, but "${item.operation}" is not one of its built operations` }
  }
  const planned = PLANNED[app]
  if (planned) return { ...operationItem, status: 'agent-buildable', clause: 'CONN-011', reason: `${planned.name} has a public ${planned.api === 'openapi' ? 'OpenAPI-described' : 'REST'} API; its native connector (${planned.clause}) is not built in this installation yet` }
  if (item.public_api === 'openapi' || item.public_api === 'rest') return { ...operationItem, status: 'agent-buildable', clause: 'CONN-011', reason: `Public ${item.public_api === 'openapi' ? 'OpenAPI description' : 'REST documentation'}; an agent can build the connector` }
  if (item.public_api === 'partner') return { ...operationItem, status: 'blocked', reason: 'Partner-only API: use an HTTP-002 request with partner access, or ask the provider for partner enrolment' }
  if (item.public_api === 'none') return { ...operationItem, status: 'blocked', reason: 'No public API: use the provider’s export or an HTTP-002 request to an endpoint it offers' }
  return { ...operationItem, status: 'blocked', reason: 'Unknown app: supply its public API documentation to assess it' }
}

const N8N: Record<string, [string, string]> = {
  'n8n-nodes-base.webhook': ['webhooks', 'catch_hook'], 'n8n-nodes-base.httpRequest': ['webhooks', 'request'],
  'n8n-nodes-base.scheduleTrigger': ['schedule', 'daily'], 'n8n-nodes-base.cron': ['schedule', 'daily'], 'n8n-nodes-base.interval': ['schedule', 'every'],
  'n8n-nodes-base.rssFeedReadTrigger': ['rss', 'new_item'], 'n8n-nodes-base.rssFeedRead': ['rss', 'new_item'],
  'n8n-nodes-base.if': ['filter_paths', 'filter'], 'n8n-nodes-base.filter': ['filter_paths', 'filter'], 'n8n-nodes-base.switch': ['filter_paths', 'paths'],
  'n8n-nodes-base.wait': ['delay', 'delay_for'], 'n8n-nodes-base.set': ['formatter', 'map'],
  'n8n-nodes-base.dateTime': ['formatter', 'date.n8n_arithmetic'],
}
const N8N_SLACK: Record<string, string> = { 'message.post': 'send_channel_message', 'message.update': 'update_message', 'message.delete': 'delete_message', 'reaction.add': 'add_reaction', 'user.getByEmail': 'find_user_by_email', 'channel.create': 'create_channel' }
const MAKE: Record<string, [string, string]> = {
  'gateway:CustomWebHook': ['webhooks', 'catch_hook'], 'http:ActionSendData': ['webhooks', 'request'], 'http:ActionSendDataBasicAuth': ['webhooks', 'request'],
  'builtin:BasicRouter': ['filter_paths', 'paths'], 'rss:TriggerWatchArticles': ['rss', 'new_item'], 'rss:ActionReadArticles': ['rss', 'new_item'],
  'util:FunctionSleep': ['delay', 'delay_for'], 'slack:CreateMessage': ['slack', 'send_channel_message'], 'slack:EditMessage': ['slack', 'update_message'],
  'slack:DeleteMessage': ['slack', 'delete_message'], 'slack:WatchMessages': ['slack', 'new_message'], 'slack:CreateReaction': ['slack', 'add_reaction'],
}

/** Accepts a typed list of apps and operations, an n8n workflow export or a Make blueprint. */
export function inventory(input: Record<string, unknown>): InventoryItem[] {
  let values = 0
  const bounded = (value: unknown, depth = 0) => {
    requireValue(depth <= COVERAGE_LIMITS.depth && ++values <= COVERAGE_LIMITS.values, 'Inventory exceeds structural coverage limits')
    if (typeof value === 'string') requireValue(value.length <= COVERAGE_LIMITS.text, 'Inventory text exceeds coverage limits')
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { requireValue(key.length <= 160, 'Inventory field exceeds coverage limits'); bounded(child, depth + 1) }
  }
  bounded(input)
  requireValue(JSON.stringify(input).length <= COVERAGE_LIMITS.bytes, 'Inventory exceeds coverage size limit')
  const finish = (items: InventoryItem[]) => { requireValue(items.length <= COVERAGE_LIMITS.items, 'Inventory has too many operations'); return items }
  const sourceNode = (node: Record<string, unknown>, kind: 'n8n' | 'make', workflowSettings?: unknown) => ({
    settings: kind === 'n8n' ? node.parameters : { parameters: node.parameters, mapper: node.mapper, filter: node.filter, routes: node.routes },
    source_kind: kind, source_type: String(node.type ?? node.module ?? ''), source_version: kind === 'n8n' ? node.typeVersion : node.version,
    source_options: Object.fromEntries(Object.entries(node).filter(([key]) => !['id', 'name', 'position', 'type', 'typeVersion', 'parameters'].includes(key))),
    ...(workflowSettings !== undefined ? { workflow_settings: workflowSettings } : {}),
  })
  if (Array.isArray(input.items)) return finish(input.items.map((raw, i) => {
    requireValue(isObject(raw) && typeof raw.app === 'string' && typeof raw.operation === 'string', `items[${i}] needs app and operation`)
    const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !['app', 'operation', 'public_api', 'source', 'settings', 'selected_resources', 'source_version'].includes(key)))
    return { ...(Object.keys(extra).length ? { extra_settings: extra } : {}), ...(Object.hasOwn(raw, 'source_version') ? { source_version: raw.source_version } : {}), ...(Object.hasOwn(raw, 'settings') ? { settings: raw.settings } : {}), ...(Object.hasOwn(raw, 'selected_resources') ? { selected_resources: raw.selected_resources } : {}), source_kind: 'typed', app: raw.app as string, operation: raw.operation as string, ...(typeof raw.public_api === 'string' ? { public_api: raw.public_api as InventoryItem['public_api'] } : {}), source: typeof raw.source === 'string' ? raw.source : 'typed list' }
  }))
  if (input.n8n !== undefined) {
    const workflows = Array.isArray(input.n8n) ? input.n8n : [input.n8n]
    return finish(workflows.flatMap((workflow: any) => { requireValue(isObject(workflow) && Array.isArray(workflow.nodes), 'n8n workflow needs a node list'); return workflow.nodes.map((node: any) => {
      requireValue(isObject(node), 'Inventory node must be an object')
      const type = String(node.type ?? ''), params = isObject(node.parameters) ? node.parameters : {}, metadata = sourceNode(node, 'n8n', workflow.settings)
      if (type === 'n8n-nodes-base.slack') return { ...metadata, app: 'slack', operation: N8N_SLACK[`${params.resource ?? 'message'}.${params.operation ?? 'post'}`] ?? `${params.resource}.${params.operation}`, source: `n8n ${workflow.name ?? ''}`.trim() }
      if (type === 'n8n-nodes-base.slackTrigger') return { ...metadata, app: 'slack', operation: Array.isArray(params.trigger) && params.trigger.includes('reaction_added') ? 'new_reaction' : Array.isArray(params.trigger) && params.trigger.includes('app_mention') ? 'app_mention' : 'new_message', source: `n8n ${workflow.name ?? ''}`.trim() }
      const known = N8N[type]
      if (known) return { ...metadata, app: known[0], operation: type === 'n8n-nodes-base.dateTime' && params.operation === 'formatDate' ? 'date.format' : known[1], source: `n8n ${workflow.name ?? ''}`.trim() }
      const app = type.replace(/^n8n-nodes-base\./, '').replace(/Trigger$/, '').replace(/([a-z])([A-Z])/g, '$1_$2')
      return { ...metadata, app, operation: `${params.resource ?? ''}${params.resource ? '.' : ''}${params.operation ?? (type.endsWith('Trigger') ? 'trigger' : 'action')}`, source: `n8n ${workflow.name ?? ''}`.trim() }
    })}))
  }
  if (isObject(input.make)) {
    const modules: any[] = []
    const walk = (flow: unknown) => { if (Array.isArray(flow)) for (const m of flow) { requireValue(isObject(m), 'Inventory module must be an object'); modules.push(m); requireValue(m.routes === undefined || Array.isArray(m.routes), 'Make routes must be a list'); for (const route of (m.routes ?? []) as any[]) { requireValue(isObject(route), 'Make route must be an object'); walk(route.flow) } } }
    requireValue(Array.isArray(input.make.flow), 'Make blueprint needs a flow list')
    walk(input.make.flow)
    return finish(modules.map(m => {
      const metadata = sourceNode(m, 'make')
      const known = MAKE[String(m.module)]
      if (known) return { ...metadata, app: known[0], operation: known[1], source: 'Make blueprint' }
      const [app, action] = String(m.module ?? 'unknown:unknown').split(':')
      return { ...metadata, app, operation: action ?? 'unknown', source: 'Make blueprint' }
    }))
  }
  requireValue(false, 'Send items (a typed list), n8n (a workflow export) or make (a blueprint)')
  return []
}

export function coverageReport(input: Record<string, unknown>) {
  const items = inventory(input).map(assess)
  const summary = { native: 0, 'agent-buildable': 0, blocked: 0 } as Record<string, number>
  for (const item of items) summary[item.status]++
  const configuration_summary = { supported: 0, unsupported: 0, not_assessed: 0 } as Record<string, number>
  for (const item of items) configuration_summary[item.configuration_status]++
  return { summary, configuration_summary, limits: COVERAGE_LIMITS, items }
}
