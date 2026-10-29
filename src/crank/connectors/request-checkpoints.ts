import { fileBase64, indexStatement, isSealed, openText, sealFileBase64, sealJson, targetFor } from '../ops/payload-seal'
import { StepError } from '../engine/errors'
import type { BoundedResponse } from '../engine/egress'
import type { RequestContext } from './retry'
import { stmt, type CrankEnv } from '../model'

const credentialHeader = /authorization|cookie|api[-_]?key|token|secret|password|signature/i
export interface RequestResult { response: BoundedResponse; attempts: number; exhausted?: boolean }
const CHUNK_BYTES = 65536
const bytes64 = (bytes: Uint8Array) => {
  let encoded = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(encoded)
}

async function responseBytes(env: CrankEnv, key: { run_id: string; path: string; operation_key: string; ordinal: number }, length: number) {
  const run = await stmt(env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', key.run_id).first<{workflow_id: string}>()
  if (!run) throw new StepError('validation', 'The retained connector run is missing')
  const chunks = await stmt(env, 'SELECT chunk_index,content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=? AND path=? AND operation_key=? AND ordinal=? ORDER BY chunk_index', key.run_id, key.path, key.operation_key, key.ordinal).all<{chunk_index: number; content_base64: string}>()
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const [index, chunk] of chunks.results.entries()) {
    if (chunk.chunk_index !== index) throw new StepError('validation', 'A retained connector response chunk is missing')
    const decoded = Uint8Array.from(atob(await fileBase64(env, run.workflow_id, chunk.content_base64)), c => c.charCodeAt(0))
    bytes.set(decoded, offset); offset += decoded.length
  }
  if (offset !== length) throw new StepError('validation', 'The retained connector response length changed')
  return bytes
}

/** Reconstruct a step's completed calls, including earlier pagination pages,
 * rather than refetching changed data or repeating a committed write. */
