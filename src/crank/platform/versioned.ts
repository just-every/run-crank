import { crankApi } from '../api'
import { workflowApi } from '../workflows/api'
import { json, type CrankEnv } from '../model'
import { mcpApi } from '../mcp/api'

const codes: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 405: 'invalid_request', 406: 'invalid_request', 409: 'conflict', 413: 'invalid_request', 415: 'invalid_request', 422: 'invalid_operation', 502: 'unavailable', 503: 'unavailable' }

/** v1 preserves native authority and behavior; the adapter only versions the wire contract. */
export async function versionedApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/crank/v1' && !url.pathname.startsWith('/api/crank/v1/')) return null
  const dispatch = async (forwarded: Request) => await workflowApi(forwarded, env) ?? await crankApi(forwarded, env) ?? json({ error: 'Route not found' }, 404)
  if (url.pathname === '/api/crank/v1/mcp') return mcpApi(request, env, dispatch)
  url.pathname = url.pathname.replace('/api/crank/v1', '/api/crank')
  const response = await dispatch(new Request(url, request))
  const headers = new Headers(response.headers)
  headers.set('Crank-API-Version', '1')
  if (response.ok) return new Response(response.body, { status: response.status, headers })
  const value = await response.json() as Record<string, unknown>
  return new Response(JSON.stringify({ ...value, api_version: '1', code: codes[response.status] ?? 'operation_failed', status: response.status }), { status: response.status, headers })
}
