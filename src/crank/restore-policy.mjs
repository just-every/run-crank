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
  crank_custom_versions: {status:['needs_review'],sandbox_json:[null]},
  crank_executor_tasks: { active: [0] },
  crank_agent_followups: { status: ['inactive'] },
  crank_flows: { status: ['draft'] },
  crank_usage_budgets: { active: [0] },
  crank_usage_allowances: { active: [0] },
  crank_usage_notices: { active: [0] },
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
  if (table === 'crank_custom_versions') return {...row,status:'needs_review',sandbox_json:null};
  if (table === 'crank_executor_tasks') return {...row,active:0};
  if (table === 'crank_agent_followups') return {...row,status:'inactive'};
  if (table === 'crank_usage_budgets' || table === 'crank_usage_allowances' || table === 'crank_usage_notices') return { ...row, active: 0 };
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
    if (!workflows.has(version.workflow_id) || version.grant_source_version_id && versions.get(version.grant_source_version_id)?.workflow_id !== version.workflow_id) return false;
    const policy = JSON.parse(version.retry_policy_json);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['read_attempts','base_delay_ms','write_base_delay_ms','idempotent_write_attempts','elapsed_ms','jitter_ms','max_wait_ms','run_parked_ms'].includes(key) || !Number.isSafeInteger(policy[key]) || policy[key] < 0)) return false;
    if (!(policy.read_attempts >= 1 && policy.read_attempts <= 10 && policy.base_delay_ms >= 1 && policy.base_delay_ms <= 3600000 && policy.write_base_delay_ms >= 1 && policy.write_base_delay_ms <= 3600000)) return false;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(version.graph_json));
    if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== version.graph_digest) return false;
  }
  for (const draft of await rows('crank_workflow_drafts')) {
    if (!workflows.has(draft.workflow_id) || draft.base_version_id && versions.get(draft.base_version_id)?.workflow_id !== draft.workflow_id) return false;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(draft.graph_json));
    if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== draft.graph_digest) return false;
  }
  for (const run of await rows('crank_wf_runs')) if (!workflows.has(run.workflow_id) || versions.get(run.version_id)?.workflow_id !== run.workflow_id) return false;
  const checkpointKey = row => JSON.stringify([row.run_id, row.path, row.operation_key, row.ordinal]);
  const chunks = new Map();
  for (const chunk of await rows('crank_request_checkpoint_chunks')) {
    const key = checkpointKey(chunk), group = chunks.get(key) ?? [];
    group.push(chunk); chunks.set(key, group);
  }
  for (const checkpoint of await rows('crank_request_checkpoints')) {
    try {
      const response = JSON.parse(checkpoint.response_json), url = new URL(response.url);
      const run = (await rows('crank_wf_runs')).find(row => row.id === checkpoint.run_id);
      const graph = run && versions.get(run.version_id)?.graph_json;
      const leaf = checkpoint.path.split('/').at(-1);
      const find = steps => steps.flatMap(step => [step, ...find(step.steps ?? []), ...(step.branches ?? []).flatMap(branch => find(branch.steps ?? [])), ...find(step.fallback?.steps ?? []), ...find(step.always?.steps ?? [])]);
      const step = graph && find(JSON.parse(graph).steps).find(step => step.id === leaf);
      if (!step || !['http','file.fetch'].includes(step.type) && !step.type.startsWith('slack.')) return false;
      const bound = (step.type === 'file.fetch' ? 1 : step.type.startsWith('slack.') ? 4 : 2) * 1024 * 1024;
      if (!Number.isSafeInteger(checkpoint.ordinal) || checkpoint.ordinal < 0 || !/^[a-f0-9]{64}$/.test(checkpoint.request_key) || typeof checkpoint.operation_key !== 'string' || !checkpoint.operation_key) return false;
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
      if (!Number.isSafeInteger(response.body_bytes) || response.body_bytes < 0 || response.body_bytes > bound || response.chunk_count !== Math.ceil(response.body_bytes / 65536) || !Array.isArray(response.headers)) return false;
      const key = checkpointKey(checkpoint), body = (chunks.get(key) ?? []).sort((a, b) => a.chunk_index - b.chunk_index);
      if (body.length !== response.chunk_count) return false;
      let length = 0;
      for (const [index, chunk] of body.entries()) {
        if (chunk.chunk_index !== index || typeof chunk.content_base64 !== 'string') return false;
        const bytes = atob(chunk.content_base64).length;
        if (bytes !== Math.min(65536, response.body_bytes - length)) return false;
        length += bytes;
      }
      if (length !== response.body_bytes) return false;
      chunks.delete(key);
      if (response.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string') || /authorization|cookie|api[-_]?key|token|secret|password|signature/i.test(pair[0]))) return false;
    } catch { return false; }
  }
  if (chunks.size) return false;
  // These product links predate foreign-key declarations; validate them explicitly.
  for (const [child, column, parent] of [
    ['crank_runs', 'flow_id', 'crank_flows'], ['crank_approvals', 'run_id', 'crank_runs'], ['crank_attempts', 'run_id', 'crank_runs'],
    ['crank_grant_escalations', 'run_id', 'crank_wf_runs'], ['crank_request_checkpoints', 'run_id', 'crank_wf_runs'], ['crank_wf_steps', 'run_id', 'crank_wf_runs'], ['crank_wf_step_revisions', 'run_id', 'crank_wf_runs'], ['crank_waits', 'run_id', 'crank_wf_runs'], ['crank_callback_events', 'run_id', 'crank_wf_runs'],
    ['crank_queue_items', 'run_id', 'crank_wf_runs'], ['crank_hold_items', 'hold_id', 'crank_holds'],
    ['crank_historical_batches', 'workflow_id', 'crank_workflows'], ['crank_historical_items', 'batch_id', 'crank_historical_batches'],
  ]) {
    const ids = new Set((await rows(parent)).map(row => row.id));
    if ((await rows(child)).some(row => !ids.has(row[column]))) return false;
  }
  const subjects = new Set([...workflows.keys(), ...(await rows('crank_flows')).map(row => row.id)]);
  for (const hold of await rows('crank_holds')) if (!subjects.has(hold.workflow_id)) return false;
  const allRuns = new Set([...(await rows('crank_wf_runs')).map(row => row.id), ...(await rows('crank_runs')).map(row => row.id)]);
  const estimates = new Map((await rows('crank_usage_version_estimates')).map(row => [row.version_id, row]));
  for (const row of await rows('crank_usage_reservations')) if (!allRuns.has(row.run_id) || estimates.get(row.version_id)?.workflow_id !== row.workflow_id || !subjects.has(row.workflow_id)) return false;
  for (const table of ['crank_usage_observations','crank_usage_provider_charges','crank_usage_reporting_errors','crank_step_admissions']) for (const row of await rows(table)) if (!allRuns.has(row.run_id)) return false;
  for (const table of ['crank_usage_workflow_estimates','crank_usage_version_estimates','crank_usage_flow_versions']) for (const row of await rows(table)) if (!subjects.has(row.workflow_id)) return false;
  for (const skill of await rows('crank_skills')) {
    if (!workflows.has(skill.workflow_id) || versions.get(skill.version_id)?.workflow_id !== skill.workflow_id) return false;
    const pipeline = JSON.parse(skill.pipeline_json);
    if (!Array.isArray(pipeline) || pipeline.length < 1 || pipeline.length > 2 || pipeline.some(op =>
      !['text.trim','text.case','text.strip_html','text.url_decode'].includes(op.fn) || !op.args || typeof op.args !== 'object' || Array.isArray(op.args)
      || Object.keys(op.args).some(key => op.fn === 'text.trim' ? key !== 'collapse' || typeof op.args[key] !== 'boolean' : op.fn === 'text.case' ? key !== 'to' || !['upper','lower','title','sentence'].includes(op.args[key]) : true))) return false;
  }
  const skills = new Map((await rows('crank_skills')).map(row => [row.id, row]));
  const runs = new Map((await rows('crank_wf_runs')).map(row => [row.id,row]));
  for (const sample of await rows('crank_skill_cases')) {
    const skill = skills.get(sample.skill_id), run = runs.get(sample.run_id);
    if (!skill || !run || run.workflow_id !== skill.workflow_id || run.version_id !== skill.version_id) return false;
  }
  const followups = new Map((await rows('crank_agent_followups')).map(row=>[row.id,row]));
  const waits = await rows('crank_waits');
  for (const followup of followups.values()) if (!runs.has(followup.run_id) || !waits.some(wait=>wait.run_id===followup.run_id && wait.path===followup.path && wait.kind==='approval')) return false;
  for (const table of ['crank_agent_followup_recipients','crank_agent_followup_contacts']) for (const row of await rows(table)) if (!followups.has(row.followup_id)) return false;
  return true;
}
