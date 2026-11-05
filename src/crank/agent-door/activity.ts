import type { AuditRow } from '../../modules/agent-door/audit'
import { classes, isClass } from '../../modules/agent-door/policy/catalogue'
import type { Person } from '../../modules/agent-door/types'
import { businessRole } from '../../modules/agent-door/people'
import { activityOutcome, className, decisionName, words } from '../../modules/agent-door/page-words'
import { authorize } from '../access'
import { CrankError, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { mayReadPayload, workflowScope } from '../team/policy'
import { readAgentOperationAudit, type NativeAgentAudit } from '../ops/audit'
import { peopleAdapter } from './people'
import { crankTools } from './tools'

interface Filters { agent: string; class: string; from: string; to: string; limit: number }
interface Cursor { v: number; after: number; through: number; filters: Filters }
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const day = 86400000

function selection(url: URL): { filters: Filters; cursor: Cursor | null } {
  const today = Math.floor(Date.now() / day), monday = today - (new Date(Date.now()).getUTCDay() + 6) % 7
  const filters: Filters = {
    agent: url.searchParams.get('agent') ?? '', class: url.searchParams.get('class') ?? '',
    from: url.searchParams.get('from') ?? new Date(monday * day).toISOString().slice(0, 10),
    to: url.searchParams.get('to') ?? new Date((today + 1) * day).toISOString().slice(0, 10),
    limit: Number(url.searchParams.get('limit') ?? 50),
  }
  requireValue(filters.agent.length <= 200 && !/[\u0000-\u001f]/.test(filters.agent), 'Invalid agent filter')
  requireValue(!filters.class || isClass(filters.class), 'Invalid class filter')
  requireValue(validDate(filters.from) && validDate(filters.to) && filters.from < filters.to
    && Date.parse(filters.to) - Date.parse(filters.from) <= 366 * day, 'Choose an ordered period of at most 366 days')
  requireValue(Number.isSafeInteger(filters.limit) && filters.limit >= 1 && filters.limit <= 100, 'Page size must be between 1 and 100')
  let cursor: Cursor | null = null
  const encoded = url.searchParams.get('cursor')
  if (encoded !== null) {
    requireValue(encoded.length <= 2000, 'Invalid activity cursor')
    try { cursor = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))) } catch { throw new CrankError(400, 'Invalid activity cursor') }
    requireValue(cursor && cursor.v === 1 && Number.isSafeInteger(cursor.after) && cursor.after >= 0
      && Number.isSafeInteger(cursor.through) && cursor.through >= cursor.after
      && JSON.stringify(cursor.filters) === JSON.stringify(filters), 'Activity cursor does not match these filters')
  }
  return { filters, cursor }
}

async function reader(env: CrankEnv, request: Request): Promise<Actor> {
  requireValue(!request.headers.has('authorization'), 'A person session is required', 403)
  const people = peopleAdapter(env), person = await people.session(request)
  requireValue(person?.active, 'Sign in to read agent activity', 401)
  requireValue(businessRole(people, person), 'Agent activity is restricted to the owner and Business editors', 403)
  return authorize(request, env)
}

function visible(actor: Actor, target: NativeAgentAudit): boolean {
  if (target.subject_kind !== 'workflow') return false
  try { workflowScope(actor, target.subject_id); return mayReadPayload(actor, target.subject_id) } catch { return false }
}

