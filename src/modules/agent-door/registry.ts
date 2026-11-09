import { offers } from './capabilities.mjs'
import { recordOnlyAuthority } from './conformance/authority.mjs'
import { narrowingContract } from './conformance/narrowing.mjs'
import { isClass } from './policy/catalogue.ts'
import { schemaValid } from './json-schema.ts'
import type { AgentDoorOptions, ToolDefinition } from './types.ts'
import { validToolName } from './conformance/tool-name.mjs'

export const defineTool = (tool: ToolDefinition): ToolDefinition => tool
export function registry(options: AgentDoorOptions): ToolDefinition[] {
  if (!/^[a-z][a-z0-9-]*$/.test(options.seed) || !validToolName(`${options.seed}.events.list`, options.seed)) throw new TypeError('Invalid seed id')
  if (new URL(options.origin).origin !== options.origin) throw new TypeError('Agent origin must be canonical')
  for (const resource of offers(options.capabilities, 'resources') ? options.resources ?? [] : []) {
    if (!resource.classes?.length || new Set(resource.classes).size !== resource.classes.length || resource.classes.some(cls => !isClass(cls)) || typeof resource.classify !== 'function') throw new TypeError(`Invalid resource classes: ${resource.uriTemplate}`)
  }
  const names = new Set<string>([`${options.seed}.events.list`])
  return options.tools.map(tool => {
    if (!validToolName(tool.name, options.seed) || names.has(tool.name)) throw new TypeError(`Invalid or duplicate tool name: ${tool.name}`)
    names.add(tool.name)
    if (tool.exposure !== undefined && tool.exposure !== 'invoke') throw new TypeError(`Invalid exposure: ${tool.name}`)
    if (!tool.classes?.length || new Set(tool.classes).size !== tool.classes.length || tool.classes.some(cls => !isClass(cls))) throw new TypeError(`Invalid classes: ${tool.name}`)
    if (!tool.inputSchema || tool.inputSchema.type !== 'object' || !schemaValid(tool.inputSchema) || tool.outputSchema === undefined || !schemaValid(tool.outputSchema)) throw new TypeError(`Missing or invalid schema: ${tool.name}`)
    if (!tool.scope || !tool.title || !tool.description || typeof tool.readOnly !== 'boolean' || !Array.isArray(tool.clauses) || typeof tool.classify !== 'function' || typeof tool.run !== 'function') throw new TypeError(`Invalid tool: ${tool.name}`)
    if ((tool.proof !== undefined || tool.proofKind !== undefined) && (tool.proof !== 'native' || typeof tool.proofKind !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.proofKind) || typeof options.nativeProof?.verify !== 'function' || typeof options.nativeProof?.handoff !== 'function')) throw new TypeError(`Missing native proof verifier or kind: ${tool.name}`)
    if ('cost' in tool) throw new TypeError(`Provider cost is not enforced: ${tool.name}`)
    if (!tool.readOnly && typeof tool.summary !== 'function') throw new TypeError(`Missing approval summary: ${tool.name}`)
    if (tool.target !== undefined && typeof tool.target !== 'function') throw new TypeError(`Invalid target resolver: ${tool.name}`)
    if (tool.continuationItem !== undefined && (tool.readOnly || typeof tool.continuationItem !== 'function')) throw new TypeError(`Invalid continuation item resolver: ${tool.name}`)
    if (tool.authority === 'none' && !recordOnlyAuthority(tool)) throw new TypeError(`Invalid no-subject authority: ${tool.name}`)
    if (tool.classes.some(cls => cls === 'access' || cls === 'security') && tool.authority !== 'none' && typeof tool.authority !== 'function') throw new TypeError(`Missing authority: ${tool.name}`)
    if ((tool.widens !== undefined || tool.narrowing !== undefined) && (!tool.classes.some(cls => cls === 'access' || cls === 'security') || tool.readOnly || !narrowingContract(tool))) throw new TypeError(`Invalid narrowing-only contract: ${tool.name}`)
    const properties = { ...tool.inputSchema.properties }
    if ('idempotency_key' in properties || 'expected_revision' in properties) throw new TypeError(`Reserved argument: ${tool.name}`)
    const required = [...tool.inputSchema.required ?? []]
    if (!tool.readOnly) { properties.idempotency_key = { type: 'string', minLength: 1, maxLength: 200 }; required.push('idempotency_key') }
    if (tool.revisionType !== undefined && (!tool.revision || !['integer', 'number', 'string'].includes(tool.revisionType))) throw new TypeError(`Invalid revision type: ${tool.name}`)
    if (tool.revision) properties.expected_revision = { type: tool.revisionType ?? 'integer' }
    return { ...tool, inputSchema: { ...tool.inputSchema, properties, required }, classes: [...tool.classes], clauses: [...tool.clauses] }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
export function describeTool(tool: ToolDefinition) {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.classes.includes('destructive'), openWorldHint: tool.classes.includes('external') },
    _meta: { 'com.runeditrun/classes': tool.classes, 'com.runeditrun/clauses': tool.clauses, 'com.runeditrun/scope': tool.scope, ...(tool.authority === 'none' ? { 'com.runeditrun/authority': 'none', 'com.runeditrun/effect': tool.effect } : {}), ...(tool.proof ? { 'com.runeditrun/proof': tool.proof, 'com.runeditrun/proof-kind': tool.proofKind } : {}), ...(tool.widens === false ? { 'com.runeditrun/widens': false, 'com.runeditrun/narrowing': tool.narrowing } : {}) } }
}
export function templateMatches(template: string, uri: string) {
  const pattern = template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+')
  return new RegExp(`^${pattern}$`).test(uri)
}
