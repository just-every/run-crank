import { decide, scopeMatches } from './policy/decide.ts'
import type { Rule, PolicyDocument } from './policy/document.ts'
import type { ClassId } from './policy/catalogue.ts'
import type { ClassAndFacts, DecisionMeta, Principal, Runtime } from './types.ts'
import { preparedBy } from './people.ts'

export interface AuditRow {
  sequence?: number; id: string; at: string; door: 'mcp' | 'embedded'; agent: Principal['agent']; sponsor: { id: string; name: string }; label: string
  tool: string; resource: string | null; decision_id: string | null; classes: ClassAndFacts[]; revision: number | null; rules: Array<{ class: string; rule: string | null; do: string }>
  decision: string; outcome: 'running' | 'done' | 'refused' | 'pending' | 'failed' | 'replayed'; code: string | null
  approval: { id: string; by: string[] } | null; review: { id: string; by: string | null } | null
  idempotency_key: string | null; trace: string | null; ignored_arguments: string[]; replay_of: string | null
}
export interface Evidence { document: PolicyDocument; usage: Record<string, number>; classes: ClassAndFacts[]; result: string; rules: unknown }
export function newAudit(rt: Runtime, principal: Principal, tool: string, door: AuditRow['door'], trace: unknown): AuditRow {
  return { id: crypto.randomUUID(), at: new Date(rt.now()).toISOString(), door, agent: { ...principal.agent, specialist: principal.agent.specialist ?? null }, sponsor: { id: principal.person.id, name: principal.person.name }, label: preparedBy(principal).label,
    tool, resource: null, decision_id: null, classes: [], revision: null, rules: [], decision: 'none', outcome: 'refused', code: null, approval: null, review: null, idempotency_key: null,
    trace: typeof trace === 'string' ? trace.slice(0, 512) : null, ignored_arguments: [], replay_of: null }
}
export function recordDecision(row: AuditRow, decision: DecisionMeta) {
  row.revision = decision.revision; row.decision = decision.disposition
  row.classes = decision.classes.map(item => ({ class: item.class as ClassId, facts: item.facts as ClassAndFacts['facts'] }))
  row.rules = decision.classes.map(({ class: cls, rule, do: action }) => ({ class: cls, rule, do: action }))
}
export function auditInsert(rt: Runtime, row: AuditRow, evidence?: Evidence, guard?: string) {
  return rt.options.db.prepare(`INSERT INTO agent_door_audit(id,at,agent,classes,row,evidence) SELECT ?,?,?,?,?,?${guard ? ' WHERE EXISTS(SELECT 1 FROM agent_door_usage WHERE decision_id=?)' : ''}`)
    .bind(row.id, row.at, row.agent.id, JSON.stringify(row.classes.map(item => item.class)), JSON.stringify(row), evidence ? JSON.stringify(evidence) : null, ...(guard ? [guard] : []))
}
export async function audit(rt: Runtime, row: AuditRow, evidence?: Evidence) {
  await rt.options.db.prepare(`INSERT INTO agent_door_audit(id,at,agent,classes,row,evidence) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET classes=excluded.classes,row=excluded.row,evidence=excluded.evidence`)
    .bind(row.id, row.at, row.agent.id, JSON.stringify(row.classes.map(item => item.class)), JSON.stringify(row), evidence ? JSON.stringify(evidence) : null).run()
}
export function outcomeRow(row: AuditRow, result: import('./types.ts').CallResult) {
  if (result.decision) recordDecision(row, result.decision)
  if (row.outcome !== 'replayed' && row.outcome !== 'failed') row.outcome = result.code === 'output_invalid' || result.code === 'execution_failed' ? 'failed' : result.outcome
  row.code = result.code ?? null
  row.approval = result.approval ? { id: result.approval.id, by: (result.receipt?.approved_by as string[]) ?? [] } : null
  row.review = result.review ? { id: result.review.id, by: null } : null
}
export async function recoverAudit(rt: Runtime, id: string, result: import('./types.ts').CallResult) {
  const record = await rt.options.db.prepare('SELECT row,evidence FROM agent_door_audit WHERE id=?').bind(id).first<{ row: string; evidence: string | null }>()
  if (!record) throw new Error('audit_missing')
  const row: AuditRow = JSON.parse(record.row)
  if (row.outcome !== 'running') return
  outcomeRow(row, result)
  await audit(rt, row, record.evidence ? JSON.parse(record.evidence) : undefined)
}
export async function usage(rt: Runtime, document: PolicyDocument, principal: Principal) {
  const day = Math.floor(rt.now() / 86400000) * 86400000
  const rows = (await rt.options.db.prepare('SELECT seed,specialist,agent,classes FROM agent_door_usage WHERE at>=? AND at<?').bind(day, day + 86400000).all<{ seed: string; specialist: string | null; agent: string; classes: string }>()).results
  const sums: Record<string, number> = {}
  for (const rule of document.rules) for (const cls of [...new Set([...rt.tools.flatMap(tool => tool.classes), ...rt.options.resources?.flatMap(resource => resource.classes) ?? []])]) {
    const key = `${rule.id}:${cls}`
    if (key in sums) continue
    sums[key] = rows.reduce((sum, row) => sum + (JSON.parse(row.classes) as ClassAndFacts[]).filter(item => item.class === cls && scopeMatches(rule, row, item.facts)
      && (typeof rule.max_per_day !== 'object' || item.facts.currency === rule.max_per_day.currency)).reduce((total, item) => total + item.facts.measure, 0), 0)
  }
  // Principal is explicitly part of the decision context; the scope test above uses each counted call.
  void principal
  return sums
}
export const usageToday = (sums: Record<string, number>) => (rule: Rule, cls: ClassId) => sums[`${rule.id}:${cls}`] ?? 0
export async function auditPage(rt: Runtime, url: URL) {
  const rows = (await rt.options.db.prepare('SELECT sequence,row,evidence FROM agent_door_audit WHERE sequence>? ORDER BY sequence LIMIT 200').bind(Number(url.searchParams.get('after')) || 0).all<{ sequence: number; row: string; evidence: string | null }>()).results
  let differs = 0
  const visible = []
  for (const record of rows) {
    const row: AuditRow = { ...JSON.parse(record.row), sequence: record.sequence }
    if (url.searchParams.get('agent') && row.agent.id !== url.searchParams.get('agent')) continue
    if (url.searchParams.get('class') && !row.classes.some(item => item.class === url.searchParams.get('class'))) continue
    if (record.evidence) {
      const evidence: Evidence = JSON.parse(record.evidence)
      const result = decide({ document: evidence.document, revision: row.revision, call: { seed: rt.options.seed, specialist: row.agent.specialist ?? null, agent: row.agent.id, classes: evidence.classes }, usageToday: usageToday(evidence.usage) })
      if (result.result !== row.decision || result.result !== evidence.result || JSON.stringify(result.classes) !== JSON.stringify(evidence.rules) || JSON.stringify(result.classes) !== JSON.stringify(row.rules)) differs++
    }
    if (row.approval) {
      const item = await rt.options.db.prepare('SELECT approvals FROM agent_door_approvals WHERE id=?').bind(row.approval.id).first<{ approvals: string }>()
      row.approval.by = item ? [...new Set((JSON.parse(item.approvals) as Array<{ person: string }>).map(item => item.person))] : []
    }
    if (row.review) row.review.by = (await rt.options.db.prepare('SELECT marked_by FROM agent_door_reviews WHERE id=?').bind(row.review.id).first<{ marked_by: string | null }>())?.marked_by ?? null
    visible.push(row)
  }
  return { rows: visible, cursor: rows.length ? String(rows.at(-1)!.sequence) : url.searchParams.get('after') ?? null, differs_from_policy: differs }
}
