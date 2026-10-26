import { SubflowWait } from '../workflows/subflow-calls'
import { allowedOperation, customVersion } from '../custom/store'
import { GatewayWait } from '../custom/gateway-tasks'
import { ExecutorWait } from '../executors/step'
import { grantProposal } from '../grants/policy'
import { approvalSpec } from '../grants/reviews'
import { admitStep } from './step-limit'
import { recordStepUsage, flushUsageNotices } from '../ops/usage'
import { sealText, targetFor } from '../ops/payload-seal'
import { mac } from '../connections/vault'
import { credential } from '../connections/store'
import { RetryWait } from '../connectors/retry-wait'
import { canonical, digest, id, now, stmt, type CrankEnv } from '../model'
import { afterSettle } from '../ops/failures'
import { workspaceSettings } from '../ops/settings'
import { evaluate, type Groups } from './conditions'
import { assertDispatchAuthority } from './authority'
import { cappedProposal } from './caps'
import { claimQueuedRun } from './queue'
import { requireZone } from './dates'
import { StepError } from './errors'
import { liveTestProposal } from './test-authority'
import { branchesOf, type Graph } from './graph'
import { executeLoop } from './loop'
import { requireFields, resolve, type Scope } from './mapping'
import { getWfRun, insertWait, loadRecords, loadReplays, loadWaits, saveRecord, type Replay, type StepRecord } from './records'
import { STEP_TYPES } from './steps'
import type { ExecutionOutcome as Outcome, RunRow, Step, StepContext, StepResult, WaitRow } from './types'
import { isObject } from './values'

const LEASE_MS = 5 * 60000

