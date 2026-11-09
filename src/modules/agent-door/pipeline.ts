import { captureFence, erasedReplay, erasedResult, expireReplayCalls } from './erasure.ts'
import { offers } from './capabilities.mjs'
import type { CallResult, DecisionMeta, Principal, Runtime, ToolContext } from './types.ts'
import { audit, newAudit, recordDecision, outcomeRow, recoverAudit, usage, usageToday, type Evidence, type AuditRow } from './audit.ts'
import { policyRefusal, policyState, setupUrl } from './policy-store.ts'
import { classify, context, digest, runTool, saveCall, selfEscalation, summary, revoked, livePrincipal } from './execution.ts'
import { decide } from './policy/decide.ts'
import { companyDecision, restrictDecision } from './company-policy.ts'
import { canonical } from './policy/document.ts'
import { durationSeconds } from './policy/document.ts'
import { validateSchema } from './json-schema.ts'
import { ToolRefusal } from './errors.ts'
import { openApproval, approvalReplay } from './approvals.ts'
import { openReview } from './reviews.ts'
import { appendEvents } from './events.ts'
import { acquireDecision, releaseDecision, startExecution, startPending } from './counting.ts'
import { preparedBy } from './people.ts'
import type { ToolDefinition } from './types.ts'
import { nativeTarget } from './target.ts'
import { nativeProof } from './native-proof.ts'
import { narrowPrincipal } from './principal.ts'
import { continuationItem, operationKey, resumeOperation, UnfinishedOperation } from './operation.ts'
import { auditUnfinishedContinuation } from './continuation-audit.ts'

