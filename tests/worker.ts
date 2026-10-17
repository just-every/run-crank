// Uses the application's public auth, product and inbound handlers with a real D1,
// and the same per-minute executor pass as the Worker's Cron trigger.
import {authResponse, runtimeBindings} from '../src/auth.server'
import {productApi} from '../src/crank/ui/handler'
import {publicHooks} from '../src/crank/triggers/public'
import {schedulerPass} from '../src/crank/ops/scheduler'
export default {
  async fetch(request:Request,env:any,ctx:ExecutionContext) {
    return await publicHooks(request,runtimeBindings(env),work=>ctx.waitUntil(work)) ?? await authResponse(request,env) ?? await productApi(request,runtimeBindings(env)) ?? new Response('Not found',{status:404})
  },
  async scheduled(controller:ScheduledController,env:any) { await schedulerPass(runtimeBindings(env),controller.scheduledTime) },
}
