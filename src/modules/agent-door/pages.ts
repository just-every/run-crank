import type { AuditRow } from './audit.ts'
import { approvalDoor, type approvalView } from './approvals.ts'
import { businessRole, matchingRefs } from './people.ts'
import { policyState, publicState, unanswered, declaredClasses, setupUrl } from './policy-store.ts'
import { CATALOGUE, classDefinition, type ClassId } from './policy/catalogue.ts'
import { SCHEMA } from './policy/document.ts'
import { reviewDoor, type reviewView } from './reviews.ts'
import type { ApprovalDisplaySummary, Person, PolicyState, Runtime } from './types.ts'
import { pageScript, pageStyle } from './page-style.ts'

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
const time = (value: string) => `<time datetime="${escape(value)}">${escape(value)}</time>`
const action = (url: string, label: string, attributes = '', fields = '') => `<form action="${escape(url)}" method="post" data-json-action>${fields}<button type="submit" ${attributes}>${escape(label)}</button></form>`
const empty = (text: string) => `<p class="muted">${escape(text)}</p>`

function actionSummary(summary: ApprovalDisplaySummary | undefined): string {
  if (!summary) return '<p data-approval-summary>No action summary was recorded.</p>'
  if ('arguments' in summary) return `<div data-approval-summary><pre>${pretty(summary.arguments)}</pre></div>`
  if ('uri' in summary) return `<div data-approval-summary><dl><dt>Resource</dt><dd>${escape(summary.uri)}</dd></dl></div>`
  const fields: Array<[string, unknown]> = []
  if (summary.target) {
    for (const [key, label] of [['name', 'Target name'], ['id', 'Target ID'], ['email', 'Target email']] as const) {
      if (summary.target[key]) fields.push([label, summary.target[key]])
    }
  }
  if (summary.recipients?.length) fields.push(['Recipients', summary.recipients.join(', ')])
  if (summary.amount) fields.push(['Amount', `${summary.amount.value} ${summary.amount.currency}`])
  if (summary.payee) fields.push(['Payee', summary.payee])
  if (summary.role) fields.push(['Role', summary.role])
  return `<div data-approval-summary><dl>${fields.map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>${summary.items?.length ? `<p>Items</p><ul>${summary.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}</div>`
}

function shell(rt: Runtime, title: string, content: string, status = 200): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(rt.options.name)}</title><style nonce="${nonce}">${pageStyle}</style><link rel="stylesheet" href="/rer-theme.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a href="/app">${escape(rt.options.name)}</a><nav aria-label="Main"><a href="/app">App</a><a href="/agents" aria-current="${title === 'Agents' ? 'page' : 'false'}">Agents</a></nav></header><main id="main"><div id="action-status" class="status" role="status" aria-live="polite" tabindex="-1"></div>${content}<noscript>JavaScript is required to save changes on this page.</noscript></main><script nonce="${nonce}">${pageScript}</script></body></html>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` },
  })
}

