import type { CrankEnv } from '../model'
import { receiveCallback } from './callbacks'
import { receiveSlackEvent } from './slack-events'
import { receiveSample } from '../workflows/samples'
import { receiveHook } from './webhook'

/** Unauthenticated inbound doors under /hooks/. Each admits events only. */
export async function publicHooks(request: Request, env: CrankEnv, defer?: (work: Promise<unknown>) => void): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/hooks/')) return null
  return confined(await route(request, env, path, defer))
}

async function route(request: Request, env: CrankEnv, path: string, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const [, , kind, token, extra] = path.split('/')
  if (!token || extra !== undefined || !/^[A-Za-z0-9_~-]{1,400}$/.test(token)) return Response.json({ error: 'Not found' }, { status: 404 })
  if (kind === 'sample') return receiveSample(request, env, token)
  if (kind === 'w') return receiveHook(request, env, token, defer)
  if (kind === 'resume') return receiveCallback(request, env, token, defer)
  if (kind === 'slack') return receiveSlackEvent(request, env, token, defer)
  return Response.json({ error: 'Not found' }, { status: 404 })
}

/** Hook responses can carry workflow-chosen bodies and headers on the app's own origin.
 * A browser that opens one renders it sandboxed: no script, form or same-origin authority,
 * whatever security headers the workflow chose. */
function confined(response: Response) {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', "sandbox; default-src 'none'")
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
