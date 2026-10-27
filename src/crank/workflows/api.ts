import { consentRegulatedOperation, readRegulatedOperations } from '../providers/regulated-authority'
import { tableApi } from '../tables/api'
import { previewReconciliation, reconcileEffect } from './reconciliation'
import { subflowApi } from './subflows'
import { reviseProposal } from '../grants/proposals'
import { issueGrant, readGrants, revokeGrant } from '../grants/store'
import { startTask, readTask } from '../grants/tasks'
import { generateAuthoring, readAuthoring, reviseAuthoring, testAuthoring, promoteAuthoring, listSkills, readSkill, proposeSkill, approveSkill } from '../agents/skills'
import { usageApi } from '../ops/usage-api'
import { isBudgetExceeded } from '../ops/usage'
import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { APPS, hostAllowed } from '../connections/apps'
import { CATALOG } from '../connections/catalog'
import { finishOauth, setOauthApp, startOauth } from '../connections/oauth'
import { createConnection, credential, getConnection, listConnections, revokeConnection, rotateConnection, setConnectionPurpose } from '../connections/store'
import { authorizeRequest } from '../connections/auth'
import { slackCall } from '../connectors/slack'
import { boundedFetch } from '../engine/egress'
import { StepError } from '../engine/errors'
import { validateGraph } from '../engine/graph'
import { body, CrankError, json, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement, exportAudit, readAudit } from '../ops/audit'
import { coverageReport } from '../ops/coverage'
import { latencyReport, operationsReport, operationsCsv, configureOperations, createObligation, verifyObligation } from '../ops/report'
import { listLogSinks, configureLogSink, removeLogSink, flushLogStreams } from '../ops/log-stream'
import { updateSettings, workspaceSettings } from '../ops/settings'
import { configureNoticeRoute, noticeDeliveries } from '../ops/run-notices'
import { getHold } from '../triggers/admission'
import { decideHold } from '../triggers/hold-decisions'
import { quoteHold } from '../ops/hold-cost'
import { plannedTimes } from '../triggers/schedule'
import { previewHistorical, readHistorical } from '../triggers/historical'
import { releaseHistorical } from '../triggers/historical-release'
import { createHook, listHooks, revokeHook } from '../triggers/webhook'
import { readDraft } from './drafts'
import { compareWorkflow } from './comparison'
import { testWorkflow } from './testing'
import { previewReplay, replaySteps } from './replay'
import { cancelRun, decideApproval, previewWorkflow, resumeRun, runDetail, runsToday, searchRuns, startRun } from './runs'
import { createWorkflow, duplicateWorkflow, getWorkflow, listWorkflows, presentWorkflow, publishWorkflow, rollbackWorkflow, setWorkflowState, unpublishWorkflow, updateDraft, versionGraph } from './store'

const PREFIXES = ['/api/crank/authoring', '/api/crank/regulated-operations', '/api/crank/tables', '/api/crank/subflows', '/api/crank/grants', '/api/crank/agent-tasks', '/api/crank/skills', '/api/crank/usage', '/api/crank/historical', '/api/crank/workflows', '/api/crank/workflow-runs', '/api/crank/connections', '/api/crank/oauth', '/api/crank/hooks', '/api/crank/holds', '/api/crank/queues', '/api/crank/catalog', '/api/crank/coverage', '/api/crank/settings', '/api/crank/audit', '/api/crank/notices', '/api/crank/reports']
const match = (path: string, pattern: RegExp) => pattern.exec(path)?.slice(1).map(decodeURIComponent) ?? null

