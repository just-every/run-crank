import { deploymentHealth } from '../base/deployment-health'
import type { Bindings } from '../auth.server'

/** Dependency probes never return exception text, configuration values or database content. */
export async function healthResponse(env: Bindings): Promise<Response> {
  const missing = ['DB', 'AUTH_ORIGIN', 'OWNER_EMAIL', 'SESSION_SECRET'].filter(name => !env[name as keyof Bindings])
  if (missing.length) return Response.json({ ok: false, status: 'unavailable', missing_bindings: missing }, { status: 503, headers: { 'cache-control': 'no-store' } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      env.DB.batch([
        env.DB.prepare('SELECT id FROM oa_operators LIMIT 1'),
        env.DB.prepare('SELECT id FROM crank_wf_runs LIMIT 1'),
        env.DB.prepare('SELECT id FROM crank_audit LIMIT 1'),
      ]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), 2000) }),
    ])
    return Response.json({ status: 'ok', ...deploymentHealth(env), dependencies: { DB: 'available', executor_storage: 'available' } }, { headers: { 'cache-control': 'no-store' } })
  } catch {
    return Response.json({ ok: false, status: 'unavailable', dependencies: { DB: 'unavailable', executor_storage: 'unavailable' } }, { status: 503, headers: { 'cache-control': 'no-store' } })
  } finally { clearTimeout(timer) }
}
