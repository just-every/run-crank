import { authorize, requireOwner, requireWriteOrigin } from './access'
import { body, type CrankEnv } from './model'
import { planN8n, applyN8n, listImportJobs, undoN8n } from './imports'

export async function importApi(request:Request,env:CrankEnv):Promise<Response|null> {
  const path = new URL(request.url).pathname
  if (!path.startsWith('/api/crank/imports')) return null
  try {
    const actor = await authorize(request,env); requireOwner(actor)
    if(request.method !== 'GET') requireWriteOrigin(request,env,actor)
    let result:unknown
    if (path === '/api/crank/imports' && request.method === 'GET') result = await listImportJobs(env)
    else if (path === '/api/crank/imports/plan' && request.method === 'POST') result = await planN8n(env,actor.id,await body(request, 262144) as any)
    else if (path === '/api/crank/imports/apply' && request.method === 'POST') result = await applyN8n(env,actor.id,await body(request, 262144) as any)
    else if (/^\/api\/crank\/imports\/[^/]+\/undo$/.test(path) && request.method === 'POST') result = await undoN8n(env,actor.id,path.split('/')[4])
    else return Response.json({error:'Not found'},{status:404})
    return Response.json(result,{headers:{'cache-control':'no-store'}})
  } catch(error:any) {
    return Response.json({error:error.code || error.message || 'Import refused'},{status:error.status || 400,headers:{'cache-control':'no-store'}})
  }
}
