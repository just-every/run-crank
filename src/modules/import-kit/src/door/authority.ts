import type { D1Database, D1Sql } from '../d1/types.ts';
import type { ImportAction } from '../types.ts';
import type { DoorRequest, DoorSnapshot, DoorHistoryEntry } from './types.ts';
import { DoorError, type DoorAction } from './protocol.ts';
import { assertion, snapshotHeld, sql, statement, transact } from './store.ts';
import { approvalCaption } from './failures.ts';
import { reserveReturn } from '../d1/budget.ts';

const actions: Record<DoorAction, ImportAction[]> = {
  uploads: [], plan: ['plan', 'read'], apply: ['create', 'apply', 'read'],
  status: ['read'], reconcile: ['read'], undo: ['read', 'undo', 'rollback'],
};
/** Statements the door runs after a kit call returns (lineage recovery and the
 * final authority check), kept out of the kit's self-sized batches. */
const DOOR_RETURN_STATEMENTS = 16;
export function kitContext(request: DoorRequest, snapshot: Pick<DoorSnapshot, 'kitNamespace'|'plan'|'id'>) {
  const {options, access: grant} = request;
  return reserveReturn({
    destination: options.destination, namespace: snapshot.kitNamespace,
    mappingVersion: snapshot.plan.mappingVersion,
    operationKey: 'door:' + snapshot.id,
    ...(grant.action === 'apply' ? {reviewedFingerprint: grant.fingerprint} : {}),
    batchSize: 20, maxBatches: 1,
    storage: {database: options.database, targets: options.targets},
    authorization: {
      principalId: options.ownerPrincipalId,
      predicate(action: ImportAction, destination: string): D1Sql {
        if (destination !== options.destination || !actions[grant.action].includes(action)) return sql('0');
        if (grant.action !== 'apply') return request.authority;
        // A plan whose apply failed is terminal: no grant or approval applies it again.
        const approved = sql(`EXISTS(SELECT 1 FROM ik_door_plans p JOIN ik_door_approvals a ON a.plan_id=p.id
          WHERE p.id=? AND p.fingerprint=? AND p.complete=1 AND a.approval_id=? AND a.owner=? AND a.approved_at=? AND a.fingerprint=p.fingerprint
          AND NOT EXISTS(SELECT 1 FROM ik_door_apply_failures f WHERE f.plan_id=p.id))`, snapshot.id, grant.fingerprint, grant.approvalRecordId, grant.email, grant.approvedAt);
        // Writing from the reviewed snapshot needs it still held; reading the job does not.
        const held = snapshotHeld(snapshot.id), fingerprint = action === 'read' ? approved : sql(`(${approved.sql}) AND (${held.sql})`, ...approved.params ?? [], ...held.params ?? []);
        return sql(`(${request.authority.sql}) AND (${fingerprint.sql})`, ...request.authority.params ?? [], ...fingerprint.params ?? []);
      },
    },
  }, DOOR_RETURN_STATEMENTS);
}
/** Server-only integration hook. The predicate must consult the seed's CURRENT
 * owner session or the owner's provisioning approval in this same database. */
