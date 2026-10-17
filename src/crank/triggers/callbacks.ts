import { mac } from '../connections/vault'
import { executeRun } from '../engine/executor'
import { resolveWait } from '../engine/records'
import { digest, now, stmt, type CrankEnv } from '../model'
import { parseInbound, rawBody } from './inbound'

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/** WORK-004 callback waits: the first valid callback before the deadline resumes the step
 * once; late or duplicate callbacks are recorded and ignored. */
export async function receiveCallback(request: Request, env: CrankEnv, token: string, defer?: (work: Promise<unknown>) => void) {
  const [runId, encoded, signature] = token.split('~')
  if (!runId || !encoded || !signature) return json({ error: 'Not found' }, 404)
  let path: string
  try { path = atob(encoded.replace(/-/g, '+').replace(/_/g, '/')) } catch { return json({ error: 'Not found' }, 404) }
  if (signature !== await mac(env, 'resume', runId + '\u0000' + path)) return json({ error: 'Not found' }, 404)
  const run = await stmt(env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', runId).first<{ workflow_id: string }>()
  if (!run) return json({ error: 'Not found' }, 404)
  const bytes = await rawBody(request, 256 * 1024)
  const inbound = await parseInbound(env, run.workflow_id, request, bytes, false)
  const wait = await stmt(env, "SELECT expires_at,resolved_at FROM crank_waits WHERE run_id=? AND path=? AND kind='callback'", runId, path).first<{ expires_at: string | null; resolved_at: string | null }>()
  const at = now(), live = !!wait && !wait.resolved_at && (!wait.expires_at || wait.expires_at > at)
  const accepted = live && await resolveWait(env, runId, path, { received: true, timed_out: false, received_at: at, body: inbound.body, query: inbound.query }, null)
  await stmt(env, 'INSERT INTO crank_callback_events(run_id,path,received_at,accepted,body_digest) VALUES(?,?,?,?,?)', runId, path, at, accepted ? 1 : 0, await digest(inbound.normalized)).run()
  if (!accepted) return json({ accepted: false, reason: wait?.resolved_at ? 'already resumed' : 'the wait has ended' }, 200)
  const work = executeRun(env, runId)
  if (defer) defer(work.catch(() => undefined)); else await work
  return json({ accepted: true }, 202)
}
