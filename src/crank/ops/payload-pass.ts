import { checkpointIndexTexts } from '../connectors/request-checkpoints'
import { id, stmt, type CrankEnv } from '../model'
import { activeKey, destroyUnreferenced, NEEDS_RESEAL, RESEAL_POSSIBLE } from './payload-keys'
import { blindDigests, fileBase64, openText, SEALED_PREFIX, sealFileBase64, sealText, subjectDigests, targetFor, type Target } from './payload-seal'

const RUNS_PER_PASS = 25, ITEMS_PER_PASS = 50, FILES_PER_PASS = 10
const PREFIX_SQL = `'${SEALED_PREFIX}'`
const plainOrHeld = (column: string) => `(substr(${column},1,${SEALED_PREFIX.length})!=${PREFIX_SQL} OR EXISTS(SELECT 1 FROM crank_payload_keys x WHERE x.sealed_key IS NOT NULL AND instr(${column},'"k":"'||x.id||'"')>0))`
/** SQL over a value column of a row whose workflow is `w`: stored differently from its target. */
const stale = (column: string) => `CASE WHEN w.data_class IN ('customer','financial','health')
  THEN NOT EXISTS(SELECT 1 FROM crank_payload_keys k WHERE k.data_class=w.data_class AND k.status='active' AND instr(${column},'"k":"'||k.id||'"')>0)
  ELSE substr(${column},1,${SEALED_PREFIX.length})=${PREFIX_SQL} END`

/** Everything the pass rewrites for one run, as one comparable text; a concurrent write or lease changes it. */
const FINGERPRINT = `SELECT COALESCE(r.trigger_json,'')||'|'||COALESCE(r.response_json,'')||'|'||COALESCE(r.error_json,'')||'|'||COALESCE(r.lease_id,'')||'|'||COALESCE(r.payload_key,'')||'|'||COALESCE(r.status,'')||'|'||
  COALESCE((SELECT group_concat(x,'#') FROM (SELECT path||'|'||status||'|'||COALESCE(input_json,'')||'|'||COALESCE(output_json,'')||'|'||COALESCE(trace_json,'')||'|'||COALESCE(error_json,'') AS x FROM crank_wf_steps WHERE run_id=r.id ORDER BY path)),'')||'|'||
  COALESCE((SELECT group_concat(x,'#') FROM (SELECT path||'|'||revision||'|'||COALESCE(input_json,'')||'|'||COALESCE(prior_input_json,'')||'|'||COALESCE(prior_error_json,'') AS x FROM crank_wf_step_revisions WHERE run_id=r.id ORDER BY path,revision)),'')||'|'||
  COALESCE((SELECT group_concat(x,'#') FROM (SELECT path||'|'||COALESCE(proposal_json,'')||'|'||COALESCE(resolution_json,'') AS x FROM crank_waits WHERE run_id=r.id ORDER BY path)),'')||'|'||
  COALESCE((SELECT group_concat(x,'#') FROM (SELECT path||'|'||operation_key||'|'||ordinal||'|'||response_json AS x FROM crank_request_checkpoints WHERE run_id=r.id ORDER BY path,operation_key,ordinal)),'')||'|'||
  COALESCE((SELECT group_concat(x,'#') FROM (SELECT path||'|'||operation_key||'|'||ordinal||'|'||chunk_index||'|'||content_base64 AS x FROM crank_request_checkpoint_chunks WHERE run_id=r.id ORDER BY path,operation_key,ordinal,chunk_index)),'') AS fp
  FROM crank_wf_runs r WHERE r.id=?`

/** DATA-003, per Cron minute: brings up to 25 runs, 50 held or historical event copies and 10 run
 * files to their workflow's current form (sealed under the class's active key with the declared
 * identifier fields indexed, or plaintext), each in one atomic batch, so a restart resumes where it
 * stopped. This is the migration of existing payloads, the batched rotation and the unsealing of a
 * workflow moved out of a sealed class. Runs being executed are skipped until their lease ends. */
