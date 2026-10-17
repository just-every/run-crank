import { chip, esc, hidden, json, timestamp } from '../document'
import { icon } from '../icons'
import { STEP_STATE, tile } from './canvas'
import { appOf, fieldLabel, lastRecord, mappingRows, mappingText, shortPaths, summaryOf, type Connection, type Node, type RunDetail } from './model'

export interface InspectorContext { workflowId: string; node: Node; tab: string; connections: Connection[]; runs: RunDetail[]; hooks: { active: boolean }[]; canPrepare: boolean; preview: any; sample: string; now: number }

const field = (label: string, value: string, mono = true) => `<div class="field"><span class="field-label">${esc(label)}</span><span class="field-value${mono ? ' mono' : ''}">${value}</span></div>`
const ago = (at: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60000))
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : minutes < 1440 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'} ago` : timestamp(at)
}
const mapped = (value: unknown) => { const text = mappingText(value), short = shortPaths(text); return short === text ? esc(text) : `<span title="${esc(text)}">${esc(short)}</span>` }

function rules(groups: unknown) {
  if (!Array.isArray(groups)) return ''
  return groups.map((group, g) => `${g ? '<p class="rule-or">or</p>' : ''}${(group as any[]).map(rule => field(String(rule.op).replace(/^(text|number|date|boolean|list)\./, '$1 ').replace(/_/g, ' '), `<span title="${esc(rule.field)}">${esc(shortPaths(`{{${rule.field}}}`).slice(2, -2))}</span>${rule.value === undefined ? '' : ` <b>${esc(mappingText(rule.value))}</b>`}`)).join('')}`).join('')
}

/** Retry and failure behaviour as the code applies it to this step type. */
function retryPolicy(node: Node) {
  const step = node.step
  if (!step || !(step.type === 'http' || step.type.startsWith('slack.'))) return ''
  const method = String((step.input as any)?.method ?? (step.type === 'http' ? 'GET' : 'POST')).toUpperCase(), write = step.type.startsWith('slack.') ? !/find_/.test(step.type) : !['GET', 'HEAD'].includes(method)
  const rows = write
    ? [field('Attempts', 'One write; never repeated blindly', false),
       ...(typeof step.idempotency_header === 'string' ? [field('Lost response', `Resent once with the same <code>${esc(step.idempotency_header)}</code>`, false)] : []),
       ...(step.readback ? [field('Then', 'Reads back by the business key before failing', false)] : []),
       ...(!step.readback && typeof step.idempotency_header !== 'string' ? [field('Lost response', 'Marked uncertain for review', false)] : [])]
    : [field('Attempts', 'Up to 3', false), field('Backoff', step.type.startsWith('slack.') ? 'Slack’s Retry-After, up to 5 s' : 'Exponential (0.5 s, 1 s)', false)]
  return `<section class="inspector-block"><h3>Retry policy ${icon('info', 'icon inline-info')}</h3>${rows.join('')}${field('Timeout', `${Number(step.timeout_ms ?? 15000) / 1000} s`, false)}${field('On error', step.on_error === 'continue' ? 'Continue the run' : 'Stop the run', false)}</section>`
}

function request(input: { method?: string; url: string }) {
  let host = input.url, rest = ''
  try { const url = new URL(input.url.replace(/\{\{[^}]*\}\}/g, 'x')); host = url.host; rest = decodeURIComponent(input.url.slice(input.url.indexOf(url.host) + url.host.length)) } catch { /* a mapped URL shows whole */ }
  return `${field('Method', esc(String(input.method ?? 'GET').toUpperCase()))}${field('Host', esc(host))}${rest ? field('Path', `<span title="${esc(rest)}">${esc(rest.length > 60 ? rest.slice(0, 57) + '…' : rest)}</span>`) : ''}`
}

