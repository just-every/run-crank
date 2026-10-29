import { capabilitySet, offers } from './capabilities.mjs'
import { json } from './errors.ts'
import type { CallResult, Runtime } from './types.ts'

export const versions = ['2026-07-28', '2025-11-25']
export interface Rpc { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> }
export const metaOf = (rpc: Rpc): Record<string, unknown> => rpc.params?._meta && typeof rpc.params._meta === 'object' ? rpc.params._meta as Record<string, unknown> : {}
export const rpcError = (id: Rpc['id'], code: number, message: string, status = 400, data?: unknown, headers: HeadersInit = {}) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status, headers)
export const rpcResult = (rpc: Rpc, result: unknown) => json({ jsonrpc: '2.0', id: rpc.id ?? null, result })
export const resourceMetadata = (rt: Runtime) => `${rt.options.origin}/.well-known/oauth-protected-resource/mcp`
export const challenge = (rt: Runtime, scope?: string) => ({ 'www-authenticate': `Bearer ${scope ? `error="insufficient_scope", scope="${scope}", ` : ''}resource_metadata="${resourceMetadata(rt)}"` })
export const cache = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
export const capabilities = { tools: { listChanged: true }, resources: { subscribe: true, listChanged: false }, prompts: { listChanged: false } }
export function doorCapabilities(rt: Runtime) {
  if (rt.options.capabilities === undefined) return capabilities
  return { tools: { listChanged: offers(rt.options.capabilities, 'subscriptions') },
    ...(offers(rt.options.capabilities, 'resources') ? { resources: { subscribe: offers(rt.options.capabilities, 'subscriptions'), listChanged: false } } : {}),
    ...(offers(rt.options.capabilities, 'prompts') ? { prompts: { listChanged: false } } : {}) }
}
export function discovery(rt: Runtime) {
  return { ...cache, supportedVersions: versions, capabilities: doorCapabilities(rt), instructions: `${rt.options.name}: tools for the ${rt.options.specialist} specialist. Act for the sponsoring person under their company policy; people decide approvals at the supplied URL.`,
    _meta: { 'com.runeditrun/capabilities': capabilitySet(rt.options.capabilities), 'io.modelcontextprotocol/serverInfo': { name: rt.options.name, version: rt.options.version ?? '1' }, 'com.runeditrun/limits': rt.options.limits, 'com.runeditrun/notTools': rt.options.notTools ?? [] } }
}
export function toolResult(result: CallResult, version: string, clientCapabilities: unknown) {
  const meta: Record<string, unknown> = { 'com.runeditrun/decision': result.decision }
  if (result.review) meta['com.runeditrun/review'] = result.review
  if (result.receipt) meta['com.runeditrun/receipt'] = result.receipt
  if (result.untrusted) meta['com.runeditrun/untrusted'] = true
  if (result.outcome === 'pending' && version !== '2025-11-25') {
    meta['com.runeditrun/approval'] = result.approval
    const elicits = (clientCapabilities as { elicitation?: { url?: unknown } } | null)?.elicitation?.url !== undefined
    return { resultType: 'input_required', requestState: result.requestState, _meta: meta,
      ...(elicits ? { inputRequests: { approval: { method: 'elicitation/create', params: { mode: 'url', url: result.approval!.url, message: 'A named person must approve this action.' } } } } : {}) }
  }
  const code = result.outcome === 'pending' ? 'approval_required' : result.code
  if (code) meta['com.runeditrun/error'] = { code, ...result.fields, ...(result.outcome === 'pending' ? { approval: result.approval } : {}) }
  return { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(code ? { code, ...result.fields } : result.result ?? null) },
    ...(!code ? (result.resources ?? []).map(resource => ({ type: 'resource_link', ...resource })) : [])],
    ...(!code ? { structuredContent: result.result } : {}), isError: !!code, _meta: meta }
}
export function headerName(value: string | null): string | null {
  if (!value?.startsWith('=?base64?')) return value
  if (!value.endsWith('?=')) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.slice(9, -2)), c => c.charCodeAt(0))) } catch { return null }
}
export async function parseRequest(rt: Runtime, request: Request): Promise<Rpc | Response> {
  if (request.method !== 'POST') return rpcError(null, -32600, 'Method not allowed', 405)
  if (request.headers.has('origin') && request.headers.get('origin') !== rt.options.origin) return rpcError(null, -32600, 'Origin refused', 403)
  if (new URL(request.url).searchParams.has('access_token')) return rpcError(null, -32001, 'Unauthorized', 401, undefined, challenge(rt))
  const max = rt.options.limits!.maxBodyBytes!
  if (Number(request.headers.get('content-length')) > max) return rpcError(null, -32600, 'Body too large', 413)
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
  if (reader) while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    length += chunk.value.byteLength
    if (length > max) { await reader.cancel(); return rpcError(null, -32600, 'Body too large', 413) }
    chunks.push(chunk.value)
  }
  let rpc: Rpc
  try {
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    rpc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Rpc
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' ||
      (rpc.params !== undefined && (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params))) ||
      (rpc.id !== undefined && rpc.id !== null && typeof rpc.id !== 'string' && typeof rpc.id !== 'number')) throw new Error()
  } catch { return rpcError(null, -32700, 'Invalid JSON-RPC request') }
  const version = request.headers.get('mcp-protocol-version') ?? (rpc.method === 'initialize' && rpc.params?.protocolVersion === '2025-11-25' ? '2025-11-25' : null), meta = metaOf(rpc)
  if (version && !versions.includes(version)) return rpcError(rpc.id, -32022, 'UnsupportedProtocolVersion', 400, { supported: versions, requested: version })
  const modern = version !== '2025-11-25', named = ['tools/call', 'resources/read', 'prompts/get'].includes(rpc.method)
  if (!version || (modern && meta['io.modelcontextprotocol/protocolVersion'] !== version) ||
    (!modern && meta['io.modelcontextprotocol/protocolVersion'] !== undefined && meta['io.modelcontextprotocol/protocolVersion'] !== version) ||
    ((modern || request.headers.has('mcp-method')) && request.headers.get('mcp-method') !== rpc.method) ||
    (named && (modern || request.headers.has('mcp-name')) && headerName(request.headers.get('mcp-name')) !== (rpc.method === 'resources/read' ? rpc.params?.uri : rpc.params?.name))) return rpcError(rpc.id, -32020, 'HeaderMismatch')
  return rpc
}
