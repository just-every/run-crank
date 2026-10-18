import type { ImportDoorOptions, ImportDoorRuntimeOptions, DoorRequest } from './types.ts';
import { runtimeOptions } from './handler.ts';
import { DoorError, verifyImportGrant, type DoorAction } from './grants.ts';
import { doorFence, erasures, sql, transact } from './store.ts';
import { importDoorSchemaCheck } from './schema.ts';

/** The storage key; grants are still verified against `claim.installationId`. */
export const doorKey = (options: ImportDoorOptions): string => options.installationId ?? options.claim.installationId;
/** Opt-in and schema state in one read. A door whose seed has not applied the
 * door migrations must refuse loudly rather than misbehave. */
export async function enabled(options: ImportDoorOptions): Promise<boolean> {
  const row = await options.database.prepare(`SELECT (SELECT enabled FROM ik_door_settings WHERE installation_id=?) AS enabled,(${importDoorSchemaCheck}) AS current`)
    .bind(doorKey(options)).first();
  if (row?.enabled !== 1) return false;
  if (row.current !== 1) throw new DoorError('import_door_schema_outdated', 503);
  return true;
}
/** This grant's parser and mapping: the mount's own, or the seed's allow-list entry
 * for the verified namespace. Unlisted namespaces are refused before any write. */
async function source(options: ImportDoorOptions, namespace: string): Promise<ImportDoorRuntimeOptions> {
  if (!options.source) return runtimeOptions(options);
  const listed = await options.source(namespace);
  if (!listed) throw new DoorError('unknown_import_source');
  return runtimeOptions({...options, parse: listed.parse, mapping: listed.mapping, ownerPrincipalId: listed.ownerPrincipalId ?? options.ownerPrincipalId});
}
export async function admit(options: ImportDoorOptions, request: Request, action: DoorAction): Promise<DoorRequest> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new DoorError('grant_required', 401);
  const {grant, kid} = await verifyImportGrant(authorization.slice(7), options.claim);
  if (grant.action !== action || new URL(request.url).origin !== options.claim.appOrigin) throw new DoorError('grant_binding_mismatch');
  const runtime = await source(options, grant.namespace);
  const key = doorKey(options), epoch = await erasures(options.database, options.destination);
  const fence = doorFence(key, grant.namespace, options.destination, epoch);
  const basic = sql(`(${fence.sql}) AND EXISTS(SELECT 1 FROM ik_door_settings WHERE installation_id=? AND enabled=1)
    AND NOT EXISTS(SELECT 1 FROM ik_door_revoked_keys WHERE installation_id=? AND kid=?)
    AND unixepoch() < ?`, ...fence.params ?? [], key, key, kid, grant.exp);
  try {
    await transact(options.database, basic, [sql('INSERT INTO ik_door_grants(installation_id,jti,action,namespace,kid,expires) VALUES(?,?,?,?,?,?)', key, grant.jti, action, grant.namespace, kid, grant.exp)]);
  } catch {
    if (await erasures(options.database, options.destination) !== epoch) throw new DoorError('erased_during_request', 410);
    throw new DoorError('grant_replayed_revoked_or_expired');
  }
  const authority = sql(`(${basic.sql}) AND EXISTS(SELECT 1 FROM ik_door_grants WHERE installation_id=? AND jti=? AND action=? AND namespace=? AND kid=? AND expires=?)`, ...basic.params ?? [], key, grant.jti, action, grant.namespace, kid, grant.exp);
  return {options: runtime, access: {...grant, installationId: key}, authority, via:'grant', epoch, nonce: {jti: grant.jti, kid}};
}