function setup(ctx: InspectorContext) {
  const { node } = ctx, step = node.step
  if (node.trigger) {
    const t = node.trigger as any, active = ctx.hooks.filter(h => h.active).length
    return `<section class="inspector-block"><h3>Trigger</h3>${field('Type', esc(t.type), false)}${t.signature ? field('Signature', `${esc(t.signature.preset)} · verified on the raw body`, false) : ''}${t.dedup?.key ? field('Dedup key', esc(t.dedup.key)) : ''}${t.type === 'webhook' ? field('Webhook URLs', active ? `${active} active` : 'None yet', false) : ''}${t.every_minutes ? field('Every', `${esc(t.every_minutes)} min`, false) : ''}${t.at ? field('At', `${esc(t.at)} ${esc(t.timezone ?? '')}`, false) : ''}</section>`
  }
  const connection = ctx.connections.find(c => c.id === step!.connection_id)
  const mapping = step!.input && typeof step!.input === 'object' ? mappingRows(step!.input).filter(([key]) => key && !(step!.type === 'http' && ['method', 'url'].includes(key))) : []
  const parts = [
    connection ? `<section class="inspector-block"><h3>Connection</h3>${field(connection.label, `${chip(connection.status, connection.status === 'active' ? 'Connected' : connection.status.replace('_', ' '))}${connection.account_name ? ` <span class="muted">${esc(connection.account_name)}</span>` : ''}`, false)}</section>` : '',
    step!.type === 'filter' ? `<section class="inspector-block"><h3>Continue only if</h3>${rules(step!.when)}</section>` : '',
    step!.type === 'paths' ? `<section class="inspector-block"><h3>Paths</h3>${field('Mode', esc(step!.mode), false)}${(node.branches ?? []).map(b => `<p class="rule-branch">${esc(b.name)}</p>${b.kind === 'rule' ? rules((step!.branches as any[]).find(x => x.id === b.id)?.when) : field('Runs', b.kind === 'always' ? 'After the matched path, every time' : 'When no path matches', false)}`).join('')}</section>` : '',
    step!.type === 'approval' && typeof step!.instructions === 'string' ? `<section class="inspector-block"><h3>Instructions</h3><p class="inspector-note">${esc(step!.instructions)}</p>${Array.isArray(step!.editable) ? field('Editable', esc((step!.editable as string[]).join(', ')), false) : ''}</section>` : '',
    step!.type === 'http' && typeof (step!.input as any)?.url === 'string' ? `<section class="inspector-block"><h3>Request</h3>${request(step!.input as any)}</section>` : '',
    mapping.length ? `<section class="inspector-block"><h3>Field mapping</h3>${mapping.map(([key, value]) => field(fieldLabel(key), mapped(value))).join('')}</section>` : '',
    retryPolicy(node),
  ]
  return parts.join('')
}

function lastResult(ctx: InspectorContext) {
  const found = ctx.node.trigger ? (ctx.runs[0] ? { run: ctx.runs[0], record: null as any } : null) : lastRecord(ctx.runs, ctx.node.path)
  const head = `<div class="result-head"><h3>Last result</h3>${ctx.canPrepare ? `<a class="btn btn-secondary btn-small" href="?step=${encodeURIComponent(ctx.node.path)}&amp;tab=test">Test step</a>` : ''}</div>`
  if (!found) return `<section class="inspector-block last-result">${head}<p class="muted">No run has reached this step yet.</p></section>`
  const status = found.record?.status ?? 'succeeded', at = found.record?.finished_at ?? found.record?.started_at ?? found.run.received_at
  const output = found.record?.output as any, body = output?.body
  const leaves = body && typeof body === 'object' ? mappingRows(body).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 4) : []
  const summary = found.record?.error ? `<p class="result-error">${esc(found.record.error.message)}</p>`
    : output?.status ? `<div class="result-card"><span class="tile tile-result" aria-hidden="true">${icon('check')}</span><div><strong>HTTP ${esc(output.status)}${output.reconciled ? ' · read back, not repeated' : ''}</strong>${leaves.map(([k, v]) => `<span><span class="muted">${esc(k)}</span> ${esc(v)}</span>`).join('')}</div></div>`
    : found.record?.status === 'waiting' ? '<p class="muted">Waiting for an owner’s decision in Approvals.</p>' : ''
  return `<section class="inspector-block last-result">${head}<p class="result-status" data-state="${esc(status)}">${icon(status === 'failed' ? 'warning' : status === 'waiting' ? 'clock' : 'check', 'icon state-mark')}<strong>${esc(STEP_STATE[status] ?? status)}</strong> <span class="muted">${ago(at, ctx.now)}</span></p>${summary}<a class="result-link" href="/app/workflow-runs/${esc(found.run.id)}">Open run ${esc(found.run.id.slice(0, 8))} ${icon('chevron')}</a></section>`
}

