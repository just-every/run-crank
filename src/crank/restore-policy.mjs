import { validatePureRecipe } from './workflows/recipe-definition.mjs';
import { validateSubflowDefinition } from './workflows/subflow-definition.mjs';
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
  (row.type === 'ai.classify' || row.type === 'orbit.update_deal' || row.type.startsWith('nook.') || row.type.startsWith('slack.') || row.type.startsWith('google_calendar.') || row.type.startsWith('quickbooks.') || row.type.startsWith('gusto.') || row.type === 'http' && !['GET', 'HEAD'].includes(String(JSON.parse(row.input_json ?? '{}').method ?? 'GET').toUpperCase()));

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
  crank_digests: { active: [0] },
  crank_digest_operations: { active: [0] },
  crank_workflow_samples: { selected: [0] },
  crank_recurring_tasks: { status: ['inactive'] },
  crank_state_tables: { active: [0] },
  crank_state_operations: { active: [0] },
  crank_subflow_versions: { active: [0] },
  crank_subflow_calls: {status:['interrupted'],lease_id:[null],lease_expires_at:[null]},
  crank_notice_deliveries: { active: [0], lease_id: [null], lease_expires_at: [null] },
  crank_gateways: {status:['revoked'],code_hash:[null],code_expires_at:[null],credential_hash:[null],public_key:[null],fingerprint:[null]},
  crank_gateway_grants: {status:['revoked']},
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
  crank_polls: { next_due_at: [distant], subscription_json: [null] },
  crank_schedules: { next_due_at: [distant] },
};

/** Bounded import normalization for archives written before (or without) the
 * export fence: activation off, adoption required, replay authority spent.
 * A run-level pause reason or a failed delivery's outcome cannot be carried in a
 * bounded value, so an unfenced unfinished run keeps only its previous status and
 * a failed delivery keeps its outcome with its single replay marked used. */
export function importRow(table, row) {
  if (table === 'crank_digests' || table === 'crank_digest_operations') return {...row,active:0};
  if (table === 'crank_workflow_samples') return {...row,selected:0};
  if (table === 'crank_recurring_tasks') return {...row,status:'inactive'};
  if (table === 'crank_state_tables' || table === 'crank_state_operations') return {...row,active:0};
  if (table === 'crank_subflow_calls') return {...row,...(['queued','running','paused'].includes(row.status) ? {status:'interrupted'} : {}),lease_id:null,lease_expires_at:null};
  if (table === 'crank_subflow_versions') return {...row,active:0};
  if (table === 'crank_notice_deliveries') return {...row,active:0,lease_id:null,lease_expires_at:null};
  if(table==='crank_gateways')return {...Object.fromEntries(Object.entries(row).map(([key,value])=>[key,['code_hash','code_expires_at','credential_hash','public_key','fingerprint'].includes(key)?null:value])),status:'revoked'};
  if(table==='crank_gateway_grants')return {...row,status:'revoked'};
  if (table === 'crank_custom_versions') return {...row,status:'needs_review',sandbox_json:null};
  if (table === 'crank_executor_tasks') return {...row,active:0};
  if (table === 'crank_drift_incidents') return {...row,state:'inactive'};
  if (table === 'crank_drift_proposals') return {...row,status:'inactive',test_bindings_json:'{}'};
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
  if (table === 'crank_polls') return { ...row, next_due_at: distant, subscription_json: null };
  if (table === 'crank_schedules') return { ...row, next_due_at: distant };
  return row;
}

/** Semantic checks on the normalized staging rows, before the atomic commit.
 * They cover the same rows on browser and CLI restore. */
