const unfinished = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'paused']);
const distant = '9999-12-31T00:00:00.000Z';
const encode = value => JSON.stringify(value);

/** Pure/idempotent normalization: backups carry history, never execution authority. */
export function fenceRow(table, row) {
  if (table === 'crank_flows') return { ...row, status: 'draft' };
  if (table === 'crank_workflows') return { ...row, status: row.status === 'draft' ? 'draft' : 'paused',
    settings_json: encode({ ...JSON.parse(row.settings_json), restore_pending: true }) };
  if (table === 'crank_connections') return { ...row, status: row.status === 'revoked' ? 'revoked' : 'needs_reconnect' };
  if (table === 'crank_wf_runs') {
    const prior = row.error_json ? JSON.parse(row.error_json) : null;
    return { ...row, lease_id: null, lease_expires_at: null, continuation_authority: 0,
      ...(unfinished.has(row.status) ? { status: 'paused', error_json: prior?.category === 'restore_fence' ? row.error_json : encode({
        category: 'restore_fence', message: 'Restored without execution authority. The owner must choose resume or cancel when publishing.',
        previous_status: row.status, previous_error: prior,
      }) } : {}) };
  }
  if (table === 'crank_wf_steps' && row.status === 'running' &&
    (row.type.startsWith('slack.') || row.type === 'http' && !['GET', 'HEAD'].includes(String(JSON.parse(row.input_json ?? '{}').method ?? 'GET').toUpperCase())))
    return { ...row, status: 'uncertain', error_json: encode({ category: 'uncertain', message: 'Restore interrupted a remote write; reconcile its destination before replaying.' }) };
  if (table === 'crank_runs') {
    const prior = row.outcome_json ? JSON.parse(row.outcome_json) : null;
    return { ...row, lease_id: null, lease_expires_at: null,
      ...(row.state === 'running' || row.state === 'failed' ? { state: 'failed', outcome_json: prior?.code === 'restore_fence' ? row.outcome_json : encode({
        status: 'failed', code: 'restore_fence', uncertain: true, previous: prior,
      }) } : {}) };
  }
  if (table === 'crank_polls') return { ...row, next_due_at: distant };
  if (table === 'crank_schedules') return { ...row, next_due_at: distant };
  return row;
}

/** Unsafe older or hand-edited archives are refused before the atomic commit.
 * Checks cover the same rows on browser and CLI restore. */
export async function validateRestore({ read }) {
  const cache = new Map();
  const rows = async table => { if (!cache.has(table)) cache.set(table, await read(table)); return cache.get(table); };
  for (const table of ['crank_flows', 'crank_workflows', 'crank_connections', 'crank_wf_runs', 'crank_wf_steps', 'crank_runs', 'crank_polls', 'crank_schedules']) {
    for (const row of await rows(table)) {
      const normalized = fenceRow(table, row);
      if (Object.keys(normalized).some(key => normalized[key] !== row[key])) return false;
    }
  }
  const workflows = new Map((await rows('crank_workflows')).map(row => [row.id, row]));
  const versions = new Map((await rows('crank_workflow_versions')).map(row => [row.id, row]));
  for (const workflow of workflows.values()) {
    const graph = JSON.parse(workflow.draft_json);
    if (!graph.trigger || !Array.isArray(graph.steps) || workflow.published_version_id && versions.get(workflow.published_version_id)?.workflow_id !== workflow.id) return false;
  }
  for (const version of versions.values()) {
    if (!workflows.has(version.workflow_id)) return false;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version.graph_json));
    if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== version.graph_digest) return false;
  }
  for (const run of await rows('crank_wf_runs')) if (!workflows.has(run.workflow_id) || versions.get(run.version_id)?.workflow_id !== run.workflow_id) return false;
  // These product links predate foreign-key declarations; validate them explicitly.
  for (const [child, column, parent] of [
    ['crank_runs', 'flow_id', 'crank_flows'], ['crank_approvals', 'run_id', 'crank_runs'], ['crank_attempts', 'run_id', 'crank_runs'],
    ['crank_wf_steps', 'run_id', 'crank_wf_runs'], ['crank_wf_step_revisions', 'run_id', 'crank_wf_runs'], ['crank_waits', 'run_id', 'crank_wf_runs'], ['crank_callback_events', 'run_id', 'crank_wf_runs'],
    ['crank_queue_items', 'run_id', 'crank_wf_runs'], ['crank_holds', 'workflow_id', 'crank_workflows'], ['crank_hold_items', 'hold_id', 'crank_holds'],
    ['crank_historical_batches', 'workflow_id', 'crank_workflows'], ['crank_historical_items', 'batch_id', 'crank_historical_batches'],
  ]) {
    const ids = new Set((await rows(parent)).map(row => row.id));
    if ((await rows(child)).some(row => !ids.has(row[column]))) return false;
  }

}
