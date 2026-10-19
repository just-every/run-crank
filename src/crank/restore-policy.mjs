const unfinished = ['queued', 'running', 'waiting', 'awaiting_approval', 'paused'];
const distant = '9999-12-31T00:00:00.000Z';
const encode = value => JSON.stringify(value);
/** Restored workflows belong to no one until the receiving owner adopts them at publish. */
export const RESTORED_OWNER = 'restore:awaiting-adoption';
const runFence = (previous_status, previous_error = null) => encode({
  category: 'restore_fence', message: 'Restored without execution authority. The owner must choose resume or cancel when publishing.',
  previous_status, previous_error,
});
const uncertainWrite = encode({ category: 'uncertain', message: 'Restore interrupted a remote write; reconcile its destination before replaying.' });
const deliveryFence = previous => encode({ status: 'failed', code: 'restore_fence', uncertain: true, previous });
const fenced = (json, key, code) => json !== null && JSON.parse(json)[key] === code;
const remoteWrite = row => row.status === 'running' &&
  (row.type.startsWith('slack.') || row.type === 'http' && !['GET', 'HEAD'].includes(String(JSON.parse(row.input_json ?? '{}').method ?? 'GET').toUpperCase()));

/** Pure/idempotent export normalization: backups carry history, never execution authority. */
export function fenceRow(table, row) {
  if (table === 'crank_wf_runs' && unfinished.includes(row.status) && !fenced(row.error_json, 'category', 'restore_fence'))
    return { ...importRow(table, row), error_json: runFence(row.status, row.error_json ? JSON.parse(row.error_json) : null) };
  if (table === 'crank_runs' && ['running', 'failed'].includes(row.state) && !fenced(row.outcome_json, 'code', 'restore_fence'))
    return { ...row, lease_id: null, lease_expires_at: null, state: 'failed', outcome_json: deliveryFence(row.outcome_json ? JSON.parse(row.outcome_json) : null) };
  return importRow(table, row);
}

/** Every value importRow may write. Base refuses any other change to a staged row. */
export const importSafety = {
  crank_flows: { status: ['draft'] },
  crank_workflows: { status: ['paused'], owner_id: [RESTORED_OWNER] },
  crank_connections: { status: ['needs_reconnect'] },
  crank_wf_runs: { status: ['paused'], error_json: unfinished.map(status => runFence(status)), lease_id: [null], lease_expires_at: [null], continuation_authority: [0] },
  crank_wf_steps: { status: ['uncertain'], error_json: [uncertainWrite] },
  crank_runs: { state: ['failed'], outcome_json: [deliveryFence(null)], replay_count: [1], lease_id: [null], lease_expires_at: [null] },
  crank_polls: { next_due_at: [distant] },
  crank_schedules: { next_due_at: [distant] },
};

/** Bounded import normalization for archives written before (or without) the
 * export fence: activation off, adoption required, replay authority spent.
 * A run-level pause reason or a failed delivery's outcome cannot be carried in a
 * bounded value, so an unfenced unfinished run keeps only its previous status and
 * a failed delivery keeps its outcome with its single replay marked used. */
export function importRow(table, row) {
  if (table === 'crank_flows') return { ...row, status: 'draft' };
  if (table === 'crank_workflows') return { ...row, status: row.status === 'draft' ? 'draft' : 'paused', owner_id: RESTORED_OWNER };
  if (table === 'crank_connections') return { ...row, status: row.status === 'revoked' ? 'revoked' : 'needs_reconnect' };
  if (table === 'crank_wf_runs') return { ...row, lease_id: null, lease_expires_at: null, continuation_authority: 0,
    ...(unfinished.includes(row.status) && !fenced(row.error_json, 'category', 'restore_fence') ? { status: 'paused', error_json: runFence(row.status) } : {}) };
  if (table === 'crank_wf_steps' && remoteWrite(row)) return { ...row, status: 'uncertain', error_json: uncertainWrite };
  if (table === 'crank_runs') {
    const open = ['running', 'failed'].includes(row.state) && !fenced(row.outcome_json, 'code', 'restore_fence');
    return { ...row, lease_id: null, lease_expires_at: null,
      ...(open && row.outcome_json === null ? { state: 'failed', outcome_json: deliveryFence(null) } : open ? { state: 'failed', replay_count: 1 } : {}) };
  }
  if (table === 'crank_polls' || table === 'crank_schedules') return { ...row, next_due_at: distant };
  return row;
}

/** Semantic checks on the normalized staging rows, before the atomic commit.
 * They cover the same rows on browser and CLI restore. */
export async function validateRestore({ read }) {
  const cache = new Map();
  const rows = async table => { if (!cache.has(table)) cache.set(table, await read(table)); return cache.get(table); };
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
  for (const draft of await rows('crank_workflow_drafts')) {
    if (!workflows.has(draft.workflow_id) || draft.base_version_id && versions.get(draft.base_version_id)?.workflow_id !== draft.workflow_id) return false;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(draft.graph_json));
    if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== draft.graph_digest) return false;
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
  return true;
}
