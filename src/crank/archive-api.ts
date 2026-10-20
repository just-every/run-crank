import { auditStatement, auditStatementWhen } from './ops/audit'
import { body, requireValue, stmt, type Actor, type CrankEnv } from './model'
import type { portability } from './data'

type Store = Awaited<ReturnType<typeof portability>>
/** Called only after Data's native owner and write-Origin checks. Every chunk is
 * an existing Base transfer checkpoint; no request owns a whole archive's lifetime. */
export async function archiveTransferApi(request: Request, env: CrankEnv, store: Store, actor: Actor): Promise<Response | null> {
  const path = new URL(request.url).pathname, headers = { 'cache-control': 'no-store' }
  if (path === '/api/crank/data/transfers' && request.method === 'POST') {
    const input = await body(request, 4096)
    requireValue(input.kind === 'export', 'Choose an export transfer')
    const id = await store.exports.create(actor.id)
    await auditStatement(env, actor.id, 'data.transfer.create', 'archive_transfer', id, { kind: 'export' }).run()
    return Response.json(await store.exports.status(id), { status: 201, headers })
  }
  const match = /^\/api\/crank\/data\/transfers\/([^/]+)\/(advance|download)$/.exec(path)
  if (!match) return null
  const id = decodeURIComponent(match[1]), action = match[2]
  requireValue(await stmt(env, "SELECT id FROM rer_portability_jobs WHERE id=? AND kind='export'", id).first(), 'Export transfer not found', 404)
  if (action === 'advance' && request.method === 'POST') {
    const input = await body(request, 4096)
    requireValue(Number.isInteger(input.maxParts) && Number(input.maxParts) >= 1 && Number(input.maxParts) <= 10, 'maxParts must be from 1 to 10')
    const status = await store.exports.advance(id, { maxParts: Number(input.maxParts) })
    if (status.phase === 'complete') await auditStatementWhen(env, "NOT EXISTS(SELECT 1 FROM crank_audit WHERE action='data.export' AND subject_kind='archive_transfer' AND subject_id=?)", [id], actor.id, 'data.export', 'archive_transfer', id, { bytes: status.bytes }).run()
    return Response.json(status, { headers })
  }
  if (action === 'download' && request.method === 'GET') {
    const stream = await store.exports.download(id)
    await auditStatement(env, actor.id, 'data.transfer.download', 'archive_transfer', id, { basis: 'download started; receipt unverified' }).run()
    return new Response(stream, { headers: { ...headers, 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="crank.rer"' } })
  }
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers })
}
