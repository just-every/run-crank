import { createAuthHandler } from '../../operator-auth/index.mjs'
import { operatorAuth } from '../../../default-seed/src/core/platform/auth/session.server'
import { businessSettings } from '../../../default-seed/src/core/platform/business.server'
import { peopleRoutes } from '../../../default-seed/src/core/features/people/routes'
import { baseAgentDoor } from '../../../default-seed/src/agent-door/index.server'
import type { Bindings } from '../../../default-seed/src/core/platform/bindings.server'

// Mount the production routes directly so module tests need no prebuilt app.
export default {
  async fetch(envelope: Request, env: Bindings) {
    const { url, ...init } = await envelope.json() as { url: string; method: string; headers: HeadersInit; body?: string }
    const request = new Request(url, init)
    if (new URL(url).pathname.startsWith('/api/people')) return peopleRoutes().fetch(request, env)
    return await baseAgentDoor(env).handle(request)
      ?? await businessSettings(env).handle(request)
      ?? await createAuthHandler(operatorAuth(env))(request)
      ?? new Response(null, { status: 404 })
  },
}
