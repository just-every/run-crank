import { stmt, type CrankEnv } from '../model'

/** Live inventory, independent of the historical report's date window. Failed
 * runs are retained dead letters, including uncertain writes needing readback;
 * they are never automatic dispatch candidates. Counts precede the page limit. */
export async function executionQueue(env: CrankEnv, workflow: string | null, team: string | null, time: number) {
  const filter = `FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
    LEFT JOIN crank_ops_teams t ON t.workflow_id=w.id LEFT JOIN oa_operators o ON o.id=w.owner_id
    WHERE r.status IN ('queued','running','waiting','awaiting_approval','paused','failed')
    AND (?1 IS NULL OR w.id=?1) AND (?2 IS NULL OR COALESCE(t.team,'Unassigned')=?2)`
  const state = `CASE WHEN r.status='failed' THEN 'dead_letter' WHEN r.status IN ('awaiting_approval','paused') THEN 'waiting' ELSE r.status END`
  const [counts, rows] = await Promise.all([
    stmt(env, `SELECT ${state} AS state,COUNT(*) AS depth,MIN(r.received_at) AS oldest_received_at ${filter} GROUP BY 1`, workflow, team).all<{ state: string; depth: number; oldest_received_at: string }>(),
    stmt(env, `SELECT r.id,r.workflow_id,w.name AS workflow,r.version_id,r.status,${state} AS state,r.priority,r.max_concurrency,
      r.received_at,r.started_at,r.lease_expires_at,w.owner_id,o.display_name AS owner,
      COALESCE(json_extract(r.error_json,'$.category'),'') AS error_category,
      (SELECT COUNT(*) FROM crank_wf_steps s WHERE s.run_id=r.id AND s.status='succeeded') AS completed_steps,
      (SELECT COUNT(*) FROM crank_wf_steps s WHERE s.run_id=r.id AND s.status='uncertain') AS uncertain_steps
      ${filter} ORDER BY r.priority DESC,r.received_at,r.id LIMIT 100`, workflow, team).all<any>(),
  ])
  const states = ['queued', 'running', 'waiting', 'dead_letter'].map(state => {
    const count = counts.results.find(c => c.state === state)
    return { state, depth: count?.depth ?? 0, oldest_received_at: count?.oldest_received_at ?? null,
      oldest_age_ms: count ? Math.max(0, time - Date.parse(count.oldest_received_at)) : null }
  })
  const depth = states.reduce((sum, state) => sum + state.depth, 0)
  return { as_of: new Date(time).toISOString(), depth, states, runs: rows.results, truncated: depth > rows.results.length }
}