function setup(rt: Runtime, state: PolicyState, owner: boolean): string {
  const missing = unanswered(rt, state), current = publicState(rt, state)
  let content = `<h2>Agent policy</h2><p>${current.policy.complete ? 'All declared action classes have an answer.' : 'Setup is incomplete. Agents cannot perform unanswered actions.'} Policy source: ${escape(current.policy.source)}. Revision: ${escape(state.revision ?? 'not set')}.</p>`
  if (current.policy.spend_caps === 'not_enforced') content += '<p class="notice" data-spend-caps="not-enforced">Paid AI spend caps are not enforced by this app. A saved cap does not limit provider charges.</p>'
  if (missing.length) content += `<ul>${missing.map(cls => `<li data-policy-question="${escape(cls)}"><strong>${escape(cls)}</strong>: ${escape(classDefinition(cls).when)} How should agents handle this?</li>`).join('')}</ul>`
  if (state.expires !== null) content += `<p>Business policy expires ${time(new Date(state.expires).toISOString())}.</p>`
  if (rt.options.trust) content += `<a href="${escape(setupUrl(rt, state))}">Manage policy in Business</a>`
  else if (owner) {
    const draft = state.document ?? { schema: SCHEMA, catalogue: CATALOGUE, rules: [], reviewers: ['role:owner'], spend: { none: true } }
    if (!state.document) content += `<form action="/agents/api/policy" method="post" data-json-action data-create-policy data-method="PUT"><h3>Set up local policy</h3><p>Choose how agents handle each class. Reviews and approvals go to the owner. Approval requests expire after 24 hours. Use the advanced document below for other reviewers or thresholds.</p>${declaredClasses(rt).map(cls => `<label for="choice-${cls}">${escape(cls)}</label><p id="help-${cls}" class="muted">${escape(classDefinition(cls).when)}</p><select id="choice-${cls}" data-policy-class="${cls}" aria-describedby="help-${cls}" required><option value="">Choose a decision</option><option value="autonomous">Act autonomously</option><option value="review">Act, then ask the owner to review</option><option value="approval">Ask the owner before acting</option><option value="blocked">Block this action</option></select>`).join('')}<label class="check"><input type="checkbox" name="noPaidAI" required> Agents will not use paid AI</label><p><button type="submit">Apply these choices</button></p></form>`
    content += `<details${state.document ? ' open' : ''}><summary>Advanced policy document</summary><form action="/agents/api/policy" method="post" data-json-action data-method="PUT"><label for="policy-document">Local policy document (JSON)</label><p id="policy-help">Give every declared class an unscoped rule. Choose autonomous, review, approval or blocked. Review rules need reviewers. Approval rules need approver references and a wait duration, such as P1D. Set spend to {"none":true} only if agents will not use paid AI. Paid AI spend caps are not enforced here. Saving applies this policy immediately.</p><textarea id="policy-document" name="document" rows="16" spellcheck="false" aria-describedby="policy-help" required>${pretty(draft)}</textarea><p><button type="submit">Save local policy</button></p></form></details><details><summary>Policy rule examples</summary><p>Each class needs its own rule, or use a class of * to answer all classes. Use unique rule IDs. These examples show the JSON shape; choose the rules for your installation.</p><pre>${pretty([
      { id: 'internal-work', class: 'standard', do: 'review' },
      { id: 'external-approval', class: 'external', do: 'approval', approver: ['role:owner'], wait: 'P1D' },
      { id: 'no-deletion', class: 'destructive', do: 'blocked' },
    ])}</pre></details>`
  }
  return `<section aria-label="Agent policy">${content}</section>`
}

function reviewFeed(items: Review[]): string {
  const visible = items.filter(item => item.state === 'open' || item.state === 'flagged')
  return `<section><h2>Open reviews</h2>${visible.length ? `<ul class="stack">${visible.map(item => `<li data-review-id="${escape(item.id)}"><h3>${escape(item.tool)}</h3><p>${escape(attribution(item))}</p><p>${escape(item.classes.map(entry => entry.class).join(', '))} · ${escape(item.state)}</p>${actionSummary(item.summary)}<details><summary>Action facts</summary><pre>${pretty(item.classes)}</pre></details><div class="actions">${action(`/agents/api/reviews/${encodeURIComponent(item.id)}/reviewed`, 'Mark reviewed', 'data-review-action="reviewed"')}${action(`/agents/api/reviews/${encodeURIComponent(item.id)}/flag`, 'Flag', 'class="secondary" data-review-action="flag"')}${item.undo.available ? action(`/agents/api/reviews/${encodeURIComponent(item.id)}/undo`, 'Undo', 'class="secondary" data-review-action="undo"') : '<p class="muted">Undo unavailable</p>'}</div></li>`).join('')}</ul>` : empty('No open reviews are available to you.')}</section>`
}

