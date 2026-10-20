import { authorize, requireWriteOrigin } from '../access'
import { body, CrankError, json, type CrankEnv } from '../model'
import { tools, validArguments } from './tools'

type Dispatch = (request: Request) => Promise<Response>
const protocol = '2025-06-18'
const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status)

/** Stateless Streamable HTTP: calls use exactly the caller's native API credentials. */
export async function mcpApi(request: Request, env: CrankEnv, dispatch: Dispatch): Promise<Response> {
  let id: unknown = null
  try {
    const actor = await authorize(request, env)
    requireWriteOrigin(request, env, actor)
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
    const accept = request.headers.get('accept') ?? ''
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return rpcError(null, -32600, 'Accept must include application/json and text/event-stream', 406)
    const version = request.headers.get('mcp-protocol-version')
    if (version && version !== protocol) return rpcError(null, -32600, 'Unsupported MCP protocol version', 400)
    const input = await body(request, 256 * 1024)
    id = input.id
    if (input.jsonrpc !== '2.0' || typeof input.method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return rpcError(null, -32600, 'Invalid JSON-RPC request', 400)
    if (id === undefined) {
      if (!['notifications/initialized', 'notifications/cancelled'].includes(input.method)) return rpcError(null, -32600, 'Unsupported notification', 400)
      return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
    }
    const result = (value: unknown) => json({ jsonrpc: '2.0', id, result: value })
    if (input.method === 'initialize') return result({ protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'crank', version: '1.0.0' }, instructions: 'Drafts do not authorize sends. Publish needs native owner authority; granted tasks need their separate execution credential. Completion webhooks are not available.' })
    if (input.method === 'ping') return result({})
    if (input.method === 'tools/list') return result({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    if (input.method !== 'tools/call') return rpcError(id, -32601, 'Method not found')
    const params = input.params as { name?: unknown; arguments?: unknown } | null
    const tool = tools.find(tool => tool.name === params?.name)
    if (!tool) return rpcError(id, -32602, 'Unknown tool')
    const args = params?.arguments ?? {}
    if (!validArguments(tool, args)) return rpcError(id, -32602, 'Arguments do not match the tool input schema')
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    headers.set('content-type', 'application/json')
    if (typeof args.idempotency_key === 'string') headers.set('Idempotency-Key', args.idempotency_key)
    else headers.delete('Idempotency-Key')
    const target = new URL('/api/crank' + tool.path(args), request.url)
    const response = await dispatch(new Request(target, { method: tool.method, headers, ...(tool.method === 'POST' ? { body: JSON.stringify(tool.body?.(args) ?? {}) } : {}) }))
    const value = await response.json()
    return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { status: response.status, value }, isError: !response.ok })
  } catch (error) {
    if (error instanceof CrankError) return rpcError(id, error.message === 'Invalid JSON' ? -32700 : -32000, error.message, error.status)
    const status = (error as { status?: number }).status
    return rpcError(id, -32000, status && status < 500 ? 'Authentication or request was refused' : 'Operation could not be confirmed', status && status >= 400 && status < 500 ? status : 503)
  }
}
