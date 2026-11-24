// Uses the application's public auth, product, app-page and inbound handlers with a real D1,
// and the same per-minute executor pass as the Worker's Cron trigger.
import {authResponse, runtimeBindings} from '../src/auth.server'
import {appResponse,productApi} from '../src/crank/ui/handler'
import {publicHooks} from '../src/crank/triggers/public'
import {healthResponse} from '../src/crank/health'
import {schedulerPass} from '../src/crank/ops/scheduler'
import {crankAgentDoor} from '../src/crank/agent-door'
import {businessSettings} from '../src/crank/agent-door/business'
import {emailHandler} from '../src/crank/triggers/email'
/** A D1 wrapper that adds up the rows each statement reads, for the read-budget test's own Cron passes. */
let cronRowsRead = 0
function meteredDb(db: D1Database): D1Database {
  const note = <T extends { meta?: { rows_read?: number } }>(result: T) => { cronRowsRead += result.meta?.rows_read ?? 0; return result }
  const wrap = (statement: D1PreparedStatement): any => ({
    inner: statement,
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    all: async () => note(await statement.all()),
    first: async (column?: string) => { const row = note(await statement.all()).results[0] as Record<string, unknown> | undefined ?? null; return column ? row?.[column] ?? null : row },
    run: async () => note(await statement.run()),
    raw: async () => note(await statement.all()).results.map(row => Object.values(row as object)),
  })
  return { prepare: (sql: string) => wrap(db.prepare(sql)), batch: async (statements: any[]) => (await db.batch(statements.map(s => s.inner ?? s))).map(note), exec: (sql: string) => db.exec(sql) } as unknown as D1Database
}
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
    if (new URL(request.url).pathname === '/__cron_rows') return Response.json({ rows: cronRowsRead })
    if (new URL(request.url).pathname === '/health') return healthResponse(env)
    return await businessSettings(runtimeBindings(env)).handle(request) ?? await crankAgentDoor(runtimeBindings(env)).handle(request) ?? await publicHooks(request,runtimeBindings(env),work=>ctx.waitUntil(work)) ?? await authResponse(request,env) ?? await productApi(request,runtimeBindings(env)) ?? await appResponse(request,runtimeBindings(env)) ?? new Response('Not found',{status:404})
  },
  async scheduled(controller:ScheduledController,env:any) {
    const bindings = runtimeBindings(env)
    if (controller.cron === 'd1-budget') { cronRowsRead = 0; await schedulerPass({ ...bindings, DB: meteredDb(bindings.DB) },controller.scheduledTime) }
    else await schedulerPass(bindings,controller.scheduledTime)
  },
}