/** Filter before paging; the native timeline enriches a call, never adds a call. */
export async function activityPage(env: CrankEnv, request: Request, actor: Actor) {
  const { filters, cursor } = selection(new URL(request.url))
  const through = cursor?.through ?? (await stmt(env, 'SELECT coalesce(max(sequence),0) AS last FROM agent_door_audit').first<{ last: number }>())!.last
  const where = "sequence<=? AND at>=? AND at<? AND (?='' OR agent=?) AND (?='' OR EXISTS(SELECT 1 FROM json_each(classes) WHERE value=?))"
  const values = [through, filters.from + 'T00:00:00.000Z', filters.to + 'T00:00:00.000Z', filters.agent, filters.agent, filters.class, filters.class]
  const [records, counts, total] = await Promise.all([
    stmt(env, `SELECT sequence,row FROM agent_door_audit WHERE ${where} AND sequence>? ORDER BY sequence LIMIT ?`, ...values, cursor?.after ?? 0, filters.limit + 1).all<{ sequence: number; row: string }>(),
    stmt(env, `SELECT c.value AS class,json_extract(a.row,'$.decision') AS decision,count(*) AS count FROM
      (SELECT * FROM agent_door_audit WHERE ${where}) a,json_each(a.classes) c GROUP BY c.value,json_extract(a.row,'$.decision') ORDER BY c.value,decision`, ...values).all<{ class: string; decision: string; count: number }>(),
    stmt(env, `SELECT count(*) AS count FROM agent_door_audit WHERE ${where}`, ...values).first<{ count: number }>(),
  ])
  const page = records.results.slice(0, filters.limit)
  const native = await readAgentOperationAudit(env, page.map(record => (JSON.parse(record.row) as AuditRow).operation_id))
  const rows = await Promise.all(page.map(async record => {
    const row = { ...JSON.parse(record.row), sequence: record.sequence } as AuditRow
    // Keep the original classification and policy facts; enrich current human marks.
    if (row.approval) {
      const item = await stmt(env, 'SELECT approvals FROM agent_door_approvals WHERE id=?', row.approval.id).first<{ approvals: string }>()
      if (item) row.approval.by = [...new Set((JSON.parse(item.approvals) as Array<{ person: string }>).map(mark => mark.person))]
    }
    if (row.review) {
      const item = await stmt(env, 'SELECT marked_by FROM agent_door_reviews WHERE id=?', row.review.id).first<{ marked_by: string | null }>()
      if (item) row.review.by = item.marked_by
    }
    const effects = native.filter(effect => !['refused', 'pending'].includes(row.outcome) && effect.operation_id === row.operation_id).map(effect => ({
      ...effect, href: visible(actor, effect) ? '/agents/api/activity/targets/' + encodeURIComponent(effect.id) : null,
    }))
    return { ...row, native: effects }
  }))
  const next = records.results.length > filters.limit ? btoa(JSON.stringify({ v: 1, after: page.at(-1)!.sequence, through, filters })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') : null
  return { rows, cursor: next, through, total: total!.count, counts: counts.results, filters }
}

function query(filters: Filters, cursor?: string | null) {
  return new URLSearchParams({ agent: filters.agent, class: filters.class, from: filters.from, to: filters.to, limit: String(filters.limit), ...(cursor ? { cursor } : {}) }).toString()
}

/** Native extensions retain person authority even when an MCP token is present. */
export async function activityResponse(env: CrankEnv, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!['/agents/api/activity', '/agents/api/activity/export'].includes(path) && !path.startsWith('/agents/api/activity/targets/')) return null
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
  try {
    const actor = await reader(env, request)
    requireValue(request.method === 'GET', 'Method not allowed', 405)
    if (path.startsWith('/agents/api/activity/targets/')) {
      const id = path.slice('/agents/api/activity/targets/'.length)
      const effect = await stmt(env, `SELECT id,subject_kind,subject_id FROM crank_audit WHERE id=? AND json_extract(detail_json,'$.agent_door.operation_id') IS NOT NULL`, id).first<NativeAgentAudit>()
      requireValue(effect && visible(actor, effect), 'Target is not available', 404)
      requireValue(await stmt(env, 'SELECT 1 FROM crank_workflows WHERE id=?', effect.subject_id).first(), 'Target is not available', 404)
      return new Response(null, { status: 303, headers: { ...headers, location: '/app/workflows/' + encodeURIComponent(effect.subject_id) } })
    }
    const page = await activityPage(env, request, actor)
    if (path.endsWith('/export')) {
      if (new URL(request.url).searchParams.get('download') === 'all') {
        requireValue(!new URL(request.url).searchParams.has('cursor'), 'Period downloads start at the first page')
        const encoder = new TextEncoder()
        const encode = (rows: typeof page.rows) => encoder.encode(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''))
        let cursor = page.cursor
        // Stream bounded pages from one snapshot into the person's complete file.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode(page.rows))
            if (!cursor) controller.close()
          },
          async pull(controller) {
            const next = new URL(request.url)
            next.search = query(page.filters, cursor)
            const nextRequest = new Request(next, { headers: request.headers })
            const batch = await activityPage(env, nextRequest, await reader(env, nextRequest))
            controller.enqueue(encode(batch.rows))
            cursor = batch.cursor
            if (!cursor) controller.close()
          },
        })
        return new Response(body, { headers: { ...headers, 'content-type': 'application'+'/'+'x-ndjson',
          'content-disposition': 'attachment; filename="agent-activity.ndjson"',
          'x-activity-total': String(page.total), 'x-activity-through': String(page.through) } })
      }
      const next = page.cursor ? '/agents/api/activity/export?' + query(page.filters, page.cursor) : null
      return new Response(page.rows.map(row => JSON.stringify(row)).join('\n') + (page.rows.length ? '\n' : ''), {
        headers: { ...headers, 'content-type': 'application'+'/'+'x-ndjson', 'content-disposition': 'attachment; filename="agent-activity.ndjson"',
          'x-activity-total': String(page.total), 'x-activity-through': String(page.through), ...(page.cursor ? { 'x-activity-next-cursor': page.cursor, link: `<${next}>; rel="next"` } : {}) },
      })
    }
    return Response.json(page, { headers })
  } catch (error) {
    if (!(error instanceof CrankError)) throw error
    return Response.json({ error: error.message }, { status: error.status, headers })
  }
}

