import type { Evidence } from './audit.ts'
import type { ClassAndFacts, Principal, Runtime, Person, ToolContext, ApprovalDisplaySummary } from './types.ts'
import { undoContext, type Effect } from './execution.ts'
import { error, json, ToolRefusal } from './errors.ts'
import { matchingRefs } from './people.ts'
import { appendEvents } from './events.ts'

interface SavedReview { decision_id: string; tool: string; classes: ClassAndFacts[]; principal: Principal; reviewers: string[]; undo?: unknown; door: ToolContext['door']; summary?: ApprovalDisplaySummary }
interface ReviewRecord { id: string; state: string; saved: string; marked_by: string | null; marked_at: string | null }
export async function openReview(rt: Runtime, tool: string, principal: Principal, decision_id: string, evidence: Evidence, undo: unknown, door: ToolContext['door'], summary?: ApprovalDisplaySummary) {
  const id = crypto.randomUUID()
  const saved: SavedReview = { decision_id, tool, classes: evidence.classes, principal, reviewers: evidence.document.reviewers ?? [], undo, door, summary }
  await rt.options.db.prepare('INSERT INTO agent_door_reviews(id,state,saved) VALUES(?,?,?)').bind(id, 'open', JSON.stringify(saved)).run()
  return { id }
}
export function reviewView(rt: Runtime, row: ReviewRecord) {
  const saved: SavedReview = JSON.parse(row.saved)
  return { id: row.id, decision_id: saved.decision_id, state: row.state, tool: saved.tool, classes: saved.classes, marked_by: row.marked_by, marked_at: row.marked_at,
    summary: saved.summary, undo: { available: saved.undo !== undefined && !!rt.tools.find(tool => tool.name === saved.tool)?.undo && row.state !== 'undone' }, prepared_by: { agent: saved.principal.agent.name, for: saved.principal.person.name } }
}
export async function reviewDoor(rt: Runtime, request: Request, person: Person, id?: string, action?: string) {
  if (!id) {
    if (request.method !== 'GET') return error('method_not_allowed', 405)
    const rows = (await rt.options.db.prepare('SELECT * FROM agent_door_reviews ORDER BY rowid DESC LIMIT 200').all<ReviewRecord>()).results
    const visible = await Promise.all(rows.map(async row => { const saved: SavedReview = JSON.parse(row.saved); return (await matchingRefs(rt, person, saved.principal.person.id, saved.reviewers)).length ? reviewView(rt, row) : null }))
    return json({ reviews: visible.filter(row => row !== null) })
  }
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_reviews WHERE id=?').bind(id).first<ReviewRecord>()
  if (!row) return error('not_found', 404)
  const saved: SavedReview = JSON.parse(row.saved)
  if (!(await matchingRefs(rt, person, saved.principal.person.id, saved.reviewers)).length) return error('forbidden', 403)
  if (request.method !== 'POST' || !['reviewed', 'flag', 'undo'].includes(action ?? '')) return error('method_not_allowed', 405)
  if (row.state === 'undoing') return error('review_conflict', 409)
  if (row.state === 'undone') return action === 'undo' ? json({ review: reviewView(rt, row) }) : error('review_closed', 409)
  const effects: Effect[] = []
  if (action === 'undo') {
    const tool = rt.tools.find(tool => tool.name === saved.tool)
    if (!tool?.undo || saved.undo === undefined) return error('undo_unavailable', 409)
    // Undo is a person's act with that person's current authority.
    const current = await rt.options.people.person(person.id)
    if (!current?.active || current.id !== person.id) return error('forbidden', 403)
    const changed = await rt.options.db.prepare("UPDATE agent_door_reviews SET state='undoing' WHERE id=? AND state=?").bind(id, row.state).run()
    if (!changed.meta.changes) return error('review_conflict', 409)
    try { const ctx = undoContext(rt, current, saved.door, effects); await tool.undo(saved.undo, ctx) }
    catch (cause) { await rt.options.db.prepare('UPDATE agent_door_reviews SET state=? WHERE id=?').bind(row.state, id).run(); if (cause instanceof ToolRefusal) return error(cause.code, 409, cause.details); throw cause }
  }
  if (action !== 'undo') {
    const marked = await rt.options.db.prepare('UPDATE agent_door_reviews SET state=? WHERE id=? AND state=?').bind(action === 'flag' ? 'flagged' : 'reviewed', id, row.state).run()
    if (!marked.meta.changes) return error('review_conflict', 409)
  }
  row.state = action === 'flag' ? 'flagged' : action === 'undo' ? 'undone' : 'reviewed'
  row.marked_by = person.id; row.marked_at = new Date(rt.now()).toISOString()
  await rt.options.db.prepare('UPDATE agent_door_reviews SET state=?,marked_by=?,marked_at=? WHERE id=?').bind(row.state, person.id, row.marked_at, id).run()
  if (action === 'flag') effects.push({ type: 'review.flagged', uri: `${rt.options.origin}/agents/reviews/${id}`, data: { classes: saved.classes, decision_id: saved.decision_id } })
  await appendEvents(rt, effects.map(effect => ({ ...effect, actor: { kind: 'person', person: { id: person.id, name: person.name } } })))
  return json({ review: reviewView(rt, row) })
}
