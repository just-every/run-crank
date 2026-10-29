import type { AuditRow } from './audit.ts'
import { approvalDoor, type approvalView } from './approvals.ts'
import { businessRole, matchingRefs } from './people.ts'
import { policyState, publicState, unanswered, declaredClasses, setupUrl } from './policy-store.ts'
import { CATALOGUE, classDefinition, type ClassId } from './policy/catalogue.ts'
import { SCHEMA } from './policy/document.ts'
import { reviewDoor, type reviewView } from './reviews.ts'
import type { ApprovalDisplaySummary, Person, PolicyState, Runtime } from './types.ts'
import { pageScript, pageStyle } from './page-style.ts'
import { actionName, activityOutcome, answers, approvalStatus, approverNames, className, decisionName, factsSentence, isIdentifier, measureText, policyAnswer, words } from './page-words.ts'

type Approval = ReturnType<typeof approvalView>
type Review = ReturnType<typeof reviewView>
interface Count { class: string; decision: string; count: number }
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const pretty = (value: unknown) => escape(JSON.stringify(value, null, 2))
const segment = (value: string) => escape(encodeURIComponent(value))
const attribution = (item: Approval | Review) => {
  const by = item.prepared_by
  return typeof by.agent === 'string' ? `${by.agent} for ${by.for}` : `${by.agent.name} for ${typeof by.for === 'string' ? by.for : by.for.name}`
}
// The server writes UTC; the page script rewrites every <time> and the zone line in the viewer's own zone.
const utc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const time = (value: string | number) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `<time datetime="${date.toISOString()}">${escape(utc.format(date))}</time>`
}
const zone = '<p class="meta" data-time-zone>Times are UTC.</p>'
const action = (url: string, label: string, attributes = '', fields = '') => `<form action="${escape(url)}" method="post" data-json-action>${fields}<button type="submit" ${attributes}>${escape(label)}</button></form>`
const empty = (text: string) => `<p class="muted">${escape(text)}</p>`
const uriOf = (summary: ApprovalDisplaySummary | undefined) => summary && 'uri' in summary ? summary.uri : undefined
const list = (items: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(items)
const money = ({ value, currency }: { value: number; currency: string }) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value) } catch { return `${value} ${currency}` }
}

/** Arguments as a field table: words for keys, ids small, never JSON. */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'None'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.some(item => item !== null && typeof item === 'object') ? `<ul>${value.map(item => `<li>${fieldValue(item)}</li>`).join('')}</ul>` : escape(value.map(item => typeof item === 'boolean' ? item ? 'Yes' : 'No' : String(item)).join(', ')) || 'None'
  if (typeof value === 'object') return fields(value as Record<string, unknown>)
  return escape(value)
}
function fields(record: Record<string, unknown>): string {
  const entries = Object.entries(record)
  return entries.length ? `<dl class="fields">${entries.map(([key, value]) => `<div${isIdentifier(key) ? ' class="id"' : ''}><dt>${escape(words(key))}</dt><dd>${fieldValue(value)}</dd></div>`).join('')}</dl>` : '<p>None</p>'
}

function actionSummary(summary: ApprovalDisplaySummary | undefined): string {
  if (!summary) return '<p data-approval-summary class="muted">No details were recorded.</p>'
  const native = summary.nativeTarget
  const record = (id?: string) => native && native.id !== id ? `<p class="id">${escape(words(native.kind))} ${escape(native.id)}</p>` : ''
  if ('arguments' in summary) return `<div data-approval-summary>${fields(summary.arguments)}${record()}</div>`
  if ('uri' in summary) return `<div data-approval-summary><p class="id">${escape(summary.uri)}</p>${record()}</div>`
  const { target } = summary, lines: string[] = []
  if (target?.name || target?.email) lines.push(`<p class="target">${escape(target.name ?? target.email)}${target.name && target.email ? ` <span class="meta">${escape(target.email)}</span>` : ''}</p>`)
  const recipients = summary.recipients?.filter(recipient => recipient !== target?.email) ?? []
  if (recipients.length) lines.push(`<p>To ${escape(list(recipients))}</p>`)
  if (summary.amount) lines.push(`<p>Amount ${escape(money(summary.amount))}</p>`)
  if (summary.payee) lines.push(`<p>Pays ${escape(summary.payee)}</p>`)
  if (summary.role) lines.push(`<p>Role: ${escape(summary.role)}</p>`)
  if (summary.items?.length) lines.push(`<ul class="items">${summary.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`)
  if (target?.id) lines.push(`<p class="id">ID ${escape(target.id)}</p>`)
  return `<div data-approval-summary>${lines.join('')}${record(target?.id)}</div>`
}