export async function payloadPass(env: CrankEnv, time = Date.now()) {
  const at = new Date(time).toISOString(), summary = { runs: 0, items: 0, files: 0, destroyed: 0 }
  for (const dataClass of (await stmt(env, "SELECT DISTINCT data_class FROM crank_workflows WHERE data_class IN ('customer','financial','health')").all<{ data_class: string }>()).results.map(r => r.data_class))
    await activeKey(env, dataClass)
  const targets = new Map<string, Promise<Target>>()
  const target = (workflowId: string) => { let t = targets.get(workflowId); if (!t) targets.set(workflowId, t = targetFor(env, workflowId)); return t }

  const runs = (await stmt(env, `SELECT r.id,r.workflow_id FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
    WHERE ${NEEDS_RESEAL} AND ${RESEAL_POSSIBLE} AND (r.lease_id IS NULL OR r.lease_expires_at<?) ORDER BY COALESCE(r.payload_failed_at,''),r.received_at,r.id LIMIT ${RUNS_PER_PASS}`, at).all<{ id: string; workflow_id: string }>()).results
  for (const run of runs) {
    try { if (await resealRun(env, await target(run.workflow_id), run.id, at)) summary.runs++ }
    catch { await stmt(env, 'UPDATE crank_wf_runs SET payload_failed_at=? WHERE id=?', at, run.id).run() }
  }
  const copies: {table:string;from:string;workflow:string;column:string;files?:boolean}[] = [
    ...['payload_json','uploads_json'].map(column=>({table:'crank_workflow_samples',from:'crank_workflow_samples i JOIN crank_workflows w ON w.id=i.workflow_id',workflow:'i.workflow_id',column})),
    { table: 'crank_app_snapshots', from: 'crank_app_snapshots i JOIN crank_workflows w ON w.id=i.workflow_id', workflow: 'i.workflow_id', column: 'fields_json' },
    ...['input_json','output_json'].map(column=>({table:'crank_gateway_tasks',from:'crank_gateway_tasks i JOIN crank_wf_runs r ON r.id=i.run_id JOIN crank_workflows w ON w.id=r.workflow_id',workflow:'r.workflow_id',column})),
    { table: 'crank_hold_items', from: 'crank_hold_items i JOIN crank_holds h ON h.id=i.hold_id JOIN crank_workflows w ON w.id=h.workflow_id', workflow: 'h.workflow_id', column: 'payload_json' },
    { table: 'crank_historical_items', from: 'crank_historical_items i JOIN crank_historical_batches h ON h.id=i.batch_id JOIN crank_workflows w ON w.id=h.workflow_id', workflow: 'h.workflow_id', column: 'payload_json' },
    { table: 'crank_files', from: 'crank_files i JOIN crank_workflows w ON w.id=i.workflow_id', workflow: 'i.workflow_id', column: 'content_base64', files: true },
  ]
  for (const copy of copies) {
    const rows = (await stmt(env, `SELECT i.rowid AS rid,i.${copy.column} AS value,${copy.workflow} AS workflow_id FROM ${copy.from}
      WHERE i.${copy.column}!='{}' AND ${stale('i.' + copy.column)} AND ${plainOrHeld('i.' + copy.column)} LIMIT ${copy.files ? FILES_PER_PASS : ITEMS_PER_PASS}`).all<{ rid: number; value: string; workflow_id: string }>()).results
    for (const row of rows) {
      try {
        const t = await target(row.workflow_id), opened = await openText(env, row.workflow_id, row.value)
        // A plaintext file holds raw base64, not JSON text.
        const text = copy.files && opened === row.value ? JSON.stringify(row.value) : opened
        const next = t.key ? await sealText(t, text) : copy.files ? JSON.parse(text!) : text
        const result = await stmt(env, `UPDATE ${copy.table} SET ${copy.column}=? WHERE rowid=? AND ${copy.column} IS ?`, next, row.rid, row.value).run()
        if (result.meta.changes) copy.files ? summary.files++ : summary.items++
      } catch { /* sealed under a key this installation no longer reads: left for the owner's key file */ }
    }
  }
  await holdDigests(env)
  summary.destroyed = await destroyUnreferenced(env, time)
  return summary
}

