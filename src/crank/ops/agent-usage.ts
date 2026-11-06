import { stmt, type CrankEnv } from '../model'

interface Counts {
  request_attempts: number
  replays: number
  original_operations: number
}
interface AgentRow extends Counts {
  agent_id: string
  name: string
  specialist: string | null
  revoked: number
}
interface DecisionRow {
  agent_id: string
  decision: string
  outcome: string
  request_attempts: number
  replays: number
}
interface ClassRow extends DecisionRow {
  class: string
}

/** Aggregate the complete month in storage, independent of the audit page size.
 * A sequence watermark excludes newly admitted calls between these reads.
 * Outcomes are the retained current outcomes of calls requested in this month.
 */
export async function agentUsage(env: CrankEnv, month: string) {
  const start = month + '-01T00:00:00.000Z', next = new Date(start)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const end = next.toISOString()
  const watermark = (await stmt(env, 'SELECT COALESCE(MAX(sequence),0) n FROM agent_door_audit WHERE at>=? AND at<?', start, end).first<{ n: number }>())!.n
  const window = 'a.at>=? AND a.at<? AND a.sequence<=?'
  const replay = "(json_extract(a.row,'$.replay_of') IS NOT NULL OR json_extract(a.row,'$.outcome')='replayed')"
  // Approval execution has its own audit row, but is a person's continuation
  // of the held request. Keep requests in their admission month and preserve
  // actual agent retries, while projecting the retained approval resolution.
  const requests = `WITH requests AS (
    SELECT a.*,CASE WHEN json_extract(a.row,'$.outcome')='pending' AND p.id IS NOT NULL THEN
      CASE WHEN json_extract(p.result,'$.code') IN ('output_invalid','execution_failed') THEN 'failed'
        WHEN p.result IS NOT NULL THEN json_extract(p.result,'$.outcome')
        WHEN p.state IN ('rejected','expired') OR (p.state='pending' AND json_extract(p.saved,'$.expires_at')<=?) THEN 'refused'
        ELSE 'pending' END
      ELSE json_extract(a.row,'$.outcome') END outcome
    FROM agent_door_audit a LEFT JOIN agent_door_approvals p ON p.id=json_extract(a.row,'$.approval.id')
    WHERE ${window} AND (p.id IS NULL OR a.id=json_extract(p.saved,'$.decision_id') OR ${replay})
  )`
  const args = [new Date().toISOString(), start, end, watermark]
  const rows = await env.DB.batch([
    stmt(env, `${requests} SELECT a.agent AS agent_id,COUNT(*) request_attempts,SUM(${replay}) replays,
      COUNT(DISTINCT CASE WHEN NOT ${replay} THEN COALESCE(json_extract(a.row,'$.operation_id'),a.id) END) original_operations,
      json_extract(last.row,'$.agent.name') name,json_extract(last.row,'$.agent.specialist') specialist,
      CASE WHEN COALESCE(g.revoked,0)=1 OR t.revoked_at IS NOT NULL THEN 1 ELSE 0 END revoked
      FROM requests a
      JOIN (SELECT agent,MAX(sequence) last_sequence FROM requests GROUP BY agent) recent ON recent.agent=a.agent
      JOIN requests last ON last.sequence=recent.last_sequence
      LEFT JOIN agent_door_agents g ON g.id=a.agent
      LEFT JOIN crank_tokens t ON a.agent='crank-token:'||t.id GROUP BY a.agent ORDER BY a.agent`, ...args),
    stmt(env, `${requests} SELECT a.agent agent_id,json_extract(a.row,'$.decision') decision,a.outcome,
      COUNT(*) request_attempts,SUM(${replay}) replays FROM requests a
      GROUP BY a.agent,decision,outcome ORDER BY a.agent,decision,outcome`, ...args),
    stmt(env, `${requests} SELECT a.agent agent_id,json_extract(c.value,'$.class') class,
      COALESCE((SELECT json_extract(r.value,'$.do') FROM json_each(a.row,'$.rules') r WHERE json_extract(r.value,'$.class')=json_extract(c.value,'$.class')),json_extract(a.row,'$.decision')) decision,
      a.outcome,COUNT(*) request_attempts,SUM(${replay}) replays
      FROM requests a,json_each(a.row,'$.classes') c
      GROUP BY a.agent,class,decision,outcome ORDER BY a.agent,class,decision,outcome`, ...args),
  ])
  const decisions = rows[1].results as unknown as DecisionRow[], classes = rows[2].results as unknown as ClassRow[]
  const agents = (rows[0].results as unknown as AgentRow[]).map(({ revoked, ...row }) => ({
    ...row, revoked: !!revoked,
    decisions: decisions.filter(item => item.agent_id === row.agent_id),
    classes: classes.filter(item => item.agent_id === row.agent_id),
    money_moved: null, provider_spend_usd: null,
  }))
  return {
    month, start, end, watermark, scope: 'All native agent calls; workflow and team filters do not apply',
    accounting: 'Requests in this UTC month; retained current outcomes. Replays are attempts, not new original operations. Class counts overlap when a call has several classes. Calls refused before agent authentication are not attributed.',
    boundary: 'The admitted native registry rejects provider-cost tools. Provider spend and money moved are not reported here; unknown amounts are not zero. Workflow budget accounting is separate.',
    totals: agents.reduce<Counts>((sum, agent) => ({
      request_attempts: sum.request_attempts + agent.request_attempts,
      replays: sum.replays + agent.replays,
      original_operations: sum.original_operations + agent.original_operations,
    }), { request_attempts: 0, replays: 0, original_operations: 0 }),
    agents,
  }
}
