import type { Principal, Runtime } from './types.ts'
import { revoked } from './execution.ts'
import { authenticate } from './credentials.ts'
import { admit } from './admission.ts'
import { policyRefusal, policyState } from './policy-store.ts'
import { answered } from './policy/document.ts'
import { decide } from './policy/decide.ts'
import { callTool } from './pipeline.ts'
import { resourceTool } from './resource-tool.ts'
import { describeTool } from './registry.ts'
import { subscriptions } from './subscriptions.ts'
import { cache, capabilities, challenge, discovery, metaOf, parseRequest, rpcError, rpcResult, toolResult, type Rpc } from './wire.ts'

const methods = ['server/discover', 'initialize', 'tools/list', 'tools/call', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'subscriptions/listen']
function readGuard(rt: Runtime, rpc: Rpc, state: Awaited<ReturnType<typeof policyState>>, principal: Principal): Response | null {
  const refusal = policyRefusal(rt, state, ['standard'])
  if (refusal) return rpcError(rpc.id, -32000, refusal.code, 200, { code: refusal.code, ...refusal.fields })
  const decision = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes: [{ class: 'standard', facts: { measure: 1 } }] }, usageToday: () => 0 })
  return ['blocked', 'approval', 'unset'].includes(decision.result) ? rpcError(rpc.id, -32000, 'Read refused by policy', 200, { code: decision.result === 'blocked' ? 'policy_blocked' : decision.result === 'unset' ? 'policy_unset' : 'approval_required', revision: state.revision }) : null
}
export async function mcp(rt: Runtime, request: Request): Promise<Response> {
  const rpc = await parseRequest(rt, request)
  if (rpc instanceof Response) return rpc
  if (!methods.includes(rpc.method) && !rpc.method.startsWith('notifications/')) return rpcError(rpc.id, -32601, 'Method not found', 404)
  if (rpc.method === 'server/discover') return rpcResult(rpc, discovery(rt))
  if (rpc.method === 'initialize') return rpcResult(rpc, { protocolVersion: '2025-11-25', capabilities, serverInfo: { name: rt.options.name, version: rt.options.version ?? '1' }, instructions: discovery(rt).instructions })
  const state = await policyState(rt), principal = await authenticate(rt.options, request, state.business)
  if (!principal || revoked(state, principal)) return rpcError(rpc.id, -32001, 'Unauthorized', 401, undefined, challenge(rt))
  const capacity = await admit(rt, principal)
  if (capacity === 'revoked') return rpcError(rpc.id, -32001, 'Unauthorized', 401, undefined, challenge(rt))
  if (typeof capacity === 'number') return rpcError(rpc.id, -32000, 'Capacity exceeded', 429, { code: 'rate_limited' }, { 'retry-after': String(capacity) })
  if (rpc.id === undefined) return new Response(null, { status: 202 })
  const params = rpc.params ?? {}, meta = metaOf(rpc)
  if (rpc.method === 'tools/call') {
    const answer = await callTool(rt, String(params.name ?? ''), params.arguments, principal, 'mcp', meta.traceparent, undefined, params.requestState)
    if (answer.status === 500) return rpcError(rpc.id, -32603, 'Tool execution failed', 500, { code: answer.result.code })
    if (answer.result.code === 'tool_not_found') return rpcError(rpc.id, -32602, 'Unknown tool', 400)
    if (answer.status === 403) return rpcError(rpc.id, -32000, 'Insufficient scope', 403, { code: 'insufficient_scope' }, challenge(rt, answer.scope))
    return rpcResult(rpc, toolResult(answer.result, request.headers.get('mcp-protocol-version')!, meta['io.modelcontextprotocol/clientCapabilities']))
  }
  if (rpc.method === 'tools/list') return rpcResult(rpc, { ...cache, tools: policyRefusal(rt, state, []) ? [] : rt.tools.filter(tool => tool.classes.every(cls => answered(state.document, cls))).map(describeTool) })
  if (rpc.method === 'resources/templates/list') return rpcResult(rpc, { ...cache, resourceTemplates: policyRefusal(rt, state, ['standard']) ? [] : [...rt.options.resources ?? []].filter(resource => !resource.scope || principal.scopes.includes(resource.scope)).sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate)).map(({ read: _read, classify: _classify, classes: _classes, scope: _scope, ...resource }) => resource) })
  if (rpc.method === 'prompts/list') return rpcResult(rpc, { ...cache, prompts: policyRefusal(rt, state, ['standard']) ? [] : [...rt.options.prompts ?? []].sort((a, b) => a.name.localeCompare(b.name)).map(({ messages: _messages, ...prompt }) => prompt) })
  if (rpc.method === 'resources/read') {
    const uri = String(params.uri ?? ''), resource = resourceTool(rt, uri)
    const answer = await callTool(rt, 'resources/read', { uri }, principal, 'mcp', meta.traceparent, resource, params.requestState)
    if (answer.status === 403) return rpcError(rpc.id, -32000, 'Insufficient scope', 403, { code: 'insufficient_scope' }, challenge(rt, answer.scope))
    if (['resource_unavailable', 'tool_not_found'].includes(answer.result.code ?? '')) return rpcError(rpc.id, -32602, 'Resource unavailable', 200)
    if (answer.result.outcome === 'pending') return rpcError(rpc.id, -32000, 'approval_required', 200, { code: 'approval_required', approval: answer.result.approval, requestState: answer.result.requestState, _meta: { 'com.runeditrun/decision': answer.result.decision } })
    if (answer.result.outcome !== 'done') return rpcError(rpc.id, -32000, answer.result.code ?? 'Read refused', answer.status ?? 200, { code: answer.result.code, ...answer.result.fields, _meta: { 'com.runeditrun/decision': answer.result.decision } })
    return rpcResult(rpc, { ...cache, ...answer.result.result as object, _meta: { 'com.runeditrun/decision': answer.result.decision, ...(answer.result.review ? { 'com.runeditrun/review': answer.result.review } : {}) } })
  }
  const refused = readGuard(rt, rpc, state, principal)
  if (refused) return refused
  if (rpc.method === 'prompts/get') {
    const prompt = rt.options.prompts?.find(prompt => prompt.name === params.name)
    if (!prompt) return rpcError(rpc.id, -32602, 'Prompt unavailable', 200)
    const args = params.arguments
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args) || Object.values(args).some(value => typeof value !== 'string'))) return rpcError(rpc.id, -32602, 'Invalid prompt arguments', 200)
    return rpcResult(rpc, { ...cache, description: prompt.description, messages: prompt.messages((args ?? {}) as Record<string, string>) })
  }
  if (rpc.method === 'subscriptions/listen') return subscriptions(rt, request, rpc, principal)
  return rpcError(rpc.id, -32601, 'Method not found', 404)
}
