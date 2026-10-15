import { rejectedResponse } from './rejected-response'
// Whether the owner has claimed this installation: the one fact an anonymous
// visitor may learn about it. Claimed means the first-run record exists (the
// owner confirmed at /setup); anything before that is unclaimed.
// This file is copied unchanged to src/base by both maintained exporters.
export type SetupState = 'claimed' | 'unclaimed'
interface StateBindings { DB: D1Database; AUTH_ORIGIN: string }

/** Reads whether the owner has confirmed first-run setup, from wherever the seed records it. */
export type ClaimRead = (db: D1Database) => Promise<boolean>

/**
 * A claim read from one query: claimed when it returns a row. A seed that keeps
 * its own first-run record passes one to setupStateResponse and lobbyResponse,
 * for example claimedWhen('SELECT 1 FROM uptime_first_run WHERE id = 1').
 */
export const claimedWhen = (sql: string): ClaimRead => async db => await db.prepare(sql).first() !== null

/** Base's first-run record, written when the owner confirms at /setup. */
export const baseFirstRun = claimedWhen('SELECT singleton FROM oa_first_run WHERE singleton = 1')

const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }

export async function setupState(db: D1Database, claimed: ClaimRead = baseFirstRun): Promise<SetupState> {
  return await claimed(db) ? 'claimed' : 'unclaimed'
}

/** The configured origin and Host, as the other public documents admit them (when one is configured). */
export function admitted(request: Request, origin: string | undefined): boolean {
  if (!origin) return true
  const url = new URL(request.url)
  return url.origin === origin && (!request.headers.has('host') || request.headers.get('host')?.toLowerCase() === url.host.toLowerCase())
}

/**
 * GET /setup/state: `{"state":"claimed"}` or `{"state":"unclaimed"}`, nothing
 * else, for anyone. `claimed` reads the seed's own first-run record when it has
 * one; Base's oa_first_run otherwise.
 */
export async function setupStateResponse(request: Request, bindings: StateBindings, claimed: ClaimRead = baseFirstRun): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/setup/state') return null
  // Another origin or Host gets the app's ordinary document 404.
  if (!admitted(request, bindings.AUTH_ORIGIN)) return rejectedResponse(request, new Response('Not found', { status: 404, headers }))
  if (request.method !== 'GET' && request.method !== 'HEAD') return rejectedResponse(request, new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } }))
  let state: SetupState
  try { state = await setupState(bindings.DB, claimed) } catch { return Response.json({ error: 'setup_unavailable' }, { status: 503, headers }) }
  const body = JSON.stringify({ state })
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'content-type': 'application/json' } })
}
