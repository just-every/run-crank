import { createImportDoorHandler, createImportOperatorHandler, readImportDoorHistory, writeImportDoorSettings } from '../modules/import-kit/src/door/index.ts'
import { schemaCurrent } from '../modules/import-kit/src/door/store.ts'
import { DoorError } from '../modules/import-kit/src/door/protocol.ts'
import type { ImportDoorSource } from '../modules/import-kit/src/door/types.ts'
import type { D1Sql } from '../modules/import-kit/src/d1/types.ts'
import { runtimeBindings } from '../auth.server'
import { authority, authorize, requireOwner, requireWriteOrigin } from './access'
import { IMPORT_DESTINATION, importFlowTargets } from './import-target.ts'
import { N8N_MAX_BYTES, N8N_MAX_WORKFLOWS, n8nSource } from './n8n.ts'
import { stmt, type Actor, type CrankEnv } from './model'
import { auditStatement, auditStatementWhen } from './ops/audit'

/** Permanent door key for settings, lineage and history. Never change it. */
export const IMPORT_DOOR_KEY = 'crank'
const OPERATOR = '/api/operator/import/'
const sources: Record<string, (env: CrankEnv, ownerId: string) => ImportDoorSource> = { n8n: n8nSource }
/** The one server-owned allow-list of import sources; each is its own namespace. */
export const importSource = (env: CrankEnv, name: string, ownerId: string) => Object.hasOwn(sources, name) ? sources[name](env, ownerId) : null

const SETTINGS = '/api/operator/import-settings'
const runtime = (env: CrankEnv, ownerPrincipalId: string) => ({ database: env.DB as never, targets: importFlowTargets, destination: IMPORT_DESTINATION, format: 'json' as const,
  limits: { maxBytes: N8N_MAX_BYTES, maxRecords: N8N_MAX_WORKFLOWS, maxRecordBytes: N8N_MAX_BYTES }, ownerPrincipalId })
const owner = (env: CrankEnv) => stmt(env, "SELECT id,email FROM oa_operators WHERE role='owner' AND status='active' ORDER BY id LIMIT 1").first<{ id: string; email: string }>()
const predicate = (actor: Actor): D1Sql => { const fence = authority(actor, 'owner'); return { sql: fence.sql, params: fence.args } }

/** The signed-in owner's move-in door: upload, plan, reviewed apply, status, reconcile, undo. */
export async function importDoor(request: Request, original: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const env = runtimeBindings(original) as CrankEnv
  if (path === SETTINGS) return importSettings(request, env)
  if (path.startsWith('/api/rer/import/')) {
    // Business grants: only with RER's trusted key ring, and only once the owner enables them.
    const principal = await owner(env)
    if (!env.RER_OWNER_CLAIM_PUBLIC_KEYS || !principal) return Response.json({ error: 'not_found' }, { status: 404 })
    return createImportDoorHandler({ ...runtime(env, principal.id), source: name => importSource(env, name, principal.id), installationId: IMPORT_DOOR_KEY,
      claim: { issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '', appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) },
    })(request)
  }
  if (!path.startsWith(OPERATOR)) return null
  const name = request.headers.get('X-Import-Source') ?? '', principal = await owner(env)
  const source = principal ? importSource(env, name, principal.id) : null
  if (!principal || !source) return Response.json({ error: 'unknown_import_source' }, { status: 400 })
  const action = path.slice(OPERATOR.length)
  let actor: Actor | undefined
  const response = await createImportOperatorHandler({
    ...runtime(env, principal.id), ...source, installationId: IMPORT_DOOR_KEY, appOrigin: env.AUTH_ORIGIN, ownerEmail: principal.email, namespace: name,
    async authorize(incoming) {
      try {
        const signedIn = await authorize(incoming, env); requireOwner(signedIn); requireWriteOrigin(incoming, env, signedIn)
        if (signedIn.tokenId) return null
        actor = signedIn
        return predicate(signedIn)
      } catch { return null }
    },
  })(request)
  // SEC-003: the finished apply and undo are audited once each, value-free. The plan comes
  // from the door's answer: the request body is read only by the door, after authorization.
  if (response?.ok && actor && (action === 'apply' || action === 'undo')) {
    const result = await response.clone().json() as { planId?: unknown; job?: { state?: string } }
    if (typeof result.planId === 'string' && result.job?.state === (action === 'apply' ? 'completed' : 'undone'))
      await auditStatementWhen(env, 'NOT EXISTS(SELECT 1 FROM crank_audit WHERE action=? AND subject_id=?)', [`import.${action}`, result.planId], actor.id, `import.${action}`, 'import', result.planId, { source: name }).run()
  }
  return response
}

/** Owner history: door imports with their approvals, newest first. */
export async function importHistory(env: CrankEnv, actor: Actor) {
  return readImportDoorHistory(env.DB as never, IMPORT_DOOR_KEY, predicate(actor))
}

/** The owner's Business-import setting: off until the owner turns it on; revoked
 * signing keys stay revoked when it is turned on again. */
async function importSettings(request: Request, env: CrankEnv) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405)
  try {
    const actor = await authorize(request, env); requireOwner(actor)
    if (request.method === 'POST') requireWriteOrigin(request, env, actor)
    if (actor.tokenId) return json({ error: 'owner_required' }, 401)
    const db = env.DB as never, ownerSql = predicate(actor)
    await schemaCurrent(db)
    if (request.method === 'POST') {
      const input = await request.json().catch(() => null) as { enabled?: unknown; revokedKids?: unknown } | null
      if (!input || typeof input.enabled !== 'boolean' || (input.revokedKids !== undefined && !Array.isArray(input.revokedKids))) return json({ error: 'invalid_settings' }, 400)
      await writeImportDoorSettings(db, IMPORT_DOOR_KEY, { enabled: input.enabled, revokedKids: input.revokedKids as string[] | undefined }, ownerSql)
      await auditStatement(env, actor.id, 'import.settings', 'import', IMPORT_DOOR_KEY, { enabled: input.enabled, revoked_keys: (input.revokedKids as string[] | undefined)?.length ?? 0 }).run()
    }
    const enabled = await stmt(env, 'SELECT enabled FROM ik_door_settings WHERE installation_id=?', IMPORT_DOOR_KEY).first<{ enabled: number }>()
    const revoked = await stmt(env, 'SELECT kid FROM ik_door_revoked_keys WHERE installation_id=? ORDER BY kid', IMPORT_DOOR_KEY).all<{ kid: string }>()
    return json({ enabled: enabled?.enabled === 1, revokedKids: revoked.results.map(row => row.kid), businessKeys: Boolean(env.RER_OWNER_CLAIM_PUBLIC_KEYS) })
  } catch (error: any) {
    return json({ error: error instanceof DoorError ? error.code : error.message || 'import_settings_refused' }, error.status ?? 409)
  }
}
