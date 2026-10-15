import { readFileSource } from '../modules/import-kit/readers/file.ts'
import type { Json, SourceBundle } from '../modules/import-kit/types.ts'
import { validateImportTargetUrl, type ImportTargetEnv } from './import-target.ts'

export const N8N_MAPPING_VERSION = 'crank-n8n-body-forward-v1'
export const N8N_MAX_BYTES = 128 * 1024
export const N8N_MAX_WORKFLOWS = 20
const BODY_FORWARD = '={{ $json.body }}'
type ObjectValue = Record<string, Json>
export interface N8nWorkflow { sourceId: string; name: string; targetUrl: string }

function object(value: Json | undefined): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('N8N_OBJECT_REQUIRED')
  return value
}
function keys(value: ObjectValue, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('N8N_UNSUPPORTED_FIELD')
}
function text(value: Json | undefined, limit = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('N8N_TEXT_INVALID')
  return value
}
function empty(value: Json | undefined) {
  if (value !== undefined && Object.keys(object(value)).length) throw new Error('N8N_UNSUPPORTED_OPTIONS')
}
/** Inspect the entire export before retention. The sole allowed expression is a
 * declarative whole-body marker in the HTTP node's jsonBody, never evaluated. */
function inspect(value: Json, path: string[] = []) {
  if (path.length > 24) throw new Error('N8N_NESTING_LIMIT')
  if (typeof value === 'string') {
    if ((value.startsWith('=') || value.includes('{{')) && !(path.join('.') === 'nodes.1.parameters.jsonBody' && value === BODY_FORWARD)) throw new Error('N8N_EXPRESSION_UNSUPPORTED')
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/credential|password|secret|authorization|cookie|api.?key|access.?token|refresh.?token/i.test(key)) throw new Error('N8N_CREDENTIALS_FORBIDDEN')
      inspect(item, [...path, key])
    }
  }
}

