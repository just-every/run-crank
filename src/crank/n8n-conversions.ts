import type { Json } from '../modules/import-kit/src/types'
import { canonicalJson, sha256 } from '../modules/import-kit/src/provenance/identity'
import type { Step } from './engine/types'

type Obj = Record<string, any>
const object = (value: any): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('N8N_CONVERSION_OBJECT_REQUIRED')
  return value
}
const keys = (value: Obj, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('N8N_CONVERSION_FIELD_UNSUPPORTED')
}
const text = (value: any, max = 160) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('N8N_CONVERSION_TEXT_INVALID')
  return value
}

/** Choices travel inside retained bytes, so the import kit's source hash and
 * cached plan fingerprint bind both the unchanged export and its review. */
export function migrationEnvelope(value: Json): { workflow: Obj; conversions: Obj; explicit: boolean } {
  const root = object(value)
  if (!Object.hasOwn(root, 'workflow')) return { workflow: root, conversions: {}, explicit: false }
  keys(root, ['workflow', 'conversions'])
  const workflow = object(root.workflow), conversions = object(root.conversions)
  const ids = new Set(Array.isArray(workflow.nodes) ? workflow.nodes.map((n: Obj) => n.id) : [])
  for (const [id, choice] of Object.entries(conversions)) {
    if (!ids.has(id)) throw Error('N8N_CONVERSION_NODE_UNKNOWN')
    object(choice)
  }
  return { workflow, conversions, explicit: true }
}

/** Permit reference-only source credentials, never secret-bearing fields.
 * Embedded snapshots receive the same inspection before source retention. */
export function inspectGraphCredentials(value: Json, path: string[] = []): void {
  if (path.length > 32) throw Error('N8N_NESTING_LIMIT')
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (key === 'credentials' && path.length === 2 && path[0] === 'nodes') {
      for (const reference of Object.values(object(item))) {
        const ref = object(reference); keys(ref, ['id', 'name'])
        for (const value of Object.values(ref)) text(value)
      }
      continue
    }
    if (/credential|password|secret|authorization|cookie|api.?key|access.?token|refresh.?token/i.test(key)) throw Error('N8N_CREDENTIALS_FORBIDDEN')
    if (key === 'workflowJson' && typeof item === 'string' && !item.startsWith('=')) {
      let embedded: Json
      try { embedded = JSON.parse(item) } catch { throw Error('N8N_SUBFLOW_JSON_INVALID') }
      inspectGraphCredentials(embedded)
    }
    inspectGraphCredentials(item as Json, [...path, key])
  }
}

/** Conversion inputs use the source compiler's literal and declarative path
 * rules. Neither native mapping expressions nor source runtime APIs are run. */
export function conversionStep(choice: Obj, node: Obj, step: Obj & { id: string }, map: (value: any, field: string) => any): Step {
  if (choice.kind === 'manual') throw Error('owner retained a manual conversion disposition')
  if (choice.reviewed !== true) throw Error('conversion requires explicit owner review')
  const input: Obj = {}
  for (const [name, value] of Object.entries(object(choice.input))) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw Error('conversion input needs simple field names')
    input[name] = map(value, 'input.' + name)
  }
  if (choice.kind === 'registry-subflow') {
    keys(choice, ['kind', 'reviewed', 'subflow_id', 'subflow_version', 'definition_digest', 'input'])
    if (node.type !== 'n8n-nodes-base.executeWorkflow') throw Error('registry binding requires an Execute Workflow node')
    if (!Number.isSafeInteger(choice.subflow_version) || choice.subflow_version < 1 || !/^[a-f0-9]{64}$/.test(choice.definition_digest)) throw Error('registry binding requires a positive version and reviewed digest')
    return { ...step, type: 'subflow', subflow_id: text(choice.subflow_id), subflow_version: choice.subflow_version, definition_digest: choice.definition_digest, input } as Step
  }
  if (choice.kind !== 'isolated-code') throw Error('unsupported conversion choice')
  keys(choice, ['kind', 'reviewed', 'language', 'source', 'connection_id', 'executor_url', 'timeout_ms', 'memory_mb', 'allowed_egress', 'output_schema', 'input'])
  if (!['n8n-nodes-base.code', 'n8n-nodes-base.function', 'n8n-nodes-base.functionItem'].includes(node.type)) throw Error('isolated code binding requires a source Code or Function node')
  if (choice.language !== 'javascript' || typeof choice.source !== 'string' || !choice.source.trim() || choice.source.length > 65536) throw Error('declare reviewed native JavaScript source within 64 KiB')
  if (!Array.isArray(choice.allowed_egress) || choice.allowed_egress.length || choice.output_schema === undefined) throw Error('isolated code requires no egress and an output schema')
  object(choice.output_schema)
  return { ...step, type: 'code', language: 'javascript', source: choice.source, connection_id: text(choice.connection_id), executor_url: text(choice.executor_url, 2048), timeout_ms: choice.timeout_ms, memory_mb: choice.memory_mb, allowed_egress: [], output_schema: choice.output_schema, input } as Step
}

export function conversionDisposition(node: Obj, choice: Obj | undefined, resolved: boolean) {
  return { node_id: node.id, kind: choice?.kind ?? 'manual', resolved, source_digest: sha256(canonicalJson(node)), ...(choice ? { choice_digest: sha256(canonicalJson(choice)) } : {}) }
}
