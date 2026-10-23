import { createErasure, defineErasure, type PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch } from './access'
import { digest, requireValue, stmt, type Actor, type CrankEnv } from './model'
import { auditStatement } from './ops/audit'
import { HELD_FLOW_RUN, HELD_WORKFLOW_RUN } from './legal-holds'

const terminal = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']

/** DATA-003 history expiry runs the same erasure as the maintenance system, under the
 * retention conditions instead of the owner's pause. A run that no longer qualifies is skipped. */
export interface SystemErasure { eligible: string; params: unknown[]; action: string; detail: Record<string, unknown> }
async function systemBatch(env: CrankEnv, statements: D1PreparedStatement[]) {
  try { await env.DB.batch(statements); return true } catch (error) {
    if (/CHECK constraint failed: ok/.test(String(error))) return false
    throw error
  }
}

const eligible = `SELECT 1 FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
  WHERE r.id=? AND w.status='paused' AND r.status IN ('succeeded','failed','stopped_by_filter','stopped_by_search','cancelled','rejected') AND NOT ${HELD_WORKFLOW_RUN}`

/** Erase run values through Base so every deleted row receives a restore fence.
 * Event admission keeps only a digest of the event's deduplication key. */
export async function eraseWorkflowRun(env: CrankEnv, actor: Actor | null, portability: PortabilityFence, runId: string, system?: SystemErasure) {
  const run = await stmt(env, `SELECT r.id,r.workflow_id,r.source_id,r.trigger_kind,r.status,r.repair_of,r.repair_paths_json,w.status AS workflow_status
    FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id WHERE r.id=?`, runId)
    .first<{ id: string; workflow_id: string; source_id: string | null; trigger_kind: string; status: string; repair_of: string | null; repair_paths_json: string | null; workflow_status: string }>()
  requireValue(run, 'Run not found.', 404)
  requireValue(system || run.workflow_status === 'paused' && terminal.includes(run.status), 'Pause the workflow and finish or cancel this run before erasing it.', 409)
  requireValue(system || !await stmt(env, `SELECT 1 FROM crank_wf_runs r WHERE r.id=? AND ${HELD_WORKFLOW_RUN}`, runId).first(), 'This run is under a legal hold. Release the hold before erasing it.', 409)

  const keys = (await stmt(env, `SELECT dedup_key FROM crank_trigger_events WHERE run_id=?
    UNION SELECT item_key AS dedup_key FROM crank_hold_items i JOIN crank_holds h ON h.id=i.hold_id WHERE i.run_id=? AND h.source='webhook'
    UNION SELECT source_id AS dedup_key FROM crank_wf_runs WHERE id=? AND trigger_kind='webhook' AND source_id IS NOT NULL`, runId, runId, runId)
    .all<{ dedup_key: string }>()).results
  const markers = await Promise.all(keys.map(async key => digest(key.dedup_key)))
  const service = createErasure({ db: env.DB, portability, declarations: [defineErasure({
    entity: 'workflow-run', root: { table: 'crank_wf_runs' },
    edges: [
      ...['crank_notice_deliveries', 'crank_gateway_tasks', 'crank_custom_hook_checks', 'crank_executor_tasks', 'crank_grant_escalations', 'crank_grant_admissions', 'crank_skill_cases', 'crank_wf_steps', 'crank_blind_index', 'crank_wf_step_revisions', 'crank_waits', 'crank_wf_attempts', 'crank_obligations', 'crank_callback_events', 'crank_queue_items', 'crank_hold_items', 'crank_historical_items', 'crank_ops_events', 'crank_request_admissions', 'crank_request_checkpoints', 'crank_request_checkpoint_chunks', 'crank_usage_observations', 'crank_usage_provider_charges', 'crank_usage_reporting_errors', 'crank_usage_reservations', 'crank_step_admissions']
        .map(table => ({ table, from: 'crank_wf_runs', on: { run_id: 'id' } })),
      { table: 'crank_notice_attempts', from: 'crank_notice_deliveries', on: {delivery_id:'id'} },
      { table: 'crank_agent_followups', from: 'crank_wf_runs', on: {run_id:'id'} },
      ...['crank_agent_followup_recipients','crank_agent_followup_contacts','crank_agent_followup_authorizations'].map(table=>({table,from:'crank_agent_followups',on:{followup_id:'id'}})),
      { table: 'crank_trigger_events', from: 'crank_wf_runs', on: { run_id: 'id' } },
      // Uploaded and connector files belong to the run whose trigger or step output names them.
      { table: 'crank_files', from: 'crank_wf_runs', where: 'workflow_id=? AND instr(?,id)>0', params: ['workflow_id', 'trigger_json'] },
      { table: 'crank_files', from: 'crank_wf_steps', where: "instr(COALESCE(?,''),id)>0", params: ['output_json'] },
      // Released hold items retain their original event key even when the event
      // row has no run link. Include that copy in the same erasure journal.
      { table: 'crank_trigger_events', from: 'crank_hold_items', where: 'dedup_key=? AND workflow_id=(SELECT workflow_id FROM crank_holds WHERE id=?)', params: ['item_key', 'hold_id'] },
    ],
    audit: [{table:'crank_audit',column:'subject_id',of:'crank_agent_followups',where:"subject_kind='followup'",clear:{detail_json:'{}'}}, { table: 'crank_audit', column: 'subject_id', of: 'crank_wf_runs', where: "subject_kind='run'", clear: { detail_json: '{}' } }],
    retain: [{table:'crank_task_idempotency',reason:'Hash-and-ID-only task receipts prevent an erased task from being dispatched again by a lost-response retry.'}, {table:'crank_agent_followup_admissions',reason:'Value-free person-digest/day receipts prevent erasure from funding more contacts.'}, { table: 'crank_usage_spend', reason: 'Value-free per-scope UTC-month debit totals are retained so erasure cannot replenish an allowance.' }, { table: 'crank_erased_webhook_events', reason: 'An opaque event-key digest permanently blocks redelivery. Existing effects in receiving apps remain under their custody.' }],
    beforeStatements: async () => [
      system ? stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT 'erase-workflow:'||?1,CASE WHEN EXISTS(${system.eligible}) THEN 1 ELSE 0 END`, ...system.params)
        : stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT 'erase-workflow:'||?,CASE WHEN EXISTS(${eligible}) THEN 1 ELSE 0 END`, runId, runId),
      ...markers.map(marker => stmt(env, 'INSERT OR IGNORE INTO crank_erased_webhook_events(workflow_id,event_digest) VALUES(?,?)', run.workflow_id, marker)),
    ],
  })] })
  const prepared = await service.nativeStatements('workflow-run', { id: runId })
  const statements = [
    // Older imported archives may predate source-held claims. Spend their
    // selection before deleting the only linked repair row that records it.
    ...(run.repair_of ? [stmt(env, `UPDATE crank_wf_runs SET repaired_paths_json=(SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(repaired_paths_json) UNION SELECT value FROM json_each(?)
    )) WHERE id=?`, run.repair_paths_json ?? '[]', run.repair_of)] : []),
    ...prepared.statements.map(s => stmt(env, s.sql, ...s.params)),
    stmt(env, "DELETE FROM crank_authority_guards WHERE id='erase-workflow:'||?", runId),
  ]
  if (system) {
    if (!await systemBatch(env, [...statements, auditStatement(env, 'system:retention', system.action, 'erasure', prepared.operationId, system.detail)])) return null
  } else await guardedBatch(env, actor!, 'owner', [...statements, auditStatement(env, actor!.id, 'data.erase', 'erasure', prepared.operationId, { entity: 'workflow-run' })])
  return service.deleteBlobs(prepared.operationId)
}

