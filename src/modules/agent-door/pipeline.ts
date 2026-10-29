import { offers } from './capabilities.mjs'
import type { CallResult, DecisionMeta, Principal, Runtime, ToolContext } from './types.ts'
import { audit, newAudit, recordDecision, outcomeRow, recoverAudit, usage, usageToday, type Evidence, type AuditRow } from './audit.ts'
import { policyRefusal, policyState, setupUrl } from './policy-store.ts'
import { classify, context, digest, runTool, saveCall, selfEscalation, summary, revoked } from './execution.ts'
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
import { nativeTarget } from './target.ts'
import { nativeProof } from './native-proof.ts'
import { narrowPrincipal } from './principal.ts'
import { continuationItem, operationKey, resumeOperation } from './operation.ts'

export interface PipelineAnswer { result: CallResult; status?: number; scope?: string }
export async function callTool(rt: Runtime, name: string, input: unknown, principal: Principal, door: ToolContext['door'], trace?: unknown, resourceTool?: ToolDefinition, requestState?: unknown, proofReference?: unknown, operationId?: string): Promise<PipelineAnswer> {
  const row = newAudit(rt, principal, name, door, trace)
  if (operationId !== undefined) row.operation_id = operationId
  if (name === 'resources/read') row.resource = String((input as { uri: string }).uri)
  let claimKey: string | null = null
  let evidence: Evidence | undefined, owned = false, effected = false, locked = false
  let result: CallResult = { outcome: 'refused', decision: null }, status: number | undefined, scope: string | undefined
  const refuse = (code: string, fields?: Record<string, unknown>) => { result = { ...result, outcome: 'refused', code, fields }; return { result, status, scope } }
  try {
    const optional = name === `${rt.options.seed}.events.list` ? 'events' : name === 'resources/read' ? 'resources' : null
    if (optional && !offers(rt.options.capabilities, optional)) return refuse('capability_not_declared', { capability: optional })
    const tool = resourceTool ?? rt.tools.find(tool => tool.name === name)
    if (!tool) { status = 400; return refuse('tool_not_found') }
    if (tool.authority === 'none') row.authority = 'none'
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
    const properties = tool.inputSchema.properties ?? {}
    const declared = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => Object.hasOwn(properties, key)))
    row.ignored_arguments = Object.keys(raw ?? {}).filter(key => !Object.hasOwn(properties, key)).sort()
    const key = !tool.readOnly && typeof raw?.idempotency_key === 'string' && raw.idempotency_key.length > 0 && raw.idempotency_key.length <= 200 && !raw.idempotency_key.includes('\0') ? raw.idempotency_key : null
    row.idempotency_key = key
    const operation = operationId === undefined ? undefined : await resumeOperation(rt, operationId, principal, key)
    const approvers = operation?.approvers ?? []
    principal = operation?.principal ?? principal
    const current = await narrowPrincipal(rt, principal)
    if (operationId !== undefined && principal.scopes.some(scope => !current.scopes.includes(scope))) return refuse('insufficient_scope')
    principal = { ...current, operationId: row.operation_id, idempotencyKey: key }
    row.scopes = [...principal.scopes]
    if (tool.scope && !principal.scopes.includes(tool.scope)) { status = 403; scope = tool.scope; return refuse('insufficient_scope') }
    const state = await policyState(rt)
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
    const ctx = context(rt, principal, door, [], approvers)
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
        if (!saved.outcome) return refuse('call_in_progress')
        previous = saved
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
    const classes = original?.classes ?? currentClasses
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
    principal = await nativeProof(rt, tool, args, principal, proofReference)
    if (previous?.outcome && cached) {
      // A newly required review or approval cannot be satisfied by an older receipt.
      if (decision.result === 'approval' && (cached.decision?.disposition !== 'approval' || cached.decision.revision !== state.revision)) return refuse('approval_required')
      if (decision.result === 'review' && cached.decision?.disposition !== 'review') return refuse('review_required')
      if (cached.outcome === 'done' && cached.receipt) cached.receipt = { ...cached.receipt, decision: cached.decision,
        ...(cached.review ? { review: cached.review } : {}) }
      await recoverAudit(rt, previous.decision_id, JSON.parse(previous.outcome))
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
    const savedSummary = await summary(tool, args, ctx, target)
    const summary_sha256 = await digest(savedSummary)
    recordDecision(row, meta)
    const claim = claimKey === null ? undefined : { key: claimKey, digest: requestDigest }
    if (principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent)) return refuse('consent_revoked')
    if (decision.result === 'approval') {
      await startPending(rt, row, principal, evidence, claim); owned = key !== null
      result = await openApproval(rt, { decision_id: row.id, revision: state.revision, tool: name, args, digest: requestDigest, key, claimKey,
        classes, principal, summary: savedSummary, summary_sha256, approvers: decision.approvers!, expires_at: new Date(rt.now() + durationSeconds(decision.wait)! * 1000).toISOString(), door, evidence,
        result, ...(expected === undefined ? {} : { expected_revision: expected as string | number }) })
      effected = true
      await saveCall(rt, principal, claimKey, result)
      await appendEvents(rt, [{ type: 'approval.pending', uri: result.approval!.url, actor: { kind: 'agent', ...preparedBy(principal) }, data: { decision_id: row.id, classes } }])
    } else {
      // Once execution begins, retain the claim even on an unexpected failure:
      // an action may already have committed and must never be executed twice.
      if (!await startExecution(rt, row, principal, classes, state, evidence, claim)) return refuse(principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent) ? 'consent_revoked' : 'decision_busy')
      owned = key !== null
      await releaseDecision(rt, row.id); locked = false
      effected = true
      const run = await runTool(rt, tool, args, principal, result, door, approvers)
      result = run.result
      if (result.outcome === 'done' && decision.result === 'review') result.review = await openReview(rt, name, principal, row.id, evidence, run.undo, door, savedSummary)
      if (result.code && result.code !== 'output_invalid') effected = false
      if (effected) await saveCall(rt, principal, claimKey, result)
      await appendEvents(rt, run.effects.map(effect => ({ ...effect, actor: { kind: 'agent', ...preparedBy(principal) } })))
    }
    return { result }
  } catch (cause) {
    if (cause instanceof ToolRefusal) return refuse(cause.code, cause.details)
    row.outcome = 'failed'; status = 500
    const failed = refuse('execution_failed')
    if (owned && effected) await saveCall(rt, principal, claimKey, result)
    return failed
  } finally {
    if (locked) await releaseDecision(rt, row.id)
    if (owned && !effected) await rt.options.db.prepare('DELETE FROM agent_door_calls WHERE agent=? AND key=? AND decision_id=?').bind(principal.agent.id, claimKey, row.id).run()
    if (row.outcome === 'running') row.outcome = result.outcome
    outcomeRow(row, result)
    await audit(rt, row, evidence)
  }
}
