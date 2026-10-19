import { mac } from '../connections/vault'
import { credential } from '../connections/store'
import { canonical, digest, id, now, stmt, type CrankEnv } from '../model'
import { afterSettle } from '../ops/failures'
import { workspaceSettings } from '../ops/settings'
import { evaluate, type Groups } from './conditions'
import { compare, parseDecimal } from './decimal'
import { requireZone } from './dates'
import { StepError } from './errors'
import { branchesOf, type Graph } from './graph'
import { requireFields, resolve, type Scope } from './mapping'
import { deleteRecord, getWfRun, insertWait, loadRecords, loadWaits, saveRecord, type StepRecord } from './records'
import { STEP_TYPES } from './steps'
import type { RunRow, Step, StepContext, StepResult, WaitRow } from './types'
import { isObject } from './values'

type Outcome =
  | { kind: 'completed' } | { kind: 'stopped'; reason: 'filter' | 'search' } | { kind: 'waiting'; approval: boolean }
  | { kind: 'paused'; reason: string; connectionId?: string } | { kind: 'failed'; error: unknown } | { kind: 'rejected'; reason: string }
const LEASE_MS = 5 * 60000

export async function resumeToken(env: CrankEnv, runId: string, path: string) {
  const encoded = btoa(path).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${runId}~${encoded}~${await mac(env, 'resume', runId + '\u0000' + path)}`
}

class Execution {
  records!: Map<string, StepRecord>
  waits!: Map<string, WaitRow>
  scope!: Scope
  zone = 'America/New_York'
  caps: { category: string; max_usd: string }[] = []
  constructor(readonly env: CrankEnv, public run: RunRow, readonly lease: string, readonly graph: Graph, readonly time: number) {}

  async prepare() {
    const [records, waits, settings] = await Promise.all([loadRecords(this.env, this.run.id), loadWaits(this.env, this.run.id), workspaceSettings(this.env)])
    this.records = records; this.waits = waits
    this.zone = requireZone(this.graph.settings?.timezone ?? settings.timezone)
    this.caps = settings.caps
    const resumeUrls: Record<string, string> = {}
    const collect = (steps: Step[], prefix: string) => steps.forEach(step => {
      if (step.type === 'wait_for_callback') resumeUrls[step.id] = prefix + step.id
      if (step.type === 'paths') for (const branch of branchesOf(step)) collect(branch.steps, `${prefix}${step.id}/${branch.id}/`)
    })
    collect(this.graph.steps, '')
    for (const [stepId, path] of Object.entries(resumeUrls)) resumeUrls[stepId] = new URL('/hooks/resume/' + await resumeToken(this.env, this.run.id, path), this.env.AUTH_ORIGIN).href
    this.scope = { trigger: JSON.parse(this.run.trigger_json), steps: {}, run: { id: this.run.id, workflow_id: this.run.workflow_id, version_id: this.run.version_id, received_at: this.run.received_at, resume_urls: resumeUrls } }
  }

  private save(step: Step, path: string, status: StepRecord['status'], extra: { input?: unknown; output?: unknown; trace?: unknown; error?: unknown }) {
    const previous = this.records.get(path)
    return saveRecord(this.env, this.run, this.lease, { run_id: this.run.id, path, step_id: step.id, type: step.type, status, started_at: previous?.started_at ?? new Date(this.time).toISOString(), finished_at: ['running', 'waiting'].includes(status) ? null : now(), operation_key: previous?.operation_key ?? `${this.run.id}:${path}`, ...extra })
  }

  async walk(steps: Step[], prefix: string): Promise<Outcome> {
    for (const step of steps) {
      const path = prefix + step.id
      const outcome = step.type === 'paths' ? await this.paths(step, path) : await this.step(step, path)
      if (outcome.kind !== 'completed') return outcome
    }
    return { kind: 'completed' }
  }

  private async step(step: Step, path: string): Promise<Outcome> {
    const type = STEP_TYPES[step.type], record = this.records.get(path)
    const output = (r: StepRecord) => r.output_json ? JSON.parse(r.output_json) : null
    if (record?.status === 'succeeded' || record?.status === 'skipped' || (record?.status === 'failed' && step.on_error === 'continue')) { this.scope.steps[step.id] = output(record); return { kind: 'completed' } }
    if (record?.status === 'stopped') { const value = output(record); return value?.rejected ? { kind: 'rejected', reason: value.reason } : { kind: 'stopped', reason: value?.reason ?? 'filter' } }
    if (record?.status === 'failed' || record?.status === 'uncertain') return { kind: 'failed', error: record.error_json ? JSON.parse(record.error_json) : { category: 'uncertain' } }
    if (record?.status === 'running' && type.mutating) {
      await this.save(step, path, 'uncertain', { error: { category: 'uncertain', message: 'Interrupted during a remote write; check the destination before replaying' } })
      return { kind: 'failed', error: { category: 'uncertain', message: 'Interrupted during a remote write' } }
    }
    const wait = this.waits.get(path)
    if (record?.status === 'waiting' && wait && !wait.resolved_at) return { kind: 'waiting', approval: wait.kind === 'approval' }
    let input: Record<string, unknown> = {}
    const ctx: StepContext = {
      env: this.env, run: this.run, scope: this.scope, path, operationKey: record?.operation_key ?? `${this.run.id}:${path}`, now: this.time, zone: this.zone, input,
      respond: async response => { await stmt(this.env, 'UPDATE crank_wf_runs SET response_json=? WHERE id=? AND lease_id=?', JSON.stringify(response), this.run.id, this.lease).run() },
    }
    try {
      input = (resolve(step.input ?? {}, this.scope) ?? {}) as Record<string, unknown>
      ctx.input = input
      let result: StepResult
      if (record?.status === 'waiting' && wait?.resolved_at && type.resume) {
        result = await type.resume(step, { ...ctx, wait })
      } else {
        if (type.required) requireFields(input, type.required, step.id)
        if (type.mutating) {
          const capped = await this.cap(step, path, input, wait)
          if (capped) return capped
        }
        if (typeof step.connection_id === 'string') await credential(this.env, step.connection_id)
        if (type.mutating) await this.save(step, path, 'running', { input })
        result = await type.execute(step, ctx)
      }
      return await this.settle(step, path, input, result)
    } catch (error) {
      if (error instanceof StepError && error.category === 'connection') {
        await deleteRecord(this.env, this.run, path)
        return { kind: 'paused', reason: error.message, connectionId: String(error.detail.connection_id ?? '') }
      }
      const failure = error instanceof StepError ? error.toJSON() : { category: 'provider', message: `Step ${step.id} failed unexpectedly` }
      if (step.on_error === 'continue') {
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
        await insertWait(this.env, this.run, path, result.wait)
        await this.save(step, path, 'waiting', { input })
        return { kind: 'waiting', approval: result.wait.kind === 'approval' }
      case 'stopped':
        await this.save(step, path, 'stopped', { input, output: { reason: result.reason, ...(isObject(result.output) ? result.output : {}) }, trace: result.trace })
        return { kind: 'stopped', reason: result.reason }
      case 'rejected':
        await this.save(step, path, 'stopped', { input, output: { rejected: true, reason: result.reason } })
        return { kind: 'rejected', reason: result.reason }
      case 'paused':
        return { kind: 'paused', reason: result.reason, connectionId: result.connectionId }
    }
  }

  /** TEAM-004 opt-in caps: a per-step cap, or a workspace cap for the step's category,
   * pauses only an out-of-cap action for approval of its exact input. */
  private async cap(step: Step, path: string, input: Record<string, unknown>, wait?: WaitRow): Promise<Outcome | null> {
    const own = isObject(step.cap) ? step.cap : null
    const workspace = typeof step.category === 'string' ? this.caps.find(cap => cap.category === step.category) : undefined
    const limit = own?.max_usd ?? workspace?.max_usd
    if (limit === undefined) return null
    const amount = parseDecimal(resolve(own?.amount ?? step.amount, this.scope)), max = parseDecimal(limit)
    if (!amount || !max) throw new StepError('validation', `Step ${step.id}: the capped amount is not a number`)
    if (compare(amount, max) <= 0) return null
    const proposal = { step: step.id, type: step.type, input, amount: resolve(own?.amount ?? step.amount, this.scope), cap: limit }
    if (!wait) {
      await insertWait(this.env, this.run, path, { kind: 'approval', proposal, reason: `${step.type} amount exceeds the ${limit} cap` })
      await this.save(step, path, 'waiting', { input })
      return { kind: 'waiting', approval: true }
    }
    if (!wait.resolved_at) return { kind: 'waiting', approval: true }
    const resolution = JSON.parse(wait.resolution_json ?? '{}')
    if (!resolution.approved) { await this.save(step, path, 'stopped', { input, output: { rejected: true, reason: resolution.reason ?? 'rejected' } }); return { kind: 'rejected', reason: resolution.reason ?? 'rejected' } }
    // The approved decision covers exactly the input it reviewed.
    if (wait.proposal_digest !== await digest(canonical(proposal))) throw new StepError('validation', `Step ${step.id}: the input changed after approval`)
    return null
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
  const lease = id(), at = new Date(time).toISOString()
  const claimed = await stmt(env, "UPDATE crank_wf_runs SET status='running',lease_id=?,lease_expires_at=?,started_at=COALESCE(started_at,?) WHERE id=? AND status='queued'", lease, new Date(time + LEASE_MS).toISOString(), at, runId).run()
  // D1 includes transactional outbox trigger writes in changes; the unique run id
  // still guarantees that any positive count means this caller claimed the run.
  if (claimed.meta.changes === 0) return getWfRun(env, runId)
  const run = (await getWfRun(env, runId))!
  const version = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ graph_json: string }>()
  const execution = new Execution(env, run, lease, JSON.parse(version!.graph_json), time)
  let outcome: Outcome
  try {
    await execution.prepare()
    outcome = await execution.walk(execution.graph.steps, '')
  } catch (error) {
    outcome = { kind: 'failed', error: error instanceof StepError ? error.toJSON() : { category: 'provider', message: 'The run failed unexpectedly' } }
  }
  let status = STATUS[outcome.kind]
  if (outcome.kind === 'stopped' && outcome.reason === 'search') status = 'stopped_by_search'
  if (outcome.kind === 'waiting' && outcome.approval) status = 'awaiting_approval'
  const terminal = !['waiting', 'awaiting_approval', 'paused'].includes(status)
  const error = outcome.kind === 'failed' ? outcome.error : outcome.kind === 'paused' ? { category: 'connection', message: outcome.reason, connection_id: outcome.connectionId, reconnect: true } : outcome.kind === 'rejected' ? { category: 'rejected', message: outcome.reason } : null
  await stmt(env, 'UPDATE crank_wf_runs SET status=?,finished_at=?,error_json=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=?', status, terminal ? now() : null, error ? JSON.stringify(error) : null, runId, lease).run()
  const settled = (await getWfRun(env, runId))!
  await afterSettle(env, settled)
  return settled
}
