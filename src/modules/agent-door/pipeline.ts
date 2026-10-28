import type { CallResult, DecisionMeta, Principal, Runtime, ToolContext } from './types.ts'
import { audit, newAudit, recordDecision, outcomeRow, recoverAudit, usage, usageToday, type Evidence } from './audit.ts'
import { policyRefusal, policyState, setupUrl } from './policy-store.ts'
import { classify, context, digest, runTool, saveCall, selfEscalation, summary } from './execution.ts'
import { decide } from './policy/decide.ts'
import { durationSeconds } from './policy/document.ts'
import { validateSchema } from './json-schema.ts'
import { ToolRefusal } from './errors.ts'
import { openApproval, approvalReplay } from './approvals.ts'
import { openReview } from './reviews.ts'
import { appendEvents } from './events.ts'
import { acquireDecision, releaseDecision, startExecution, startPending } from './counting.ts'
import { preparedBy } from './people.ts'
import type { ToolDefinition } from './types.ts'

export interface PipelineAnswer { result: CallResult; status?: number; scope?: string }
export async function callTool(rt: Runtime, name: string, input: unknown, principal: Principal, door: ToolContext['door'], trace?: unknown, resourceTool?: ToolDefinition, requestState?: unknown): Promise<PipelineAnswer> {
  const row = newAudit(rt, principal, name, door, trace)
  if (name === 'resources/read') row.resource = String((input as { uri: string }).uri)
  let evidence: Evidence | undefined, owned = false, effected = false, locked = false
  let result: CallResult = { outcome: 'refused', decision: null }, status: number | undefined, scope: string | undefined
  const refuse = (code: string, fields?: Record<string, unknown>) => { result = { ...result, outcome: 'refused', code, fields }; return { result, status, scope } }
  try {
    const tool = resourceTool ?? rt.tools.find(tool => tool.name === name)
    if (!tool) { status = 400; return refuse('tool_not_found') }
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
    const properties = tool.inputSchema.properties ?? {}
    const declared = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => Object.hasOwn(properties, key)))
    row.ignored_arguments = Object.keys(raw ?? {}).filter(key => !Object.hasOwn(properties, key)).sort()
    const key = !tool.readOnly && typeof raw?.idempotency_key === 'string' && raw.idempotency_key.length > 0 && raw.idempotency_key.length <= 200 ? raw.idempotency_key : null
    row.idempotency_key = key
    if (tool.scope && !principal.scopes.includes(tool.scope)) { status = 403; scope = tool.scope; return refuse('insufficient_scope') }
    const state = await policyState(rt)
    row.revision = state.revision
    const refusal = policyRefusal(rt, state, tool.classes)
    if (refusal) {
      const disposition = { agents_paused: 'paused', policy_unset: 'unset', policy_unavailable: 'unavailable' }[refusal.code] ?? 'none'
      result.decision = { id: row.id, disposition, revision: state.revision, classes: [] }
      return refuse(refusal.code, refusal.fields)
    }
    if (!tool.readOnly && !key) return refuse('idempotency_key_required')
    const requestDigest = await digest({ name, arguments: declared })
    if (tool.readOnly && requestState !== undefined) {
      if (typeof requestState !== 'string') return refuse('invalid_arguments')
      const pending = await rt.options.db.prepare("SELECT saved FROM agent_door_approvals WHERE json_extract(saved,'$.result.requestState')=?").bind(requestState).first<{ saved: string }>()
      const saved = pending ? JSON.parse(pending.saved) : null
      if (!saved || saved.principal.person.id !== principal.person.id || saved.principal.agent.id !== principal.agent.id || saved.tool !== name || saved.digest !== requestDigest) return refuse('invalid_arguments')
      result = await approvalReplay(rt, saved.result)
      if (result.decision) result = { ...result, decision: { ...result.decision, id: row.id } }
      row.replay_of = saved.decision_id; row.outcome = 'replayed'
      return { result }
    }
    if (key !== null) {
      const previous = await rt.options.db.prepare('SELECT digest,outcome,decision_id FROM agent_door_calls WHERE agent=? AND key=?').bind(principal.agent.id, key).first<{ digest: string; outcome: string | null; decision_id: string }>()
      if (previous) {
        if (previous.digest !== requestDigest) return refuse('idempotency_conflict')
        if (!previous.outcome) return refuse('call_in_progress')
        await recoverAudit(rt, previous.decision_id, JSON.parse(previous.outcome))
        result = await approvalReplay(rt, JSON.parse(previous.outcome))
        if (result.decision) result = { ...result, decision: { ...result.decision, id: row.id } }
        row.replay_of = previous.decision_id; row.outcome = 'replayed'
        return { result }
      }
    }
    if (!raw || !validateSchema(tool.inputSchema, declared)) return refuse('invalid_arguments')
    const { idempotency_key: _key, expected_revision: expected, ...args } = declared
    const ctx = context(rt, principal, door, [])
    if (tool.revision && expected !== undefined) {
      const current = await tool.revision(args, ctx)
      if (expected !== current) return refuse('revision_conflict', { current_revision: current })
    }
    const authority = await tool.authority?.(args, ctx)
    if (selfEscalation(authority, principal)) {
      result.decision = { id: row.id, disposition: 'self_escalation', revision: state.revision, classes: [] }
      return refuse('self_escalation')
    }
    const classes = await classify(tool, args, ctx)
    locked = await acquireDecision(rt, row.id)
    if (!locked) return refuse('decision_busy')
    const sums = await usage(rt, state.document!, principal)
    const decision = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes }, usageToday: usageToday(sums) })
    const meta: DecisionMeta = { id: row.id, disposition: decision.result, revision: state.revision,
      classes: decision.classes.map(item => ({ ...item, facts: classes.find(value => value.class === item.class)!.facts })) }
    result.decision = meta
    evidence = { document: state.document!, usage: sums, classes, result: decision.result, rules: decision.classes }
    if (decision.result === 'unset') return refuse('policy_unset', { unanswered: decision.unset, setup_url: setupUrl(rt, state) })
    if (decision.result === 'blocked') return refuse('policy_blocked', { class: decision.deciding!.class, rule: decision.deciding!.rule, revision: state.revision })
    const savedSummary = await summary(tool, args, ctx)
    const summary_sha256 = await digest(savedSummary)
    recordDecision(row, meta)
    const claim = key === null ? undefined : { key, digest: requestDigest }
    if (decision.result === 'approval') {
      await startPending(rt, row, principal, evidence, claim); owned = key !== null
      result = await openApproval(rt, { decision_id: row.id, revision: state.revision, tool: name, args, digest: requestDigest, key,
        classes, principal, summary: savedSummary, summary_sha256, approvers: decision.approvers!, expires_at: new Date(rt.now() + durationSeconds(decision.wait)! * 1000).toISOString(), door, evidence,
        result, ...(expected === undefined ? {} : { expected_revision: expected as number }) })
      effected = true
      await saveCall(rt, principal, key, result)
      await appendEvents(rt, [{ type: 'approval.pending', uri: result.approval!.url, actor: { kind: 'agent', ...preparedBy(principal) }, data: { decision_id: row.id, classes } }])
    } else {
      // Once execution begins, retain the claim even on an unexpected failure:
      // an action may already have committed and must never be executed twice.
      if (!await startExecution(rt, row, principal, classes, state, evidence, claim)) return refuse('decision_busy')
      owned = key !== null
      await releaseDecision(rt, row.id); locked = false
      effected = true
      const run = await runTool(rt, tool, args, principal, result, door)
      result = run.result
      if (result.outcome === 'done' && decision.result === 'review') result.review = await openReview(rt, name, principal, row.id, evidence, run.undo, door, savedSummary)
      if (result.code && result.code !== 'output_invalid') effected = false
      if (effected) await saveCall(rt, principal, key, result)
      await appendEvents(rt, run.effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(principal) } })))
    }
    return { result }
  } catch (cause) {
    if (cause instanceof ToolRefusal) return refuse(cause.code, cause.details)
    row.outcome = 'failed'; status = 500
    const failed = refuse('execution_failed')
    if (owned && effected) await saveCall(rt, principal, row.idempotency_key, result)
    return failed
  } finally {
    if (locked) await releaseDecision(rt, row.id)
    if (owned && !effected) await rt.options.db.prepare('DELETE FROM agent_door_calls WHERE agent=? AND key=? AND decision_id=?').bind(principal.agent.id, row.idempotency_key, row.id).run()
    if (row.outcome === 'running') row.outcome = result.outcome
    outcomeRow(row, result)
    await audit(rt, row, evidence)
  }
}