/** Server-rendered extension of the existing Agents page and its components. */
export async function activityHtml(env: CrankEnv, request: Request, _person: Person): Promise<string> {
  let page: Awaited<ReturnType<typeof activityPage>>
  try { page = await activityPage(env, request, await reader(env, request)) }
  catch (error) {
    if (!(error instanceof CrankError)) throw error
    return `<section aria-label="Agent activity"><h2>Activity</h2><p role="alert">${escape(error.message)}</p><a href="/agents">Reset activity filters</a></section>`
  }
  const { filters } = page
  const titles = new Map(crankTools(env).map(tool => [tool.name, tool.title]))
  const field = (name: string, label: string, type = 'text') => `<div class="field"><label for="activity-${name}">${label}</label><input id="activity-${name}" name="${name}" type="${type}" value="${escape(filters[name as keyof Filters])}"${type === 'text' ? ' maxlength="200"' : ''}></div>`
  const counts = page.counts.map(row => `<tr><th scope="row">${escape(className(row.class))}</th><td>${escape(decisionName(row.decision))}</td><td data-agents-count data-class="${escape(row.class)}" data-decision="${escape(row.decision)}">${row.count}</td></tr>`).join('')
  const rows = page.rows.map(row => `<li data-activity-id="${escape(row.id)}"><p class="row-title">${escape(titles.get(row.tool) ?? words(row.tool))}</p><p>${escape(row.label)}</p><p class="meta">${escape(activityOutcome(row.decision, row.outcome, row.code))} · <time datetime="${escape(row.at)}">${escape(row.at)}</time></p><p class="meta">${escape(row.classes.map(item => className(item.class)).join(', ') || 'No class recorded')}</p>${row.native.map(effect => `<p>${escape(words(effect.action))}${effect.href ? ` · <a href="${escape(effect.href)}">Open workflow</a>` : ''}</p>`).join('')}${row.approval ? `<a href="/agents/approvals/${encodeURIComponent(row.approval.id)}">View approval</a>` : ''}</li>`).join('')
  return `<section aria-labelledby="activity-title"><h2 id="activity-title">Activity</h2><form action="/agents" method="get" aria-label="Filter activity">${field('agent', 'Agent ID')}<div class="field"><label for="activity-class">Class</label><select id="activity-class" name="class"><option value="">All classes</option>${classes.map(item => `<option value="${escape(item.id)}"${filters.class === item.id ? ' selected' : ''}>${escape(className(item.id))}</option>`).join('')}</select></div>${field('from', 'From date', 'date')}${field('to', 'Before date', 'date')}<p><button type="submit">Apply filters</button></p></form><p data-activity-total>${page.total} calls in this period</p>${counts ? `<table aria-label="Calls by class and decision"><thead><tr><th scope="col">Class</th><th scope="col">Decision</th><th scope="col">Calls</th></tr></thead><tbody>${counts}</tbody></table>` : ''}<p><a href="/agents/api/activity/export?${escape(query(filters))}&amp;download=all">Export this period</a></p>${rows ? `<ul class="stack">${rows}</ul>` : '<p>No activity matches these filters.</p>'}${page.cursor ? `<a href="/agents?${escape(query(filters, page.cursor))}">Next activity page</a>` : ''}</section>`
}
