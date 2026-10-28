import { isClass } from './policy/catalogue.ts'
import { schemaValid } from './json-schema.ts'
import type { AgentDoorOptions, ToolDefinition } from './types.ts'

export const defineTool = (tool: ToolDefinition): ToolDefinition => tool
export function registry(options: AgentDoorOptions): ToolDefinition[] {
  if (!/^[a-z][a-z0-9-]*$/.test(options.seed)) throw new TypeError('Invalid seed id')
  if (new URL(options.origin).origin !== options.origin) throw new TypeError('Agent origin must be canonical')
  for (const resource of options.resources ?? []) {
    if (!resource.classes?.length || new Set(resource.classes).size !== resource.classes.length || resource.classes.some(cls => !isClass(cls)) || typeof resource.classify !== 'function') throw new TypeError(`Invalid resource classes: ${resource.uriTemplate}`)
  }
  const names = new Set<string>([`${options.seed}.events.list`])
  return options.tools.map(tool => {
    if (tool.name.length > 200 || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(tool.name) || !tool.name.startsWith(`${options.seed}.`) || names.has(tool.name)) throw new TypeError(`Invalid or duplicate tool name: ${tool.name}`)
    names.add(tool.name)
    if (!tool.classes?.length || new Set(tool.classes).size !== tool.classes.length || tool.classes.some(cls => !isClass(cls))) throw new TypeError(`Invalid classes: ${tool.name}`)
    if (!tool.inputSchema || tool.inputSchema.type !== 'object' || !schemaValid(tool.inputSchema) || tool.outputSchema === undefined || !schemaValid(tool.outputSchema)) throw new TypeError(`Missing or invalid schema: ${tool.name}`)
    if (!tool.scope || !tool.title || !tool.description || typeof tool.readOnly !== 'boolean' || !Array.isArray(tool.clauses) || typeof tool.classify !== 'function' || typeof tool.run !== 'function') throw new TypeError(`Invalid tool: ${tool.name}`)
    if ('cost' in tool) throw new TypeError(`Provider cost is not enforced: ${tool.name}`)
    if (!tool.readOnly && typeof tool.summary !== 'function') throw new TypeError(`Missing approval summary: ${tool.name}`)
    if (tool.classes.some(cls => cls === 'access' || cls === 'security') && typeof tool.authority !== 'function') throw new TypeError(`Missing authority: ${tool.name}`)
    const properties = { ...tool.inputSchema.properties }
    if ('idempotency_key' in properties || 'expected_revision' in properties) throw new TypeError(`Reserved argument: ${tool.name}`)
    const required = [...tool.inputSchema.required ?? []]
    if (!tool.readOnly) { properties.idempotency_key = { type: 'string', minLength: 1, maxLength: 200 }; required.push('idempotency_key') }
    if (tool.revision) properties.expected_revision = { type: 'integer' }
    return { ...tool, inputSchema: { ...tool.inputSchema, properties, required }, classes: [...tool.classes], clauses: [...tool.clauses] }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
export function describeTool(tool: ToolDefinition) {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.classes.includes('destructive'), openWorldHint: tool.classes.includes('external') },
    _meta: { 'com.runeditrun/classes': tool.classes, 'com.runeditrun/clauses': tool.clauses, 'com.runeditrun/scope': tool.scope } }
}
export function templateMatches(template: string, uri: string) {
  const pattern = template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+')
  return new RegExp(`^${pattern}$`).test(uri)
}