export async function requestCheckpoint(ctx: RequestContext, ordinal: number, requestKey: string) {
  const row = await stmt(ctx.env, 'SELECT request_key,response_json,attempts,exhausted FROM crank_request_checkpoints WHERE run_id=? AND path=? AND operation_key=? AND ordinal=?', ctx.run.id, ctx.path, ctx.operationKey, ordinal)
    .first<{ request_key: string; response_json: string; attempts: number; exhausted: number }>()
  if (!row) return null
  if (row.request_key !== requestKey) throw new StepError('validation', 'The retained connector continuation no longer matches its immutable request; inspect this run before starting new work.')
  const response = JSON.parse(row.response_json)
  const run = await stmt(ctx.env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', ctx.run.id).first<{workflow_id: string}>()
  if (!run) throw new StepError('authority', 'The retained response no longer belongs to a run')
  response.headers = JSON.parse((await openText(ctx.env, run.workflow_id, JSON.stringify(response.headers)))!)
  const bytes = await responseBytes(ctx.env, { run_id: ctx.run.id, path: ctx.path, operation_key: ctx.operationKey, ordinal }, response.body_bytes)
  return { response: { ...response, headers: new Headers(response.headers), bytes } as BoundedResponse, attempts: row.attempts, exhausted: !!row.exhausted }
}

/** A definite authorization refusal is recoverable after an explicit owner resume. */
export async function discardRequestCheckpoint(ctx: RequestContext, ordinal: number) {
  await stmt(ctx.env, 'DELETE FROM crank_request_checkpoints WHERE run_id=? AND path=? AND operation_key=? AND ordinal=?', ctx.run.id, ctx.path, ctx.operationKey, ordinal).run()
}

export async function saveRequestCheckpoint(ctx: RequestContext, ordinal: number, requestKey: string, result: RequestResult) {
  const response = result.response
  const target = await targetFor(ctx.env, ctx.run.workflow_id)
  // The effective URL may contain a credential query parameter. Only the
  // value-free request digest identifies it; response consumers use the URL
  // prepared by their graph, not a persisted URL with installation credentials.
  const safeUrl = new URL(response.url)
  safeUrl.search = ''; safeUrl.hash = ''; safeUrl.username = ''; safeUrl.password = ''
  const safe = { status: response.status, headers: [...response.headers].filter(([key]) => !credentialHeader.test(key)), body_bytes: response.bytes.length, chunk_count: Math.ceil(response.bytes.length / CHUNK_BYTES), url: safeUrl.href, redirects: response.redirects }
  const stored = { ...safe, headers: JSON.parse((await sealJson(target, safe.headers))!) }
  const guard = "EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?)"
  const index = await indexStatement(ctx.env, target, ctx.run.id, [checkpointText(response.bytes), JSON.stringify(safe.headers)], guard, [ctx.run.id,ctx.run.lease_id])
  const jobs = [stmt(ctx.env, `INSERT INTO crank_request_checkpoints(run_id,path,operation_key,ordinal,request_key,response_json,attempts,exhausted)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?)
    ON CONFLICT(run_id,path,operation_key,ordinal) DO NOTHING`, ctx.run.id, ctx.path, ctx.operationKey, ordinal, requestKey, JSON.stringify(stored), result.attempts, result.exhausted ? 1 : 0, ctx.run.id, ctx.run.lease_id)]
  for (let offset = 0; offset < response.bytes.length; offset += CHUNK_BYTES) jobs.push(stmt(ctx.env, `INSERT INTO crank_request_checkpoint_chunks(run_id,path,operation_key,ordinal,chunk_index,content_base64)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?)
    ON CONFLICT DO NOTHING`, ctx.run.id, ctx.path, ctx.operationKey, ordinal, offset / CHUNK_BYTES, await sealFileBase64(target, bytes64(response.bytes.subarray(offset, offset + CHUNK_BYTES))), ctx.run.id, ctx.run.lease_id))
  if (index) jobs.push(index)
  await ctx.env.DB.batch(jobs)
  return result
}

/** DATA-002 also finds a subject whose only retained occurrence is in an
 * unfinished page. Scan in small batches; cancellation drops these responses. */
export async function checkpointSubjects(env: CrankEnv, subject: string) {
  const runs = new Set<string>()
  let after = 0
  for (;;) {
    const page = await stmt(env, 'SELECT c.rowid AS cursor,c.run_id,c.path,c.operation_key,c.ordinal,c.response_json FROM crank_request_checkpoints c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.rowid>? ORDER BY c.rowid LIMIT 25', after)
      .all<{ cursor: number; run_id: string; path: string; operation_key: string; ordinal: number; response_json: string }>()
    if (!page.results.length) return [...runs]
    for (const row of page.results) {
      const response = JSON.parse(row.response_json)
      // Legacy plaintext pages remain discoverable even on an already sealed run.
      // Sealed pages use only the declared-field blind index, without opening keys.
      const chunk = await stmt(env, 'SELECT content_base64 FROM crank_request_checkpoint_chunks WHERE run_id=? AND path=? AND operation_key=? AND ordinal=? ORDER BY chunk_index LIMIT 1', row.run_id, row.path, row.operation_key, row.ordinal).first<{content_base64: string}>()
      if (isSealed(chunk?.content_base64)) { after = row.cursor; continue }
      const text = new TextDecoder().decode(await responseBytes(env, row, response.body_bytes)).toLowerCase()
      if (text.includes(subject) || text.includes(JSON.stringify(subject).slice(1, -1)) || JSON.stringify(response.headers).toLowerCase().includes(subject)) runs.add(row.run_id)
      after = row.cursor
    }
  }
}

function checkpointText(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes)
  try { JSON.parse(text); return text } catch { return JSON.stringify(text) }
}

/** Include unfinished pages when a data class or identifier declaration changes. */
export async function checkpointIndexTexts(env: CrankEnv, runId: string) {
  const rows = await stmt(env, 'SELECT run_id,path,operation_key,ordinal,response_json FROM crank_request_checkpoints WHERE run_id=?', runId).all<{run_id:string;path:string;operation_key:string;ordinal:number;response_json:string}>()
  const texts: string[] = []
  for (const row of rows.results) {
    const response = JSON.parse(row.response_json)
    texts.push(checkpointText(await responseBytes(env,row,response.body_bytes)))
  }
  return texts
}

/** Declared JSON/body identifiers remain available to existing custody callers. */
export const checkpointPayloads = checkpointIndexTexts
