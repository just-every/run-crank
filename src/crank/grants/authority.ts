import { runtimeBindings } from '../../auth.server'
import { devGate } from '../../modules/operator-auth/index.mjs'
import { StepError } from '../engine/errors'
import { digest, requireValue, stmt, type Actor, type CrankEnv } from '../model'

export interface GrantRow {
  id: string; label: string; workflow_id: string; version_id: string; token_hash: string
  owner_id: string; owner_version: number; session_kind: 'native' | 'dev'; policy_json: string
  expires_at: string; revoked_at: string | null; created_at: string
}
export type GrantActor = Actor & { grantId: string }

/** Repeated inside effect admission, so a revoked grant cannot win a stale check. */
export function grantFence(actor: Actor & { grantId?: string }): { sql: string; args: unknown[] }
export function grantFence(env: CrankEnv, grantId: string, workflowId: string, versionId: string): { sql: string; args: unknown[] }
export function grantFence(subject: CrankEnv | (Actor & { grantId?: string }), grantId?: string, workflowId?: string, versionId?: string): { sql: string; args: unknown[] } {
  if (grantId === undefined) {
    const actor = subject as Actor & { grantId?: string }
    return {
      sql: `EXISTS(SELECT 1 FROM crank_grants g JOIN oa_operators o ON o.id=g.owner_id
        JOIN crank_workflows w ON w.id=g.workflow_id JOIN crank_workflow_versions v ON v.id=g.version_id AND v.workflow_id=w.id
        WHERE g.id=? AND g.owner_id=? AND g.owner_version=? AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
        AND (g.session_kind='native' OR (g.session_kind='dev' AND ?=1))
        AND w.owner_id=g.owner_id AND w.status='published' AND w.published_version_id=g.version_id AND v.retired_at IS NULL AND v.mode='production')`,
      args: [actor.grantId ?? null, actor.id, actor.version, actor.local ? 1 : 0],
    }
  }
  const env = subject as CrankEnv
  return {
    sql: `EXISTS(SELECT 1 FROM crank_grants g JOIN oa_operators o ON o.id=g.owner_id
      JOIN crank_workflows w ON w.id=g.workflow_id
      JOIN crank_workflow_versions source ON source.id=g.version_id AND source.workflow_id=w.id
      JOIN crank_workflow_versions v ON v.id=? AND v.workflow_id=w.id
      WHERE g.id=? AND g.workflow_id=? AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
      AND (g.session_kind='native' OR (g.session_kind='dev' AND ?=1))
      AND w.owner_id=g.owner_id AND w.status='published' AND w.published_version_id=g.version_id
      AND source.retired_at IS NULL AND source.mode='production' AND v.retired_at IS NULL AND v.mode='production'
      AND (v.id=g.version_id OR v.grant_source_version_id=g.version_id))`,
    args: [versionId, grantId, workflowId, env.AUTH_LOCAL === 'true' ? 1 : 0],
  }
}

/** This credential deliberately has no tokenId: preparation tokens remain separate. */
export async function authorizeGrant(request: Request, original: CrankEnv, bearer: string): Promise<GrantActor> {
  const env = runtimeBindings(original) as CrankEnv, token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer
  requireValue(/^crg_[A-Za-z0-9_-]{43}$/.test(token), 'Invalid execution credential', 401)
  const row = await stmt(env, `SELECT g.*,o.display_name FROM crank_grants g JOIN oa_operators o ON o.id=g.owner_id
    WHERE g.token_hash=? AND g.revoked_at IS NULL AND g.expires_at>?
    AND o.status='active' AND o.role='owner' AND o.version=g.owner_version`, await digest(token), new Date().toISOString()).first<GrantRow & { display_name: string }>()
  requireValue(row, 'Invalid, expired or revoked execution credential', 401)
  return actorForGrant(request, env, row)
}

/** Per-client MCP secrets reuse the same live person and local-development boundary. */
export async function actorForGrant(request: Request, env: CrankEnv, row: GrantRow & { display_name: string }): Promise<GrantActor> {
  if (row.session_kind === 'dev') {
    const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true' })
    requireValue(gate && await gate.admits(request), 'Local development gate is required', 401)
  }
  return { id: row.owner_id, name: row.display_name, role: 'admin', kind: 'agent', version: row.owner_version, grantId: row.id, local: env.AUTH_LOCAL === 'true' }
}

export async function assertGrantStart(env: CrankEnv, actor: Actor & { grantId?: string }, workflowId: string): Promise<string> {
  requireValue(actor.grantId, 'An execution grant is required', 403)
  const row = await stmt(env, 'SELECT * FROM crank_grants WHERE id=? AND owner_id=? AND owner_version=?', actor.grantId, actor.id, actor.version).first<GrantRow>()
  requireValue(row, 'The execution grant does not authorize this caller', 403)
  const fence = grantFence(env, row.id, workflowId, row.version_id)
  requireValue(await stmt(env, `SELECT 1 AS ok WHERE ${fence.sql}`, ...fence.args).first(), 'The execution grant is expired, revoked or bound to another publication', 403)
  return row.id
}

export async function assertGrantAuthority(env: CrankEnv, runId: string): Promise<void> {
  const run = await stmt(env, 'SELECT grant_id,workflow_id,version_id FROM crank_wf_runs WHERE id=?', runId).first<{ grant_id: string | null; workflow_id: string; version_id: string }>()
  if (!run?.grant_id) return
  const fence = grantFence(env, run.grant_id, run.workflow_id, run.version_id)
  if (!await stmt(env, `SELECT 1 AS ok WHERE ${fence.sql}`, ...fence.args).first())
    throw new StepError('authority', 'The execution grant is expired, revoked or no longer authorizes this workflow version', { grant_id: run.grant_id })
}
