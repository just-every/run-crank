import { withDemo } from './modules/demo/index.mjs'
import { seedDemo } from './demo'
import { rejectedResponse } from './base/rejected-response'
import start from '@tanstack/react-start/server-entry'
import { Hono } from 'hono'
import { dispatch } from './base/dispatch'
import { staticAssetResponse } from './base/static-assets'
import { healthResponse } from './crank/health'
import { lobbyResponse } from './base/lobby'
import { setupStateResponse } from './base/setup-state'
import { authResponse, runtimeBindings, type Bindings } from './auth.server'
import { identity } from './identity'
import { appResponse, productApi } from './crank/ui/handler'
import { publicHooks } from './crank/triggers/public'
import { schedulerPass } from './crank/ops/scheduler'
import { emailHandler } from './crank/triggers/email'
import { crankAgentResponse } from './crank/agent-door'
import { businessSettingsResponse } from './crank/agent-door/business'

const api = new Hono<{ Bindings: Bindings }>()
api.get('/health', (context) => healthResponse(context.env))

// Start documents keep their own cache policy and add no-transform, so no proxy
// rewrites the HTML React hydrates (Cloudflare's email address obfuscation
// honours it; src/base/hydration/README.md).
function noTransform(response: Response): Response {
  const headers = new Headers(response.headers), policy = headers.get('cache-control')
  headers.set('cache-control', policy ? `${policy}, no-transform` : 'no-transform')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default withDemo({
  email: emailHandler,
  async fetch(request, env, execution) {
    const asset = await staticAssetResponse(request, env)
    if (asset) return asset
    const bindings = runtimeBindings(env)
    const business = await businessSettingsResponse(request, bindings)
    if (business) return business
    const door = await crankAgentResponse(request, bindings)
    if (door) return rejectedResponse(request, door)
    const auth = await authResponse(request, env)
    if (auth) return auth
    // Inbound webhook, callback and Slack event doors admit events only; runs continue after the response.
    const hook = await publicHooks(request, runtimeBindings(env), work => execution.waitUntil(work))
    if (hook) return hook
    const product = await productApi(request, runtimeBindings(env)) ?? await appResponse(request, runtimeBindings(env))
    if (product) return product
    // The installed variant: the Lobby at / and the public claim state it reads.
    // Local dev serves the saved origin's data at its own port (RER_DEV_ORIGIN).
    const state = await setupStateResponse(request, runtimeBindings(env))
    if (state) return state
    const lobby = await lobbyResponse(request, runtimeBindings(env), identity)
    if (lobby) return lobby
    return rejectedResponse(request, await dispatch(request, () => api.fetch(request, env, execution), async () => noTransform(await start.fetch(request))))
  },
  // The per-minute executor pass: delays, queues, polls, schedules, holds and queued runs.
  async scheduled(controller, env, execution) {
    execution.waitUntil(schedulerPass(runtimeBindings(env), controller.scheduledTime))
  },
} satisfies ExportedHandler<Bindings>, { seed: seedDemo })
