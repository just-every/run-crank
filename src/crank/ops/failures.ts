import type { RunRow } from '../engine/types'
import { now, stmt, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { notifyRun } from './run-notices'
import { workspaceSettings } from './settings'

/** Owner notices after a run settles. Approvals: one notice per waiting decision.
 * EXEC-003: one notice per workflow, failure category and hour, then the auto-pause
 * policy. `stopped by filter` and `stopped by search` are not failures. */
export async function afterSettle(env: CrankEnv, run: RunRow) {
  if (run.mode === 'test') return
  if (run.status === 'awaiting_approval') return approvalNotice(env, run)
  if (run.status !== 'failed' && run.status !== 'paused') return
  const workflow = await stmt(env, 'SELECT id,name,status,owner_id FROM crank_workflows WHERE id=?', run.workflow_id).first<{ id: string; name: string; status: string; owner_id: string }>()
  if (!workflow) return
  const error = run.error_json ? JSON.parse(run.error_json) : {}, category = String(error.category ?? 'provider')
  const owner = await stmt(env, 'SELECT display_name FROM oa_operators WHERE id=?', workflow.owner_id).first<{ display_name: string }>()
  if (run.status === 'paused') {
    await notifyRun(env, { runId: run.id, category, key: `paused:${run.id}:${category}`, workflowId: workflow.id, kind: 'run_paused', subject: `${category === 'authority' ? 'Workflow authority needed' : 'Reconnect needed'}: ${workflow.name}`,
      text: `A run of "${workflow.name}" paused: ${error.message ?? 'a connection needs attention'}. Accountable owner: ${owner?.display_name ?? 'workflow owner'}. Next action: ${category === 'authority' ? 'resume the workflow, or start a new run of its current published version' : 'reconnect the connection, then resume the run'}.`, link: `/api/crank/workflow-runs/${run.id}` })
    return
  }
  await notifyRun(env, { runId: run.id, category, key: `failed:${workflow.id}:${category}:${now().slice(0, 13)}`, workflowId: workflow.id, kind: 'run_failed', subject: `Run failed in ${workflow.name} (${category})`,
    text: `A run of "${workflow.name}" failed${error.step ? ` at step ${error.step}` : ''}: ${error.message ?? category}. Failure category: ${category}. Accountable owner: ${owner?.display_name ?? 'workflow owner'}. Next action: inspect the run, correct the cause and start a new run.`, link: `/api/crank/workflow-runs/${run.id}` })
  const settings = await workspaceSettings(env), policy = settings.auto_pause
  if (!policy.enabled || workflow.status !== 'published') return
  const since = new Date(Date.now() - policy.window_hours * 3600000).toISOString()
  const counts = await stmt(env, `SELECT COUNT(*) AS total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM crank_wf_runs
    WHERE mode='production' AND workflow_id=? AND received_at>=? AND status IN ('succeeded','failed','rejected','cancelled')`, workflow.id, since).first<{ total: number; failed: number }>()
  if (!counts || counts.total < policy.min_runs || counts.failed / counts.total < policy.failure_rate) return
  const paused = await env.DB.batch([
    stmt(env, "UPDATE crank_workflows SET status='paused' WHERE id=? AND status='published'", workflow.id),
    auditStatement(env, 'system', 'workflow.auto_pause', 'workflow', workflow.id, { failed: counts.failed, total: counts.total, window_hours: policy.window_hours }),
  ])
  if (paused[0].meta.changes !== 1) return
  const categories = await stmt(env, `SELECT json_extract(error_json,'$.category') AS category, COUNT(*) AS n FROM crank_wf_runs WHERE mode='production' AND workflow_id=? AND status='failed' AND received_at>=? GROUP BY 1`, workflow.id, since).all<{ category: string; n: number }>()
  await notifyRun(env, { runId: run.id, category, key: `autopause:${workflow.id}:${now()}`, workflowId: workflow.id, kind: 'auto_paused', subject: `${workflow.name} was paused after repeated failures`,
    text: `"${workflow.name}" was paused automatically: ${counts.failed} of ${counts.total} runs failed in ${policy.window_hours} hours (${categories.results.map(c => `${c.category}: ${c.n}`).join(', ')}). New trigger events are held with no effect. Resume the workflow, then run or discard the held events.` })
}

async function approvalNotice(env: CrankEnv, run: RunRow) {
  const workflow = await stmt(env, 'SELECT id,name FROM crank_workflows WHERE id=?', run.workflow_id).first<{ id: string; name: string }>()
  const waits = await stmt(env, "SELECT w.id,w.path,w.reason,s.type FROM crank_waits w JOIN crank_wf_steps s ON s.run_id=w.run_id AND s.path=w.path WHERE w.run_id=? AND w.kind='approval' AND w.resolved_at IS NULL", run.id).all<{ id: string; path: string; reason: string | null; type: string }>()
  for (const wait of waits.results) await notifyRun(env, { runId: run.id, category: wait.type === 'collect' ? 'information' : 'approval', key: `approval:${wait.id}`, workflowId: run.workflow_id, kind: wait.type === 'collect' ? 'collect' : 'approval', subject: `${wait.type === 'collect' ? 'Information' : 'Approval'} needed: ${workflow?.name ?? 'workflow run'}`,
    text: `A run of "${workflow?.name ?? run.workflow_id}" is waiting for your decision at step ${wait.path} (${wait.reason ?? 'approval'}). Review the exact proposed action, then approve, edit allowed fields or reject.`, link: `/api/crank/workflow-runs/${run.id}` })
}
