import type { D1Database } from '../d1/types.ts';
import type { DoorRequest, ImportDoorRuntime, ImportDoorRawSource } from './types.ts';
import { DoorError, GRANT_ONLY_ACTIONS, type DoorAction } from './protocol.ts';
import { authorized, erasedSince } from './store.ts';
import { sizeLimitError } from './limits.ts';
import { requestDatabase } from '../d1/budget.ts';
import { uploads } from './uploads.ts';
import { plan } from './planning.ts';
import { apply, status, reconcile, undo, cancel } from './jobs.ts';
import { archive, restoreCheck } from './archive.ts';
import { streamUpload } from './intake-upload.ts';
import { intakeIdentity } from './intake-policy.ts';

const routes = {uploads,plan,apply,status,reconcile,undo,cancel,archive,'restore-check':restoreCheck};
const headers = {'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
async function readInput(request: Request): Promise<Record<string,unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json' || !request.body) throw new DoorError('json_body_required',400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 100_000) throw new DoorError('request_too_large',413);
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part,offset); offset += part.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new DoorError('invalid_json',400); }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new DoorError('invalid_input',400);
  return value;
}
type RuntimeConfiguration = {[K in keyof ImportDoorRuntime]?: ImportDoorRuntime[K]} & {
  readRaw?: ImportDoorRawSource['readRaw'];
};

/** The settings every mount needs whatever its source: a preserving undo policy needs the adapter's preserved undo. */
export function mountValid(options: RuntimeConfiguration): boolean {
  return !!options.ownerPrincipalId?.trim() && !!options.destination?.trim() && [undefined,'strict','preserve-conflicts'].includes(options.reversalPolicy)
    && (options.reversalPolicy!=='preserve-conflicts' || typeof options.targets?.preparePreservedUndo==='function');
}
/** Refuses a mount, or a resolved source, missing what the pipeline needs. */
export function runtimeOptions<T extends RuntimeConfiguration>(options: T): T & ImportDoorRuntime {
  if (!options.mapping?.version || !mountValid(options)
    || (options.format === 'raw' ? typeof options.readRaw !== 'function' || options.intake !== undefined
      : typeof options.parse !== 'function')) throw new DoorError('invalid_configuration',503);
  if (options.intake !== undefined) intakeIdentity(options.intake);
  return options as T & ImportDoorRuntime;
}
/** Server-side mount only. A null response belongs to another dispatcher. Every
 * statement of one request, the door's own, the adapter's and each kit call's,
 * runs on `database` wrapped in one D1 request budget; exhausting it is a named 413. */
export function createDoorHandler(prefix: string, database: D1Database,
  admit: (request: Request, action: DoorAction, database: D1Database) => Promise<DoorRequest | null>,
  review: (request: DoorRequest, input: Record<string, unknown>) => Promise<DoorRequest> = async request => request,
  available: (database: D1Database) => Promise<boolean> = async () => true,
): (request: Request)=>Promise<Response|null> {
  return async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/rer/import/') && prefix !== '/api/rer/import/') return Response.json({error:'not_found'},{status:404,headers});
    if (!url.pathname.startsWith(prefix)) return null;
    let admitted: DoorRequest | null = null;
    try {
      const budgeted = requestDatabase(database);
      if (!await available(budgeted)) return Response.json({error:'not_found'},{status:404,headers});
      const action = url.pathname.slice(prefix.length) as DoorAction;
      if (!Object.hasOwn(routes,action) || (prefix !== '/api/rer/import/' && GRANT_ONLY_ACTIONS.includes(action))) return Response.json({error:'not_found'},{status:404,headers});
      if (request.method!=='POST') return Response.json({error:'method_not_allowed'},{status:405,headers:{...headers,Allow:'POST'}});
      if (url.search || url.hash) throw new DoorError('query_transport_forbidden',400);
      admitted = await admit(request,action,budgeted);
      if (!admitted) return Response.json({error:'not_found'},{status:404,headers});
      if (action === 'uploads' && admitted.options.intake && request.headers.get('Content-Type')?.split(';')[0] === 'application/octet-stream') {
        const result = await streamUpload(admitted,request);
        await authorized(admitted);
        return Response.json(result,{headers});
      }
      const input = await readInput(request);
      admitted = await review(admitted,input);
      if (['status','reconcile','undo','cancel'].includes(action) && Object.keys(input).some(k=>k!=='planId')) throw new DoorError('invalid_input',400);
      const result = await routes[action](admitted,input);
      await authorized(admitted);
      return Response.json(result,{headers});
    } catch (caught) {
      // Work an erasure overtook answers one stable refusal, whichever batch it
      // reached: an unknown error, or the final authority check, after an erasure.
      const overtaken = admitted && (!(caught instanceof DoorError) || ['grant_revoked_or_expired','owner_required'].includes(caught.code))
        && await erasedSince(admitted).catch(() => false);
      // A kit size or request limit is a named 413.
      const error = overtaken ? new DoorError('erased_during_request', 410) : sizeLimitError(caught) ?? caught;
      const known = error instanceof DoorError;
      // Never reflect a parser/native adapter error containing customer records.
      return Response.json({error:known?error.code:'import_door_conflict',...(known && error.details?{details:error.details}:{})},{status:known?error.status:409,headers});
    }
  };
}