function data(ctx: InspectorContext) {
  const found = ctx.node.trigger ? null : lastRecord(ctx.runs, ctx.node.path)
  if (ctx.node.trigger) return ctx.runs[0]?.trigger !== undefined ? `<section class="inspector-block"><h3>Latest event</h3><pre>${json(ctx.runs[0].trigger)}</pre></section>` : '<section class="inspector-block"><p class="muted">No events yet, or your role cannot read payloads.</p></section>'
  if (!found) return '<section class="inspector-block"><p class="muted">No run has reached this step yet.</p></section>'
  return `<section class="inspector-block"><h3>Input</h3>${found.record.input === undefined ? '<p class="muted">Restricted for your role.</p>' : `<pre>${json(found.record.input)}</pre>`}</section>${found.record.output !== undefined && found.record.output !== null ? `<section class="inspector-block"><h3>Output</h3><pre>${json(found.record.output)}</pre></section>` : ''}${found.record.error ? `<section class="inspector-block"><h3>Error</h3><pre>${json(found.record.error)}</pre></section>` : ''}`
}

function test(ctx: InspectorContext) {
  const results = ctx.preview ? `<section class="inspector-block"><h3>Preview result</h3><p class="inspector-note">On a ${esc(ctx.preview.sample_source)}; nothing was sent.</p><ol class="preview-list">${(ctx.preview.steps as any[]).map(s => `<li data-outcome="${esc(s.outcome ?? (s.output !== undefined ? 'mapped' : ''))}"><code>${esc(s.path)}</code><span>${esc(s.outcome ?? 'mapped')}${s.matched ? ` · ${esc(s.matched.join(', '))}` : ''}</span>${s.error ? `<small>${esc(s.error.message)}</small>` : ''}</li>`).join('')}</ol></section>` : ''
  if (!ctx.canPrepare) return '<section class="inspector-block"><p class="muted">Owners and admins can preview a flow on a sample.</p></section>'
  return `${results}<section class="inspector-block"><h3>Test on a sample</h3><p class="inspector-note">Filters, paths and formatters run on the sample. The preview stops before the first step that would call an app.</p><form method="post" action="/app/workflows/${esc(ctx.workflowId)}/preview">${hidden('step', ctx.node.path)}<label>Sample trigger (JSON)<textarea name="sample" rows="8" spellcheck="false" required>${esc(ctx.sample)}</textarea></label><button class="btn btn-primary">Run preview</button></form></section>`
}

export function inspector(ctx: InspectorContext) {
  const app = appOf(ctx.node, ctx.connections), tabs = [['setup', 'Setup'], ['data', 'Data'], ['test', 'Test']]
  const link = (tab: string) => `?step=${encodeURIComponent(ctx.node.path)}&amp;tab=${tab}`
  const body = ctx.tab === 'data' ? data(ctx) : ctx.tab === 'test' ? test(ctx) : setup(ctx) + lastResult(ctx)
  return `<section class="panel inspector" aria-label="Selected step"><div class="inspector-head">${tile(app)}<div><h2>${esc(app.title)}</h2><p>${esc(summaryOf(ctx.node))}</p></div></div><nav class="tabs" aria-label="Step details">${tabs.map(([id, name]) => `<a href="${link(id)}"${ctx.tab === id ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav>${body}</section>`
}
