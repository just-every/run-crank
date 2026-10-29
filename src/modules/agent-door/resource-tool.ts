import type { Runtime, ToolDefinition } from './types.ts'
import { templateMatches } from './registry.ts'
import { ToolRefusal } from './errors.ts'

/** A resource read uses the same admission, decision and execution as a tool. */
export function resourceTool(rt: Runtime, uri: string): ToolDefinition | undefined {
  const resource = rt.options.resources?.find(resource => templateMatches(resource.uriTemplate, uri))
  if (!resource) return undefined
  let record: Awaited<ReturnType<typeof resource.read>>
  return {
    name: 'resources/read', title: resource.name, description: resource.description ?? resource.name,
    scope: resource.scope ?? '', readOnly: true, classes: resource.classes, clauses: [],
    inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { contents: { type: 'array', items: { type: 'object' } } }, required: ['contents'], additionalProperties: false },
    async classify(_args, ctx) {
      try { record = await resource.read(uri, { person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId, db: ctx.db }) } catch { record = null }
      if (!record) throw new ToolRefusal('resource_unavailable')
      return resource.classify(record, { person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId, db: ctx.db })
    },
    async run(_args, ctx) {
      if (!record || !await resource.read(uri, { person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId, db: ctx.db })) throw new ToolRefusal('resource_unavailable')
      return { result: { contents: [{ uri, mimeType: resource.mimeType ?? 'application/json', text: record.text ?? JSON.stringify(record.json),
        ...(record.untrusted ? { _meta: { 'com.runeditrun/untrusted': true } } : {}) }] } }
    },
  }
}
export const savedTool = (rt: Runtime, name: string, args: Record<string, unknown>) => name === 'resources/read' ? resourceTool(rt, String(args.uri)) : rt.tools.find(tool => tool.name === name)
