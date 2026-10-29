import type { AgentDoor, AgentDoorOptions, Runtime } from './types.ts'
import { capabilitySet, offers } from './capabilities.mjs'
import { registry } from './registry.ts'
import { eventsTool, appendEvents } from './events.ts'
import { personDoor } from './person-doors.ts'
import { agentPage } from './pages.ts'
import { mcp } from './transport.ts'
import { adoptPolicy, policyState } from './policy-store.ts'
import { admit } from './admission.ts'
import { callTool } from './pipeline.ts'
import { revoked } from './execution.ts'
import { json } from './errors.ts'

export { CORE_CAPABILITIES, OPTIONAL_CAPABILITIES } from './capabilities.mjs'
export type { Capability } from './capabilities.mjs'
export { defineTool } from './registry.ts'
export { ToolRefusal } from './errors.ts'
export { operatorAuthPeople } from './operator-people.ts'
export type * from './types.ts'
export type { ClassId, ClassFacts } from './policy/catalogue.ts'

export function createAgentDoor(options: AgentDoorOptions): AgentDoor {
  capabilitySet(options.capabilities)
  options = { ...options, ...(options.capabilities === undefined ? {} : { capabilities: [...options.capabilities] }) }
  if (options.capabilities !== undefined) {
    if (!options.tools.length) throw new TypeError('Declared tools must offer at least one tool')
    if (offers(options.capabilities, 'resources') && !options.resources?.length) throw new TypeError('Declared resources must offer a resource')
    if (offers(options.capabilities, 'prompts') && !options.prompts?.length) throw new TypeError('Declared prompts must offer a prompt')
  }
  const limits = { requestsPerMinute: 600, maxBodyBytes: 1048576, ...options.limits }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('Invalid capacity limits')
  const rt: Runtime = { options: { ...options, limits }, tools: registry(options), now: options.now ?? Date.now }
  rt.tools = [...rt.tools, ...(offers(options.capabilities, 'events') ? [eventsTool(rt)] : [])].sort((a, b) => a.name.localeCompare(b.name))
  return {
    async handle(request) {
      const path = new URL(request.url).pathname
      if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)) return json({ resource: `${options.origin}/mcp`, authorization_servers: options.trust ? [options.trust.issuer] : [], scopes_supported: [...new Set([...rt.tools.map(tool => tool.scope), ...(offers(options.capabilities, 'resources') ? options.resources?.flatMap(resource => resource.scope ? [resource.scope] : []) ?? [] : [])])].sort(), bearer_methods_supported: ['header'] })
      if (path === '/api/rer/agent-policy') {
        const response = await adoptPolicy(rt, request)
        if (response.ok) {
          const state = await policyState(rt)
          await appendEvents(rt, [{ type: 'policy.adopted', uri: `${options.origin}/agents/policy/${state.seq}`, actor: { kind: 'business' }, data: { seq: state.seq, revision: state.revision } }])
        }
        return response
      }
      if (path === '/mcp' || options.paths?.includes(path)) return mcp(rt, request)
      if (path.startsWith('/agents/api/')) return personDoor(rt, request)
      if (path === '/agents' || /^\/agents\/approvals\/[^/]+$/.test(path)) {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        const person = request.headers.has('authorization') ? null : await options.people.session(request)
        return agentPage(rt, request, person?.active ? person : null)
      }
      return null
    },
    async invoke(name, args, who, proofReference) {
      const person = await options.people.person(who.person.id)
      if (!person?.active || person.id !== who.person.id) return { outcome: 'refused', code: 'unauthenticated', decision: null }
      const principal = { person, agent: who.agent, consent: who.consent, scopes: [...who.scopes], clientId: who.clientId }
      if (revoked(await policyState(rt), { agent: principal.agent })) return { outcome: 'refused', code: 'unauthenticated', decision: null }
      const capacity = await admit(rt, principal)
      if (capacity !== null) return { outcome: 'refused', code: capacity === 'revoked' ? 'unauthenticated' : 'rate_limited', decision: null }
      return (await callTool(rt, name, args, principal, 'embedded', undefined, undefined, undefined, proofReference, who.operationId)).result
    },
    async emit(event) {
      await appendEvents(rt, [{ type: event.type, uri: event.uri, actor: { kind: 'person', person: { id: event.person.id, name: event.person.name } }, data: event.data }])
    },
  }
}
