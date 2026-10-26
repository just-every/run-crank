import { guardedBatch } from '../access'
import { canonical, id, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { indexStatement, sealText, targetFor } from '../ops/payload-seal'

/** A refused call is terminal history, with the same payload custody as an admitted task. */
export async function refusedCall(env: CrankEnv, actor: Actor, call: {
  id: string; clientId: string; tool: string; workflowId: string; versionId: string; at: string
  arguments: unknown; reason: string; status: number
}) {
  const runId = id(), target = await targetFor(env,call.workflowId)
  const payload = canonical({mcp:{client_id:call.clientId,tool:call.tool,arguments:call.arguments}})
  const outcome = canonical({refused:true,status:call.status,reason:call.reason})
  const error = canonical({category:'authority',code:'mcp_call_refused',message:call.reason})
  const index = await indexStatement(env,target,runId,[payload,outcome,error])
  await guardedBatch(env,actor,'read',[
    stmt(env,`INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,finished_at,created_by,grant_id,payload_key,payload_index,response_json,error_json)
      VALUES(?,?,?,'agent',?,?,'failed',?,?,?,?,?,?,?,?)`,runId,call.workflowId,call.versionId,`mcp:${call.clientId}:${call.tool}`,await sealText(target,payload),call.at,call.at,actor.id,actor.grantId,target.key?.id??null,target.key?target.fieldsJson:null,await sealText(target,outcome),await sealText(target,error)),
    ...(index ? [index] : []),
    stmt(env,"INSERT INTO crank_mcp_calls(id,client_id,tool,run_id,status,reason,created_at) VALUES(?,?,?,?,'refused',?,?)",call.id,call.clientId,call.tool,runId,call.reason,call.at),
    auditStatement(env,actor.id,'mcp.call.refused','run',runId,{client_id:call.clientId,call_id:call.id,tool:call.tool,reason:call.reason},call.versionId),
  ])
  return runId
}
