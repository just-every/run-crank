import { authorize, requireOwner, requireWriteOrigin } from '../access'
import { body, CrankError, json, requireValue, type CrankEnv } from '../model'
import { StepError } from '../engine/errors'
import { adoptRecurringTask, controlRecurringTask, createRecurringTask, listRecurring, publishRecurringSkill } from './recurring-store'
import { dispatchRecurring, readRecurringWithRuns } from './recurring-dispatch'

export async function recurringApi(request:Request,env:CrankEnv):Promise<Response|null> {
  const path = new URL(request.url).pathname
  if (!['/api/crank/recurring-skills','/api/crank/recurring-tasks'].some(root=>path===root || path.startsWith(root+'/'))) return null
  try {
    const actor = await authorize(request,env)
    requireOwner(actor)
    if (request.method==='GET') {
      if (path==='/api/crank/recurring-skills' || path==='/api/crank/recurring-tasks') return json(await listRecurring(env,actor))
      const task = /^\/api\/crank\/recurring-tasks\/([^/]+)$/.exec(path)
      if (task) return json(await readRecurringWithRuns(env,actor,decodeURIComponent(task[1])))
    }
    requireValue(request.method==='POST','Method not allowed',405)
    requireWriteOrigin(request,env,actor)
    const input = await body(request)
    if (path==='/api/crank/recurring-skills') return json(await publishRecurringSkill(env,actor,input),201)
    if (path==='/api/crank/recurring-tasks') return json(await createRecurringTask(env,actor,input),201)
    const action = /^\/api\/crank\/recurring-tasks\/([^/]+)\/(adopt|dispatch|pause|resume|takeover|cancel|revoke-tool)$/.exec(path)
    if (action) {
      const taskId = decodeURIComponent(action[1])
      if (action[2]==='adopt') return json(await adoptRecurringTask(env,actor,taskId,input))
      if (action[2]==='dispatch') { requireValue(Object.keys(input).length===0,'Dispatch accepts no authority or recipient overrides',422); return json(await dispatchRecurring(env,actor,taskId)) }
      return json(await controlRecurringTask(env,actor,taskId,action[2],input))
    }
    return json({error:'Recurring task door not found'},404)
  } catch (error) {
    if (error instanceof CrankError) return json({error:error.message},error.status)
    if (error instanceof StepError) return json({error:error.message},422)
    const status = (error as {status?:number}).status
    return json({error:'Recurring operation could not be confirmed'},status && status>=400 && status<500 ? status : 503)
  }
}