function shell(rt: Runtime, title: string, content: string, status = 200, current = false): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(rt.options.name)}</title><style nonce="${nonce}">${pageStyle}</style><link rel="stylesheet" href="/rer-theme.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a href="/app">${escape(rt.options.name)}</a><nav aria-label="Main"><a href="/agents"${current ? ' aria-current="page"' : ''}>Agents</a></nav></header><main id="main"><div id="action-status" class="status" role="status" aria-live="polite" tabindex="-1"></div>${content}<noscript>Turn on JavaScript to approve, decline or save.</noscript></main><script nonce="${nonce}">${pageScript}</script></body></html>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` },
  })
}

const choice = (cls: ClassId) => `<div class="field" data-policy-question="${cls}"><label for="choice-${cls}">${escape(className(cls))}</label><p id="help-${cls}" class="meta">${escape(classDefinition(cls).when)}</p><select id="choice-${cls}" data-policy-class="${cls}" aria-describedby="help-${cls}" aria-errormessage="error-${cls}"><option value="">Choose…</option>${(['autonomous', 'review', 'approval', 'blocked'] as const).map(value => `<option value="${value}">${answers[value]}</option>`).join('')}</select><p id="error-${cls}" class="field-error" hidden>Choose an answer.</p></div>`
const paidAI = '<fieldset class="field" data-paid-ai aria-describedby="error-paid-ai"><legend>Can agents use paid AI?</legend><label class="choice"><input type="radio" name="paidAI" value="no"> No</label><label class="choice"><input type="radio" name="paidAI" value="yes"> Yes</label><p id="error-paid-ai" class="field-error" hidden></p></fieldset>'

function setup(rt: Runtime, state: PolicyState, owner: boolean): string {
  const missing = unanswered(rt, state), current = publicState(rt, state), classes = declaredClasses(rt)
  const quick = owner && !rt.options.trust && !state.document
  let content = '<h2 id="policy-title">Agent policy</h2>'
  if (quick) content += '<p>Choose what agents may do. They wait until every answer is set.</p>'
  else {
    content += `<dl class="fields">${classes.map(cls => `<div${missing.includes(cls) ? ` data-policy-question="${cls}"` : ''}><dt>${escape(className(cls))}</dt><dd>${escape(missing.includes(cls) || !state.document ? 'Not answered' : policyAnswer(state.document, cls))}</dd></div>`).join('')}</dl>`
    if (missing.length) content += '<p>Agents wait on anything not answered.</p>'
  }
  if (current.policy.spend_caps === 'not_enforced') content += '<p class="notice" data-spend-caps="not-enforced">Paid AI spend caps are not enforced by this app. A saved cap does not limit provider charges.</p>'
  if (rt.options.trust) content += `<p>Managed in Business.${state.expires !== null ? ` Valid until ${time(state.expires)}.` : ''}</p><a href="${escape(setupUrl(rt, state))}">Manage policy in Business</a>`
  else if (owner) {
    const draft = state.document ?? { schema: SCHEMA, catalogue: CATALOGUE, rules: [], reviewers: ['role:owner'], spend: { none: true } }
    if (quick) content += `<form action="/agents/api/policy" method="post" data-json-action data-create-policy data-method="PUT" novalidate>${classes.map(choice).join('')}${paidAI}<p><button type="submit">Save policy</button></p></form>`
    content += `<details data-policy-editor><summary>Edit policy document</summary><form action="/agents/api/policy" method="post" data-json-action data-method="PUT"><label for="policy-document">Policy document</label><p id="policy-help" class="meta">Each declared class needs an unscoped rule: autonomous, review, approval or blocked. Review rules need reviewers; approval rules need approvers and a wait such as P1D. For paid AI, set spend caps; they are not enforced here. Saving applies the policy at once.</p><textarea id="policy-document" name="document" rows="16" spellcheck="false" aria-describedby="policy-help" required>${pretty(draft)}</textarea><p class="meta">Example rules</p><pre>${pretty([
      { id: 'internal-work', class: 'standard', do: 'review' },
      { id: 'external-approval', class: 'external', do: 'approval', approver: ['role:owner'], wait: 'P1D' },
      { id: 'no-deletion', class: 'destructive', do: 'blocked' },
    ])}</pre><p><button type="submit">Save policy document</button></p></form></details>`
  }
  return `<section aria-labelledby="policy-title">${content}</section>`
}

