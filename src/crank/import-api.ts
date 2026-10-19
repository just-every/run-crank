import { authorize, requireOwner, requireWriteOrigin } from './access'
import { type CrankEnv } from './model'
import { listImportJobs, undoLegacyImport } from './imports'
import { importHistory } from './import-door'

/** Import history from either authority: door plans (upload/plan/apply/undo at
 * /api/operator/import/) and jobs approved before the door, which keep their undo. */
export async function importApi(request:Request,env:CrankEnv):Promise<Response|null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/crank/imports')) return null
  try {
    const actor = await authorize(request,env); requireOwner(actor)
    if(request.method !== 'GET') requireWriteOrigin(request,env,actor)
    let result:unknown
    if (path === '/api/crank/imports' && request.method === 'GET') result = [
      ...(await importHistory(env,actor)).map(entry => ({ ...entry, id: entry.planId, authority: 'door' })),
      ...(await listImportJobs(env)).map(job => ({ ...job, authority: 'legacy' })),
    ]
    else if (/^\/api\/crank\/imports\/[^/]+\/undo$/.test(path) && request.method === 'POST') result = await undoLegacyImport(env,actor.id,path.split('/')[4])
    else return Response.json({error:'Not found'},{status:404})
    return Response.json(result,{headers:{'cache-control':'no-store'}})
  } catch(error:any) {
    return Response.json({error:error.code || error.message || 'Import refused'},{status:error.status || 400,headers:{'cache-control':'no-store'}})
  }
}
