import { createImportOperatorHandler, readImportDoorHistory } from '../modules/import-kit/src/door/operator.ts'
import type { ImportDoorSource } from '../modules/import-kit/src/door/types.ts'
import type { D1Sql } from '../modules/import-kit/src/d1/types.ts'
import { runtimeBindings } from '../auth.server'
import { authority, authorize, requireOwner, requireWriteOrigin } from './access'
import { IMPORT_DESTINATION, importFlowTargets } from './import-target.ts'
import { N8N_MAX_BYTES, N8N_MAX_WORKFLOWS, n8nSource } from './n8n.ts'
import { stmt, type Actor, type CrankEnv } from './model'
import { auditStatementWhen } from './ops/audit'

/** Permanent door key for settings, lineage and history. Never change it. */
export const IMPORT_DOOR_KEY = 'crank'
const OPERATOR = '/api/operator/import/'
const sources: Record<string, (env: CrankEnv, ownerId: string) => ImportDoorSource> = { n8n: n8nSource }
/** The one server-owned allow-list of import sources; each is its own namespace. */
export const importSource = (env: CrankEnv, name: string, ownerId: string) => Object.hasOwn(sources, name) ? sources[name](env, ownerId) : null

const owner = (env: CrankEnv) => stmt(env, "SELECT id,email FROM oa_operators WHERE role='owner' AND status='active' ORDER BY id LIMIT 1").first<{ id: string; email: string }>()
const predicate = (actor: Actor): D1Sql => { const fence = authority(actor, 'owner'); return { sql: fence.sql, params: fence.args } }

/** The signed-in owner's move-in door: upload, plan, reviewed apply, status, reconcile, undo. */
export async function importDoor(request: Request, original: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path.startsWith('/api/rer/import/')) return Response.json({ error: 'not_found' }, { status: 404 })
  if (!path.startsWith(OPERATOR)) return null
  const env = runtimeBindings(original) as CrankEnv, name = request.headers.get('X-Import-Source') ?? '', principal = await owner(env)
  const source = principal ? importSource(env, name, principal.id) : null
  if (!principal || !source) return Response.json({ error: 'unknown_import_source' }, { status: 400 })
  const input = await request.clone().json().catch(() => ({})) as { planId?: unknown }, action = path.slice(OPERATOR.length)
  let actor: Actor | undefined
  const response = await createImportOperatorHandler({
    ...source, database: env.DB as never, targets: importFlowTargets, destination: IMPORT_DESTINATION, format: 'json',
    limits: { maxBytes: N8N_MAX_BYTES, maxRecords: N8N_MAX_WORKFLOWS, maxRecordBytes: N8N_MAX_BYTES },
    ownerPrincipalId: principal.id, installationId: IMPORT_DOOR_KEY, appOrigin: env.AUTH_ORIGIN, ownerEmail: principal.email, namespace: name,
    async authorize(incoming) {
      try {
        const signedIn = await authorize(incoming, env); requireOwner(signedIn); requireWriteOrigin(incoming, env, signedIn)
        if (signedIn.tokenId) return null
        actor = signedIn
        return predicate(signedIn)
      } catch { return null }
    },
  })(request)
  // SEC-003: the finished apply and undo are audited once each, value-free.
  if (response?.ok && actor && typeof input.planId === 'string' && (action === 'apply' || action === 'undo')) {
    const result = await response.clone().json() as { job?: { state?: string } }
    if (result.job?.state === (action === 'apply' ? 'completed' : 'undone'))
      await auditStatementWhen(env, 'NOT EXISTS(SELECT 1 FROM crank_audit WHERE action=? AND subject_id=?)', [`import.${action}`, input.planId], actor.id, `import.${action}`, 'import', input.planId, { source: name }).run()
  }
  return response
}

/** Owner history: door imports with their approvals, newest first. */
export async function importHistory(env: CrankEnv, actor: Actor) {
  return readImportDoorHistory(env.DB as never, IMPORT_DOOR_KEY, predicate(actor))
}