function reviewFeed(rt: Runtime, items: Review[]): string {
  const visible = items.filter(item => item.state === 'open' || item.state === 'flagged')
  if (!visible.length) return ''
  return `<section aria-labelledby="reviews-title"><h2 id="reviews-title">To review</h2><ul class="stack">${visible.map(item => `<li data-review-id="${escape(item.id)}" data-review-state="${escape(item.state)}"><p class="row-title">${escape(actionName(rt, item.tool, uriOf(item.summary)))}${item.state === 'flagged' ? ' <span class="tag">Flagged</span>' : ''}</p><p class="meta">${escape(attribution(item))} · ${escape(item.classes.map(factsSentence).join('; '))}</p>${actionSummary(item.summary)}<div class="actions">${action(`/agents/api/reviews/${encodeURIComponent(item.id)}/reviewed`, 'Mark reviewed', 'data-review-action="reviewed"')}${action(`/agents/api/reviews/${encodeURIComponent(item.id)}/flag`, 'Flag', 'class="secondary" data-review-action="flag"')}${item.undo.available ? action(`/agents/api/reviews/${encodeURIComponent(item.id)}/undo`, 'Undo', 'class="secondary" data-review-action="undo"') : ''}</div></li>`).join('')}</ul></section>`
}

function approvalFeed(rt: Runtime, items: Approval[]): string {
  const pending = items.filter(item => item.state === 'pending')
  if (!pending.length) return ''
  return `<section aria-labelledby="approvals-title"><h2 id="approvals-title">Waiting for approval</h2><ul class="stack">${pending.map(item => `<li><a class="row-title" href="/agents/approvals/${segment(item.id)}" data-approval-id="${escape(item.id)}">${escape(actionName(rt, item.tool, uriOf(item.summary)))}</a><p class="meta">${escape(attribution(item))} · expires ${time(item.expires_at)}</p>${actionSummary(item.summary)}</li>`).join('')}</ul></section>`
}

function activity(rt: Runtime, rows: AuditRow[]): string {
  return `<section aria-labelledby="activity-title"><h2 id="activity-title">Recent activity</h2>${rows.length ? `<ul class="stack">${rows.map(row => {
    const name = escape(actionName(rt, row.tool, row.resource))
    return `<li><p class="row-title">${row.approval ? `<a href="/agents/approvals/${segment(row.approval.id)}">${name}</a>` : name}</p><p class="meta">${escape(row.agent.name)} for ${escape(row.sponsor.name)} · ${escape(activityOutcome(row.decision, row.outcome, row.code))} · ${time(row.at)}</p></li>`
  }).join('')}</ul>` : empty('No agent activity yet.')}</section>`
}

