import type { ImportDoorOptions } from './types.ts';
import { admit, enabled } from './admission.ts';
import { createDoorHandler, mountValid, runtimeOptions } from './handler.ts';
import { DoorError } from './grants.ts';
export type * from './types.ts';
export type { DoorAction, DoorGrant, RerGrant } from './grants.ts';
export { verifyImportGrant, verifyRerGrant, DoorError } from './grants.ts';
export { importDoorSchema, importDoorApplyFailureMigration, importDoorScopesMigration, importDoorArchiveMigration, importDoorIntakeMigration } from './schema.ts';
export { writeImportDoorSettings, readImportDoorHistory, enableDoorAtFirstClaim } from './authority.ts';
export { createImportOperatorHandler } from './operator.ts';

/** Grant mount: disabled until a trusted key ring and explicit opt-in exist. */
export function createImportDoorHandler(options: ImportDoorOptions): (request: Request)=>Promise<Response|null> {
  if (options.installationId !== undefined && (typeof options.installationId !== 'string' || !options.installationId.trim())) throw new DoorError('invalid_configuration',503);
  if (options.source === undefined) runtimeOptions(options);
  else if (typeof options.source !== 'function' || options.parse !== undefined || options.mapping !== undefined || options.readRaw !== undefined
    || !mountValid(options)) throw new DoorError('invalid_configuration',503);
  return createDoorHandler('/api/rer/import/', options.database, (request, action, database) => admit({...options, database}, request, action),
    undefined, async database => !!options.claim?.publicKeys && Object.keys(options.claim.publicKeys).length > 0 && await enabled({...options, database}));
}
