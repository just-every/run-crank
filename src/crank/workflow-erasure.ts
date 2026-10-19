import { createErasure, defineErasure, type PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch } from './access'
import { digest, requireValue, stmt, type Actor, type CrankEnv } from './model'
import { auditStatement } from './ops/audit'

const terminal = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']
const eligible = `SELECT 1 FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
  WHERE r.id=? AND w.status='paused' AND r.status IN ('succeeded','failed','stopped_by_filter','stopped_by_search','cancelled','rejected')`

/** Erase run values through Base so every deleted row receives a restore fence.
 * Event admission keeps only a digest of the event's deduplication key. */
export async function eraseWorkflowRun(env: CrankEnv, actor: Actor, portability: PortabilityFence, runId: string) {
  const run = await stmt(env, `SELECT r.id,r.workflow_id,r.source_id,r.trigger_kind,r.status,w.status AS workflow_status
    FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id WHERE r.id=?`, runId)
    .first<{ id: string; workflow_id: string; source_id: string | null; trigger_kind: string; status: string; workflow_status: string }>()
  requireValue(run, 'Run not found.', 404)
  requireValue(run.workflow_status === 'paused' && terminal.includes(run.status), 'Pause the workflow and finish or cancel this run before erasing it.', 409)

  const keys = (await stmt(env, `SELECT dedup_key FROM crank_trigger_events WHERE run_id=?
    UNION SELECT item_key AS dedup_key FROM crank_hold_items i JOIN crank_holds h ON h.id=i.hold_id WHERE i.run_id=? AND h.source='webhook'
    UNION SELECT source_id AS dedup_key FROM crank_wf_runs WHERE id=? AND trigger_kind='webhook' AND source_id IS NOT NULL`, runId, runId, runId)
    .all<{ dedup_key: string }>()).results
  const markers = await Promise.all(keys.map(async key => digest(key.dedup_key)))
  const service = createErasure({ db: env.DB, portability, declarations: [defineErasure({
    entity: 'workflow-run', root: { table: 'crank_wf_runs' },
    edges: [
      ...['crank_wf_steps', 'crank_wf_step_revisions', 'crank_waits', 'crank_wf_attempts', 'crank_obligations', 'crank_callback_events', 'crank_queue_items', 'crank_hold_items', 'crank_historical_items', 'crank_ops_events', 'crank_request_admissions']
        .map(table => ({ table, from: 'crank_wf_runs', on: { run_id: 'id' } })),
      { table: 'crank_trigger_events', from: 'crank_wf_runs', on: { run_id: 'id' } },
      // Released hold items retain their original event key even when the event
      // row has no run link. Include that copy in the same erasure journal.
      { table: 'crank_trigger_events', from: 'crank_hold_items', where: 'dedup_key=? AND workflow_id=(SELECT workflow_id FROM crank_holds WHERE id=?)', params: ['item_key', 'hold_id'] },
    ],
    audit: [{ table: 'crank_audit', column: 'subject_id', of: 'crank_wf_runs', where: "subject_kind='run'", clear: { detail_json: '{}' } }],
    retain: [{ table: 'crank_erased_webhook_events', reason: 'An opaque event-key digest permanently blocks redelivery. Existing effects in receiving apps remain under their custody.' }],
    beforeStatements: async () => [
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT 'erase-workflow:'||?,CASE WHEN EXISTS(${eligible}) THEN 1 ELSE 0 END`, runId, runId),
      ...markers.map(marker => stmt(env, 'INSERT OR IGNORE INTO crank_erased_webhook_events(workflow_id,event_digest) VALUES(?,?)', run.workflow_id, marker)),
    ],
  })] })
  const prepared = await service.nativeStatements('workflow-run', { id: runId })
  await guardedBatch(env, actor, 'owner', [
    ...prepared.statements.map(s => stmt(env, s.sql, ...s.params)),
    stmt(env, "DELETE FROM crank_authority_guards WHERE id='erase-workflow:'||?", runId),
    auditStatement(env, actor.id, 'data.erase', 'erasure', prepared.operationId, { entity: 'workflow-run' }),
  ])
  return service.deleteBlobs(prepared.operationId)
}
