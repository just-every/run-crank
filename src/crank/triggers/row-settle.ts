import { canonical, digest, stmt, type CrankEnv } from '../model'

/** Only a digest and observation time persist while a row is being filled. */
export async function rowReady(env: CrankEnv, workflow: string, version: string, record: string, trigger: Record<string, any>, fields: Record<string, unknown>, started: string, seed: boolean) {
  const params = [workflow, version, record], statements: D1PreparedStatement[] = []
  if (seed || !trigger.settle_delay && !trigger.required_columns?.length) return { ready: true, at: started, statements }
  const watched = trigger.any_field ? Object.keys(fields) : trigger.watched_fields ?? []
  const names = [...new Set([...watched, ...(trigger.mapped_columns ?? Object.keys(fields)), ...(trigger.required_columns ?? [])])].sort()
  const hash = await digest(canonical(names.map(name => [name, Object.hasOwn(fields, name), fields[name] ?? null])))
  const previous = await stmt(env, 'SELECT value_digest,stable_since FROM crank_app_pending_rows WHERE workflow_id=? AND version_id=? AND record_id=?', ...params).first<{ value_digest: string; stable_since: string }>()
  const since = previous?.value_digest === hash ? previous.stable_since : started
  const complete = (trigger.required_columns ?? []).every((name: string) => fields[name] !== undefined && fields[name] !== null && !(typeof fields[name] === 'string' && !fields[name].trim()) && !(Array.isArray(fields[name]) && !fields[name].length))
  const ready = complete && Date.parse(started) - Date.parse(since) >= Number(trigger.settle_delay ?? 0) * 60000
  if (ready) statements.push(stmt(env, 'DELETE FROM crank_app_pending_rows WHERE workflow_id=? AND version_id=? AND record_id=?', ...params))
  else statements.push(stmt(env, `INSERT INTO crank_app_pending_rows(workflow_id,version_id,record_id,value_digest,stable_since) VALUES(?,?,?,?,?)
    ON CONFLICT(workflow_id,version_id,record_id) DO UPDATE SET value_digest=excluded.value_digest,stable_since=excluded.stable_since`, ...params, hash, since))
  return { ready, at: since, statements }
}