export async function validateRestore({ read }) {
  const cache = new Map();
  const rows = async table => { if (!cache.has(table)) cache.set(table, await read(table)); return cache.get(table); };
  for (const row of await rows('crank_custom_versions')) {
    const definition=JSON.parse(row.definition_json);
    if(definition.id!==row.id || definition.version!==row.version || !Array.isArray(definition.operations))return false;
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.definition_json));
    if(Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')!==row.definition_digest)return false;
  }
  const stateTables = new Set((await rows('crank_state_tables')).map(row=>row.id));
  const stateRecords = new Set();
  for (const row of await rows('crank_state_records')) {
    let value; try { value=JSON.parse(row.value_json); } catch { return false; }
    if(!stateTables.has(row.table_id) || !/^[a-z][a-z0-9_]{0,59}$/.test(row.record_key) || !(Number.isSafeInteger(value) || Array.isArray(value)&&value.length<=1000&&value.every(Number.isSafeInteger)))return false;
    stateRecords.add(row.id);
  }
  for(const row of await rows('crank_state_operations'))if(!stateRecords.has(row.record_id))return false;
  const subflows = new Map((await rows('crank_subflow_versions')).map(row => [row.id, row]));
  const subflowRefs = steps => Array.isArray(steps) && steps.every(step => step && typeof step==='object' &&
    (step.type!=='subflow' || subflows.has(step.subflow_id+':'+step.subflow_version)) &&
    (!['table.atomic','table.lookup'].includes(step.type) || stateTables.has(step.table_id)) &&
    (step.type!=='loop' || subflowRefs(step.steps)) &&
    (step.type!=='paths' || (Array.isArray(step.branches) && step.branches.every(branch=>subflowRefs(branch.steps)) && (!step.fallback || subflowRefs(step.fallback.steps)) && (!step.always || subflowRefs(step.always.steps)))));
  for (const row of subflows.values()) {
    try {
      validateSubflowDefinition(JSON.parse(row.definition_json));
      if (row.recipe_json) {
        const recipe = JSON.parse(row.recipe_json); validatePureRecipe(recipe);
        if (JSON.stringify(recipe.definition) !== JSON.stringify(JSON.parse(row.definition_json))) return false;
      }
    } catch { return false; }
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.definition_json));
    if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== row.definition_digest || row.id !== row.subflow_id + ':' + row.version) return false;
  }
  for (const row of await rows('crank_subflow_calls')) {
    if (!subflows.has(row.subflow_version_id) || !(await rows('crank_wf_runs')).some(run=>run.id===row.run_id) || !(await rows('crank_wf_steps')).some(step=>step.run_id===row.run_id && step.path===row.path && step.type==='subflow' && step.operation_key===row.operation_key)) return false;
  }
  const workflows = new Map((await rows('crank_workflows')).map(row => [row.id, row]));
  for (const sample of await rows('crank_workflow_samples')) {
    if (!workflows.has(sample.workflow_id) || !['manual','webhook','history','schema'].includes(sample.source) || sample.source === 'history' && !(await rows('crank_wf_runs')).some(run => run.id === sample.source_id && run.workflow_id === sample.workflow_id)) return false;
    try { JSON.parse(sample.payload_json); JSON.parse(sample.uploads_json); } catch { return false; }
  }
  for (const fields of await rows('crank_sample_fields')) if (!workflows.has(fields.workflow_id) || !Array.isArray(JSON.parse(fields.fields_json))) return false;
  for (const row of await rows('crank_app_field_values')) if (!workflows.has(row.workflow_id) || !/^[a-f0-9]{64}$/.test(row.record_id) || !/^[a-f0-9]{64}$/.test(row.value_digest) || !Number.isFinite(Date.parse(row.first_seen_at))) return false;
  for (const row of await rows('crank_app_pending_rows')) if (!workflows.has(row.workflow_id) || !/^[a-f0-9]{64}$/.test(row.record_id) || !/^[a-f0-9]{64}$/.test(row.value_digest) || !Number.isFinite(Date.parse(row.stable_since))) return false;
  for (const row of await rows('crank_app_snapshots')) if (row.observed_at != null && !Number.isFinite(Date.parse(row.observed_at))) return false;
  for (const row of await rows('crank_app_subjects')) if (!workflows.has(row.workflow_id) || !/^[a-f0-9]{64}$/.test(row.record_id) || !/^[a-f0-9]{64}$/.test(row.record_subject_digest)) return false;
  const erasedAppRecords = new Set();
  for (const row of await rows('crank_app_erased_records')) {
    if (!workflows.has(row.workflow_id) || !/^[a-f0-9]{64}$/.test(row.record_id)) return false;
    erasedAppRecords.add(JSON.stringify([row.workflow_id,row.record_id]));
  }
  for (const table of ['crank_app_field_values','crank_app_snapshots','crank_app_pending_rows','crank_app_subjects']) for (const row of await rows(table)) if (erasedAppRecords.has(JSON.stringify([row.workflow_id,row.record_id]))) return false;
  const versions = new Map((await rows('crank_workflow_versions')).map(row => [row.id, row]));
  for (const row of await rows('crank_app_pending_rows')) if (versions.get(row.version_id)?.workflow_id !== row.workflow_id) return false;
  for (const workflow of workflows.values()) {
    const graph = JSON.parse(workflow.draft_json);
    if (!graph.trigger || !Array.isArray(graph.steps) || workflow.published_version_id && versions.get(workflow.published_version_id)?.workflow_id !== workflow.id) return false;
  }
  for (const version of versions.values()) {
    if (!subflowRefs(JSON.parse(version.graph_json).steps)) return false;
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
      if (step?.type === 'custom.request') {
        const definitionRow=(await rows('crank_custom_versions')).find(row=>row.id===step.connector_id && row.version===step.connector_version)
        const operations=definitionRow && JSON.parse(definitionRow.definition_json).operations
        const search=operations?.find(op=>op.id===step.operation)
        const allowed=[search?.id,search?.find_or_create?.operation].filter(Boolean)
        if (!step.gateway_id || !search?.gateway || response.body_bytes>65536 || !allowed.some(operation=>url.pathname===`/api/crank/gateways/${encodeURIComponent(step.gateway_id)}/operations/${encodeURIComponent(operation)}/pages/0`)) return false;
      }
      if (!step || !['http','file.fetch','custom.request','gmail.search_threads'].includes(step.type) && !step.type.startsWith('orbit.') && !step.type.startsWith('nook.') && !step.type.startsWith('slack.') && !step.type.startsWith('quickbooks.') && !step.type.startsWith('gusto.')) return false;
      const bound = (step.type === 'file.fetch' || step.type === 'nook.send_message' || step.type.startsWith('orbit.') ? 1 : step.type.startsWith('slack.') ? 4 : 2) * 1024 * 1024;
      if (!Number.isSafeInteger(checkpoint.ordinal) || checkpoint.ordinal < 0 || !/^[a-f0-9]{64}$/.test(checkpoint.request_key) || typeof checkpoint.operation_key !== 'string' || !checkpoint.operation_key) return false;
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
      if (!Number.isSafeInteger(response.body_bytes) || response.body_bytes < 0 || response.body_bytes > bound || response.chunk_count !== Math.ceil(response.body_bytes / 65536) || !Array.isArray(response.headers)) return false;
      const key = checkpointKey(checkpoint), body = (chunks.get(key) ?? []).sort((a, b) => a.chunk_index - b.chunk_index);
      if (body.length !== response.chunk_count) return false;
      let length = 0;
      for (const [index, chunk] of body.entries()) {
        if (chunk.chunk_index !== index || typeof chunk.content_base64 !== 'string') return false;
        const expected = Math.min(65536, response.body_bytes - length);
        let bytes;
        if (chunk.content_base64.startsWith('{"sealed":"crank-payload-v1"')) {
          const envelope = JSON.parse(chunk.content_base64);
          if (!run.payload_key || envelope.k !== run.payload_key || !['customer','financial','health'].includes(envelope.c) || atob(envelope.iv).length !== 12 || atob(envelope.ct).length !== 4 * Math.ceil(expected / 3) + 18) return false;
          bytes = expected;
        } else bytes = atob(chunk.content_base64).length;
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
  const driftIncidents=new Map((await rows('crank_drift_incidents')).map(row=>[row.id,row]));
  const driftProposals=new Map((await rows('crank_drift_proposals')).map(row=>[row.id,row]));
  for(const incident of driftIncidents.values()) if(runs.get(incident.run_id)?.workflow_id!==incident.workflow_id || versions.get(incident.version_id)?.workflow_id!==incident.workflow_id)return false;
  for(const proposal of driftProposals.values()) if(driftIncidents.get(proposal.incident_id)?.workflow_id!==proposal.workflow_id || versions.get(proposal.version_id)?.workflow_id!==proposal.workflow_id || proposal.approved_version_id && versions.get(proposal.approved_version_id)?.workflow_id!==proposal.workflow_id)return false;
  for(const sample of await rows('crank_drift_cases')) if(!driftProposals.has(sample.proposal_id) || !runs.has(sample.source_run_id) || sample.test_run_id && !runs.has(sample.test_run_id))return false;
  for(const continuation of await rows('crank_drift_continuations')) if(!driftProposals.has(continuation.proposal_id) || !runs.has(continuation.run_id) || !versions.has(continuation.source_version_id) || !versions.has(continuation.repaired_version_id))return false;
  const followups = new Map((await rows('crank_agent_followups')).map(row=>[row.id,row]));
  const waits = await rows('crank_waits');
  for (const followup of followups.values()) if (!runs.has(followup.run_id) || !waits.some(wait=>wait.run_id===followup.run_id && wait.path===followup.path && wait.kind==='approval')) return false;
  for (const table of ['crank_agent_followup_recipients','crank_agent_followup_contacts']) for (const row of await rows(table)) if (!followups.has(row.followup_id)) return false;
  const digests = new Set((await rows('crank_digests')).map(row=>row.id));
  for (const table of ['crank_digest_entries','crank_digest_operations']) for (const row of await rows(table)) if (!digests.has(row.digest_id)) return false;
  for (const row of await rows('crank_digest_entries')) { try { JSON.parse(row.value_json); } catch { return false; } if (!runs.has(row.source_run_id)) return false; }
  for (const row of await rows('crank_digest_operations')) { try { JSON.parse(row.result_json); } catch { return false; } if (!runs.has(row.run_id)) return false; }
  return true;
}
