import { requireOwner, requireWriteOrigin } from '../access'
import { body, json, requireValue, type Actor, type CrankEnv } from '../model'
import { allowOverage, flushUsageNotices, quoteWorkflow, readWorkflowEstimate, setBudget, usageReport } from './usage'

/** Called after native authentication, before the workflow router consumes a body. */
export async function usageApi(request: Request, env: CrankEnv, actor: Actor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname
  const estimate = /^\/api\/crank\/workflows\/([^/]+)\/estimate$/.exec(path)
  if (!estimate && !['/api/crank/reports/usage', '/api/crank/usage/budgets', '/api/crank/usage/allowance'].includes(path)) return null
  requireOwner(actor)
  if (request.method === 'GET') {
    if (path === '/api/crank/reports/usage') return json(await usageReport(env, url.searchParams))
    requireValue(estimate, 'Method not allowed', 405)
    const rawCount = url.searchParams.get('count') ?? '1', count = Number(rawCount)
    requireValue(/^[1-9]\d*$/.test(rawCount) && Number.isSafeInteger(count), 'count must be a positive safe integer')
    return json(await readWorkflowEstimate(env, decodeURIComponent(estimate[1]), count))
  }
  requireValue(request.method === 'POST' && path !== '/api/crank/reports/usage', 'Method not allowed', 405)
  requireWriteOrigin(request, env, actor)
  const input = await body(request, 16 * 1024)
  if (estimate) return json(await quoteWorkflow(env, actor, decodeURIComponent(estimate[1]), input))
  if (path === '/api/crank/usage/budgets') {
    // The ordinary HTML removal form sends the same explicit unset as JSON null.
    if (input.monthly_usd === '') input.monthly_usd = null
    const result = await setBudget(env, actor, input)
    await flushUsageNotices(env)
    return json(result)
  }
  return json(await allowOverage(env, actor, input), 201)
}