async function testConnection(env: CrankEnv, actor: Actor, connectionId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const row = await getConnection(env, connectionId)
  requireValue(row.app !== 'nook', 'Nook tokens only post to their bound conversation. Test the native send_message action with explicit write confirmation or a test binding.')
  if (row.app === 'slack') {
    const result = await slackCall({ env }, connectionId, 'auth.test', {}, false)
    await stmt(env, 'UPDATE crank_connections SET account_name=? WHERE id=?', String(result.team ?? ''), connectionId).run()
    return { ok: true, account: result.team ?? null, user: result.user ?? null }
  }
  if (row.app === 'webhook') { await credential(env, connectionId); return { ok: true } }
  const target = APPS[row.app]?.test?.url ?? (typeof input.url === 'string' ? input.url : null)
  requireValue(target, 'Give a url inside this connection’s domains to test')
  const url = new URL(target), headers = new Headers({ accept: 'application/json' })
  requireValue(hostAllowed(url.hostname, JSON.parse(row.domains_json)), 'That URL is outside this connection’s domains')
  await authorizeRequest(env, connectionId, url, headers, null)
  const response = await boundedFetch(url.href, { method: APPS[row.app]?.test?.method ?? 'GET', headers, maxBytes: 65536 })
  return { ok: response.status >= 200 && response.status < 300, status: response.status }
}

async function triggerState(env: CrankEnv, workflowId: string, params: URLSearchParams) {
  const from = params.get('from') ? Date.parse(params.get('from')!) : Date.now(), count = Math.min(Math.max(Number(params.get('count') ?? 5), 1), 50)
  requireValue(Number.isFinite(from), 'from must be an ISO time')
  const workflow = await getWorkflow(env, workflowId)
  const graph = workflow.published_version_id ? JSON.parse((await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', workflow.published_version_id).first<{ graph_json: string }>())!.graph_json) : JSON.parse(workflow.draft_json)
  const [poll, log, schedule, occurrences] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_polls WHERE workflow_id=?', workflowId).first(),
    stmt(env, 'SELECT * FROM crank_poll_log WHERE workflow_id=? ORDER BY due_at DESC LIMIT 20', workflowId).all(),
    stmt(env, 'SELECT * FROM crank_schedules WHERE workflow_id=?', workflowId).first(),
    stmt(env, 'SELECT * FROM crank_schedule_occurrences WHERE workflow_id=? ORDER BY planned_at DESC LIMIT 20', workflowId).all(),
  ])
  return {
    trigger: graph.trigger, hooks: await listHooks(env, workflowId), poll, poll_log: log.results, schedule,
    planned: graph.trigger.type === 'schedule' ? plannedTimes(graph.trigger, from, count).map(o => ({ at: new Date(o.at).toISOString(), local: o.local, occurrence: o.key })) : [],
    occurrences: occurrences.results,
    policies: graph.trigger.type === 'schedule' ? { missed: graph.trigger.missed ?? 'catch_up', overlap: graph.trigger.overlap ?? 'allow', dst: 'Local wall time in the schedule timezone: a skipped time runs at the shifted instant; a repeated hour runs once.' } : null,
  }
}