export async function resumeToken(env: CrankEnv, runId: string, path: string) {
  const encoded = btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${runId}~${encoded}~${await mac(env, 'resume', runId + '\u0000' + path)}`
}

class Execution {
  records!: Map<string, StepRecord>
  waits!: Map<string, WaitRow>
  replays!: Map<string, Replay>
  scope!: Scope
  zone = 'America/New_York'
  constructor(readonly env: CrankEnv, public run: RunRow, readonly lease: string, readonly graph: Graph, readonly time: number, readonly retryPolicy: Record<string, unknown>) {}

  async prepare() {
    if (this.run.mode !== 'test' && !await stmt(this.env, 'SELECT 1 FROM crank_usage_reservations WHERE run_id=?', this.run.id).first()) throw new StepError('authority', 'Cost estimate required for this pre-metering run. Its work is retained; cancel it and prepare a freshly quoted run before dispatch.')
    const [records, waits, replays, settings] = await Promise.all([loadRecords(this.env, this.run.id), loadWaits(this.env, this.run.id), loadReplays(this.env, this.run.id), workspaceSettings(this.env)])
    this.records = records; this.waits = waits; this.replays = replays
    this.zone = requireZone(this.graph.settings?.timezone ?? settings.timezone)
    this.scope = { trigger: JSON.parse(this.run.trigger_json), steps: {}, run: { id: this.run.id, workflow_id: this.run.workflow_id, version_id: this.run.version_id, received_at: this.run.received_at, resume_urls: {} } }
    await this.callbacks(this.graph.steps, '')
  }

  private async callbacks(steps: Step[], prefix: string) {
    const resumeUrls = { ...(this.scope.run.resume_urls as Record<string, string>) }
    const paths: Record<string, string> = {}
    const collect = (steps: Step[], prefix: string) => steps.forEach(step => {
      if (step.type === 'wait_for_callback') paths[step.id] = prefix + step.id
      if (step.type === 'paths') for (const branch of branchesOf(step)) collect(branch.steps, `${prefix}${step.id}/${branch.id}/`)
    })
    collect(steps, prefix)
    for (const [stepId, path] of Object.entries(paths)) resumeUrls[stepId] = new URL('/hooks/resume/' + await resumeToken(this.env, this.run.id, path), this.env.AUTH_ORIGIN).href
    this.scope.run.resume_urls = resumeUrls
  }

  async fork(steps: Step[], prefix: string, item: unknown, index: number) {
    const child = new Execution(this.env, this.run, this.lease, this.graph, this.time, this.retryPolicy)
    child.records = this.records; child.waits = this.waits; child.replays = this.replays; child.zone = this.zone
    child.scope = { ...this.scope, item, item_index: index, steps: { ...this.scope.steps }, run: { ...this.scope.run } }
    await child.callbacks(steps, prefix)
    return child
  }

  async save(step: Step, path: string, status: StepRecord['status'], extra: { input?: unknown; output?: unknown; trace?: unknown; error?: unknown }) {
    const previous = this.records.get(path)
    const record = { run_id: this.run.id, path, step_id: step.id, type: step.type, status, started_at: previous?.started_at ?? new Date(this.time).toISOString(), finished_at: ['running', 'waiting'].includes(status) ? null : now(), operation_key: previous?.operation_key ?? this.replays.get(path)?.operation_key ?? `${this.run.id}:${path}` }
    await saveRecord(this.env, this.run, this.lease, { ...record, ...extra })
    const encode = (value: unknown) => value === undefined ? null : JSON.stringify(value)
    this.records.set(path, { ...record, input_json: extra.input === undefined ? previous?.input_json ?? null : encode(extra.input), output_json: encode(extra.output), trace_json: encode(extra.trace), error_json: encode(extra.error) })
  }

  async walk(steps: Step[], prefix: string): Promise<Outcome> {
    for (const step of steps) {
      // Renew before another action; a stale executor must not begin new effects.
      const leaseTime = Date.now()
      const held = await stmt(this.env, "UPDATE crank_wf_runs SET lease_expires_at=? WHERE id=? AND lease_id=? AND status='running' AND lease_expires_at>? RETURNING id", new Date(leaseTime + LEASE_MS).toISOString(), this.run.id, this.lease, new Date(leaseTime).toISOString()).first<{ id: string }>()
      if (!held) throw new StepError('uncertain', 'The execution lease changed; no further action was started', { uncertain: true })
      await assertDispatchAuthority(this.env, this.run.id)
      const path = prefix + step.id
      await admitStep(this.env, this.run.id, path, Number(this.graph.settings?.max_steps ?? 10000))
      await recordStepUsage(this.env, this.run.id, path, step.type)
      const outcome = step.type === 'paths' ? await this.paths(step, path) : step.type === 'loop' ? await executeLoop(step, path, this) : await this.step(step, path)
      if (outcome.kind !== 'completed') return outcome
    }
    return { kind: 'completed' }
  }

  private async step(step: Step, path: string): Promise<Outcome> {
    const type = STEP_TYPES[step.type], record = this.records.get(path)
    // HTTP's registry entry supports writes, but a statically declared read is
    // safe to repeat after interruption. Never reclassify a retained write.
    const method = isObject(step.input) ? String(step.input.method ?? 'GET').toUpperCase() : 'GET'
    const priorMethod = record?.input_json ? String(JSON.parse(record.input_json).method ?? 'GET').toUpperCase() : method
    let mutating = type.mutating && !(step.type === 'http' && ['GET', 'HEAD'].includes(method) && ['GET', 'HEAD'].includes(priorMethod))
    const output = (r: StepRecord) => r.output_json ? JSON.parse(r.output_json) : null
    if (record?.status === 'succeeded' || record?.status === 'skipped' || (record?.status === 'failed' && step.on_error === 'continue')) { this.scope.steps[step.id] = output(record); return { kind: 'completed' } }
    if (record?.status === 'stopped') { const value = output(record); return value?.rejected ? { kind: 'rejected', reason: value.reason } : { kind: 'stopped', reason: value?.reason ?? 'filter' } }
    if (record?.status === 'failed' || record?.status === 'uncertain') return { kind: 'failed', error: record.error_json ? JSON.parse(record.error_json) : { category: 'uncertain' } }
    const wait = this.waits.get(path)
    if (record?.status === 'waiting' && wait && !wait.resolved_at) return { kind: 'waiting', approval: wait.kind === 'approval' }
    let input: Record<string, unknown> = {}
    const ctx: StepContext = {
      env: this.env, run: this.run, scope: this.scope, path, operationKey: record?.operation_key ?? this.replays.get(path)?.operation_key ?? `${this.run.id}:${path}`, now: this.time, zone: this.zone, input, requests: { next: 0 }, retryPolicy: { ...this.retryPolicy, ...(isObject(step.retry_policy) ? step.retry_policy : {}), write_base_delay_ms: isObject(step.retry_policy) ? step.retry_policy.base_delay_ms ?? this.retryPolicy.write_base_delay_ms : this.retryPolicy.write_base_delay_ms },
      respond: async response => { await stmt(this.env, 'UPDATE crank_wf_runs SET response_json=? WHERE id=? AND lease_id=?', await sealText(await targetFor(this.env, this.run.workflow_id), JSON.stringify(response)), this.run.id, this.lease).run() },
    }
    try {
      const replay = record ? undefined : this.replays.get(path)
      input = record?.input_json ? JSON.parse(record.input_json) : replay?.input_json ? JSON.parse(replay.input_json) : (resolve(step.input ?? {}, this.scope) ?? {}) as Record<string, unknown>
      ctx.input = input
      if(step.type==='custom.request') {
        const operation=allowedOperation(await customVersion(this.env,String(step.connector_id),Number(step.connector_version)),String(step.operation),this.run.mode==='test')
        mutating=!['GET','HEAD'].includes(operation.method)
      }
      if (record?.status === 'running' && mutating && !type.reconciles) {
        await this.save(step, path, 'uncertain', { error: { category: 'uncertain', message: 'Interrupted during a remote write; check the destination before replaying' } })
        return { kind: 'failed', error: { category: 'uncertain', message: 'Interrupted during a remote write' } }
      }
      let result: StepResult
      if (record?.status === 'waiting' && wait?.resolved_at && type.resume) {
        result = await type.resume(step, { ...ctx, wait })
      } else {
        if (type.required) requireFields(input, type.required, step.id)
        const boundary = await this.cap(step, path, input, wait, mutating)
        if (boundary) return boundary
        if (typeof step.connection_id === 'string') await credential(this.env, step.connection_id)
        if (mutating) await this.save(step, path, 'running', { input })
        result = await type.execute(step, ctx)
      }
      return await this.settle(step, path, input, result)
    } catch (error) {
      if (error instanceof SubflowWait) {
        await this.save(step,path,'waiting',{input,trace:{child_id:error.callId}})
        return {kind:'waiting',approval:false}
      }
      if (error instanceof GatewayWait) {
        await this.save(step,path,'waiting',{input,trace:{gateway_task_id:error.taskId}})
        return {kind:'waiting',approval:false}
      }
      if (error instanceof ExecutorWait) {
        await this.save(step,path,'waiting',{input,trace:{executor_task_id:error.taskId}})
        return {kind:'waiting',approval:false}
      }
      if (error instanceof RetryWait) {
        await this.save(step, path, 'waiting', { input, trace: { retry_attempt_id: error.attemptId, retry_at: error.dueAt } })
        return { kind: 'waiting', approval: false }
      }
      if (error instanceof StepError && (error.category === 'connection' || error.category === 'authority')) {
        await this.save(step, path, 'waiting', { input })
        return { kind: 'paused', reason: error.message, connectionId: String(error.detail.connection_id ?? ''), authority: error.category === 'authority' }
      }
      const failure = error instanceof StepError ? error.toJSON() : { category: 'provider', message: `Step ${step.id} failed unexpectedly` }
      if (step.on_error === 'continue' && failure.category !== 'uncertain' && !(failure as any).uncertain) {
        const value = { ok: false, error: { category: failure.category, message: failure.message }, ...(error instanceof StepError ? error.detail : {}) }
        await this.save(step, path, 'failed', { input, output: value, error: failure })
        this.scope.steps[step.id] = value
        return { kind: 'completed' }
      }
      await this.save(step, path, (failure as any).uncertain ? 'uncertain' : 'failed', { input, error: failure, trace: (failure as any).trace })
      return { kind: 'failed', error: { ...failure, step: step.id } }
    }
  }

  private async settle(step: Step, path: string, input: Record<string, unknown>, result: StepResult): Promise<Outcome> {
    switch (result.status) {
      case 'succeeded':
        await this.save(step, path, 'succeeded', { input, output: result.output, trace: result.trace })
        this.scope.steps[step.id] = result.output
        return { kind: 'completed' }
      case 'waiting':
        await insertWait(this.env, this.run, path, result.wait.kind === 'approval' ? await approvalSpec(this.env, this.run, result.wait.proposal, result.wait.reason ?? 'approval step', step.type === 'collect' ? result.wait.expiresAt : null) : result.wait)
        await this.save(step, path, 'waiting', { input })
        return { kind: 'waiting', approval: result.wait.kind === 'approval' }
      case 'stopped':
        await this.save(step, path, 'stopped', { input, output: { reason: result.reason, ...(isObject(result.output) ? result.output : {}) }, trace: result.trace })
        return { kind: 'stopped', reason: result.reason }
      case 'rejected':
        await this.save(step, path, 'stopped', { input, output: { rejected: true, reason: result.reason } })
        return { kind: 'rejected', reason: result.reason }
      case 'paused':
        await this.save(step, path, 'waiting', { input, output: result.output, trace: result.trace })
        return { kind: 'paused', reason: result.reason, connectionId: result.connectionId }
    }
  }

  /** TEAM-002/004: approval covers one exact effect; grants remain live limits. */
  private async cap(step: Step, path: string, input: Record<string, unknown>, wait: WaitRow | undefined, mutating: boolean): Promise<Outcome | null> {
    if (wait?.kind === 'approval') {
      if (!wait.resolved_at) return {kind:'waiting',approval:true}
      const decision = JSON.parse(wait.resolution_json ?? '{}')
      if (!decision.approved) {
        await this.save(step,path,'stopped',{input,output:{rejected:true,reason:decision.reason ?? 'rejected'}})
        return {kind:'rejected',reason:decision.reason ?? 'rejected'}
      }
      const reviewed = JSON.parse(wait.proposal_json ?? '{}')
      if (canonical(reviewed.input) !== canonical(input) || wait.proposal_digest !== await digest(canonical(reviewed)))
        throw new StepError('authority','The proposed effect changed; a fresh review is required')
      await grantProposal(this.env,this.run,step,path,input,true)
      return null
    }
    const grant = await grantProposal(this.env,this.run,step,path,input)
    const capped = mutating ? cappedProposal(step,input,this.scope,(await workspaceSettings(this.env)).caps) : null
    const liveTest = mutating ? await liveTestProposal(this.env,this.run,step,input) : null
    if (!grant && !capped && !liveTest) return null
    const proposal = {...grant?.proposal,...capped?.proposal,...liveTest?.proposal,step:step.id,type:step.type,input}
    const reason = [grant?.reason,capped?.reason,liveTest?.reason].filter(Boolean).join('; ')
    await insertWait(this.env,this.run,path,await approvalSpec(this.env,this.run,proposal,reason))
    await this.save(step,path,'waiting',{input})
    return {kind:'waiting',approval:true}
  }

  /** WORK-013 path groups: exclusive or parallel, with fallback or always-run branches. */
  private async paths(step: Step, path: string): Promise<Outcome> {
    const branches = branchesOf(step), record = this.records.get(path)
    let chosen: string[]
    if (record?.status === 'succeeded') chosen = JSON.parse(record.output_json!).matched
    else if (record?.status === 'stopped') return { kind: 'stopped', reason: 'filter' }
    else {
      const results: { branch: string; pass: boolean; trace: unknown }[] = []
      let mismatch: { branch: string; message: string } | null = null
      for (const branch of branches.filter(b => b.kind === 'rule')) {
        const evaluation = evaluate(branch.when as Groups, this.scope, this.zone, this.time)
        results.push({ branch: branch.id, pass: evaluation.pass, trace: evaluation })
        if (evaluation.mismatch && !mismatch) mismatch = { branch: branch.id, message: `type mismatch in path ${step.id}/${branch.id}: ${evaluation.mismatch.field} (${evaluation.mismatch.message})` }
      }
      if (mismatch) {
        const route = step.on_type_mismatch
        if (route === undefined || route === 'halt') {
          const error = new StepError('type_mismatch', mismatch.message, { outcome: 'type mismatch', trace: results })
          await this.save(step, path, 'failed', { error: error.toJSON(), trace: results })
          return { kind: 'failed', error: { ...error.toJSON(), step: step.id } }
        }
        chosen = [String(route)]
      } else {
        const passing = results.filter(r => r.pass).map(r => r.branch)
        chosen = step.mode === 'exclusive' ? passing.slice(0, 1) : passing
        if (!chosen.length && branches.some(b => b.kind === 'fallback')) chosen = ['fallback']
      }
      if (branches.some(b => b.kind === 'always')) chosen.push('always')
      if (!chosen.length) {
        await this.save(step, path, 'stopped', { output: { reason: 'filter', matched: [] }, trace: results })
        return { kind: 'stopped', reason: 'filter' }
      }
      await this.save(step, path, 'succeeded', { output: { mode: step.mode, matched: chosen }, trace: results })
    }
    this.scope.steps[step.id] = { matched: chosen }
    const outcomes: Outcome[] = []
    for (const branch of branches.filter(b => chosen.includes(b.id))) {
      const outcome = await this.walk(branch.steps, `${path}/${branch.id}/`)
      if (outcome.kind !== 'completed' && outcome.kind !== 'stopped') return outcome
      outcomes.push(outcome)
    }
    return outcomes.every(o => o.kind === 'stopped') ? outcomes[0] : { kind: 'completed' }
  }
}

const STATUS: Record<Outcome['kind'], string> = { completed: 'succeeded', stopped: 'stopped_by_filter', waiting: 'waiting', paused: 'paused', failed: 'failed', rejected: 'rejected' }

/** Claims a queued run, walks its version's graph from the checkpoints and settles it. */
export async function executeRun(env: CrankEnv, runId: string, time = Date.now()): Promise<RunRow | null> {
  const lease = id()
  if (!await claimQueuedRun(env, runId, lease, time, LEASE_MS)) return getWfRun(env, runId)
  const run = (await getWfRun(env, runId))!
  const version = await stmt(env, 'SELECT graph_json,retry_policy_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ graph_json: string; retry_policy_json: string }>()
  const execution = new Execution(env, run, lease, JSON.parse(version!.graph_json), time, JSON.parse(version!.retry_policy_json))
  let outcome: Outcome
  try {
    await execution.prepare()
    outcome = await execution.walk(execution.graph.steps, '')
  } catch (error) {
    outcome = error instanceof StepError && (error.category === 'authority' || error.category === 'connection')
      ? {kind: 'paused', reason: error.message, authority: error.category === 'authority', connectionId: String(error.detail.connection_id ?? '')}
      : { kind: 'failed', error: error instanceof StepError ? error.toJSON() : { category: 'provider', message: 'The run failed unexpectedly' } }
  }
  let status = STATUS[outcome.kind]
  if (outcome.kind === 'stopped' && outcome.reason === 'search') status = 'stopped_by_search'
  if (outcome.kind === 'waiting' && outcome.approval) status = 'awaiting_approval'
  const terminal = !['waiting', 'awaiting_approval', 'paused'].includes(status)
  const error = outcome.kind === 'failed' ? outcome.error : outcome.kind === 'paused' ? { category: outcome.authority ? 'authority' : 'connection', message: outcome.reason, connection_id: outcome.connectionId, reconnect: !outcome.authority } : outcome.kind === 'rejected' ? { category: 'rejected', message: outcome.reason } : null
  // A callback/approval can resolve while another item is still running. Queue
  // only waits whose child checkpoint remains waiting, so old completed waits
  // cannot spin an otherwise parked run.
  await stmt(env, `UPDATE crank_wf_runs SET status=CASE WHEN ? IN ('waiting','awaiting_approval') AND EXISTS(
    SELECT 1 FROM crank_waits w JOIN crank_wf_steps s ON s.run_id=w.run_id AND s.path=w.path
    WHERE w.run_id=crank_wf_runs.id AND w.resolved_at IS NOT NULL AND s.status='waiting' AND json_extract(s.trace_json,'$.retry_attempt_id') IS NULL AND json_extract(s.trace_json,'$.gateway_task_id') IS NULL
  ) THEN 'queued' ELSE ? END,finished_at=?,error_json=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=?`, status, status, terminal ? now() : null, error ? await sealText(await targetFor(env, run.workflow_id), JSON.stringify(error)) : null, runId, lease).run()
  const settled = (await getWfRun(env, runId))!
  // Page payloads are continuation state, not a second permanent copy of run data.
  await stmt(env,`UPDATE crank_gateway_tasks SET input_json='{}',output_json=NULL WHERE run_id=? AND (EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=crank_gateway_tasks.run_id AND s.path=crank_gateway_tasks.path AND s.status='succeeded') OR ?=1)`,runId,terminal && !(outcome.kind==='failed' && isObject(outcome.error) && outcome.error.category==='uncertain')?1:0).run()
  await afterSettle(env, settled)
  await flushUsageNotices(env)
  return settled
}