function approvalFeed(items: Approval[]): string {
  const pending = items.filter(item => item.state === 'pending')
  return `<section><h2>Pending approvals</h2>${pending.length ? `<ul class="stack">${pending.map(item => `<li><h3><a href="/agents/approvals/${segment(item.id)}" data-approval-id="${escape(item.id)}">${escape(item.tool)}</a></h3><p>${escape(attribution(item))}</p>${actionSummary(item.summary)}<p>Expires ${time(item.expires_at)}</p></li>`).join('')}</ul>` : empty('No pending approvals are available to you.')}</section>`
}

function countTable(counts: Count[], classes: readonly ClassId[]): string {
  const allClasses = [...new Set([...classes, ...counts.map(item => item.class)])]
  return `<section><h2>This week</h2><p class="muted">Calls recorded during the current UTC week, grouped by action class and policy decision. A call can have more than one class.</p>${allClasses.length ? `<table><caption>Agent call counts</caption><thead><tr><th scope="col">Class</th><th scope="col">Decision</th><th scope="col">Count</th></tr></thead><tbody>${allClasses.map(cls => [...new Set(['autonomous', 'review', 'approval', 'blocked', 'unset', ...counts.filter(row => row.class === cls).map(row => row.decision)])].map(decision => `<tr><th scope="row">${escape(cls)}</th><td>${escape(decision)}</td><td data-agents-count data-class="${escape(cls)}" data-decision="${escape(decision)}">${counts.find(row => row.class === cls && row.decision === decision)?.count ?? 0}</td></tr>`).join('')).join('')}</tbody></table>` : empty('No agent action classes are declared.')}</section>`
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
  if (!approvalResponse.ok || !reviewResponse.ok) return shell(rt, 'Agents', '<h1>Agents</h1><p>Unable to load your review and approval access. Reload to try again.</p>', 503)
  const approvals = await approvalResponse.json() as { approvals: Approval[] }
  const reviews = await reviewResponse.json() as { reviews: Review[] }
  const paused = state.paused || state.localPaused
  let content = `<div class="heading"><div><h1>Agents</h1><p>Review agent work and decide what needs your approval.</p><p><strong>${paused ? 'Agents are paused.' : 'Agents are not paused.'}</strong>${state.paused ? ' The Business policy has paused agents.' : ''}</p></div>${role === 'owner' ? `<div class="actions">${action('/agents/api/pause', state.localPaused ? 'Resume local agents' : 'Pause agents', 'data-agents-pause', `<input type="hidden" name="paused" value="${!state.localPaused}">`)}</div>` : ''}</div>`
  if (counts) content += countTable(counts.results, declaredClasses(rt))
  content += reviewFeed(reviews.reviews) + approvalFeed(approvals.approvals)
  if (canAudit) content += setup(rt, state, role === 'owner')
  if (recent) content += `<section><h2>Recent activity</h2>${recent.results.length ? `<ul class="stack">${recent.results.map(record => {
    const row = JSON.parse(record.row) as AuditRow
    return `<li><h3>${escape(row.tool)}</h3><p>${escape(row.agent.name)} for ${escape(row.sponsor.name)}</p><p>${escape(row.decision)} · ${escape(row.outcome)}${row.code ? ` · ${escape(row.code)}` : ''}</p><p>${time(row.at)}</p></li>`
  }).join('')}</ul>` : empty('No agent activity has been recorded.')}</section>`
  return shell(rt, 'Agents', content)
}

