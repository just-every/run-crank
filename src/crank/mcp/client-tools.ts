import { assertExecutorOutput, validateOutputSchema } from '../executors/output-schema'
import { grantLeaves, type GrantPolicy, type GrantRule } from '../grants/policy'
import type { Graph } from '../engine/graph'
import { compare, parseDecimal } from '../engine/decimal'
import { isObject } from '../engine/values'
import { canonical, requireValue, text } from '../model'

export interface ClientTool {
  name: string; description: string; step_id: string; inputSchema: Record<string, unknown>
  fixed: Record<string, unknown>; approval_step_id?: string
}

/** Expose only explicitly selected native connector leaves of one publication. */
export function clientTools(value: unknown, graph: Graph, policy: GrantPolicy): ClientTool[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 50, 'Choose between one and fifty tools')
  const leaves = grantLeaves(graph), names = new Set<string>()
  return value.map(raw => {
    requireValue(isObject(raw), 'Each tool needs a declaration')
    requireValue(Object.keys(raw).every(k => ['name','description','step_id','inputSchema','fixed','approval_step_id'].includes(k)), 'Unknown tool setting')
    const name = text(raw.name, 'Tool name', 64)
    requireValue(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) && !names.has(name), 'Tool names must be distinct identifiers'); names.add(name)
    const step = leaves.find(s => s.id === raw.step_id), rule = policy.rules.find(r => r.step_id === raw.step_id)
    requireValue(step && rule && /^(slack\.|google_calendar\.)/.test(step.type), 'Choose a native connector action or search from the publication')
    validateOutputSchema(raw.inputSchema, name)
    requireValue(isObject(raw.inputSchema) && raw.inputSchema.type === 'object' && raw.inputSchema.additionalProperties === false, 'Tool input must be an object with additionalProperties false')
    const properties = isObject(raw.inputSchema.properties) ? raw.inputSchema.properties : {}
    requireValue(Object.keys(properties).every(key => rule.fields.includes(key) && !['__proto__','constructor','prototype'].includes(key)), 'Tool arguments must be allowed grant fields')
    const fixed = raw.fixed ?? {}
    requireValue(isObject(fixed) && Object.keys(fixed).every(key => rule.fields.includes(key) && !Object.hasOwn(properties,key)), 'Fixed fields must be allowed and cannot be exposed as arguments')
    requireValue(!canonical(fixed).includes('{{'), 'Fixed parameters must be literal JSON')
    if (raw.approval_step_id !== undefined) requireValue(leaves.some(s => s.id === raw.approval_step_id && s.type === 'approval' && s.on_reject !== 'continue') && policy.rules.some(r=>r.step_id===raw.approval_step_id && r.fields.includes('proposal')), 'Choose a stopping approval step from the same publication')
    return { name, description: text(raw.description, 'Tool description', 500), step_id: step.id, inputSchema: raw.inputSchema, fixed,
      ...(typeof raw.approval_step_id === 'string' ? { approval_step_id: raw.approval_step_id } : {}) }
  })
}

function inputAt(input: Record<string, unknown>, path: string): unknown {
  let value: unknown = input
  for (const key of path.split('.')) { if (!isObject(value) || !Object.hasOwn(value,key)) return undefined; value = value[key] }
  return value
}

/** These client limits are hard boundaries; native workflow caps may still ask for approval. */
export function toolInput(tool: ClientTool, args: unknown, original: unknown, rule: GrantRule): Record<string, unknown> {
  try { assertExecutorOutput(args,tool.inputSchema,tool.name,'mcp') } catch { requireValue(false,'Arguments do not match the enabled tool schema',422) }
  const input = {...(isObject(original) ? original : {}),...tool.fixed,...args as Record<string,unknown>}
  requireValue(!canonical(input).includes('{{'), 'Tool inputs must be literal JSON',422)
  requireValue(Object.keys(input).every(key => rule.fields.includes(key)), 'Input fields exceed the client grant',403)
  if (rule.recipient_field) {
    const value = inputAt(input,rule.recipient_field), recipients = Array.isArray(value) ? value : [value]
    requireValue(recipients.length > 0 && recipients.every(v => typeof v === 'string' && rule.recipients.includes(v)), 'Recipients exceed the client grant',403)
  }
  if (rule.amount_field) {
    const amount = parseDecimal(inputAt(input,rule.amount_field)), maximum = parseDecimal(rule.max_usd)
    requireValue(amount && maximum && amount.units >= 0n && compare(amount,maximum) <= 0, 'Amount exceeds the client grant',403)
  }
  return input
}
