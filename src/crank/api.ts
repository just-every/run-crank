import { serviceAccountApi } from './team/service-accounts'
import { authorize, requireOwner, requireWriteOrigin } from './access'
import { deliverRun, recoverExpiredRuns, rejectRun } from './delivery'
import { createFlow, getFlow, setFlowStatus } from './flows'
import { CrankError, body, json, presentRun, publicActor, requireValue, stmt, type Actor, type CrankEnv, type Flow, type Run } from './model'
import { getRun, prepareRun } from './runs'
import { mintToken, revokeToken, credentialColumns } from './tokens'
import { quoteWorkflow, readWorkflowEstimate, flushUsageNotices } from './ops/usage'
import { StepError } from './engine/errors'

async function state(env: CrankEnv, actor: Actor): Promise<Response> {
  requireValue(actor.kind !== 'trigger', 'Trigger tokens only admit events to their scoped flow', 403)
  if (actor.team) {
    const scope=JSON.stringify(actor.team.workflow_ids)
    const flows=await stmt(env,'SELECT * FROM crank_flows WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id',scope).all<Flow>()
    const rows=await stmt(env,'SELECT * FROM crank_runs WHERE flow_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id LIMIT 200',scope).all<Run>()
    const payload=['admin','builder','operator','approver'].includes(actor.team.role)
    return json({actor:publicActor(actor),flows:flows.results,runs:rows.results.map(run=>payload?presentRun(run):{id:run.id,flow_id:run.flow_id,state:run.state,created_at:run.created_at,updated_at:run.updated_at,payload:'restricted'}),approvals:[],attempts:[],tokens:[],people:[]})
  }
  await recoverExpiredRuns(env, actor)
  const canManage = actor.role === 'owner' && (actor.kind === 'native' || actor.kind === 'dev')
  const [flows, runs, approvals, attempts, tokens, people] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_flows ORDER BY created_at DESC,id').all<Flow>(),
    stmt(env, 'SELECT * FROM crank_runs ORDER BY created_at DESC,id LIMIT 200').all<Run>(),
    stmt(env, 'SELECT * FROM crank_approvals WHERE run_id IN (SELECT id FROM crank_runs ORDER BY created_at DESC,id LIMIT 200) ORDER BY created_at DESC,id').all(),
    stmt(env, 'SELECT * FROM crank_attempts WHERE run_id IN (SELECT id FROM crank_runs ORDER BY created_at DESC,id LIMIT 200) ORDER BY started_at DESC,id').all(),
    canManage ? stmt(env, `SELECT ${credentialColumns} FROM crank_tokens ORDER BY created_at DESC,id`).all() : Promise.resolve({ results: [] }),
    // Names only, so decisions and versions read "Maya Chen" rather than an operator ID.
    stmt(env, 'SELECT id,display_name AS name FROM oa_operators ORDER BY created_at,id').all<{ id: string; name: string }>(),
  ])
  return json({ actor: publicActor(actor), flows: flows.results, runs: runs.results.map(presentRun), approvals: approvals.results, attempts: attempts.results, tokens: tokens.results, people: people.results })
}

export async function crankApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank' && !path.startsWith('/api/crank/')) return null
  try {
    const actor = await authorize(request, env)
    if(request.method!=='GET')requireWriteOrigin(request,env,actor)
    const service=await serviceAccountApi(request,env,actor);if(service)return service
    requireValue(!actor.grantId, 'Execution credentials use the agent task door', 403)
    if (request.method === 'GET') {
      if (path === '/api/crank/state') return await state(env, actor)
      requireValue(actor.kind !== 'trigger', 'Trigger tokens only admit events', 403)
      const estimate = /^\/api\/crank\/flows\/([^/]+)\/estimate$/.exec(path)
      if (estimate) {
        requireOwner(actor)
        const rawCount = new URL(request.url).searchParams.get('count') ?? '1', count = Number(rawCount)
        requireValue(/^[1-9]\d*$/.test(rawCount) && Number.isSafeInteger(count), 'count must be a positive safe integer')
        return json(await readWorkflowEstimate(env, decodeURIComponent(estimate[1]), count))
      }
      const flow = /^\/api\/crank\/flows\/([^/]+)$/.exec(path)
      if (flow) return json(await getFlow(env, decodeURIComponent(flow[1])))
      const run = /^\/api\/crank\/runs\/([^/]+)$/.exec(path)
      if (run) return json(presentRun(await getRun(env, decodeURIComponent(run[1]))))
      return json({ error: 'Route not found' }, 404)
    }
    requireValue(request.method === 'POST', 'Method not allowed', 405)
    requireWriteOrigin(request, env, actor)
    const estimate = /^\/api\/crank\/flows\/([^/]+)\/estimate$/.exec(path)
    if (estimate) return json(await quoteWorkflow(env, actor, decodeURIComponent(estimate[1]), await body(request, 16 * 1024)))
    if (path === '/api/crank/flows') return json(await createFlow(env, actor, await body(request)), 201)
    if (path === '/api/crank/tokens') return json(await mintToken(env, actor, await body(request)), 201)
    const flowAction = /^\/api\/crank\/flows\/([^/]+)\/(activate|pause|runs|trigger)$/.exec(path)
    if (flowAction) {
      const flowId = decodeURIComponent(flowAction[1]), action = flowAction[2]
      if (action === 'runs' || action === 'trigger') {
        requireValue(action === 'trigger' ? actor.kind === 'trigger' : actor.kind !== 'trigger', action === 'trigger' ? 'A scoped trigger bearer is required' : 'Use the scoped trigger endpoint', 403)
        const result = await prepareRun(env, actor, flowId, await body(request))
        await flushUsageNotices(env)
        return json('held' in result ? result : presentRun(result), 'held' in result ? 202 : 201)
      }
      requireOwner(actor)
      if (request.body) await body(request)
      return json(await setFlowStatus(env, actor, flowId, action === 'activate' ? 'active' : 'draft'))
    }
    const runAction = /^\/api\/crank\/runs\/([^/]+)\/(approve|reject|replay)$/.exec(path)
    if (runAction) {
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
    if (error instanceof StepError) return json({ error: error.message, category: error.category }, 422)
    // Base authentication errors carry a safe code and status; never expose SQL,
    // upstream bodies or exception text to clients.
    const authError = error as { status?: unknown; code?: unknown }
    if (typeof authError.status === 'number' && authError.status >= 400 && authError.status < 500) return json({ error: 'Authentication or request was refused' }, authError.status)
    return json({ error: 'Workflow operation could not be confirmed' }, 503)
  }
}
