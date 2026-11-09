import { businessRunning } from './business-state.ts'
import { verifyJws } from './credentials.ts'
import { error, json } from './errors.ts'
import type { AuditRow } from './audit.ts'
import type { Runtime } from './types.ts'

const encoder = new TextEncoder()
const claims = ['v', 'iss', 'aud', 'sub', 'business', 'after', 'limit', 'iat', 'exp', 'jti']
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
interface FeedRow {
  business: string | null; head: number; sequence: number | null; row: string | null
  approval_state: string | null; expires_at: string | null; review_state: string | null
}

async function pullBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); return null }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'pull') return null
    const pull = (body as { pull: unknown }).pull
    return typeof pull === 'string' ? pull : null
  } catch { return null } finally { reader.releaseLock() }
}

function project(record: FeedRow, now: number) {
  const row = JSON.parse(record.row!) as AuditRow
  const common = { id: row.id, seq: record.sequence!, at: row.at, tool: row.tool,
    classes: row.classes.map(item => item.class), disposition: row.decision, agent: row.agent.id }
  if (row.tombstone) return { ...common, erased: true }
  const links = row.tool === 'resources/read' && typeof row.resource === 'string' ? [row.resource] : row.resources ?? []
  const resources = links.filter(uri => typeof uri === 'string' && uri.length <= 512).slice(0, 8)
  return { ...common, outcome: row.outcome, code: row.code && /^[a-z][a-z0-9_]{0,63}$/.test(row.code) ? row.code : null,
    revision: row.revision, consent: row.consent, execution_of: row.decision_id, replay_of: row.replay_of,
    approval: record.approval_state === null ? null : {
      state: record.approval_state === 'executing' ? 'pending' : record.approval_state === 'pending' && now >= Date.parse(record.expires_at!) ? 'expired' : record.approval_state,
      expires_at: record.expires_at,
    }, review: record.review_state === null ? null : { state: record.review_state },
    resources, resource_count: Math.max(resources.length, row.tool === 'resources/read' ? links.length : row.resource_count ?? links.length) }
}

/** A signed Business pull; no credential, person session or outbound request. */
export async function relayDecisions(rt: Runtime, request: Request): Promise<Response> {
  if (request.method !== 'POST') return error('method_not_allowed', 405)
  const pull = await pullBody(request)
  if (pull === null) return error('relay_invalid')
  const { trust, db } = rt.options
  if (!trust) return new Response(null, { status: 404 })
  const value = await verifyJws(pull, 'rer-agent-decisions+jwt', trust.publicKeys)
  const now = rt.now(), seconds = now / 1000
  if (!value || Object.keys(value).length !== claims.length || claims.some(key => !Object.hasOwn(value, key)) ||
    value.v !== 1 || value.iss !== trust.issuer || value.aud !== trust.appOrigin || value.sub !== trust.installationId ||
    !nonempty(value.business) || !nonempty(value.jti) || !Number.isSafeInteger(value.after) || Number(value.after) < 0 ||
    !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200 ||
    !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || !Number.isFinite(seconds) ||
    Number(value.iat) > seconds + 30 || Number(value.exp) <= seconds || Number(value.exp) <= Number(value.iat) || Number(value.exp) - Number(value.iat) > 60) return error('relay_unauthenticated', 401)
  if (!await businessRunning(rt.options.people)) return new Response(null, { status: 404 })
  // One snapshot and one indexed feed range read, including empty pages and the
  // current pairing. Join only public state from approvals and reviews.
  const records = (await db.prepare(`SELECT context.business,head.head,feed.sequence,a.row,
      p.state AS approval_state,json_extract(p.saved,'$.expires_at') AS expires_at,v.state AS review_state
    FROM (SELECT (SELECT json_extract(envelope,'$.business') FROM agent_door_state WHERE id=1) AS business) context
    CROSS JOIN (SELECT COALESCE(MAX(sequence),0) AS head FROM agent_door_relay WHERE business=?) head
    LEFT JOIN (SELECT sequence,decision_id FROM agent_door_relay WHERE business=? AND sequence>? ORDER BY sequence LIMIT ?) feed ON 1=1
    LEFT JOIN agent_door_audit a ON a.id=feed.decision_id
    LEFT JOIN agent_door_approvals p ON p.id=json_extract(a.row,'$.approval.id')
    LEFT JOIN agent_door_reviews v ON v.id=json_extract(a.row,'$.review.id')
    ORDER BY feed.sequence`).bind(value.business, value.business, value.after, value.limit).all<FeedRow>()).results
  if (records[0]?.business !== value.business) return new Response(null, { status: 404 })
  const head = records[0]!.head, decisions: ReturnType<typeof project>[] = []
  let cursor = Number(value.after), decisionBytes = 0
  for (const record of records) {
    if (record.sequence === null || record.row === null) continue
    const decision = project(record, now)
    const bytes = encoder.encode(JSON.stringify(decision)).byteLength
    // An empty envelope includes the brackets; each preceding decision adds one
    // comma. Measure cursor/more for this candidate so page edges stay identical.
    const envelope = { decisions: [], cursor: record.sequence, head, more: record.sequence < head }
    const size = encoder.encode(JSON.stringify(envelope)).byteLength + decisionBytes + decisions.length + bytes
    if (size > 65536) break
    decisionBytes += bytes
    decisions.push(decision); cursor = record.sequence
  }
  return json({ decisions, cursor, head, more: cursor < head })
}