function workflow(value: Json, index: number, env: ImportTargetEnv): N8nWorkflow {
  const root = object(value)
  keys(root, ['id', 'name', 'nodes', 'connections', 'active', 'settings', 'versionId', 'createdAt', 'updatedAt', 'tags', 'pinData', 'staticData', 'meta'])
  const name = text(root.name)
  const sourceId = root.id === undefined ? `workflow-${index + 1}` : text(root.id)
  if (root.active !== undefined && typeof root.active !== 'boolean') throw new Error('N8N_ACTIVE_INVALID')
  if (root.tags !== undefined && (!Array.isArray(root.tags) || root.tags.length)) throw new Error('N8N_TAGS_UNSUPPORTED')
  empty(root.pinData); empty(root.meta)
  if (root.staticData !== null) empty(root.staticData)
  for (const field of ['versionId', 'createdAt', 'updatedAt']) if (root[field] !== undefined) text(root[field])
  const settings = root.settings === undefined ? {} : object(root.settings)
  keys(settings, ['executionOrder'])
  if (settings.executionOrder !== undefined && settings.executionOrder !== 'v1') throw new Error('N8N_SETTINGS_UNSUPPORTED')
  if (!Array.isArray(root.nodes) || root.nodes.length !== 2) throw new Error('N8N_TWO_NODES_REQUIRED')
  const nodes = root.nodes.map(object)
  const webhook = nodes.find(node => node.type === 'n8n-nodes-base.webhook')
  const http = nodes.find(node => node.type === 'n8n-nodes-base.httpRequest')
  if (!webhook || !http || webhook === http) throw new Error('N8N_GRAPH_UNSUPPORTED')
  // Normalize node order only for the credential/expression inspection path.
  inspect({ ...root, nodes: [webhook, http] })
  for (const node of nodes) {
    keys(node, ['id', 'name', 'type', 'typeVersion', 'position', 'parameters', 'webhookId'])
    text(node.id); text(node.name)
    if (!Array.isArray(node.position) || node.position.length !== 2 || node.position.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('N8N_POSITION_INVALID')
    if (node.webhookId !== undefined) text(node.webhookId)
  }
  if (webhook.id === http.id || webhook.name === http.name) throw new Error('N8N_DUPLICATE_NODE')
  if (![1, 2, 2.1].includes(webhook.typeVersion as number) || ![4, 4.1, 4.2, 4.3].includes(http.typeVersion as number)) throw new Error('N8N_NODE_VERSION_UNSUPPORTED')
  const trigger = object(webhook.parameters)
  keys(trigger, ['httpMethod', 'path', 'authentication', 'responseMode', 'options'])
  if (trigger.httpMethod !== 'POST' || (trigger.authentication !== undefined && trigger.authentication !== 'none') || (trigger.responseMode !== undefined && trigger.responseMode !== 'onReceived')) throw new Error('N8N_WEBHOOK_MODE_UNSUPPORTED')
  text(trigger.path, 240); empty(trigger.options)
  const request = object(http.parameters)
  keys(request, ['method', 'url', 'authentication', 'sendBody', 'contentType', 'specifyBody', 'jsonBody', 'sendHeaders', 'sendQuery', 'options'])
  if (request.method !== 'POST' || request.sendBody !== true || (request.contentType !== undefined && request.contentType !== 'json') || request.specifyBody !== 'json' || request.jsonBody !== BODY_FORWARD) throw new Error('N8N_BODY_MODE_UNSUPPORTED')
  if ((request.authentication !== undefined && request.authentication !== 'none') || (request.sendHeaders !== undefined && request.sendHeaders !== false) || (request.sendQuery !== undefined && request.sendQuery !== false)) throw new Error('N8N_REQUEST_OPTIONS_UNSUPPORTED')
  empty(request.options)
  const connections = object(root.connections)
  keys(connections, [webhook.name as string, http.name as string])
  const outgoing = object(connections[webhook.name as string])
  keys(outgoing, ['main'])
  if (!Array.isArray(outgoing.main) || outgoing.main.length !== 1 || !Array.isArray(outgoing.main[0]) || outgoing.main[0].length !== 1) throw new Error('N8N_GRAPH_UNSUPPORTED')
  const edge = object(outgoing.main[0][0])
  keys(edge, ['node', 'type', 'index'])
  if (edge.node !== http.name || edge.type !== 'main' || edge.index !== 0) throw new Error('N8N_GRAPH_UNSUPPORTED')
  if (connections[http.name as string] !== undefined) empty(connections[http.name as string])
  return { sourceId, name, targetUrl: validateImportTargetUrl(env, request.url) }
}

export async function readN8nSource(env: ImportTargetEnv, namespace: string, source: string): Promise<{ bundle: SourceBundle; workflows: N8nWorkflow[] }> {
  if (typeof namespace !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(namespace)) throw new Error('IMPORT_NAMESPACE_INVALID')
  if (typeof source !== 'string' || !source.trim()) throw new Error('N8N_SOURCE_REQUIRED')
  const bytes = new TextEncoder().encode(source)
  if (bytes.length > N8N_MAX_BYTES) throw new Error('N8N_SOURCE_BYTE_LIMIT')
  const workflows: N8nWorkflow[] = []
  // The kit reader checks every retained byte for credentials and duplicate keys.
  // Only fully supported exports are accepted; no source rows can be skipped.
  let failure: unknown
  const bundle = await readFileSource({ namespace, name: 'n8n-workflows.json', bytes, format: 'json', parse(value, index) {
    try {
      if (index >= N8N_MAX_WORKFLOWS) throw new Error('N8N_WORKFLOW_LIMIT')
      const parsed = workflow(value, index, env)
      if (workflows.some(row => row.sourceId === parsed.sourceId)) throw new Error('N8N_DUPLICATE_WORKFLOW_ID')
      workflows.push(parsed)
      return { kind: 'n8n-workflow', sourceId: parsed.sourceId, payload: value }
    } catch (error) { failure = error; throw error }
  } }, { maxBytes: N8N_MAX_BYTES, maxRecords: N8N_MAX_WORKFLOWS, maxRecordBytes: N8N_MAX_BYTES }).catch(error => { throw failure ?? error })
  if (!workflows.length) throw new Error('N8N_SOURCE_EMPTY')
  return { bundle, workflows }
}
