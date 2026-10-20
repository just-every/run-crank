import { guardedBatch } from '../access'
import { assertGrantAuthority } from './authority'
import { taskInput } from './tasks'
import { isObject } from '../engine/values'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { indexStatement, openText, sealText, targetFor } from '../ops/payload-seal'
import { auditStatement } from '../ops/audit'
import { readTask } from './tasks'

/** Revising a held effect spends its old review, even after deferred approval.
 * No revision can alter an effect that has begun dispatching. */
export async function reviseProposal(env: CrankEnv, actor: Actor, runId: string, input: Record<string, unknown>) {
  const row = await stmt(env, `SELECT r.workflow_id,r.grant_id,r.status,w.path,w.proposal_json,w.proposal_digest,s.input_json,s.operation_key
    FROM crank_wf_runs r JOIN crank_waits w ON w.run_id=r.id JOIN crank_wf_steps s ON s.run_id=r.id AND s.path=w.path
    WHERE r.id=? AND w.path=? AND w.kind='approval' AND s.status='waiting'
    AND r.status IN ('awaiting_approval','queued')`,runId,String(input.path ?? '')).first<{
      workflow_id:string;grant_id:string;status:string;path:string;proposal_json:string;proposal_digest:string;input_json:string;operation_key:string
    }>()
  requireValue(row && row.grant_id === actor.grantId, 'No held proposal belongs to this execution credential', 404)
  await assertGrantAuthority(env,runId)
  requireValue(input.digest === row.proposal_digest, 'The proposal changed; read it again',409)
  requireValue(isObject(input.input), 'Supply the revised input object',422)
  const prior = JSON.parse((await openText(env,row.workflow_id,row.input_json))!), proposed = taskInput(prior,input.input)
  const oldProposal = JSON.parse((await openText(env,row.workflow_id,row.proposal_json))!), proposal = {...oldProposal,input:proposed}
  const target = await targetFor(env,row.workflow_id), at=now(), guard=id(), newDigest=await digest(canonical(proposal))
  const index = await indexStatement(env,target,runId,[canonical(proposed)])
  await guardedBatch(env,actor,'read',[
    stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM crank_wf_runs r JOIN crank_waits w ON w.run_id=r.id JOIN crank_wf_steps s ON s.run_id=r.id AND s.path=w.path
      WHERE r.id=? AND r.grant_id=? AND r.status IN ('awaiting_approval','queued') AND w.path=? AND w.proposal_digest=? AND s.status='waiting') THEN 1 ELSE 0 END`,guard,runId,actor.grantId,row.path,row.proposal_digest),
    stmt(env,`INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
      SELECT ?,?,COALESCE(MAX(revision),0)+1,?,NULL,?,?,?,1,?,? FROM crank_wf_step_revisions WHERE run_id=? AND path=?`,runId,row.path,row.input_json,row.operation_key,await sealText(target,canonical(proposed)),row.operation_key,actor.id,at,runId,row.path),
    stmt(env,`UPDATE crank_waits SET proposal_json=?,proposal_digest=?,resolved_at=NULL,resolution_json=NULL,decided_by=NULL WHERE run_id=? AND path=?`,await sealText(target,canonical(proposal)),newDigest,runId,row.path),
    stmt(env,'UPDATE crank_wf_steps SET input_json=? WHERE run_id=? AND path=?',await sealText(target,canonical(proposed)),runId,row.path),
    ...(index ? [index] : []),
    stmt(env,"UPDATE crank_wf_runs SET status='awaiting_approval' WHERE id=?",runId),
    auditStatement(env,actor.id,'grant.proposal.revise','run',runId,{path:row.path,prior_digest:row.proposal_digest,digest:newDigest},null),
    stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',guard),
  ])
  return readTask(env,actor,runId)
}
