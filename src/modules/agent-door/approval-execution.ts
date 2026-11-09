import { retire } from './retired-refs.ts'
import { REPLAY_WINDOW_MS } from './erasure.ts'
import type { SavedApproval, ApprovalMark } from './approvals.ts'
import type { Runtime } from './types.ts'
import { audit, newAudit, recordDecision, outcomeRow, usage, usageToday } from './audit.ts'
import { classify, context, livePrincipal, runTool, sameFacts, digest, selfEscalation, summary, revoked, type Effect } from './execution.ts'
import { appendEvents } from './events.ts'
import { matchingRefs, preparedBy } from './people.ts'
import { acquireDecision, releaseDecision, startExecution } from './counting.ts'
import { decide } from './policy/decide.ts'
import { companyDecision, restrictDecision } from './company-policy.ts'
import { ToolRefusal } from './errors.ts'
import { canonical } from './policy/document.ts'
import { policyRefusal, policyState } from './policy-store.ts'
import { savedTool } from './resource-tool.ts'
import { nativeTarget } from './target.ts'
import { savedPrincipal } from './principal.ts'

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
    let principal = await livePrincipal(rt, savedPrincipal({ ...saved.principal, operationId: saved.principal.operationId ?? saved.decision_id, idempotencyKey: saved.key }, saved.door)), state = await policyState(rt)
    const tool = savedTool(rt, saved.tool, saved.args), scopes = principal?.scopes ?? []
    if (tool?.authority === 'none') row.authority = 'none'
    const refusal = policyRefusal(rt, state, tool?.classes)
    if (saved.principal.consent && state.revoked.consents.includes(saved.principal.consent)) result = { ...result, outcome: 'refused', code: 'consent_revoked' }
    else if (!principal || !tool) result = { ...result, outcome: 'refused', code: 'sponsor_unavailable' }
    else if (saved.principal.scopes.some(scope => !scopes.includes(scope)) || tool.scope && !principal.scopes.includes(tool.scope)) result = { ...result, outcome: 'refused', code: 'insufficient_scope' }
    else if (refusal) result = { ...result, outcome: 'refused', ...refusal }
    else if (state.revision !== saved.revision) result = { ...result, outcome: 'refused', code: 'approval_evidence_changed' }
    else {
      for (const mark of approvals) {
        const person = await rt.options.people.person(mark.person)
        if (!person?.active || !(await matchingRefs(rt, person, principal.person.id, [mark.ref])).length) throw new Error('approval_evidence_changed')
        if (!approvers.some(item => item.id === person.id)) approvers.push({ id: person.id, name: person.name })
      }
      let ctx = context(rt, principal, saved.door, [], approvers)
      const target = await nativeTarget(tool, saved.args, ctx)
      if (saved.tool !== 'resources/read') row.resource = target
      const authority = typeof tool.authority === 'function' ? await tool.authority(saved.args, ctx) : null
      const currentRevision = tool.revision && saved.expected_revision !== undefined ? await tool.revision(saved.args, ctx) : undefined
      if (tool.widens === false && authority?.widens) result = { ...result, outcome: 'refused', code: 'narrowing_contract_violation' }
      else if (selfEscalation(authority, principal)) result = { ...result, outcome: 'refused', code: 'self_escalation' }
      else if (tool.revision && saved.expected_revision !== undefined && currentRevision !== saved.expected_revision) result = { ...result, outcome: 'refused', code: 'revision_conflict', fields: { current_revision: currentRevision } }
      else {
        let classes = await classify(tool, saved.args, ctx)
        row.classes = classes
        const admission = await acquireDecision(rt, row.id)
        locked = !!admission
        if (!locked) throw new Error('decision_busy')
        if (admission === 'waited') {
          const current = await livePrincipal(rt, principal)
          state = await policyState(rt)
          if (principal.consent && state.revoked.consents.includes(principal.consent)) throw new ToolRefusal('consent_revoked')
          if (!current || revoked(state, principal)) throw new ToolRefusal('sponsor_unavailable')
          const agent = await rt.options.db.prepare('SELECT revoked,sponsor FROM agent_door_agents WHERE id=?').bind(principal.agent.id).first<{ revoked: number; sponsor: string }>()
          if (agent?.revoked || agent && agent.sponsor !== principal.person.id) throw new ToolRefusal('sponsor_unavailable')
          if (saved.principal.scopes.some(scope => !current.scopes.includes(scope)) || tool.scope && !current.scopes.includes(tool.scope)) throw new ToolRefusal('insufficient_scope')
          const refusal = policyRefusal(rt, state, tool.classes)
          if (refusal) throw new ToolRefusal(refusal.code, undefined, refusal.fields)
          if (state.revision !== saved.revision) throw new ToolRefusal('approval_evidence_changed')
          if (rt.now() >= Date.parse(saved.expires_at)) throw new ToolRefusal('approval_expired')
          principal = current
          approvers.length = 0
          for (const mark of approvals) {
            const person = await rt.options.people.person(mark.person)
            if (!person?.active || !(await matchingRefs(rt, person, principal.person.id, [mark.ref])).length) throw new ToolRefusal('approval_evidence_changed')
            if (!approvers.some(item => item.id === person.id)) approvers.push({ id: person.id, name: person.name })
          }
          ctx = context(rt, principal, saved.door, [], approvers)
          const authority = typeof tool.authority === 'function' ? await tool.authority(saved.args, ctx) : null
          if (tool.widens === false && authority?.widens) throw new ToolRefusal('narrowing_contract_violation')
          if (selfEscalation(authority, principal)) throw new ToolRefusal('self_escalation')
          if (tool.revision && saved.expected_revision !== undefined) {
            const current = await tool.revision(saved.args, ctx)
            if (current !== saved.expected_revision) throw new ToolRefusal('revision_conflict', undefined, { current_revision: current })
          }
          classes = await classify(tool, saved.args, ctx)
          row.classes = classes
        }
        const sums = await usage(rt, state.document!, principal)
        let fresh = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes }, usageToday: usageToday(sums) })
        const company = fresh.result === 'blocked' || fresh.result === 'unset' ? undefined : await companyDecision(rt, saved.tool, saved.args, classes, target, fresh, ctx)
        fresh = restrictDecision(fresh, company)
        evidence = { document: state.document!, usage: sums, classes, result: fresh.result, rules: fresh.classes, ...(company ? { company_policy: company } : {}) }
        result.decision = { ...(company ? { company_policy: company } : {}), id: saved.decision_id, disposition: fresh.result, revision: state.revision, classes: fresh.classes.map(item => ({ ...item, facts: classes.find(value => value.class === item.class)!.facts })) }
        recordDecision(row, result.decision)
        if (!sameFacts(saved.classes, classes) || await digest({ ...await summary(tool, saved.args, ctx, target), ...(company ? { company_policy: company } : {}) }) !== saved.summary_sha256 || canonical(fresh.classes) !== canonical(saved.evidence.rules) || canonical(company ?? null) !== canonical(saved.evidence.company_policy ?? null) || fresh.result !== 'approval') throw new Error('approval_evidence_changed')
        row.approval = { id, by }
        if (!await startExecution(rt, row, principal, classes, state, evidence)) throw new Error(principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent) ? 'consent_revoked' : 'decision_busy')
        await releaseDecision(rt, row.id); locked = false
        const run = await runTool(rt, tool, saved.args, principal, result, saved.door, approvers, row.id)
        result = run.result; effects = run.effects
      }
    }
  } catch (cause) {
    if (cause instanceof ToolRefusal && locked) result.fields = cause.details
    result = { ...result, outcome: 'refused', code: cause instanceof ToolRefusal && (locked || rt.options.companyPolicy && ['company_policy_invalid', 'company_policy_unavailable'].includes(cause.code)) ? cause.code : cause instanceof Error && ['decision_busy', 'approval_evidence_changed', 'consent_revoked'].includes(cause.message) ? cause.message : 'execution_failed' }
  } finally { if (locked) await releaseDecision(rt, row.id) }
  if (result.outcome === 'done') result.receipt = { id: crypto.randomUUID(), decision_id: saved.decision_id, approval_id: id, prepared_by: preparedBy(saved.principal), approved_by: by }
  result.execution_id = row.id
  const state = result.outcome === 'done' ? 'executed' : 'refused'
  const stored = await retire(rt.options.db, result)
  // Keep the recorded outcome durable before attempting the final audit write.
  await rt.options.db.batch([
    rt.options.db.prepare(`UPDATE agent_door_approvals SET state=?,result=${stored.sql} WHERE id=? AND json_extract(saved,'$.tombstone') IS NULL`).bind(state, stored.value, id),
    ...(saved.key === null ? [] : [rt.options.db.prepare(`UPDATE agent_door_calls SET state=?,outcome=${stored.sql},expires_at=coalesce(expires_at,?) WHERE agent=? AND key=?`).bind(result.outcome, stored.value, rt.now() + REPLAY_WINDOW_MS, saved.principal.agent.id, saved.claimKey ?? saved.key)]),
  ])
  if (row.outcome === 'running') row.outcome = result.outcome
  outcomeRow(row, result); row.approval = { id, by }
  await audit(rt, row, evidence)
  await appendEvents(rt, effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(saved.principal) } })), row.id)
  return { state, code: result.code }
}
