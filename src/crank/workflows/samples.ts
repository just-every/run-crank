import { guardedBatch, requireOwner, requirePrepare } from '../access'
import { randomToken } from '../connections/vault'
import { validateGraph, type Graph } from '../engine/graph'
import { isObject, lookup } from '../engine/values'
import { canonical, CrankError, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { openText, sealText, targetFor } from '../ops/payload-seal'
import { workflowScope } from '../team/policy'
import { parseInbound, rawBody } from '../triggers/inbound'
import { StepError } from '../engine/errors'
import { pendingRestore } from './restore'
import { getWorkflow } from './store'
import { canReadPayload, runDetail } from './runs'

type SampleRow = { id: string; workflow_id: string; step_path: string; source: string; source_id: string | null; source_time: string | null; payload_json: string; selected: number; created_at: string }
const sourceLabel = (row: Pick<SampleRow, 'source' | 'source_id' | 'id'>) => row.source === 'manual' ? 'manual sample' : row.source === 'schema' ? 'schema sample · not tested' : row.source === 'history' ? `history run ${row.source_id}` : `webhook sample ${row.id}`
function readScope(actor: Actor, workflowId: string) {
  workflowScope(actor, workflowId)
  requireValue(canReadPayload(actor, workflowId), 'Your role cannot read sample payloads', 403)
}
async function editable(env: CrankEnv, actor: Actor, workflowId: string) {
  requirePrepare(actor); readScope(actor, workflowId)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(!pendingRestore(workflow), 'Adopt the restored workflow before selecting or capturing samples', 409)
  return workflow
}
async function present(env: CrankEnv, row: SampleRow) {
  const payload = JSON.parse((await openText(env, row.workflow_id, row.payload_json, 'display'))!)
  return { id: row.id, step_path: row.step_path, source: row.source, source_id: row.source_id, source_time: row.source_time, label: sourceLabel(row), selected: !!row.selected, created_at: row.created_at, tested: false, payload }
}
export async function readSamples(env: CrankEnv, actor: Actor, workflowId: string) {
  readScope(actor, workflowId)
  const workflow = await getWorkflow(env, workflowId)
  const rows = (await stmt(env, 'SELECT * FROM crank_workflow_samples WHERE workflow_id=? ORDER BY created_at DESC,id DESC LIMIT 100', workflowId).all<SampleRow>()).results
  return { samples: await Promise.all(rows.map(row => present(env, row))), warnings: await sampleWarnings(env, actor, workflowId, JSON.parse(workflow.draft_json)) }
}
export async function saveSample(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  const workflow = await editable(env, actor, workflowId), source = String(input.source ?? 'manual'), step = String(input.step_path ?? 'trigger')
  requireValue(['manual','history','schema'].includes(source), 'Choose manual, history or schema sample')
  requireValue(step === 'trigger' || validateGraph(JSON.parse(workflow.draft_json)).declared.steps.some(s => s.path === step), 'Choose a step in this draft', 422)
  let payload = input.sample, sourceId: string | null = null, sourceTime: string | null = null
  if (source === 'history') {
    requireValue(step === 'trigger' && typeof input.run_id === 'string', 'Choose a history run for the trigger')
    const run = await runDetail(env, actor, input.run_id)
    requireValue(run.workflow_id === workflowId && !run.payload_expired_at, 'Choose retained history from this workflow', 422)
    requireValue('trigger' in run, 'Your role cannot read this history payload', 403)
    payload = run.trigger; sourceId = run.id; sourceTime = run.source_time ?? run.received_at
  }
  requireValue(isObject(payload), 'The sample must be a JSON object', 422)
  requireValue(canonical(payload).length <= 256 * 1024, 'The sample is too large', 413)
  const sampleId = id(), at = now(), target = await targetFor(env, workflowId)
  await guardedBatch(env, actor, 'prepare', [
    stmt(env, 'UPDATE crank_workflow_samples SET selected=0 WHERE workflow_id=? AND step_path=?', workflowId, step),
    stmt(env, 'INSERT INTO crank_workflow_samples(id,workflow_id,step_path,source,source_id,source_time,payload_json,selected,created_by,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)', sampleId, workflowId, step, source, sourceId, sourceTime, await sealText(target, canonical(payload)), actor.id, at),
    auditStatement(env, actor.id, 'workflow.sample', 'workflow', workflowId, { sample_id: sampleId, source, step }),
  ])
  return readSamples(env, actor, workflowId)
}
export async function sampleAction(env: CrankEnv, actor: Actor, workflowId: string, action: string, input: Record<string, unknown>) {
  await editable(env, actor, workflowId)
  if (action === 'fields') {
    requireValue(Array.isArray(input.fields) && input.fields.length <= 100 && input.fields.every(f => typeof f === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,160}$/.test(f)), 'Give up to 100 field paths')
    await guardedBatch(env, actor, 'prepare', [stmt(env, 'INSERT INTO crank_sample_fields(workflow_id,fields_json,updated_at) VALUES(?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET fields_json=excluded.fields_json,updated_at=excluded.updated_at', workflowId, canonical([...new Set(input.fields)]), now())])
  } else {
    requireValue(action === 'select' || action === 'delete', 'Unknown sample action', 404)
    requireValue(typeof input.sample_id === 'string' && input.sample_id.length > 0, 'Choose a retained sample', 422)
    const sample = await stmt(env, 'SELECT * FROM crank_workflow_samples WHERE id=? AND workflow_id=?', input.sample_id, workflowId).first<SampleRow>()
    requireValue(sample, 'Sample not found', 404)
    const deletion: D1PreparedStatement[] = []
    if (action === 'delete') {
      const { portability } = await import('../data')
      const store = await portability(env)
      const payload = (await openText(env, workflowId, sample.payload_json, 'display'))!
      const held = `EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL AND ((h.kind='workflow' AND h.workflow_id=?) OR (h.kind='subject' AND (instr(lower(?),h.subject_encoded)>0 OR json_extract(?,'$.sealed')=1))))`
      requireValue(!(await stmt(env, 'SELECT 1 WHERE '+held, workflowId, payload, payload).first()), 'This sample is under a legal hold', 409)
      const holdGuard = 'sample-delete:'+sample.id
      deletion.push(stmt(env, 'INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN NOT '+held+' THEN 1 ELSE 0 END', holdGuard, workflowId, payload, payload))
      deletion.push(stmt(env, 'DELETE FROM crank_workflow_samples WHERE id=? AND workflow_id=?', sample.id, workflowId), ...await store.erasureStatements('crank_workflow_samples', { id: sample.id }), ...await store.invalidateTransfersStatements(), auditStatement(env, actor.id, 'workflow.sample.delete', 'workflow', workflowId, {sample_id:sample.id}), stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', holdGuard))
    }
    await guardedBatch(env, actor, 'prepare', action === 'delete' ? deletion : [
      stmt(env, 'UPDATE crank_workflow_samples SET selected=0 WHERE workflow_id=? AND step_path=?', workflowId, sample.step_path),
      stmt(env, 'UPDATE crank_workflow_samples SET selected=1 WHERE id=? AND workflow_id=?', sample.id, workflowId),
    ])
  }
  return readSamples(env, actor, workflowId)
}
export async function previewSample(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requirePrepare(actor); readScope(actor, workflowId)
  if (input.sample !== undefined) {
    requireValue(isObject(input.sample), 'The sample must be a JSON object', 422)
    return { payload: input.sample, source: { source: 'manual', label: 'manual sample', tested: false } }
  }
  const row = await stmt(env, `SELECT * FROM crank_workflow_samples WHERE workflow_id=? AND step_path='trigger' AND ${input.sample_id ? 'id=?' : 'selected=1'}`, workflowId, ...(input.sample_id ? [input.sample_id] : [])).first<SampleRow>()
  requireValue(row, 'Select a trigger sample first', 422)
  return { payload: JSON.parse((await openText(env, workflowId, row.payload_json))!), source: { id: row.id, source: row.source, source_id: row.source_id, source_time: row.source_time, label: sourceLabel(row), tested: false } }
}
export async function sampleWarnings(env: CrankEnv, actor: Actor, workflowId: string, graph: Graph) {
  workflowScope(actor, workflowId)
  if (!canReadPayload(actor, workflowId)) return []
  const warnings: string[] = [], row = await stmt(env, "SELECT * FROM crank_workflow_samples WHERE workflow_id=? AND step_path='trigger' AND selected=1", workflowId).first<SampleRow>()
  if (row) {
    const payload = JSON.parse((await openText(env, workflowId, row.payload_json, 'display'))!), fields = await stmt(env, 'SELECT fields_json FROM crank_sample_fields WHERE workflow_id=?', workflowId).first<{fields_json:string}>()
    const expected = new Set<string>(fields ? JSON.parse(fields.fields_json) : [])
    for (const match of canonical(graph.steps).matchAll(/trigger\.([a-zA-Z0-9_.\[\]-]+)/g)) expected.add(match[1])
    const missing = [...expected].filter(field => !lookup(payload, field).found).sort()
    if (missing.length) warnings.push(`Stale sample: missing fields ${missing.join(', ')}`)
    if (row.source === 'schema') warnings.push('Trigger relies on a schema sample; not tested')
  } else warnings.push('Trigger relies on a schema sample; not tested')
  const tested = new Set((await stmt(env, `SELECT DISTINCT s.path FROM crank_wf_steps s JOIN crank_wf_runs r ON r.id=s.run_id JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.workflow_id=? AND r.mode='test' AND (v.graph_json=? OR json_extract(v.declared_json,'$.test_draft_digest')=?) AND s.status='succeeded'`, workflowId, canonical(graph), await digest(canonical(graph))).all<{path:string}>()).results.map(s=>s.path))
  for (const step of validateGraph(graph).declared.steps.filter(s => !['map','transform','filter','paths','loop'].includes(s.type))) {
    if (!tested.has(step.path)) warnings.push(`Step ${step.path} relies on a schema sample; not tested`)
  }
  return warnings
}
export async function listenForSample(env: CrankEnv, actor: Actor, workflowId: string) {
  requireOwner(actor)
  const workflow = await editable(env, actor, workflowId)
  requireValue(JSON.parse(workflow.draft_json).trigger.type === 'webhook', 'Choose a draft webhook trigger', 422)
  const secret = randomToken(), expires = new Date(Date.now() + 10 * 60000).toISOString()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'DELETE FROM crank_sample_listeners WHERE workflow_id=? OR expires_at<=?', workflowId, now()),
    stmt(env, 'INSERT INTO crank_sample_listeners(secret_hash,workflow_id,draft_json,created_by,operator_version,session_id,expires_at) VALUES(?,?,?,?,?,?,?)', await digest(secret), workflowId, workflow.draft_json, actor.id, actor.version, actor.sessionId, expires),
    auditStatement(env, actor.id, 'workflow.sample.listen', 'workflow', workflowId, { expires_at: expires }),
  ])
  return { url: new URL('/hooks/sample/' + secret, env.AUTH_ORIGIN).href, expires_at: expires }
}
export async function receiveSample(request: Request, env: CrankEnv, secret: string) {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 })
  try {
    const hash = await digest(secret), listener = await stmt(env, 'SELECT * FROM crank_sample_listeners WHERE secret_hash=?', hash).first<{workflow_id:string;created_by:string;draft_json:string}>()
    requireValue(listener, 'Sample listener expired or unavailable', 404)
    const inbound = await parseInbound(env, listener.workflow_id, request, await rawBody(request), true)
    for (const name of Object.keys(inbound.headers)) if (/authorization|cookie|token|key|secret|password|signature/i.test(name)) delete inbound.headers[name]
    const payload = { method: inbound.method, headers: inbound.headers, query: inbound.query, body: inbound.body, files: inbound.files, raw: inbound.raw }
    const sampleId = id(), at = now(), target = await targetFor(env, listener.workflow_id), guard = 'sample:' + sampleId
    await env.DB.batch([
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_sample_listeners l JOIN crank_workflows w ON w.id=l.workflow_id JOIN oa_operators o ON o.id=l.created_by JOIN oa_sessions s ON s.id=l.session_id WHERE l.secret_hash=? AND l.expires_at>? AND w.draft_json=l.draft_json AND w.owner_id!='restore:awaiting-adoption' AND o.status='active' AND o.role='owner' AND o.version=l.operator_version AND s.operator_id=o.id AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>? AND s.kind IN ('native','dev')) THEN 1 ELSE 0 END`, guard, hash, at, Date.now()),
      stmt(env, "UPDATE crank_workflow_samples SET selected=0 WHERE workflow_id=? AND step_path='trigger'", listener.workflow_id),
      stmt(env, "INSERT INTO crank_workflow_samples(id,workflow_id,step_path,source,source_time,payload_json,uploads_json,selected,created_by,created_at) VALUES(?,?,'trigger','webhook',?,?,?,1,?,?)", sampleId, listener.workflow_id, at, await sealText(target, canonical(payload)), await sealText(target, canonical(inbound.uploads)), listener.created_by, at),
      stmt(env, 'DELETE FROM crank_sample_listeners WHERE secret_hash=?', hash),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
      auditStatement(env, listener.created_by, 'workflow.sample.capture', 'workflow', listener.workflow_id, { sample_id: sampleId }),
    ])
    return Response.json({ captured: true, sample_id: sampleId }, { status: 201, headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof CrankError || error instanceof StepError) return Response.json({ error: error.message }, { status: error instanceof CrankError ? error.status : 400 })
    if (/crank_authority_guards|CHECK constraint failed: ok/.test(String(error))) return Response.json({ error: 'Sample listener expired or authority changed' }, { status: 404 })
    throw error
  }
}
