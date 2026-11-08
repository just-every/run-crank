import type { ResourceContext, ResourceDefinition, Runtime, ToolContext, ToolDefinition } from './types.ts'
import { templateMatches } from './registry.ts'
import { ToolRefusal } from './errors.ts'
import { policyState } from './policy-store.ts'
import { canonical } from './policy/document.ts'

const resourceContext = (ctx: ToolContext): ResourceContext => ({ person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId, db: ctx.db,
  consent: ctx.consent, operationId: ctx.operationId, idempotencyKey: ctx.idempotencyKey, continuationItemId: ctx.continuationItemId })
const projection = (record: NonNullable<Awaited<ReturnType<ResourceDefinition['read']>>>) => {
  // Retain classifier inputs and serialize the JSON fallback once for comparison and serving.
  const value = record.json, text = record.text, untrusted = !!record.untrusted
  const json = text == null ? JSON.stringify(value) : undefined
  return { snapshot: canonical({ json: value, text, untrusted, serialized: json === undefined ? undefined : JSON.parse(json) }), text: text ?? json, untrusted }
}

/** A resource read uses the same admission, decision and execution as a tool. */
export function resourceTool(rt: Runtime, uri: string): ToolDefinition | undefined {
  const resource = rt.options.resources?.find(resource => templateMatches(resource.uriTemplate, uri))
  if (!resource) return undefined
  let snapshot: string | undefined
  const consentFence = async (ctx: ToolContext) => {
    if (ctx.consent && (await policyState(rt)).revoked.consents.includes(ctx.consent)) throw new ToolRefusal('consent_revoked')
  }
  return {
    name: 'resources/read', title: resource.name, description: resource.description ?? resource.name,
    scope: resource.scope ?? '', readOnly: true, classes: resource.classes, clauses: [],
    inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { contents: { type: 'array', items: { type: 'object' } } }, required: ['contents'], additionalProperties: false },
    async classify(_args, ctx) {
      snapshot = undefined
      let record: Awaited<ReturnType<typeof resource.read>>
      try { record = await resource.read(uri, resourceContext(ctx)) } catch { record = null }
      if (!record) throw new ToolRefusal('resource_unavailable')
      // Retain values before a classifier or later read can mutate the record.
      snapshot = projection(record).snapshot
      return resource.classify(record, resourceContext(ctx))
    },
    async run(_args, ctx) {
      if (snapshot === undefined) throw new ToolRefusal('resource_unavailable')
      await consentFence(ctx)
      const record = await resource.read(uri, resourceContext(ctx))
      const current = record && projection(record)
      const contents = current && [{ uri, mimeType: resource.mimeType ?? 'application/json', text: current.text,
        ...(current.untrusted ? { _meta: { 'com.runeditrun/untrusted': true } } : {}) }]
      // Fence the awaited read itself, including a revocation inside its hook.
      await consentFence(ctx)
      if (!contents) throw new ToolRefusal('resource_unavailable')
      if (current?.snapshot !== snapshot) throw new ToolRefusal('resource_changed')
      return { result: { contents } }
    },
  }
}
export const savedTool = (rt: Runtime, name: string, args: Record<string, unknown>) => name === 'resources/read' ? resourceTool(rt, String(args.uri)) : rt.tools.find(tool => tool.name === name)
