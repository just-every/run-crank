import { authorize, requireOwner, requireWriteOrigin } from './access'
import { body, requireValue, type CrankEnv } from './model'
import { comparisonIndex, createComparison, comparisonReport, comparisonEvent, comparisonDecision, eraseComparison } from './import-comparison'
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
    const comparison = /^\/api\/crank\/imports\/comparisons(?:\/([^/]+)(?:\/(evaluate|observe|decisions|cutover|erase))?)?$/.exec(path)
    if (comparison) {
      const key = comparison[1], action = comparison[2]
      if (request.method === 'GET' && !action) result = key ? await comparisonReport(env,key) : await comparisonIndex(env)
      else if (request.method === 'POST') {
        const input = await body(request,196608)
        if (!key) result = await createComparison(env,actor,input)
        else if (action === 'evaluate' || action === 'observe') result = await comparisonEvent(env,actor,key,action,input)
        else if (action === 'decisions') result = await comparisonDecision(env,actor,key,input)
        else if (action === 'cutover') { await comparisonReport(env,key); requireValue(false,'Cutover is unavailable: owner-supplied comparison observations cannot establish live parity, watermark takeover or source shutdown',409) }
        else if (action === 'erase') { requireValue(input.confirm === 'ERASE','Type ERASE to confirm'); const {portability}=await import('./data'); result=await eraseComparison(env,actor,await portability(env),key) }
        else return Response.json({error:'Not found'},{status:404})
      } else return Response.json({error:'Method not allowed'},{status:405})
    }
    else if (path === '/api/crank/imports' && request.method === 'GET') result = [
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
