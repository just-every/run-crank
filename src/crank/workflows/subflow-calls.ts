import { guardedBatch, requireOwner } from '../access'
import { assertDispatchAuthority } from '../engine/authority'
import { StepError } from '../engine/errors'
import { getWfRun } from '../engine/records'
import type { StepContext } from '../engine/types'
import { body, canonical, digest, id, json, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { indexStatement, openText, sealText, targetFor } from '../ops/payload-seal'
import { auditStatement } from '../ops/audit'
import { callable, evaluatePureSubflow, readSubflow } from './subflows'

type Call = {id:string;run_id:string;path:string;operation_key:string;subflow_version_id:string;status:string;lease_id:string|null;lease_expires_at:string|null;created_at:string;started_at:string|null;finished_at:string|null}
export class SubflowWait extends Error { constructor(readonly callId: string) { super('Pure child is retained for execution') } }
export async function readChildCall(env: CrankEnv, callId: string) {
  const call = await stmt(env, 'SELECT * FROM crank_subflow_calls WHERE id=?',callId).first<Call>()
  requireValue(call,'Pure child history not found',404)
  const {lease_id,lease_expires_at,...history} = call
  return {...history, parent_history:'/app/workflow-runs/'+call.run_id}
}
/** The parent checkpoint owns all values. A child retains only execution metadata. */
export async function queuePureChild(ctx: StepContext, versionId: string): Promise<never> {
  if (ctx.run.mode === 'test' || ctx.run.grant_id) throw new StepError('authority','Pure child execution requires a native-owner production caller')
  const callId = await digest(ctx.operationKey), at = now()
  await stmt(ctx.env, `INSERT INTO crank_subflow_calls(id,run_id,path,operation_key,subflow_version_id,status,created_at)
    SELECT ?,?,?,?,?,'queued',? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running')
    ON CONFLICT(operation_key) DO NOTHING`,callId,ctx.run.id,ctx.path,ctx.operationKey,versionId,at,ctx.run.id).run()
  const call = await readChildCall(ctx.env,callId)
  if (['interrupted','paused'].includes(call.status)) throw new StepError('authority','Review and explicitly resume this pure child; no child ran')
  if (call.status === 'cancelled') throw new StepError('business','This pure child was cancelled')
  throw new SubflowWait(callId)
}

/** One bounded pure child, guarded by its own lease and the live parent checkpoint. */
export async function runPureChild(env: CrankEnv, callId: string) {
  const lease = id(), at = now()
  await stmt(env, "UPDATE crank_subflow_calls SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND lease_expires_at<=?",callId,at).run()
  const call = await stmt(env, `UPDATE crank_subflow_calls SET status='running',lease_id=?,lease_expires_at=?,started_at=COALESCE(started_at,?)
    WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM crank_wf_runs r JOIN crank_wf_steps s ON s.run_id=r.id
      WHERE r.id=crank_subflow_calls.run_id AND r.status='waiting' AND s.path=crank_subflow_calls.path AND s.operation_key=crank_subflow_calls.operation_key AND s.status='waiting') RETURNING *`,lease,new Date(Date.now()+300000).toISOString(),at,callId).first<Call>()
  if (!call) return
  const run = await getWfRun(env,call.run_id)
  if (!run) return
  let output: unknown, trace: unknown, failure: unknown, status = 'succeeded'
  try {
    const version = await stmt(env,'SELECT subflow_id,version FROM crank_subflow_versions WHERE id=?',call.subflow_version_id).first<{subflow_id:string;version:number}>()
    if (!version) throw new StepError('validation','The child definition is unavailable')
    const row = await readSubflow(env,version.subflow_id,version.version)
    const check = async () => {
      await callable({env,run},row)
      const current = await stmt(env, `SELECT 1 FROM crank_subflow_calls c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.id=? AND c.status='running' AND c.lease_id=? AND c.lease_expires_at>? AND r.status='waiting'`,call.id,lease,now()).first()
      if (!current) throw new StepError('authority','The child or parent was stopped; no further operation ran')
    }
    await check()
    if (await digest(row.definition_json) !== row.definition_digest) throw new StepError('validation','The child definition digest does not match')
    const record = await stmt(env,'SELECT input_json FROM crank_wf_steps WHERE run_id=? AND path=?',run.id,call.path).first<{input_json:string}>()
    requireValue(record,'The parent checkpoint is unavailable',409)
    const input = JSON.parse((await openText(env,run.workflow_id,record.input_json))!)
    const definition = JSON.parse(row.definition_json)
    output = await evaluatePureSubflow(definition,input,check)
    trace = {child_id:call.id,subflow_id:row.subflow_id,version:row.version,definition_digest:row.definition_digest,operations:definition.steps.map(({id,fn}:{id:string;fn:string})=>({id,fn}))}
  } catch (error) {
    const cause = error instanceof StepError ? error : new StepError('validation','The pure child failed validation')
    status = cause.category === 'authority' || cause.category === 'connection' ? 'paused' : 'failed'
    failure = cause.toJSON()
  }
  const target = await targetFor(env,run.workflow_id), finished = now(), plain = output === undefined ? null : canonical(output)
  const guard = `EXISTS(SELECT 1 FROM crank_subflow_calls c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.id=? AND c.status='running' AND c.lease_id=? AND c.lease_expires_at>? AND r.status='waiting')`
  const args = [call.id,lease,finished]
  const index = await indexStatement(env,target,run.id,[plain],guard,args)
  await env.DB.batch([
    stmt(env, `UPDATE crank_wf_steps SET status=?,output_json=?,trace_json=?,error_json=?,finished_at=? WHERE run_id=? AND path=? AND ${guard}`,status==='paused'?'waiting':status,await sealText(target,plain),await sealText(target,trace ? canonical(trace) : canonical({child_id:call.id})),await sealText(target,failure ? canonical(failure) : null),status==='paused'?null:finished,run.id,call.path,...args),
    ...(index ? [index] : []),
    stmt(env, `UPDATE crank_wf_runs SET status=?,error_json=?,finished_at=? WHERE id=? AND ${guard}`,status==='succeeded'?'queued':status,await sealText(target,failure ? canonical(failure) : null),status==='failed'?finished:null,run.id,...args),
    stmt(env, `UPDATE crank_subflow_calls SET status=?,lease_id=NULL,lease_expires_at=NULL,finished_at=? WHERE id=? AND status='running' AND lease_id=? AND EXISTS(SELECT 1 FROM crank_wf_runs r JOIN crank_wf_steps s ON s.run_id=r.id WHERE r.id=crank_subflow_calls.run_id AND s.path=crank_subflow_calls.path AND s.operation_key=crank_subflow_calls.operation_key AND r.status=?)`,status,status==='paused'?null:finished,call.id,lease,status==='succeeded'?'queued':status),
  ])
}
export async function runPureChildren(env: CrankEnv, time = Date.now()) {
  const at = new Date(time).toISOString()
  await stmt(env,"UPDATE crank_subflow_calls SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE status='running' AND lease_expires_at<=?",at).run()
  await stmt(env,"UPDATE crank_subflow_calls SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,finished_at=? WHERE status IN ('queued','running','paused') AND EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=crank_subflow_calls.run_id AND r.status IN ('cancelled','failed','rejected','succeeded','stopped_by_filter','stopped_by_search'))",at).run()
  const calls = await stmt(env,"SELECT id FROM crank_subflow_calls WHERE status='queued' OR (status='running' AND lease_expires_at<=?) ORDER BY created_at,id LIMIT 50",at).all<{id:string}>()
  for (const call of calls.results) await runPureChild(env,call.id)
}

export async function childCallApi(request: Request, env: CrankEnv, actor: Actor) {
  const match = /^\/api\/crank\/subflows\/calls\/([a-f0-9]{64})(?:\/(cancel|resume|run))?$/.exec(new URL(request.url).pathname)
  if (!match) return null
  requireOwner(actor)
  const call = await readChildCall(env,match[1])
  if (request.method === 'GET' && !match[2]) return json(call)
  requireValue(request.method==='POST' && match[2],'Child history is read only; choose cancel, resume or run',405)
  if (match[2] === 'run') {
    requireValue(!['interrupted','paused'].includes(call.status),'Explicitly resume this child before dispatch',409)
    if (['succeeded','failed','cancelled'].includes(call.status)) return json(call)
    await runPureChild(env,call.id)
    const {executeRun} = await import('../engine/executor')
    const parent = await stmt(env,'SELECT status FROM crank_wf_runs WHERE id=?',call.run_id).first<{status:string}>()
    if (parent?.status === 'queued') await executeRun(env,call.run_id)
    return json(await readChildCall(env,call.id))
  }
  const input = await body(request), at = now()
  if (match[2] === 'resume') {
    requireValue(['interrupted','paused'].includes(call.status),'Only an interrupted or paused child can be resumed',409)
    requireValue(await stmt(env,"SELECT 1 FROM crank_wf_runs r JOIN crank_wf_steps s ON s.run_id=r.id WHERE r.id=? AND r.status IN ('paused','waiting') AND s.path=? AND s.status='waiting' AND s.operation_key=?",call.run_id,call.path,call.operation_key).first(),'The parent no longer waits for this child',409)
    await assertDispatchAuthority(env,call.run_id)
    const version = await stmt(env,'SELECT definition_digest,active FROM crank_subflow_versions WHERE id=?',call.subflow_version_id).first<{definition_digest:string;active:number}>()
    requireValue(version?.active===1 && input.definition_digest===version.definition_digest && input.confirm==='RESUME_PURE_CHILD','Review the active definition digest and confirm RESUME_PURE_CHILD',409)
    await guardedBatch(env,actor,'owner',[
      stmt(env,"UPDATE crank_subflow_calls SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE id=? AND status IN ('interrupted','paused')",call.id),
      stmt(env,"UPDATE crank_wf_runs SET status='waiting',error_json=NULL WHERE id=? AND status='paused' AND COALESCE(json_extract(error_json,'$.category'),'')!='restore_fence'",call.run_id),
      auditStatement(env,actor.id,'subflow.child.resume','run',call.run_id,{child_id:call.id}),
    ])
  } else {
    requireValue(['queued','running','paused','interrupted'].includes(call.status),'This child cannot be cancelled now',409)
    await guardedBatch(env,actor,'owner',[
      stmt(env,"UPDATE crank_subflow_calls SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,finished_at=? WHERE id=? AND status IN ('queued','running','paused','interrupted')",at,call.id),
      stmt(env,"UPDATE crank_wf_runs SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,finished_at=? WHERE id=? AND status IN ('queued','running','waiting','paused')",at,call.run_id),
      stmt(env,"UPDATE crank_wf_steps SET status='stopped',finished_at=? WHERE run_id=? AND path=? AND status='waiting'",at,call.run_id,call.path),
      auditStatement(env,actor.id,'subflow.child.cancel','run',call.run_id,{child_id:call.id}),
    ])
  }
  return json(await readChildCall(env,call.id))
}
