import { authorize, requireOwner, requireWriteOrigin } from './access'
import { deliverRun, recoverExpiredRuns, rejectRun } from './delivery'
import { createFlow, getFlow, setFlowStatus } from './flows'
import { CrankError, body, json, presentRun, publicActor, requireValue, stmt, type Actor, type CrankEnv, type Flow, type Run } from './model'
import { getRun, prepareRun } from './runs'
import { mintToken, revokeToken, tokenColumns } from './tokens'

async function state(env: CrankEnv, actor: Actor): Promise<Response> {
  requireValue(actor.kind !== 'trigger', 'Trigger tokens only admit events to their scoped flow', 403)
  await recoverExpiredRuns(env, actor)
  const canManage = actor.role === 'owner' && (actor.kind === 'native' || actor.kind === 'dev')
  const [flows, runs, approvals, attempts, tokens] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_flows ORDER BY created_at DESC,id').all<Flow>(),
    stmt(env, 'SELECT * FROM crank_runs ORDER BY created_at DESC,id LIMIT 200').all<Run>(),
    stmt(env, 'SELECT * FROM crank_approvals WHERE run_id IN (SELECT id FROM crank_runs ORDER BY created_at DESC,id LIMIT 200) ORDER BY created_at DESC,id').all(),
    stmt(env, 'SELECT * FROM crank_attempts WHERE run_id IN (SELECT id FROM crank_runs ORDER BY created_at DESC,id LIMIT 200) ORDER BY started_at DESC,id').all(),
    canManage ? stmt(env, `SELECT ${tokenColumns} FROM crank_tokens ORDER BY created_at DESC,id`).all() : Promise.resolve({ results: [] }),
  ])
  return json({ actor: publicActor(actor), flows: flows.results, runs: runs.results.map(presentRun), approvals: approvals.results, attempts: attempts.results, tokens: tokens.results })
}

export async function crankApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank' && !path.startsWith('/api/crank/')) return null
  try {
    const actor = await authorize(request, env)
    if (request.method === 'GET') {
      if (path === '/api/crank/state') return await state(env, actor)
      requireValue(actor.kind !== 'trigger', 'Trigger tokens only admit events', 403)
      const flow = /^\/api\/crank\/flows\/([^/]+)$/.exec(path)
      if (flow) return json(await getFlow(env, decodeURIComponent(flow[1])))
      const run = /^\/api\/crank\/runs\/([^/]+)$/.exec(path)
      if (run) return json(presentRun(await getRun(env, decodeURIComponent(run[1]))))
      return json({ error: 'Route not found' }, 404)
    }
    requireValue(request.method === 'POST', 'Method not allowed', 405)
    requireWriteOrigin(request, env, actor)
    if (path === '/api/crank/flows') return json(await createFlow(env, actor, await body(request)), 201)
    if (path === '/api/crank/tokens') return json(await mintToken(env, actor, await body(request)), 201)
    const flowAction = /^\/api\/crank\/flows\/([^/]+)\/(activate|pause|runs|trigger)$/.exec(path)
    if (flowAction) {
      const flowId = decodeURIComponent(flowAction[1]), action = flowAction[2]
      if (action === 'runs' || action === 'trigger') {
        requireValue(action === 'trigger' ? actor.kind === 'trigger' : actor.kind !== 'trigger', action === 'trigger' ? 'A scoped trigger bearer is required' : 'Use the scoped trigger endpoint', 403)
        return json(presentRun(await prepareRun(env, actor, flowId, await body(request))), 201)
      }
      requireOwner(actor)
      if (request.body) await body(request)
      return json(await setFlowStatus(env, actor, flowId, action === 'activate' ? 'active' : 'draft'))
    }
    const runAction = /^\/api\/crank\/runs\/([^/]+)\/(approve|reject|replay)$/.exec(path)
    if (runAction) {
      requireOwner(actor)
      if (request.body) await body(request)
      const runId = decodeURIComponent(runAction[1]), action = runAction[2]
      return json(presentRun(action === 'reject' ? await rejectRun(env, actor, runId) : await deliverRun(env, actor, runId, action === 'replay')))
    }
    const revoke = /^\/api\/crank\/tokens\/([^/]+)\/revoke$/.exec(path)
    if (revoke) {
      requireOwner(actor)
      if (request.body) await body(request)
      return json(await revokeToken(env, actor, decodeURIComponent(revoke[1])))
    }
    return json({ error: 'Route not found' }, 404)
  } catch (error) {
    if (error instanceof CrankError) return json({ error: error.message }, error.status)
    // Base authentication errors carry a safe code and status; never expose SQL,
    // upstream bodies or exception text to clients.
    const authError = error as { status?: unknown; code?: unknown }
    if (typeof authError.status === 'number' && authError.status >= 400 && authError.status < 500) return json({ error: 'Authentication or request was refused' }, authError.status)
    return json({ error: 'Workflow operation could not be confirmed' }, 503)
  }
}
