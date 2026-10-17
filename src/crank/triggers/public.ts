import type { CrankEnv } from '../model'
import { receiveCallback } from './callbacks'
import { receiveSlackEvent } from './slack-events'
import { receiveHook } from './webhook'

/** Unauthenticated inbound doors under /hooks/. Each admits events only. */
export async function publicHooks(request: Request, env: CrankEnv, defer?: (work: Promise<unknown>) => void): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/hooks/')) return null
  const [, , kind, token, extra] = path.split('/')
  if (!token || extra !== undefined || !/^[A-Za-z0-9_~-]{1,400}$/.test(token)) return Response.json({ error: 'Not found' }, { status: 404 })
  if (kind === 'w') return receiveHook(request, env, token, defer)
  if (kind === 'resume') return receiveCallback(request, env, token, defer)
  if (kind === 'slack') return receiveSlackEvent(request, env, token, defer)
  return Response.json({ error: 'Not found' }, { status: 404 })
}
