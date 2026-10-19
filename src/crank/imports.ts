import { undoD1Import, rollbackD1Import } from '../modules/import-kit/src/d1/reverse.ts'
import type { D1Database, D1ImportContext } from '../modules/import-kit/src/d1/types.ts'
import { IMPORT_DESTINATION, importFlowTargets, type ImportTargetEnv } from './import-target.ts'
import { N8N_MAPPING_VERSION, N8N_MAX_WORKFLOWS } from './n8n.ts'
import type { CrankEnv } from './model'
import { auditStatement } from './ops/audit'

export interface ImportEnv extends ImportTargetEnv { DB: D1Database }
const OWNER_SQL = "EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND role='owner' AND status='active')"

function context(env: ImportEnv, actorId: string, namespace: string): D1ImportContext {
  if (typeof actorId !== 'string' || !actorId) throw new Error('IMPORT_ACTOR_REQUIRED')
  return {
    destination: IMPORT_DESTINATION, namespace, mappingVersion: N8N_MAPPING_VERSION,
    batchSize: N8N_MAX_WORKFLOWS, maxBatches: 1,
    storage: { database: env.DB, targets: importFlowTargets },
    authorization: { principalId: actorId, predicate: () => ({ sql: OWNER_SQL, params: [actorId] }) },
  }
}

/** Jobs approved through Crank's earlier n8n importer, before the shared door.
 * HTTP callers enforce owner access before listing this installation's journal. */
export async function listImportJobs(env: ImportEnv) {
  const { results } = await env.DB.prepare(`SELECT j.id,j.fingerprint,j.namespace,j.state,j.checkpoint,j.total,j.error,
    a.approved_by AS approvedBy,a.approved_at AS approvedAt FROM ik_jobs j
    JOIN crank_import_approvals a ON a.job_id=j.id
    WHERE j.destination=? AND j.mapping_version=? ORDER BY j.rowid DESC LIMIT 100`).bind(IMPORT_DESTINATION, N8N_MAPPING_VERSION).all()
  return results
}

export async function undoLegacyImport(env: ImportEnv, actorId: string, jobId: string) {
  const job = await env.DB.prepare('SELECT j.namespace,j.state FROM ik_jobs j JOIN crank_import_approvals a ON a.job_id=j.id WHERE j.id=? AND j.destination=? AND j.mapping_version=?').bind(jobId, IMPORT_DESTINATION, N8N_MAPPING_VERSION).first()
  if (!job) throw new Error('IMPORT_JOB_NOT_FOUND')
  const ctx = context(env, actorId, job.namespace)
  // Partial imports can be reversed too. Base persists intent and progress;
  // strict native matches fence edits, activation and every recorded flow run.
  const result = await (['completed', 'undoing', 'undone'].includes(job.state) ? undoD1Import(jobId, ctx) : rollbackD1Import(jobId, ctx))
  await auditStatement(env as CrankEnv, actorId, 'import.undo', 'import', jobId).run()
  return result
}
