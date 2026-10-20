import { authorize, requireWriteOrigin } from '../../access'
import { body, CrankError, json, requireValue, type CrankEnv } from '../../model'
import { createFollowup, readFollowups, readInbox, revokeFollowup, savePersonCalendar } from './store'

/** Native, in-app contact only. A notice confers no proposal/approval authority. */
export async function followupApi(request:Request,env:CrankEnv):Promise<Response|null> {
 const path=new URL(request.url).pathname,root='/api/crank/followups'
 if(path!==root && !path.startsWith(root+'/') && path!=='/api/crank/inbox')return null
 try {
  const actor=await authorize(request,env)
  if(request.method==='GET' && path===root)return json(await readFollowups(env,actor))
  if(request.method==='GET' && path==='/api/crank/inbox')return json(await readInbox(env,actor))
  requireValue(request.method==='POST','Method not allowed',405)
  requireWriteOrigin(request,env,actor)
  if(path===root)return json(await createFollowup(env,actor,await body(request)),201)
  const person=/^\/api\/crank\/followups\/people\/([^/]+)$/.exec(path)
  if(person)return json(await savePersonCalendar(env,actor,decodeURIComponent(person[1]),await body(request)))
  const revoke=/^\/api\/crank\/followups\/([^/]+)\/revoke$/.exec(path)
  if(revoke)return json(await revokeFollowup(env,actor,decodeURIComponent(revoke[1])))
  return json({error:'Follow-up door not found'},404)
 } catch(error) {
  if(error instanceof CrankError)return json({error:error.message},error.status)
  const status=(error as {status?:number}).status
  return json({error:'Follow-up operation could not be confirmed'},status && status>=400 && status<500?status:503)
 }
}
