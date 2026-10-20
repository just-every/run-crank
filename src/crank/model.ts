import type { Bindings } from '../auth.server'

export type CrankEnv = Bindings & { CRANK_TARGET_ORIGIN?: string; CRANK_TARGET_TOKEN?: string }
export type Role = 'owner' | 'admin' | 'member'
export type ActorKind = 'native' | 'dev' | 'oidc' | 'password' | 'review' | 'agent' | 'trigger'
export interface Actor {
  id: string; name: string; role: Role; kind: ActorKind; version: number
  team?: import('./team/policy').TeamAccess
  sessionId?: string; tokenId?: string; grantId?: string; flowId?: string | null; local: boolean
}
export interface Flow {
  id: string; name: string; source_app: string; destination_app: string; target_url: string
  revision: number; status: 'draft' | 'active'; created_by: string; created_at: string
}
export type RunState = 'pending' | 'approved' | 'running' | 'succeeded' | 'failed' | 'rejected'
export interface Run {
  id: string; flow_id: string; event_id: string; input_json: string; input_digest: string
  target_url: string; flow_revision: number; source_app: string; destination_app: string
  action_json: string; action_digest: string; state: RunState; created_by: string
  created_at: string; updated_at: string; replay_count: number
  lease_id: string | null; lease_expires_at: string | null; outcome_json: string | null
}
export class CrankError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export function requireValue(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new CrankError(status, message)
}
export const now = () => new Date().toISOString()
export const id = () => crypto.randomUUID()
export function text(value: unknown, label: string, limit = 200): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value), `${label} is required and must be at most ${limit} characters`)
  return value.trim()
}
export const stmt = (env: CrankEnv, sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values)
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Stable bytes bind event deduplication, human approval and every delivery. */
export function canonical(value: unknown, depth = 0): string {
  requireValue(depth <= 64, 'JSON nesting exceeds 64 levels')
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']'
  const object = value as Record<string, unknown>
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key], depth + 1)).join(',') + '}'
}
export function publicActor(actor: Actor) { return { id: actor.id, name: actor.name, role: actor.role, kind: actor.kind } }
export function presentRun(run: Run) {
  return { ...run, input: JSON.parse(run.input_json), action: JSON.parse(run.action_json), outcome: run.outcome_json ? JSON.parse(run.outcome_json) : null }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } })
}
/** Enforce the limit while streaming; Content-Length alone is not trustworthy. */
export async function body(request: Request, limit = 65536): Promise<Record<string, unknown>> {
  requireValue(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'Use application/json', 415)
  const reader = request.body?.getReader()
  requireValue(reader, 'JSON body is required')
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) { await reader.cancel(); throw new CrankError(413, 'Request body exceeds the allowed size') }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new CrankError(400, 'Invalid JSON') }
    requireValue(value && typeof value === 'object' && !Array.isArray(value), 'JSON object is required')
    return value as Record<string, unknown>
  } finally { reader.releaseLock() }
}
