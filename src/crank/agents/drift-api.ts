import { authorize, requireWriteOrigin } from '../access'
import { StepError } from '../engine/errors'
import { body, CrankError, json, type CrankEnv } from '../model'
import { approveDrift, rollbackDrift } from './drift-approval'
import { listDrift, proposeDrift, readDrift, rejectDrift } from './drift-store'
import { finishDriftTests, testDrift } from './drift-testing'
import { recheckDriftPermission } from './drift-permission'

/** Root dispatches this before the generic workflow API. Every action is native-owner only. */
export async function driftApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank/drift' && !path.startsWith('/api/crank/drift/')) return null
  try {
    const actor = await authorize(request, env)
    if (request.method === 'GET') {
      if (path === '/api/crank/drift') return json(await listDrift(env, actor))
      const match = /^\/api\/crank\/drift\/([^/]+)$/.exec(path)
      if (match) return json(await readDrift(env, actor, match[1]))
    }
    if (request.method === 'POST') {
      requireWriteOrigin(request, env, actor)
      const input = await body(request)
      if (path === '/api/crank/drift') return json(await proposeDrift(env, actor, input), 201)
      const permission = /^\/api\/crank\/drift\/incidents\/([^/]+)\/recheck$/.exec(path)
      if (permission) return json(await recheckDriftPermission(env, actor, permission[1]))
      const match = /^\/api\/crank\/drift\/([^/]+)\/(test|results|approve|reject|rollback)$/.exec(path)
      if (match) {
        const [, proposalId, action] = match
        if (action === 'test') return json(await testDrift(env, actor, proposalId, input))
        if (action === 'approve') return json(await approveDrift(env, actor, proposalId, input))
        if (action === 'reject') return json(await rejectDrift(env, actor, proposalId, input))
        if (action === 'rollback') return json(await rollbackDrift(env, actor, proposalId, input))
        await finishDriftTests(env, actor, proposalId)
        return json(await readDrift(env, actor, proposalId))
      }
    }
    return json({ error: 'Choose an existing drift review action' }, 405)
  } catch (error) {
    if (error instanceof CrankError) return json({ error: error.message }, error.status)
    if (error instanceof StepError) return json({ error: error.message, category: error.category }, 422)
    throw error
  }
}