async function resealRun(env: CrankEnv, target: Target, runId: string, at: string) {
  const [run, steps, revisions, waits, chunks, checkpoints, fp] = await Promise.all([
    stmt(env, 'SELECT trigger_json,response_json,error_json FROM crank_wf_runs WHERE id=?', runId).first<{ trigger_json: string; response_json: string | null; error_json: string | null }>(),
    stmt(env, 'SELECT path,input_json,output_json,trace_json,error_json FROM crank_wf_steps WHERE run_id=?', runId).all<{ path: string; input_json: string | null; output_json: string | null; trace_json: string | null; error_json: string | null }>(),
    stmt(env, 'SELECT path,revision,input_json,prior_input_json,prior_error_json FROM crank_wf_step_revisions WHERE run_id=?', runId).all<{ path: string; revision: number; input_json: string | null; prior_input_json: string | null; prior_error_json: string | null }>(),
    stmt(env, 'SELECT path,proposal_json,resolution_json FROM crank_waits WHERE run_id=?', runId).all<{ path: string; proposal_json: string | null; resolution_json: string | null }>(),
    stmt(env, 'SELECT rowid AS rid,content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=?', runId).all<{rid: number; content_base64: string}>(),
    stmt(env, 'SELECT rowid AS rid,response_json FROM crank_request_checkpoints WHERE run_id=?', runId).all<{rid: number; response_json: string}>(),
    stmt(env, FINGERPRINT, runId).first<{ fp: string }>(),
  ])
  if (!run || !fp) return false
  const w = target.workflowId, open = (text: string | null) => openText(env, w, text)
  const reseal = async (text: string | null) => sealText(target, await open(text))
  const trigger = await open(run.trigger_json), stepPlain = await Promise.all(steps.results.map(async s => ({ ...s, input: await open(s.input_json), output: await open(s.output_json) })))
  const digests = await blindDigests(target, [trigger, ...stepPlain.flatMap(s => [s.input, s.output]), ...await checkpointIndexTexts(env,runId)])
  const guard = id()
  const statements = [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN (${FINGERPRINT.replace('WHERE r.id=?', 'WHERE r.id=? AND (r.lease_id IS NULL OR r.lease_expires_at<?)')})=? THEN 1 ELSE 0 END`, guard, runId, at, fp.fp),
    stmt(env, 'UPDATE crank_wf_runs SET trigger_json=?,response_json=?,error_json=?,payload_key=?,payload_index=?,payload_failed_at=NULL WHERE id=?',
      await sealText(target, trigger), await reseal(run.response_json), await reseal(run.error_json), target.key?.id ?? null, target.key ? target.fieldsJson : null, runId),
    ...await Promise.all(stepPlain.map(async s => stmt(env, 'UPDATE crank_wf_steps SET input_json=?,output_json=?,trace_json=?,error_json=? WHERE run_id=? AND path=?',
      await sealText(target, s.input), await sealText(target, s.output), await reseal(s.trace_json), await reseal(s.error_json), runId, s.path))),
    ...await Promise.all(revisions.results.map(async r => stmt(env, 'UPDATE crank_wf_step_revisions SET input_json=?,prior_input_json=?,prior_error_json=? WHERE run_id=? AND path=? AND revision=?', await reseal(r.input_json), await reseal(r.prior_input_json), await reseal(r.prior_error_json), runId, r.path, r.revision))),
    ...await Promise.all(waits.results.map(async x => stmt(env, 'UPDATE crank_waits SET proposal_json=?,resolution_json=? WHERE run_id=? AND path=?', await reseal(x.proposal_json), await reseal(x.resolution_json), runId, x.path))),
    ...await Promise.all(chunks.results.map(async x => stmt(env, 'UPDATE crank_request_checkpoint_chunks SET content_base64=? WHERE rowid=?', await sealFileBase64(target, await fileBase64(env, w, x.content_base64)), x.rid))),
    ...await Promise.all(checkpoints.results.map(async x => {
      const response = JSON.parse(x.response_json)
      response.headers = JSON.parse((await reseal(JSON.stringify(response.headers)))!)
      return stmt(env, 'UPDATE crank_request_checkpoints SET response_json=? WHERE rowid=?', JSON.stringify(response), x.rid)
    })),
    stmt(env, 'DELETE FROM crank_blind_index WHERE run_id=?', runId),
    ...(digests.length ? [stmt(env, 'INSERT OR IGNORE INTO crank_blind_index(run_id,key_id,digest) SELECT ?,?,value FROM json_each(?)', runId, target.key!.id, JSON.stringify(digests))] : []),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ]
  try { await env.DB.batch(statements); return true } catch (error) {
    if (/CHECK constraint failed: ok/.test(String(error))) return false
    throw error
  }
}

/** Every open subject hold carries its identifier's digest under every key this installation holds. */
async function holdDigests(env: CrankEnv) {
  const holds = (await stmt(env, `SELECT h.id,h.subject FROM crank_legal_holds h WHERE h.released_at IS NULL AND h.kind='subject' AND h.subject IS NOT NULL
    AND EXISTS(SELECT 1 FROM crank_payload_keys k WHERE k.sealed_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crank_hold_digests d WHERE d.hold_id=h.id AND d.key_id=k.id))`).all<{ id: string; subject: string }>()).results
  for (const hold of holds) {
    const digests = await subjectDigests(env, hold.subject)
    if (digests.length) await env.DB.batch(digests.map(d => stmt(env, 'INSERT OR IGNORE INTO crank_hold_digests(hold_id,key_id,digest) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM crank_legal_holds WHERE id=? AND released_at IS NULL)', hold.id, d.key_id, d.digest, hold.id)))
  }
}