export async function workflowApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname
  if (!PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + '/'))) return null
  try {
    const actor = await authorize(request, env)
    if (actor.grantId) {
      if (request.method === 'POST' && path === '/api/crank/agent-tasks') {
        requireWriteOrigin(request, env, actor)
        return json(await startTask(env, actor, await body(request, 256 * 1024), request.headers.get('Idempotency-Key')), 201)
      }
      const proposal = /^\/api\/crank\/agent-tasks\/([^/]+)\/proposal$/.exec(path)
      if (request.method === 'POST' && proposal) {
        requireWriteOrigin(request,env,actor)
        return json(await reviseProposal(env,actor,decodeURIComponent(proposal[1]),await body(request)))
      }
      const task = /^\/api\/crank\/agent-tasks\/([^/]+)$/.exec(path)
      if (request.method === 'GET' && task) return json(await readTask(env, actor, decodeURIComponent(task[1])))
      return json({error:'This execution credential only starts and reads its own agent tasks'},403)
    }
    requireValue(!path.startsWith('/api/crank/agent-tasks'), 'Agent tasks require a separate execution credential',403)
    requireValue(actor.kind !== 'trigger', 'Trigger tokens only admit events', 403)
    if (path === '/api/crank/tables' || path.startsWith('/api/crank/tables/')) {
      if (request.method !== 'GET') requireWriteOrigin(request, env, actor)
      return await tableApi(request, env, actor)
    }
    if (path === '/api/crank/subflows' || path.startsWith('/api/crank/subflows/')) {
      if (request.method !== 'GET') requireWriteOrigin(request, env, actor)
      return await subflowApi(request, env, actor)
    }
    const usage = await usageApi(request, env, actor)
    if (usage) return usage
    let m: string[] | null
    if (path === '/api/crank/audit' || path.startsWith('/api/crank/audit/')) {
      requireValue(request.method === 'GET', 'The audit is append-only: no caller can change or remove its records.', 405)
      requireOwner(actor)
      if (path === '/api/crank/audit/export') {
        await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'audit.export', 'workspace', 'audit')])
        return new Response(await exportAudit(env), { headers: { 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="crank-audit.ndjson"', 'cache-control': 'no-store' } })
      }
      requireValue(path === '/api/crank/audit', 'Route not found', 404)
      return json(await readAudit(env, url.searchParams.get('kind') ?? undefined, url.searchParams.get('id') ?? undefined))
    }
    if (request.method === 'GET') {
      if ((m = match(path, /^\/api\/crank\/authoring\/([^/]+)$/))) return json(await readAuthoring(env, actor, m[0]))
      if (path === '/api/crank/grants') return json(await readGrants(env, actor))
      if (path === '/api/crank/skills') return json(await listSkills(env, actor))
      if ((m = match(path, /^\/api\/crank\/skills\/([^/]+)$/))) return json(await readSkill(env, actor, m[0]))
      if ((m = match(path, /^\/api\/crank\/historical\/([^/]+)$/))) return json(await readHistorical(env, actor, m[0]))
      if (path === '/api/crank/workflows') return json(await listWorkflows(env, url.searchParams, actor))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)$/))) return json(await presentWorkflow(env, await getWorkflow(env, m[0])))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/drafts\/([^/]+)$/))) return json(await readDraft(env, m[0], m[1]))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/compare$/))) return json(await compareWorkflow(env, m[0], url.searchParams))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/trigger$/))) return json(await triggerState(env, m[0], url.searchParams))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/versions\/(\d+)$/))) return json(await versionGraph(env, m[0], Number(m[1])))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/today$/))) return json(await runsToday(env, m[0]))
      if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/holds$/))) return json((await stmt(env, 'SELECT * FROM crank_holds WHERE workflow_id=? ORDER BY created_at DESC', m[0]).all()).results)
      if (path === '/api/crank/regulated-operations') return json(await readRegulatedOperations(env, actor, Object.fromEntries(url.searchParams)))
      if (path === '/api/crank/workflow-runs') return json(await searchRuns(env, actor, url.searchParams))
      if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)$/))) return json(await runDetail(env, actor, m[0]))
      if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)\/replay$/))) return json(await previewReplay(env, actor, m[0]))
      if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)\/reconcile$/))) return json(await previewReconciliation(env, actor, m[0], url.searchParams.get('path') ?? ''))
      if ((m = match(path, /^\/api\/crank\/holds\/([^/]+)$/))) return json(await getHold(env, m[0]))
      if (path === '/api/crank/queues') return json((await stmt(env, `SELECT q.name,q.spacing_seconds,q.last_release_at,COUNT(i.seq) AS depth,MIN(i.arrived_at) AS oldest_arrived_at FROM crank_delay_queues q
        LEFT JOIN crank_queue_items i ON i.queue=q.name AND i.released_at IS NULL GROUP BY q.name ORDER BY q.name`).all<any>()).results.map(q => ({ ...q, next_release_at: q.depth ? new Date(Math.max(Date.now(), q.last_release_at ? Date.parse(q.last_release_at) + q.spacing_seconds * 1000 : 0)).toISOString() : null })))
      if ((m = match(path, /^\/api\/crank\/connections\/([^/]+)\/history$/))) { requireOwner(actor); await getConnection(env, m[0]); return json(await readAudit(env, 'connection', m[0])) }
      if (path === '/api/crank/connections') return json(await listConnections(env, actor))
      if (path === '/api/crank/catalog') return json({ apps: CATALOG })
      if (path === '/api/crank/oauth/callback') return json(await finishOauth(env, actor, url.searchParams), 201)
      if (path === '/api/crank/settings') return json(await workspaceSettings(env))
      if (path === '/api/crank/notices/deliveries') { requireOwner(actor); return json(await noticeDeliveries(env, url.searchParams.get('run_id'))) }
      if (path === '/api/crank/notices') { requireOwner(actor); return json((await stmt(env, 'SELECT * FROM crank_notices ORDER BY created_at DESC LIMIT 200').all()).results) }
      if (path === '/api/crank/reports/operations') {
        requireOwner(actor)
        const report = await operationsReport(env, url.searchParams)
        return url.searchParams.get('format') === 'csv' ? new Response(operationsCsv(report), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename=crank-operations.csv', 'cache-control': 'no-store' } }) : json(report)
      }
      if (path === '/api/crank/reports/log-sinks') { requireOwner(actor); return json(await listLogSinks(env)) }
      if (path === '/api/crank/reports/latency') return json(await latencyReport(env, url.searchParams))
      return json({ error: 'Route not found' }, 404)
    }
    requireValue(request.method === 'POST', 'Method not allowed', 405)
    requireWriteOrigin(request, env, actor)
    const input = request.body ? await body(request, 256 * 1024) : {}
    if (path === '/api/crank/authoring') return json(await generateAuthoring(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/authoring\/([^/]+)\/(revise|test|promote)$/))) {
      const action = m[1] === 'revise' ? reviseAuthoring : m[1] === 'test' ? testAuthoring : promoteAuthoring
      return json(await action(env, actor, m[0], input))
    }
    if (path === '/api/crank/grants') return json(await issueGrant(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/grants\/([^/]+)\/revoke$/))) return json(await revokeGrant(env, actor, m[0]))
    if (path === '/api/crank/skills') return json(await proposeSkill(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/skills\/([^/]+)\/approve$/))) return json(await approveSkill(env, actor, m[0], input))
    if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/historical$/))) return json(await previewHistorical(env, actor, m[0], input), 201)
    if ((m = match(path, /^\/api\/crank\/historical\/([^/]+)\/run$/))) return json(await releaseHistorical(env, actor, m[0], input))
    if (path === '/api/crank/reports/log-sinks') return json(await configureLogSink(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/reports\/log-sinks\/([^/]+)\/delete$/))) return json(await removeLogSink(env, actor, m[0]))
    if (path === '/api/crank/reports/log-streams/flush') { requireOwner(actor); return json(await flushLogStreams(env)) }
    if (path === '/api/crank/reports/settings') return json(await configureOperations(env, actor, input))
    if (path === '/api/crank/reports/obligations') return json(await createObligation(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/reports\/obligations\/([^/]+)\/verify$/))) return json(await verifyObligation(env, actor, m[0], input))
    if (path === '/api/crank/workflows') return json(await createWorkflow(env, actor, input, request.headers.get('Idempotency-Key')), 201)
    if ((m = match(path, /^\/api\/crank\/workflows\/([^/]+)\/(draft|validate|publish|rollback|unpublish|pause|resume|duplicate|run|test|preview|hooks)$/))) {
      const [workflowId, action] = m
      if (action === 'draft') return json(await updateDraft(env, actor, workflowId, input, request.headers.get('Idempotency-Key')))
      if (action === 'validate') {
        try { const { warnings, declared } = validateGraph(input.graph ?? JSON.parse((await getWorkflow(env, workflowId)).draft_json)); return json({ ok: true, warnings, declared }) }
        catch (error) { if (error instanceof StepError) return json({ ok: false, error: error.message }, 422); throw error }
      }
      if (action === 'publish') return json(await publishWorkflow(env, actor, workflowId, input, request.headers.get('Idempotency-Key')), 201)
      if (action === 'rollback') return json(await rollbackWorkflow(env, actor, workflowId, input, request.headers.get('Idempotency-Key')), 201)
      if (action === 'unpublish') return json(await unpublishWorkflow(env, actor, workflowId))
      if (action === 'pause' || action === 'resume') return json(await setWorkflowState(env, actor, workflowId, action === 'pause' ? 'paused' : 'published'))
      if (action === 'duplicate') return json(await duplicateWorkflow(env, actor, workflowId, input, request.headers.get('Idempotency-Key')), 201)
      if (action === 'test') return json(await testWorkflow(env, actor, workflowId, input), 201)
      if (action === 'run') return json(await startRun(env, actor, workflowId, input), 201)
      if (action === 'preview') return json(await previewWorkflow(env, workflowId, input))
      return json(await createHook(env, actor, workflowId, input), 201)
    }
    if ((m = match(path, /^\/api\/crank\/hooks\/([^/]+)\/revoke$/))) return json(await revokeHook(env, actor, m[0]))
    if ((m = match(path, /^\/api\/crank\/holds\/([^/]+)\/estimate$/))) return json(await quoteHold(env, actor, m[0], input))
    if ((m = match(path, /^\/api\/crank\/holds\/([^/]+)\/(release|discard)$/))) return json(await decideHold(env, actor, m[0], m[1] as 'release' | 'discard', input))
    if (path === '/api/crank/regulated-operations/consent') return json(await consentRegulatedOperation(env, actor, input))
    if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)\/replay$/))) return json(await replaySteps(env, actor, m[0], input))
    if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)\/reconcile$/))) return json(await reconcileEffect(env, actor, m[0], input))
    if ((m = match(path, /^\/api\/crank\/workflow-runs\/([^/]+)\/(approve|reject|resume|cancel)$/))) {
      if (m[1] === 'approve' || m[1] === 'reject') return json(await decideApproval(env, actor, m[0], m[1], input))
      return json(m[1] === 'resume' ? await resumeRun(env, actor, m[0]) : await cancelRun(env, actor, m[0]))
    }
    if (path === '/api/crank/connections') return json(await createConnection(env, actor, input), 201)
    if ((m = match(path, /^\/api\/crank\/connections\/([^/]+)\/(rotate|revoke|test|purpose)$/))) {
      if (m[1] === 'purpose') return json(await setConnectionPurpose(env, actor, m[0], input))
      if (m[1] === 'rotate') return json(await rotateConnection(env, actor, m[0], input))
      if (m[1] === 'revoke') return json(await revokeConnection(env, actor, m[0]))
      return json(await testConnection(env, actor, m[0], input))
    }
    if ((m = match(path, /^\/api\/crank\/oauth\/apps\/([^/]+)$/))) return json(await setOauthApp(env, actor, m[0], input))
    if (path === '/api/crank/oauth/start') return json(await startOauth(env, actor, input), 201)
    if (path === '/api/crank/coverage') return json(coverageReport(input))
    if (path === '/api/crank/notices/slack') return json(await configureNoticeRoute(env, actor, input))
    if (path === '/api/crank/settings') return json(await updateSettings(env, actor, input))
    return json({ error: 'Route not found' }, 404)
  } catch (error) {
    if (isBudgetExceeded(error)) return json({ error: 'USD budget exhausted. Work remains held or in its existing preview; replenish the budget or record an owner allowance before release.' }, 409)
    if (error instanceof CrankError) return json({ error: error.message }, error.status)
    if (error instanceof StepError) return json({ error: error.message, category: error.category }, error.category === 'auth' ? 502 : 422)
    const authError = error as { status?: unknown }
    if (typeof authError.status === 'number' && authError.status >= 400 && authError.status < 500) return json({ error: 'Authentication or request was refused' }, authError.status)
    return json({ error: 'Workflow operation could not be confirmed' }, 503)
  }
}