export interface PipelineAnswer { result: CallResult; status?: number; scope?: string }
export async function callTool(rt: Runtime, name: string, input: unknown, principal: Principal, door: ToolContext['door'], trace?: unknown, resourceTool?: ToolDefinition, requestState?: unknown, proofReference?: unknown, operationId?: string): Promise<PipelineAnswer> {
  await expireReplayCalls(rt)
  const row = newAudit(rt, principal, name, door, trace)
  if (operationId !== undefined) row.operation_id = operationId
  if (name === 'resources/read') row.resource = String((input as { uri: string }).uri)
  let claimKey: string | null = null
  let evidence: Evidence | undefined, owned = false, effected = false, locked = false, recoveredNative = false, recoverableExecution = false, privateRefusal = false
  let result: CallResult = { outcome: 'refused', decision: null }, status: number | undefined, scope: string | undefined
  const refuse = (code: string, fields?: Record<string, unknown>) => { result = { ...result, outcome: 'refused', code, fields }; return { result, status, scope } }
  try {
    const optional = name === `${rt.options.seed}.events.list` ? 'events' : name === 'resources/read' ? 'resources' : null
    if (optional && !offers(rt.options.capabilities, optional)) return refuse('capability_not_declared', { capability: optional })
    const tool = resourceTool ?? rt.tools.find(tool => tool.name === name && (door !== 'mcp' || tool.exposure !== 'invoke'))
    if (!tool) { status = 400; return refuse('tool_not_found') }
    if (tool.authority === 'none') row.authority = 'none'
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
    const properties = tool.inputSchema.properties ?? {}
    const declared = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => Object.hasOwn(properties, key)))
    row.ignored_arguments = Object.keys(raw ?? {}).filter(key => !Object.hasOwn(properties, key)).sort()
    const key = !tool.readOnly && typeof raw?.idempotency_key === 'string' && raw.idempotency_key.length > 0 && raw.idempotency_key.length <= 200 && !raw.idempotency_key.includes('\0') ? raw.idempotency_key : null
    if (key !== null) {
      const erased = await erasedReplay(rt, principal.agent.id, key, operationId)
      if (erased) {
        privateRefusal = true
        const current = await narrowPrincipal(rt, principal), state = await policyState(rt)
        if (tool.scope && !current.scopes.includes(tool.scope)) { status = 403; scope = tool.scope; return refuse('insufficient_scope') }
        const agent = await rt.options.db.prepare('SELECT revoked,sponsor FROM agent_door_agents WHERE id=?').bind(principal.agent.id).first<{ revoked: number; sponsor: string }>()
        if (revoked(state, principal) || agent?.revoked || agent && agent.sponsor !== current.person.id) { status = 401; return refuse('unauthenticated') }
        const refusal = policyRefusal(rt, state, tool.classes)
        if (refusal) return refuse(refusal.code, refusal.fields)
        return { result: erased }
      }
    }
    try { await captureFence(rt, name, declared, context(rt, principal, door, [])) }
    catch (cause) {
      if (cause instanceof ToolRefusal && cause.code === 'subject_erasure_in_progress') {
        privateRefusal = true; status = 409; return refuse(cause.code)
      }
      throw cause
    }
    row.idempotency_key = key
    let operation: Awaited<ReturnType<typeof resumeOperation>> | undefined
    try { operation = operationId === undefined ? undefined : await resumeOperation(rt, operationId, principal, key) }
    catch (cause) {
      if (cause instanceof UnfinishedOperation) evidence = await auditUnfinishedContinuation(rt, row, tool, declared, principal, door)
      throw cause
    }
    const approvers = operation?.approvers ?? []
    principal = operation?.principal ?? principal
    const current = await narrowPrincipal(rt, principal)
    if (operationId !== undefined && principal.scopes.some(scope => !current.scopes.includes(scope))) return refuse('insufficient_scope')
    principal = { ...current, operationId: row.operation_id, idempotencyKey: key }
    row.scopes = [...principal.scopes]
    if (tool.scope && !principal.scopes.includes(tool.scope)) { status = 403; scope = tool.scope; return refuse('insufficient_scope') }
    let state = await policyState(rt)
    row.revision = state.revision
    if (principal.consent && state.revoked.consents.includes(principal.consent)) { if (door === 'mcp') { status = 401; return refuse('unauthenticated') }; return refuse('consent_revoked') }
    const agent = await rt.options.db.prepare('SELECT revoked,sponsor FROM agent_door_agents WHERE id=?').bind(principal.agent.id).first<{ revoked: number; sponsor: string }>()
    if (revoked(state, principal) || agent?.revoked || agent && agent.sponsor !== principal.person.id) { status = 401; return refuse('unauthenticated') }
    const { idempotency_key: _key, expected_revision: expected, ...args } = declared
    const validInput = raw && validateSchema(tool.inputSchema, declared)
    const refusal = policyRefusal(rt, state, tool.classes)
    if (refusal) {
      const ctx = context(rt, principal, door, [], approvers)
      const disposition = { agents_paused: 'paused', policy_unset: 'unset', policy_unavailable: 'unavailable' }[refusal.code] ?? 'none'
      let classes: Awaited<ReturnType<typeof classify>> = []
      if (validInput) try {
        const target = await nativeTarget(tool, args, ctx)
        if (name !== 'resources/read') row.resource = target
        classes = await classify(tool, args, ctx)
      } catch (cause) {
        if (!(cause instanceof ToolRefusal)) throw cause
        row.classification_refusal = cause.code
      }
      result.decision = { id: row.id, disposition, revision: state.revision, classes: classes.map(item => ({ ...item, rule: null, do: disposition })) }
      return refuse(refusal.code, refusal.fields)
    }
    if (tool.continuationItem && (!raw || !validateSchema(tool.inputSchema, declared))) return refuse('invalid_arguments')
    const item = await continuationItem(tool, args, context(rt, principal, door, [], approvers), operationId)
    principal = { ...principal, continuationItemId: item }
    if (item !== undefined) row.continuation_item_id = item
    claimKey = key === null ? null : operationId === undefined ? key : operationKey(operationId, name, key, item)
    let ctx = context(rt, principal, door, [], approvers)
    if (!tool.readOnly && !key) return refuse('idempotency_key_required')
    if (tool.widens === false && row.ignored_arguments.length) return refuse('invalid_arguments')
    if (tool.authority === 'none' && row.ignored_arguments.length) return refuse('undeclared_arguments')
    let previous: { outcome: string | null; decision_id: string } | undefined
    const requestDigest = await digest({ name, arguments: declared, ...(principal.clientId === undefined ? {} : { client_id: principal.clientId }) })
    if (tool.readOnly && requestState !== undefined) {
      if (typeof requestState !== 'string') return refuse('invalid_arguments')
      const pending = await rt.options.db.prepare("SELECT saved FROM agent_door_approvals WHERE json_extract(saved,'$.result.requestState')=?").bind(requestState).first<{ saved: string }>()
      const saved = pending ? JSON.parse(pending.saved) : null
      if (!saved || saved.principal.person.id !== principal.person.id || saved.principal.agent.id !== principal.agent.id || saved.tool !== name || saved.digest !== requestDigest) return refuse('invalid_arguments')
      previous = { outcome: JSON.stringify(saved.result), decision_id: saved.decision_id }
    }
    if (key !== null) {
      const saved = await rt.options.db.prepare('SELECT digest,outcome,decision_id FROM agent_door_calls WHERE agent=? AND key=?').bind(principal.agent.id, claimKey).first<{ digest: string; outcome: string | null; decision_id: string }>()
      if (saved) {
        if (saved.digest !== requestDigest) return refuse('idempotency_conflict')
        if (tool.recover) {
          const origin = await rt.options.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(saved.decision_id).first<{ row: string }>()
          if (!origin) return refuse('call_in_progress')
          const bound: AuditRow = JSON.parse(origin.row)
          if (bound.agent.id !== principal.agent.id || bound.sponsor.id !== principal.person.id
            || bound.consent !== (principal.consent ?? null) || bound.client_id !== (principal.clientId ?? null)) return refuse('idempotency_conflict')
        }
        if (!saved.outcome) {
          const recovered = await tool.recover?.(args, ctx, { decisionId: saved.decision_id, requestDigest })
          if (!recovered || recovered.outcome !== 'done' || !validateSchema(tool.outputSchema, recovered.result)) return refuse('call_in_progress')
          previous = { ...saved, outcome: JSON.stringify(recovered) }; recoveredNative = true
        } else previous = saved
      }
    }
    if (!raw || !validateSchema(tool.inputSchema, declared)) return refuse('invalid_arguments')
    const cached = previous?.outcome ? await approvalReplay(rt, JSON.parse(previous.outcome)) : undefined
    // Completed mutations retain their effect evidence after preparation is
    // consumed. Native classification must still admit the current sponsor.
    const completed = !tool.readOnly && cached?.outcome === 'done'
    let original: AuditRow | undefined
    if (completed) {
      const saved = await rt.options.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(previous!.decision_id).first<{ row: string }>()
      if (!saved) throw new Error('audit_missing')
      original = JSON.parse(saved.row)
    }
    const target = completed ? null : await nativeTarget(tool, args, ctx)
    if (name !== 'resources/read') row.resource = original?.resource ?? target
    if (!previous && tool.revision && expected !== undefined) {
      const current = await tool.revision(args, ctx)
      if (expected !== current) return refuse('revision_conflict', { current_revision: current })
    }
    const authority = !completed && typeof tool.authority === 'function' ? await tool.authority(args, ctx) : null
    if (tool.widens === false && authority?.widens) return refuse('narrowing_contract_violation')
    if (selfEscalation(authority, principal)) {
      result.decision = { id: row.id, disposition: 'self_escalation', revision: state.revision, classes: [] }
      return refuse('self_escalation')
    }
    const currentClasses = await classify(tool, args, ctx, original?.classes)
    let classes = original?.classes ?? currentClasses
    // Retain native classification even when policy admission is busy.
    row.classes = classes
    const admission = await acquireDecision(rt, row.id)
    locked = !!admission
    if (!locked) return refuse('decision_busy')
    if (admission === 'waited') {
      // Keep the early refusal/target order above. Waiting has acquired nothing
      // until now: refresh admission evidence, without replaying native targets,
      // continuation resolvers, or an action that may already have committed.
      const current = await livePrincipal(rt, principal)
      state = await policyState(rt)
      row.revision = state.revision
      if (principal.consent && state.revoked.consents.includes(principal.consent)) {
        if (door === 'mcp') { status = 401; return refuse('unauthenticated') }
        return refuse('consent_revoked')
      }
      const agent = await rt.options.db.prepare('SELECT revoked,sponsor FROM agent_door_agents WHERE id=?').bind(principal.agent.id).first<{ revoked: number; sponsor: string }>()
      if (revoked(state, principal) || agent?.revoked || agent && agent.sponsor !== principal.person.id) { status = 401; return refuse('unauthenticated') }
      if (!current) return refuse('sponsor_unavailable')
      if (operationId !== undefined && principal.scopes.some(scope => !current.scopes.includes(scope))) return refuse('insufficient_scope')
      principal = current
      row.scopes = [...principal.scopes]
      if (tool.scope && !principal.scopes.includes(tool.scope)) { status = 403; scope = tool.scope; return refuse('insufficient_scope') }
      const refusal = policyRefusal(rt, state, tool.classes)
      if (refusal) return refuse(refusal.code, refusal.fields)
      ctx = context(rt, principal, door, [], approvers)
      if (!previous && tool.revision && expected !== undefined) {
        const current = await tool.revision(args, ctx)
        if (expected !== current) return refuse('revision_conflict', { current_revision: current })
      }
      const authority = !completed && typeof tool.authority === 'function' ? await tool.authority(args, ctx) : null
      if (tool.widens === false && authority?.widens) return refuse('narrowing_contract_violation')
      if (selfEscalation(authority, principal)) return refuse('self_escalation')
      const currentClasses = await classify(tool, args, ctx, original?.classes)
      classes = original?.classes ?? currentClasses
      if (key !== null && !previous) {
        const claimed = await rt.options.db.prepare('SELECT digest FROM agent_door_calls WHERE agent=? AND key=?').bind(principal.agent.id, claimKey).first<{ digest: string }>()
        if (claimed) return refuse(claimed.digest === requestDigest ? 'call_in_progress' : 'idempotency_conflict')
      }
    }
    const sums = await usage(rt, state.document!, principal)
    let decision = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: principal.agent.specialist ?? null, agent: principal.agent.id, classes }, usageToday: usageToday(sums) })
    const meta: DecisionMeta = { id: row.id, disposition: decision.result, revision: state.revision,
      classes: decision.classes.map(item => ({ ...item, facts: classes.find(value => value.class === item.class)!.facts })) }
    result.decision = meta
    evidence = { document: state.document!, usage: sums, classes, result: decision.result, rules: decision.classes }
    if (decision.result === 'unset') return refuse('policy_unset', { unanswered: decision.unset, setup_url: setupUrl(rt, state) })
    if (decision.result === 'blocked') return refuse('policy_blocked', { class: decision.deciding!.class, rule: decision.deciding!.rule, revision: state.revision })
    const company = await companyDecision(rt, name, args, classes, typeof row.resource === 'object' ? row.resource : null, decision, ctx)
    if (company) {
      decision = restrictDecision(decision, company)
      meta.company_policy = company; meta.disposition = decision.result
      evidence.company_policy = company; evidence.result = decision.result
      if (company.decision === 'deny') return refuse('company_policy_denied', { rule: company.rule, revision: company.revision })
    }
    principal = await nativeProof(rt, tool, args, principal, proofReference)
    if (previous?.outcome && cached) {
      // A newly required review or approval cannot be satisfied by an older receipt.
      if (decision.result === 'approval' && (cached.decision?.disposition !== 'approval' || cached.decision.revision !== state.revision || canonical(cached.decision.company_policy ?? null) !== canonical(company ?? null))) return refuse('approval_required')
      if (decision.result === 'review' && cached.decision?.disposition !== 'review') return refuse('review_required')
      if (cached.outcome === 'done' && cached.receipt) cached.receipt = { ...cached.receipt, decision: cached.decision,
        ...(cached.review ? { review: cached.review } : {}) }
      if (!tool.readOnly && key !== null) await rt.options.db.prepare(`UPDATE agent_door_calls SET state='done',outcome=?
        WHERE agent=? AND key=? AND decision_id=? AND digest=? AND outcome IS NULL`)
        .bind(previous.outcome, principal.agent.id, claimKey, previous.decision_id, requestDigest).run()
      await recoverAudit(rt, previous.decision_id, JSON.parse(previous.outcome), recoveredNative)
      const original = await rt.options.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(previous.decision_id).first<{ row: string }>()
      row.operation_id = original ? JSON.parse(original.row).operation_id ?? previous.decision_id : previous.decision_id
      if (tool.readOnly && cached.outcome === 'done') {
        // Aggregate visibility can live inside the native read rather than its
        // target/classifier. A retained approval cannot authorize old rows.
        // Start without cached content so a native refusal cannot expose it.
        const readApprovers = []
        for (const id of cached.receipt?.approved_by as string[] ?? []) {
          const person = await rt.options.people.person(id)
          if (!person?.active) return refuse('sponsor_unavailable')
          readApprovers.push({ id: person.id, name: person.name })
        }
        await releaseDecision(rt, row.id); locked = false
        const fresh = await runTool(rt, tool, args, { ...principal, operationId: row.operation_id }, { outcome: 'refused', decision: meta }, door, readApprovers, row.id)
        if (fresh.result.outcome !== 'done') { result = fresh.result; return { result } }
        result = { ...cached, ...fresh.result }
      } else result = { ...cached, decision: { ...meta, id: row.id } }
      row.replay_of = previous.decision_id; row.outcome = 'replayed'
      return { result }
    }
    const savedSummary = { ...await summary(tool, args, ctx, target), ...(company ? { company_policy: company } : {}) }
    const summary_sha256 = await digest(savedSummary)
    recordDecision(row, meta)
    const claim = claimKey === null ? undefined : { key: claimKey, digest: requestDigest }
    if (principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent)) return refuse('consent_revoked')
    if (decision.result === 'approval') {
      if (!await startPending(rt, row, principal, evidence, claim)) return refuse('subject_erased')
      owned = key !== null
      result = await openApproval(rt, { decision_id: row.id, revision: state.revision, tool: name, args, digest: requestDigest, key, claimKey,
        classes, principal, summary: savedSummary, summary_sha256, approvers: decision.approvers!, expires_at: new Date(rt.now() + durationSeconds(decision.wait)! * 1000).toISOString(), door, evidence,
        result, ...(expected === undefined ? {} : { expected_revision: expected as string | number }) })
      if (result.outcome !== 'pending') return { result }
      effected = true
      await saveCall(rt, principal, claimKey, result)
      await appendEvents(rt, [{ type: 'approval.pending', uri: result.approval!.url, actor: { kind: 'agent', ...preparedBy(principal) }, data: { decision_id: row.id, classes } }], row.id)
    } else {
      // Once execution begins, retain the claim even on an unexpected failure:
      // an action may already have committed and must never be executed twice.
      if (!await startExecution(rt, row, principal, classes, state, evidence, claim)) return refuse(principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent) ? 'consent_revoked' : 'decision_busy')
      owned = key !== null
      await releaseDecision(rt, row.id); locked = false
      effected = true
      recoverableExecution = !!tool.recover && decision.result === 'autonomous'
      const run = await runTool(rt, tool, args, principal, result, door, approvers)
      result = run.result
      if (result.outcome === 'done' && decision.result === 'review') result.review = await openReview(rt, name, principal, row.id, evidence, run.undo, door, savedSummary)
      if (result.code && result.code !== 'output_invalid') effected = false
      if (effected) await saveCall(rt, principal, claimKey, result)
      await appendEvents(rt, run.effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(principal) } })), row.id)
    }
    return { result }
  } catch (cause) {
    if (cause instanceof ToolRefusal) return refuse(cause.code, cause.details)
    row.outcome = 'failed'; status = 500
    const failed = refuse('execution_failed')
    // An inert native effect may already have committed its frozen success.
    // Leave its claim uncertain for evidence-only recovery; a catch-path refusal
    // must never replace that success when outcome storage briefly recovers.
    if (owned && effected && !recoverableExecution) await saveCall(rt, principal, claimKey, result)
    return failed
  } finally {
    if (locked) await releaseDecision(rt, row.id)
    if (owned && !effected) await rt.options.db.prepare('DELETE FROM agent_door_calls WHERE agent=? AND key=? AND decision_id=?').bind(principal.agent.id, claimKey, row.id).run()
    if (rt.options.erasure && !privateRefusal) {
      const erased = await rt.options.db.prepare("SELECT json_extract(row,'$.tombstone') AS tombstone FROM agent_door_audit WHERE id IN (?,?,?) AND json_extract(row,'$.tombstone') IS NOT NULL").bind(row.id, row.operation_id, row.decision_id).first<{ tombstone: string | null }>()
      if (erased?.tombstone) {
        const replacement = erasedResult(JSON.parse(erased.tombstone))
        for (const key of Object.keys(result)) delete (result as unknown as Record<string, unknown>)[key]
        Object.assign(result, replacement)
      }
    }
    if (row.outcome === 'running') row.outcome = result.outcome
    outcomeRow(row, result)
    if (!privateRefusal) await audit(rt, row, evidence)
  }
}