function countTable(counts: Count[], since: number): string {
  const rows = counts.filter(row => row.count > 0)
  if (!rows.length) return ''
  return `<section aria-labelledby="week-title"><h2 id="week-title">This week</h2><p class="meta">Since ${time(since)}</p><table aria-labelledby="week-title"><thead><tr><th scope="col">Kind of action</th><th scope="col">Handled</th><th scope="col">Calls</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escape(className(row.class))}</th><td>${escape(decisionName(row.decision))}</td><td data-agents-count data-class="${escape(row.class)}" data-decision="${escape(row.decision)}">${row.count}</td></tr>`).join('')}</tbody></table></section>`
}

async function dashboard(rt: Runtime, request: Request, person: Person): Promise<Response> {
  const role = businessRole(rt.options.people, person), canAudit = role === 'owner' || role === 'editor'
  const today = Math.floor(rt.now() / 86400000), weekStart = (today - (new Date(rt.now()).getUTCDay() + 6) % 7) * 86400000
  const [state, approvalResponse, reviewResponse, counts, recent] = await Promise.all([
    policyState(rt), approvalDoor(rt, request, person), reviewDoor(rt, request, person),
    canAudit ? rt.options.db.prepare("SELECT c.value AS class,json_extract(a.row,'$.decision') AS decision,count(*) AS count FROM agent_door_audit a,json_each(a.classes) c WHERE a.at>=? AND a.at<=? GROUP BY c.value,json_extract(a.row,'$.decision') ORDER BY c.value,decision")
      .bind(new Date(weekStart).toISOString(), new Date(rt.now()).toISOString()).all<Count>() : null,
    canAudit ? rt.options.db.prepare('SELECT row FROM agent_door_audit ORDER BY sequence DESC LIMIT 20').all<{ row: string }>() : null,
  ])
  if (!approvalResponse.ok || !reviewResponse.ok) return shell(rt, 'Agents', '<h1>Agents</h1><p>Agent work could not load. Reload to try again.</p>', 503, true)
  const approvals = await approvalResponse.json() as { approvals: Approval[] }
  const reviews = await reviewResponse.json() as { reviews: Review[] }
  const paused = state.paused || state.localPaused, complete = publicState(rt, state).policy.complete
  const policy = canAudit ? setup(rt, state, role === 'owner') : ''
  let content = `<div class="heading"><div><h1>Agents</h1><p data-agents-state>${paused ? 'Agents are paused.' : 'Agents are on.'}</p>${state.paused ? '<p>Paused in Business.</p>' : ''}</div>${role === 'owner' ? `<div class="actions">${action('/agents/api/pause', state.localPaused ? 'Resume agents' : 'Pause agents', 'data-agents-pause', `<input type="hidden" name="paused" value="${!state.localPaused}">`)}</div>` : ''}</div>`
  if (!complete) content += policy
  content += approvalFeed(rt, approvals.approvals) + reviewFeed(rt, reviews.reviews) || '<section aria-label="Waiting for you"><p>Nothing is waiting for you.</p></section>'
  if (recent) content += activity(rt, recent.results.map(record => JSON.parse(record.row) as AuditRow))
  if (counts) content += countTable(counts.results, weekStart)
  if (complete) content += policy
  return shell(rt, 'Agents', content + zone, 200, true)
}

async function approvalPage(rt: Runtime, request: Request, person: Person, id: string): Promise<Response> {
  const response = await approvalDoor(rt, request, person, id)
  if (!response.ok) return shell(rt, 'Approval', '<h1>Request not found</h1><p>It does not exist, or it is not yours to see.</p><a href="/agents">Open Agents</a>', response.status)
  const { approval } = await response.json() as { approval: Approval }
  const by = approval.prepared_by
  const sponsor = typeof by.for === 'string' ? '' : by.for.id
  const eligible = await matchingRefs(rt, person, sponsor, approval.approvers)
  const marks = approval.approvals as Array<{ ref: string; name?: string; person: string; at: string }>
  const waiting = eligible.some(ref => !marks.some(mark => mark.ref === ref))
  const evidence = `<input type="hidden" name="revision" value="${pretty(approval.revision)}"><input type="hidden" name="summary_sha256" value="${escape(approval.summary_sha256)}">`
  const name = actionName(rt, approval.tool, uriOf(approval.summary))
  const rules = (approval.rules ?? []).map(rule => {
    const facts = approval.classes.find(entry => entry.class === rule.class)
    const answer = rule.do in answers ? answers[rule.do as keyof typeof answers] : words(rule.do)
    const measure = facts ? measureText(facts) : ''
    return `${answer} for ${className(rule.class).toLowerCase()}${measure ? ` (${measure})` : ''}${rule.rule && rule.rule !== rule.class ? `, rule ${rule.rule}` : ''}`
  })
  let content = `<h1>${escape(name)}</h1><p class="lead">${escape(attribution(approval))}</p><section aria-label="Request"><p class="state" data-approval-state="${escape(approval.state)}"${approval.code ? ` data-approval-code="${escape(approval.code)}"` : ''}><strong>${escape(approvalStatus(approval.state, approval.code, waiting, eligible.length > 0))}</strong>${approval.state === 'pending' ? ` · expires ${time(approval.expires_at)}` : ''}</p>`
  if (marks.length) content += `<p class="meta">Approved by ${marks.map(mark => `${escape(mark.name ?? 'a person')}, ${time(mark.at)}`).join('; ')}</p>`
  content += actionSummary(approval.summary)
  if (approval.state === 'pending' && waiting) content += `<div class="actions">${action(`/agents/api/approvals/${encodeURIComponent(id)}/approve`, 'Approve', 'data-approval-action="approve"', evidence)}${action(`/agents/api/approvals/${encodeURIComponent(id)}/reject`, 'Decline', 'class="secondary" data-approval-action="reject"', evidence)}</div>`
  content += `<details><summary>Details</summary><dl class="fields"><div><dt>Policy</dt><dd>${rules.length ? escape(rules.join('; ')) : 'No rule was recorded.'}</dd></div><div><dt>Who decides</dt><dd>${escape(await approverNames(rt, approval.approvers))}</dd></div><div><dt>Policy version</dt><dd>${escape(approval.revision ?? 'Not set')}</dd></div><div class="id"><dt>Action</dt><dd>${escape(approval.tool)}</dd></div></dl></details></section>`
  return shell(rt, name, content + zone)
}

/** Server-rendered person door. Visibility is delegated to the same JSON APIs. */
export async function agentPage(rt: Runtime, request: Request, person: Person | null): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return shell(rt, 'Agents', '<h1>Method not allowed</h1>', 405)
  const path = new URL(request.url).pathname
  if (!person || !person.active) return shell(rt, 'Agents', `<h1>Agents</h1><p>Sign in to see agent work.</p><a class="button" href="/signin?returnTo=${segment(path)}">Sign in</a>`)
  const read = request.method === 'HEAD' ? new Request(request.url, { method: 'GET', headers: request.headers }) : request
  let response: Response
  if (path === '/agents' || path === '/agents/') response = await dashboard(rt, read, person)
  else {
    const match = /^\/agents\/approvals\/([^/]+)\/?$/.exec(path)
    if (!match) return shell(rt, 'Agents', '<h1>Not found</h1><a href="/agents">Open Agents</a>', 404)
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { return shell(rt, 'Approval', '<h1>Not found</h1><p>This approval link is broken.</p><a href="/agents">Open Agents</a>', 400) }
    response = await approvalPage(rt, read, person, id)
  }
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
}