/** Erase one finished flow run (the original approval flows) through Base, with its event fence. */
export async function eraseFlowRun(env: CrankEnv, actor: Actor | null, portability: PortabilityFence, runId: string, system?: SystemErasure) {
  const row = await env.DB.prepare('SELECT r.*,f.status AS flow_status FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id WHERE r.id=?').bind(runId).first<{id:string;flow_id:string;event_id:string;state:string;flow_status:string}>()
  requireValue(row,'Run not found.',404)
  requireValue(system || row.flow_status === 'draft' && ['succeeded','failed','rejected'].includes(row.state),'Pause the flow and finish or reject this run before erasing it.',409)
  requireValue(system || !await stmt(env,`SELECT 1 FROM crank_runs r WHERE r.id=? AND ${HELD_FLOW_RUN}`,row.id).first(),'This run is under a legal hold. Release the hold before erasing it.',409)
  const marker = await digest(row.event_id)
  const service = createErasure({db:env.DB,portability,declarations:[defineErasure({
    entity:'run',root:{table:'crank_runs'},
    edges:[...['crank_usage_observations','crank_usage_provider_charges', 'crank_usage_reporting_errors','crank_usage_reservations','crank_hold_items'].map(table=>({table,from:'crank_runs',on:{run_id:'id'}})),{table:'crank_approvals',from:'crank_runs',on:{run_id:'id'}},{table:'crank_attempts',from:'crank_runs',on:{run_id:'id'}}],
    audit:[{table:'crank_audit',column:'subject_id',of:'crank_runs',where:"subject_kind='flow_run'",clear:{detail_json:'{}'}}],
    retain:[{table:'crank_usage_spend',reason:'Value-free per-scope UTC-month debit totals are retained so erasure cannot replenish an allowance.'},{table:'crank_erased_events',reason:'An opaque event digest blocks redelivery of the erased event. The receiving app owns its existing effect.'}],
    beforeStatements:async()=>[
      system ? env.DB.prepare(`INSERT INTO crank_authority_guards(id,ok) SELECT 'erase:'||?1,CASE WHEN EXISTS(${system.eligible}) THEN 1 ELSE 0 END`).bind(...system.params)
        : env.DB.prepare(`INSERT INTO crank_authority_guards(id,ok) SELECT 'erase:'||?,CASE WHEN EXISTS(SELECT 1 FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id WHERE r.id=? AND r.state IN ('succeeded','failed','rejected') AND f.status='draft' AND NOT ${HELD_FLOW_RUN}) THEN 1 ELSE 0 END`).bind(row.id,row.id),
      env.DB.prepare('INSERT OR IGNORE INTO crank_erased_events(flow_id,event_digest) VALUES(?,?)').bind(row.flow_id,marker),
    ],
  })]})
  const prepared = await service.nativeStatements('run',{id:row.id})
  const statements=[...prepared.statements.map(s=>env.DB.prepare(s.sql).bind(...s.params)),
    env.DB.prepare("DELETE FROM crank_authority_guards WHERE id='erase:'||?").bind(row.id)]
  if (system) {
    if (!await systemBatch(env,[...statements,auditStatement(env,'system:retention',system.action,'erasure',prepared.operationId,system.detail)])) return null
  } else await guardedBatch(env,actor!,'owner',[...statements,auditStatement(env,actor!.id,'data.erase','erasure',prepared.operationId,{entity:'run'})])
  return service.deleteBlobs(prepared.operationId)
}
