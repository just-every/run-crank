import type { Evidence } from './audit.ts'
import { recoverAudit } from './audit.ts'
import type { ClassAndFacts, CallResult, Person, Principal, Runtime, ToolContext, ApprovalDisplaySummary } from './types.ts'
import { appendEvents } from './events.ts'
import { error, json } from './errors.ts'
import { matchingRefs, preparedBy } from './people.ts'
import { executeApproval } from './approval-execution.ts'

export interface SavedApproval {
  decision_id: string; revision: number | null; tool: string; args: Record<string, unknown>; digest: string; key: string | null
  classes: ClassAndFacts[]; principal: Principal; approvers: string[]; expires_at: string; door: ToolContext['door']; evidence: Evidence
  result: CallResult; expected_revision?: number; summary: ApprovalDisplaySummary; summary_sha256: string
}
interface ApprovalRecord { id: string; state: string; saved: string; approvals: string; result: string | null; version: number }
export interface ApprovalMark { ref: string; person: string; name: string; at: string }
export async function openApproval(rt: Runtime, saved: SavedApproval) {
  const id = crypto.randomUUID(), requestState = crypto.randomUUID()
  const approval = { id, url: `${rt.options.origin}/agents/approvals/${id}`, expires_at: saved.expires_at }
  saved.result = { ...saved.result, outcome: 'pending', approval, requestState }
  await rt.options.db.prepare('INSERT INTO agent_door_approvals(id,state,saved) VALUES(?,?,?)').bind(id, 'pending', JSON.stringify(saved)).run()
  return saved.result
}
export async function approvalReplay(rt: Runtime, result: CallResult): Promise<CallResult> {
  if (!result.approval) return result
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(result.approval.id).first<ApprovalRecord>()
  if (!row) return { ...result, outcome: 'refused', code: 'approval_expired' }
  const saved: SavedApproval = JSON.parse(row.saved)
  if (row.result) {
    const completed: CallResult = JSON.parse(row.result)
    if (completed.execution_id) await recoverAudit(rt, completed.execution_id, completed)
    return completed
  }
  if (row.state === 'rejected') return { ...result, outcome: 'refused', code: 'approval_rejected' }
  if (row.state === 'expired' || rt.now() >= Date.parse(saved.expires_at)) return { ...result, outcome: 'refused', code: 'approval_expired' }
  return result
}
export function approvalView(rt: Runtime, row: ApprovalRecord) {
  const saved: SavedApproval = JSON.parse(row.saved)
  return { id: row.id, decision_id: saved.decision_id, revision: saved.revision, state: row.state === 'pending' && rt.now() >= Date.parse(saved.expires_at) ? 'expired' : row.state === 'executing' ? 'pending' : row.state,
    code: row.result ? JSON.parse(row.result).code ?? null : null, summary: saved.summary, summary_sha256: saved.summary_sha256,
    tool: saved.tool, classes: saved.classes, approvers: saved.approvers, approvals: JSON.parse(row.approvals), expires_at: saved.expires_at,
    prepared_by: preparedBy(saved.principal), rules: saved.result.decision?.classes.map(({ class: cls, rule, do: action }) => ({ class: cls, rule, do: action })) }
}
export const canReadApproval = async (rt: Runtime, person: Person, saved: SavedApproval) => person.id === saved.principal.person.id || (await matchingRefs(rt, person, saved.principal.person.id, saved.approvers)).length > 0
export async function approvalDoor(rt: Runtime, request: Request, person: Person, id?: string, action?: string): Promise<Response> {
  if (!id) {
    if (request.method !== 'GET') return error('method_not_allowed', 405)
    const rows = (await rt.options.db.prepare('SELECT * FROM agent_door_approvals ORDER BY rowid DESC LIMIT 200').all<ApprovalRecord>()).results
    const visible = await Promise.all(rows.map(async row => await canReadApproval(rt, person, JSON.parse(row.saved)) ? approvalView(rt, row) : null))
    return json({ approvals: visible.filter(row => row !== null) })
  }
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(id).first<ApprovalRecord>()
  if (!row) return error('not_found', 404)
  const saved: SavedApproval = JSON.parse(row.saved)
  if (!await canReadApproval(rt, person, saved)) return error('forbidden', 403)
  if (request.method === 'GET' && !action) return json({ approval: approvalView(rt, row) })
  if (request.method !== 'POST' || !['approve', 'reject'].includes(action ?? '')) return error('method_not_allowed', 405)
  let body: { revision?: unknown; summary_sha256?: unknown }
  try { body = await request.json() } catch { return error('invalid_arguments') }
  if (body.summary_sha256 !== saved.summary_sha256) return error('approval_summary_mismatch', 409)
  if (body.revision !== saved.revision) return error('revision_conflict', 409, { current_revision: saved.revision })
  if (row.state === 'expired' || rt.now() >= Date.parse(saved.expires_at) && row.state === 'pending') {
    await rt.options.db.prepare("UPDATE agent_door_approvals SET state='expired' WHERE id=? AND state='pending'").bind(id).run()
    return error('approval_expired', 409)
  }
  const approvals: ApprovalMark[] = JSON.parse(row.approvals)
  const refs = await matchingRefs(rt, person, saved.principal.person.id, saved.approvers)
  if (!refs.length) return error('forbidden', 403)
  if (row.state !== 'pending') return json({ approval: approvalView(rt, row) })
  const unsatisfied = refs.filter(ref => !approvals.some(mark => mark.ref === ref))
  if (!unsatisfied.length) return json({ approval: approvalView(rt, row) })
  if (action === 'approve') approvals.push(...unsatisfied.map(ref => ({ ref, person: person.id, name: person.name, at: new Date(rt.now()).toISOString() })))
  const complete = action === 'approve' && saved.approvers.every(ref => approvals.some(mark => mark.ref === ref))
  const nextState = action === 'reject' ? 'rejected' : complete ? 'executing' : 'pending'
  const changed = await rt.options.db.prepare('UPDATE agent_door_approvals SET state=?,approvals=?,version=version+1 WHERE id=? AND version=? AND state=?')
    .bind(nextState, JSON.stringify(approvals), id, row.version, 'pending').run()
  if (!changed.meta.changes) return error('approval_conflict', 409)
  const final = complete ? await executeApproval(rt, id, saved, approvals) : { state: nextState, code: undefined }
  await appendEvents(rt, [{ type: 'approval.decided', uri: `${rt.options.origin}/agents/approvals/${id}`, actor: { kind: 'person', person: { id: person.id, name: person.name } }, data: { decision_id: saved.decision_id, classes: saved.classes, decision: 'approval', state: final.state, ...(final.code ? { code: final.code } : {}) } }])
  const current = (await rt.options.db.prepare('SELECT * FROM agent_door_approvals WHERE id=?').bind(id).first<ApprovalRecord>())!
  return json({ approval: approvalView(rt, current) })
}