export async function writeImportDoorSettings(db: D1Database, installationId: string, changes: {enabled: boolean; revokedKids?: string[]}, ownerPredicate: D1Sql): Promise<void> {
  if (!installationId || typeof changes.enabled !== 'boolean' || changes.revokedKids?.some(k => !/^[A-Za-z0-9_-]{1,64}$/.test(k))) throw new DoorError('invalid_settings', 400);
  await transact(db, ownerPredicate, [
    sql('INSERT INTO ik_door_settings(installation_id,enabled) VALUES(?,?) ON CONFLICT(installation_id) DO UPDATE SET enabled=excluded.enabled', installationId, changes.enabled ? 1 : 0),
    ...(changes.revokedKids ?? []).map(kid => sql('INSERT OR IGNORE INTO ik_door_revoked_keys(installation_id,kid) VALUES(?,?)', installationId, kid)),
  ]);
}
/** Use alongside the seed's existing owner-bound import list and undo route. */
export async function readImportDoorHistory(db: D1Database, installationId: string, ownerPredicate: D1Sql) {
  const query = sql(`SELECT p.id AS planId,p.job_id AS jobId,p.namespace,p.fingerprint,j.state,j.error,f.reason_code AS failureCode,
    a.owner,a.approved_at AS approvedAt,a.approval_id AS approvalRecordId,a.reviewer
    FROM ik_door_plans p JOIN ik_door_approvals a ON a.plan_id=p.id JOIN ik_jobs j ON j.id=p.job_id
    LEFT JOIN ik_door_apply_failures f ON f.plan_id=p.id
    WHERE p.installation_id=? ORDER BY a.approved_at DESC,p.id`, installationId);
  const results = await db.batch([
    statement(db, sql(`SELECT CASE WHEN (${ownerPredicate.sql}) THEN 1 ELSE json('IMPORT_DOOR_OWNER_REQUIRED') END`, ...ownerPredicate.params ?? [])),
    statement(db, query),
    statement(db, sql(`SELECT CASE WHEN (${ownerPredicate.sql}) THEN 1 ELSE json('IMPORT_DOOR_OWNER_REQUIRED') END`, ...ownerPredicate.params ?? [])),
  ]);
  const rows = results[1] as {results: Omit<DoorHistoryEntry, 'caption'>[]} | Omit<DoorHistoryEntry, 'caption'>[];
  return (Array.isArray(rows) ? rows : rows.results).map(row => ({...row,
    caption: approvalCaption({owner: row.owner, approved_at: row.approvedAt, approval_id: row.approvalRecordId, reviewer: row.reviewer}, row.fingerprint, row.failureCode)}));
}
export async function reserveApply(request: DoorRequest, snapshot: DoorSnapshot): Promise<void> {
  const g = request.access;
  if (snapshot.standingApproval && (g.catchup !== 'bounded' || g.approvalRecordId !== snapshot.standingApproval.id || g.approvedAt !== snapshot.standingApproval.at)) throw new DoorError('standing_approval_mismatch');
  if (!snapshot.standingApproval && g.catchup === 'bounded') throw new DoorError('standing_approval_mismatch');
  const consumed = await request.options.database.prepare(`SELECT 1 FROM ik_door_approvals a JOIN ik_door_apply_failures f ON f.plan_id=a.plan_id
    JOIN ik_door_plans p ON p.id=a.plan_id WHERE p.installation_id=? AND a.approval_id=?`).bind(g.installationId,g.approvalRecordId).first();
  if (consumed) throw new DoorError('failed_approval_requires_new_approval',409);
  await transact(request.options.database, request.authority, [
    assertion(sql('NOT EXISTS(SELECT 1 FROM ik_door_apply_failures WHERE plan_id=?)', snapshot.id)),
    assertion(sql(`NOT EXISTS(SELECT 1 FROM ik_door_approvals a JOIN ik_door_apply_failures f ON f.plan_id=a.plan_id
      JOIN ik_door_plans p ON p.id=a.plan_id WHERE p.installation_id=? AND a.approval_id=?)`, g.installationId, g.approvalRecordId)),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_namespaces WHERE installation_id=? AND namespace=? AND pending_id=? AND head_id IS ?)', g.installationId, g.namespace, snapshot.id, snapshot.previous)),
    assertion(snapshotHeld(snapshot.id)),
    sql('INSERT OR IGNORE INTO ik_door_approvals(plan_id,approval_id,owner,approved_at,fingerprint,reviewer) VALUES(?,?,?,?,?,?)', snapshot.id, g.approvalRecordId, g.email, g.approvedAt, g.fingerprint, snapshot.standingApproval?.id ?? (request.via === 'operator' ? 'operator' : g.approvalRecordId)),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_approvals WHERE plan_id=? AND approval_id=? AND owner=? AND approved_at=? AND fingerprint=?)', snapshot.id, g.approvalRecordId, g.email, g.approvedAt, g.fingerprint)),
  ]);
}
