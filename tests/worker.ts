// Uses the application's public auth, product, app-page and inbound handlers with a real D1,
// and the same per-minute executor pass as the Worker's Cron trigger.
import {authResponse, runtimeBindings} from '../src/auth.server'
import {appResponse,productApi} from '../src/crank/ui/handler'
import {publicHooks} from '../src/crank/triggers/public'
import {healthResponse} from '../src/crank/health'
import {schedulerPass} from '../src/crank/ops/scheduler'
import {emailHandler} from '../src/crank/triggers/email'
export default {
  email: emailHandler,
  async fetch(request:Request,env:any,ctx:ExecutionContext) {
    // The transport fixture can supply a raw stream larger than the emulator's
    // pre-parser permits; it invokes the same exported Email Worker handler.
    if (new URL(request.url).pathname === '/__email-stream') {
      let rejection: string | null = null
      const url = new URL(request.url)
      await emailHandler({ from: url.searchParams.get('from')!, to: url.searchParams.get('to')!, raw: request.body!, rawSize: 0, headers: request.headers, setReject(reason: string) { rejection = reason } } as ForwardableEmailMessage, env, ctx)
      return Response.json({ rejection })
    }
    if (new URL(request.url).pathname === '/health') return healthResponse(env)
    return await publicHooks(request,runtimeBindings(env),work=>ctx.waitUntil(work)) ?? await authResponse(request,env) ?? await productApi(request,runtimeBindings(env)) ?? await appResponse(request,runtimeBindings(env)) ?? new Response('Not found',{status:404})
  },
  async scheduled(controller:ScheduledController,env:any) { await schedulerPass(runtimeBindings(env),controller.scheduledTime) },
}
