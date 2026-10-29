import type { SavedApproval, ApprovalMark } from './approvals.ts'
import type { Runtime } from './types.ts'
import { audit, newAudit, recordDecision, outcomeRow, usage, usageToday } from './audit.ts'
import { classify, context, livePrincipal, runTool, sameFacts, digest, selfEscalation, summary, type Effect } from './execution.ts'
import { appendEvents } from './events.ts'
import { matchingRefs, preparedBy } from './people.ts'
import { acquireDecision, releaseDecision, startExecution } from './counting.ts'
import { decide } from './policy/decide.ts'
import { canonical } from './policy/document.ts'
import { policyRefusal, policyState } from './policy-store.ts'
import { savedTool } from './resource-tool.ts'
import { nativeTarget } from './target.ts'

/** This person request executes once and has an audit separate from the held call. */
export async function executeApproval(rt: Runtime, id: string, saved: SavedApproval, approvals: ApprovalMark[]) {
  const row = newAudit(rt, saved.principal, saved.tool, saved.door, null)
  row.decision_id = saved.decision_id
  row.operation_id = saved.principal.operationId ?? saved.decision_id
  row.idempotency_key = saved.key
  if (saved.tool === 'resources/read') row.resource = String(saved.args.uri)
  else row.resource = saved.summary.nativeTarget ?? null
  let result = { ...saved.result }, locked = false, effects: Effect[] = [], evidence = saved.evidence
  const by = [...new Set(approvals.map(mark => mark.person))]
  const approvers: Array<{ id: string; name: string }> = []
  try {
    const principal = await livePrincipal(rt, { ...saved.principal, operationId: saved.principal.operationId ?? saved.decision_id, idempotencyKey: saved.key }), state = await policyState(rt), tool = savedTool(rt, saved.tool, saved.args)
    if (tool?.authority === 'none') row.authority = 'none'
    const refusal = policyRefusal(rt, state, tool?.classes)
    if (saved.principal.consent && state.revoked.consents.includes(saved.principal.consent)) result = { ...result, outcome: 'refused', code: 'consent_revoked' }
    else if (!principal || !tool) result = { ...result, outcome: 'refused', code: 'sponsor_unavailable' }
    else if (saved.principal.scopes.some(scope => !principal.scopes.includes(scope)) || tool.scope && !principal.scopes.includes(tool.scope)) result = { ...result, outcome: 'refused', code: 'insufficient_scope' }
    else if (refusal) result = { ...result, outcome: 'refused', ...refusal }
    else if (state.revision !== saved.revision) result = { ...result, outcome: 'refused', code: 'approval_evidence_changed' }
    else {
      for (const mark of approvals) {
        const person = await rt.options.people.person(mark.person)
        if (!person?.active || !(await matchingRefs(rt, person, principal.person.id, [mark.ref])).length) throw new Error('approval_evidence_changed')
        if (!approvers.some(item => item.id === person.id)) approvers.push({ id: person.id, name: person.name })
      }
      const ctx = context(rt, principal, saved.door, [], approvers)
      const target = await nativeTarget(tool, saved.args, ctx)
      if (saved.tool !== 'resources/read') row.resource = target
      const authority = typeof tool.authority === 'function' ? await tool.authority(saved.args, ctx) : null
      const currentRevision = tool.revision && saved.expected_revision !== undefined ? await tool.revision(saved.args, ctx) : undefined
      if (tool.widens === false && authority?.widens) result = { ...result, outcome: 'refused', code: 'narrowing_contract_violation' }
      else if (selfEscalation(authority, principal)) result = { ...result, outcome: 'refused', code: 'self_escalation' }
      else if (tool.revision && saved.expected_revision !== undefined && currentRevision !== saved.expected_revision) result = { ...result, outcome: 'refused', code: 'revision_conflict', fields: { current_revision: currentRevision } }
      else {
        const classes = await classify(tool, saved.args, ctx)
        row.classes = classes
        locked = await acquireDecision(rt, row.id)
        if (!locked) throw new Error('decision_busy')
        const sums = await usage(rt, state.document!, principal)
        const fresh = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes }, usageToday: usageToday(sums) })
        evidence = { document: state.document!, usage: sums, classes, result: fresh.result, rules: fresh.classes }
        result.decision = { id: saved.decision_id, disposition: fresh.result, revision: state.revision, classes: fresh.classes.map(item => ({ ...item, facts: classes.find(value => value.class === item.class)!.facts })) }
        recordDecision(row, result.decision)
        if (!sameFacts(saved.classes, classes) || await digest(await summary(tool, saved.args, ctx, target)) !== saved.summary_sha256 || canonical(fresh.classes) !== canonical(saved.evidence.rules)) throw new Error('approval_evidence_changed')
        row.approval = { id, by }
        if (!await startExecution(rt, row, principal, classes, state, evidence)) throw new Error(principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent) ? 'consent_revoked' : 'decision_busy')
        await releaseDecision(rt, row.id); locked = false
        const run = await runTool(rt, tool, saved.args, principal, result, saved.door, approvers, row.id)
        result = run.result; effects = run.effects
      }
    }
  } catch (cause) {
    result = { ...result, outcome: 'refused', code: cause instanceof Error && ['decision_busy', 'approval_evidence_changed', 'consent_revoked'].includes(cause.message) ? cause.message : 'execution_failed' }
  } finally { if (locked) await releaseDecision(rt, row.id) }
  if (result.outcome === 'done') result.receipt = { id: crypto.randomUUID(), decision_id: saved.decision_id, approval_id: id, prepared_by: preparedBy(saved.principal), approved_by: by }
  result.execution_id = row.id
  const state = result.outcome === 'done' ? 'executed' : 'refused'
  // Keep the recorded outcome durable before attempting the final audit write.
  await rt.options.db.batch([
    rt.options.db.prepare('UPDATE agent_door_approvals SET state=?,result=? WHERE id=?').bind(state, JSON.stringify(result), id),
    ...(saved.key === null ? [] : [rt.options.db.prepare('UPDATE agent_door_calls SET state=?,outcome=? WHERE agent=? AND key=?').bind(result.outcome, JSON.stringify(result), saved.principal.agent.id, saved.claimKey ?? saved.key)]),
  ])
  if (row.outcome === 'running') row.outcome = result.outcome
  outcomeRow(row, result); row.approval = { id, by }
  await audit(rt, row, evidence)
  await appendEvents(rt, effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(saved.principal) } })))
  return { state, code: result.code }
}
