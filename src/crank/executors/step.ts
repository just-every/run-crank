import { digest, stmt } from '../model'
import { StepError } from '../engine/errors'
import { checkEgress } from '../engine/egress'
import type { StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { executorRequest } from './transport'

export class ExecutorWait extends Error {
  constructor(readonly taskId: string) { super('Waiting for the owner-deployed executor') }
}

export const code: StepType = {
  mutating:true, connection:'required', reconciles:true,
  validate(step) {
    if (!['python','javascript','typescript'].includes(String(step.language))) throw new StepError('validation',`Code ${step.id}: choose python, javascript or typescript`)
    if (typeof step.source!=='string' || !step.source || step.source.length>65536) throw new StepError('validation',`Code ${step.id}: source must contain 1 to 65536 characters`)
    if (typeof step.executor_url!=='string' || step.executor_url.includes('{{')) throw new StepError('validation',`Code ${step.id}: declare a literal executor URL`)
    const url=checkEgress(step.executor_url)
    if (url.pathname!=='/' || url.search || url.hash) throw new StepError('validation',`Code ${step.id}: executor_url must be an origin`)
    if (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms)<100 || Number(step.timeout_ms)>60000) throw new StepError('validation',`Code ${step.id}: timeout_ms must be 100 to 60000`)
    if (!Number.isInteger(step.memory_mb) || Number(step.memory_mb)<(step.language==='python'?64:512) || Number(step.memory_mb)>2048) throw new StepError('validation',`Code ${step.id}: memory_mb must be 64 (Python) or 512 (JavaScript/TypeScript) to 2048`)
    if (!Array.isArray(step.allowed_egress) || step.allowed_egress.length) throw new StepError('validation',`Code ${step.id}: this executor supports only explicit allowed_egress: []; network-enabled jobs are not implemented`)
    if (step.dependencies!==undefined && (!isObject(step.dependencies) || Object.keys(step.dependencies).length)) throw new StepError('validation',`Code ${step.id}: third-party dependencies are not implemented`)
    if (step.runtime_version!==undefined && (typeof step.runtime_version!=='string' || !/^\d+\.\d+\.\d+$/.test(step.runtime_version))) throw new StepError('validation',`Code ${step.id}: runtime_version must be an exact version`)
  },
  async execute(step,ctx) {
    const connectionId=String(step.connection_id), endpoint=new URL(String(step.executor_url)).origin
    const taskId=await digest(ctx.operationKey)
    await stmt(ctx.env,`INSERT INTO crank_executor_tasks(id,run_id,path,connection_id,endpoint,status,next_poll_at,created_at,active)
      SELECT ?,?,?,?,?, 'prepared',?,?,1 WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) ON CONFLICT(id) DO NOTHING`,taskId,ctx.run.id,ctx.path,connectionId,endpoint,new Date(ctx.now).toISOString(),new Date().toISOString(),ctx.run.id,ctx.run.lease_id).run()
    const row=await stmt(ctx.env,'SELECT active,status,created_at FROM crank_executor_tasks WHERE id=?',taskId).first<{active:number;status:string;created_at:string}>()
    if (!row?.active) throw new StepError('authority','Restored executor tasks have no execution authority. Start fresh work after reviewing and reconnecting the executor.')
    if (Date.now()-Date.parse(row.created_at)>Number(step.timeout_ms)+15*60000) throw new StepError('provider','Executor task exceeded its wall deadline and reconciliation allowance',{task_id:taskId})
    const url=`${endpoint}/tasks/${taskId}`
    let response=await executorRequest(ctx,connectionId,url,'GET')
    if (response.status===404) {
      if (row.status!=='prepared') throw new StepError('uncertain','The executor lost a submitted task; inspect the executor before starting fresh work',{task_id:taskId,uncertain:true})
      await stmt(ctx.env,"UPDATE crank_executor_tasks SET status='submitting' WHERE id=? AND active=1",taskId).run()
      // Only a genuinely absent task can be submitted. Duplicate submissions use
      // the executor's durable exact-body identity, including after response loss.
      try {
        response=await executorRequest(ctx,connectionId,url,'POST',{language:step.language,source:step.source,input:ctx.input,timeout_ms:step.timeout_ms,memory_mb:step.memory_mb,allowed_egress:step.allowed_egress,...(step.runtime_version?{runtime_version:step.runtime_version}:{})})
      } catch(error) {
        if (!(error instanceof StepError) || !(error.category==='network' || Number(error.detail.status)>=500)) throw error
        response=await executorRequest(ctx,connectionId,url,'GET')
        if (response.status===404) throw new StepError('uncertain','The executor did not confirm the submitted task; inspect it before starting fresh work',{task_id:taskId,uncertain:true})
      }
    }
    if (response.value.task_id!==taskId || !['queued','running','succeeded','failed','cancelled','interrupted'].includes(String(response.value.status))) throw new StepError('provider','Executor task identity or status did not match')
    const status=String(response.value.status)
    await stmt(ctx.env,`UPDATE crank_executor_tasks SET status=?,next_poll_at=? WHERE id=? AND active=1 AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?)`,status,new Date(Date.now()+60000).toISOString(),taskId,ctx.run.id,ctx.run.lease_id).run()
    if (status==='queued' || status==='running') throw new ExecutorWait(taskId)
    if (status!=='succeeded') {
      const reason=isObject(response.value.error) && ['timeout','output_limit','invalid_output','execution_failed','sandbox_unavailable','invalid_source','cancelled','interrupted'].includes(String(response.value.error.category)) ? String(response.value.error.category) : status
      throw new StepError(status==='interrupted'?'uncertain':'provider',`Executor task ${status} (${reason})`,{task_id:taskId,executor_error_category:reason,...(status==='interrupted'?{uncertain:true}:{})})
    }
    return {status:'succeeded',output:{task_id:taskId,status,output:response.value.output}}
  },
}