async function approvalPage(rt: Runtime, request: Request, person: Person, id: string): Promise<Response> {
  const response = await approvalDoor(rt, request, person, id)
  if (!response.ok) return shell(rt, 'Approval', '<h1>Approval unavailable</h1><p>This request is unavailable or you do not have access to it.</p><a href="/agents">Back to Agents</a>', response.status)
  const { approval } = await response.json() as { approval: Approval }
  const by = approval.prepared_by
  const sponsor = typeof by.for === 'string' ? '' : by.for.id
  const eligible = await matchingRefs(rt, person, sponsor, approval.approvers)
  const waiting = eligible.some(ref => !(approval.approvals as Array<{ ref: string }>).some(mark => mark.ref === ref))
  const evidence = `<input type="hidden" name="revision" value="${pretty(approval.revision)}"><input type="hidden" name="summary_sha256" value="${escape(approval.summary_sha256)}">`
  let content = `<a href="/agents">Back to Agents</a><h1>Approval request</h1><section><h2>${escape(approval.tool)}</h2><p>${escape(attribution(approval))}</p><dl><dt>Status</dt><dd data-approval-state>${escape(approval.state)}</dd>${approval.code ? `<dt>Result code</dt><dd data-approval-code>${escape(approval.code)}</dd>` : ''}<dt>Policy revision</dt><dd>${escape(approval.revision ?? 'not set')}</dd><dt>Expires</dt><dd data-approval-expires>${time(approval.expires_at)}</dd><dt>Required approvers</dt><dd>${escape(approval.approvers.join(', '))}</dd></dl><h3>Action summary</h3>${actionSummary(approval.summary)}<h3>Action facts</h3><div class="facts">${approval.classes.map(entry => `<div data-approval-class="${escape(entry.class)}"><h3>${escape(entry.class)}</h3><pre>${pretty(entry.facts)}</pre></div>`).join('')}</div><h3>Rules behind this request</h3>${approval.rules?.length ? `<ul>${approval.rules.map(rule => `<li>${escape(rule.class)}: ${escape(rule.rule ?? 'No matching rule')} · ${escape(rule.do)}</li>`).join('')}</ul>` : empty('No rule details were recorded.')}`
  if (approval.approvals.length) content += `<h3>Approvals recorded</h3><ul>${(approval.approvals as Array<{ ref: string; name?: string; person: string; at: string }>).map(mark => `<li>${escape(mark.name ?? mark.person)} · ${escape(mark.ref)} · ${time(mark.at)}</li>`).join('')}</ul>`
  if (approval.state === 'pending' && waiting) content += `<p>Approve to allow the exact action above under the recorded policy revision. Reject to stop this request.</p><div class="actions">${action(`/agents/api/approvals/${encodeURIComponent(id)}/approve`, 'Approve', 'data-approval-action="approve"', evidence)}${action(`/agents/api/approvals/${encodeURIComponent(id)}/reject`, 'Reject', 'class="secondary" data-approval-action="reject"', evidence)}</div>`
  else if (approval.state === 'pending') content += empty(eligible.length ? 'Your approval is recorded. Waiting for other required approvers.' : 'You can view this request. A required approver must decide it.')
  return shell(rt, 'Approval', content + '</section>')
}

/** Server-rendered person door. Visibility is delegated to the same JSON APIs. */
export async function agentPage(rt: Runtime, request: Request, person: Person | null): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return shell(rt, 'Agents', '<h1>Method not allowed</h1>', 405)
  if (!person || !person.active) return shell(rt, 'Agents', '<h1>Agents</h1><p>Sign in to review agent work and approvals.</p><a class="button" href="/signin">Sign in</a>')
  const path = new URL(request.url).pathname
  const read = request.method === 'HEAD' ? new Request(request.url, { method: 'GET', headers: request.headers }) : request
  let response: Response
  if (path === '/agents' || path === '/agents/') response = await dashboard(rt, read, person)
  else {
    const match = /^\/agents\/approvals\/([^/]+)\/?$/.exec(path)
    if (!match) return shell(rt, 'Agents', '<h1>Not found</h1><a href="/agents">Back to Agents</a>', 404)
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { return shell(rt, 'Approval', '<h1>Invalid approval link</h1>', 400) }
    response = await approvalPage(rt, read, person, id)
  }
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
}
