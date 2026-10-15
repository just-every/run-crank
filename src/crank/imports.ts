import { planD1Import, createD1ImportJob } from '../modules/import-kit/src/d1/jobs.ts'
import { applyD1ImportBatches } from '../modules/import-kit/src/d1/apply.ts'
import { undoD1Import, rollbackD1Import } from '../modules/import-kit/src/d1/reverse.ts'
import { canonicalJson, sha256 } from '../modules/import-kit/src/provenance/identity.ts'
import type { D1Database, D1ImportContext } from '../modules/import-kit/src/d1/types.ts'
import type { ImportMapping } from '../modules/import-kit/src/types.ts'
import { IMPORT_DESTINATION, importFlowTargets, type ImportTargetEnv } from './import-target.ts'
import { readN8nSource, N8N_MAPPING_VERSION, N8N_MAX_WORKFLOWS } from './n8n.ts'

export interface ImportEnv extends ImportTargetEnv { DB: D1Database }
export interface N8nInput { namespace: string; source: string }
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

async function makePlan(env: ImportEnv, actorId: string, input: N8nInput) {
  const { bundle, workflows } = await readN8nSource(env, input.namespace, input.source)
  const byId = new Map(workflows.map(workflow => [workflow.sourceId, workflow]))
  const mapping: ImportMapping = { version: N8N_MAPPING_VERSION, map(record) {
    const workflow = byId.get(record.sourceId)
    if (!workflow) throw new Error('N8N_SOURCE_MAPPING_MISSING')
    return { effects: [{ targetKind: 'flow', targetId: `import-${sha256(canonicalJson([input.namespace, record.sourceId]))}`, value: {
      name: workflow.name, source_app: 'n8n', destination_app: 'HTTP inbox', target_url: workflow.targetUrl, created_by: actorId, status: 'draft', revision: 1,
    } }] }
  } }
  const ctx = context(env, actorId, input.namespace)
  return { plan: await planD1Import(bundle, mapping, ctx), ctx, workflows }
}

export async function planN8n(env: ImportEnv, actorId: string, input: N8nInput) {
  const { plan, workflows } = await makePlan(env, actorId, input)
  return {
    fingerprint: plan.fingerprint,
    summary: { workflows: workflows.length, drafts: workflows.length, source: 'n8n', destination: 'HTTP inbox', activationRequired: true },
    workflows, warnings: ['All flows remain drafts. Review the new webhook address, then explicitly activate each flow. The original n8n webhook URL is not retained as a live endpoint.'],
  }
}

/** The caller submits the fingerprint from an explicit human approval. The
 * reviewed plan is recomputed, recorded durably, then applied by Base's engine. */
export async function applyN8n(env: ImportEnv, actorId: string, input: N8nInput & { fingerprint: string }) {
  const { plan, ctx } = await makePlan(env, actorId, input)
  if (typeof input.fingerprint !== 'string' || input.fingerprint !== plan.fingerprint) throw new Error('REVIEW_FINGERPRINT_MISMATCH')
  ctx.reviewedFingerprint = input.fingerprint
  ctx.operationKey = `n8n:${input.fingerprint}`
  const job = await createD1ImportJob(plan, ctx)
  // Approval and owner/fingerprint fences share a D1 transaction. A queued job
  // without an approval can never produce native flows through this API.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ik_d1_assertions(ok) SELECT CASE WHEN ${OWNER_SQL} AND EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND fingerprint=? AND principal_id=?) THEN 1 ELSE 0 END`).bind(actorId, job.id, input.fingerprint, actorId),
    env.DB.prepare("INSERT INTO crank_import_approvals(job_id,fingerprint,approved_by,approved_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(job_id) DO NOTHING").bind(job.id, input.fingerprint, actorId),
    env.DB.prepare('DELETE FROM ik_d1_assertions'),
  ])
  ctx.authorization.predicate = () => ({
    sql: `${OWNER_SQL} AND EXISTS(SELECT 1 FROM crank_import_approvals a JOIN ik_jobs j ON j.id=a.job_id WHERE a.job_id=? AND a.fingerprint=? AND j.fingerprint=a.fingerprint AND a.approved_by=? AND j.principal_id=a.approved_by)`,
    params: [actorId, job.id, input.fingerprint, actorId],
  })
  return applyD1ImportBatches(job.id, ctx)
}

/** HTTP callers enforce owner access before listing this installation's journal. */
export async function listImportJobs(env: ImportEnv) {
  const { results } = await env.DB.prepare(`SELECT j.id,j.fingerprint,j.namespace,j.state,j.checkpoint,j.total,j.error,
    a.approved_by AS approvedBy,a.approved_at AS approvedAt FROM ik_jobs j
    LEFT JOIN crank_import_approvals a ON a.job_id=j.id
    WHERE j.destination=? AND j.mapping_version=? ORDER BY j.rowid DESC LIMIT 100`).bind(IMPORT_DESTINATION, N8N_MAPPING_VERSION).all()
  return results
}

export async function undoN8n(env: ImportEnv, actorId: string, jobId: string) {
  const job = await env.DB.prepare('SELECT namespace,state FROM ik_jobs WHERE id=? AND destination=? AND mapping_version=?').bind(jobId, IMPORT_DESTINATION, N8N_MAPPING_VERSION).first()
  if (!job) throw new Error('IMPORT_JOB_NOT_FOUND')
  const ctx = context(env, actorId, job.namespace)
  // Partial imports can be reversed too. Base persists intent and progress;
  // strict native matches fence edits, activation and every recorded flow run.
  return ['completed', 'undoing', 'undone'].includes(job.state) ? undoD1Import(jobId, ctx) : rollbackD1Import(jobId, ctx)
}
