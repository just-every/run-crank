import { chip, esc, hidden, json, timestamp } from '../document'
import { icon } from '../icons'
import { STEP_STATE, tile } from './canvas'
import type { Graph } from '../../engine/graph'
import { causeHtml, renameOf } from '../failure'
import { appOf, findNode, lastRecord, mappingRows, mappingText, rowLabel, shortPaths, summaryOf, type Connection, type Node, type RunDetail } from './model'
import { summaryHtml, summaryOfResult } from './results'

export interface InspectorContext { sampleData?: any; triggerState?: any; workflowId: string; graph: Graph; live: { graph: Graph; number: number } | null; node: Node; tab: string; connections: Connection[]; runs: RunDetail[]; hooks: { active: boolean }[]; canPrepare: boolean; preview: any; sample: string; now: number; people: { id: string; name: string }[] }

const STATE_ICON: Record<string, string> = { failed: 'warning', uncertain: 'warning', waiting: 'clock', running: 'clock', stopped: 'stop', skipped: 'stop' }

const field = (label: string, value: string, mono = true) => `<div class="field"><span class="field-label">${esc(label)}</span><span class="field-value${mono ? ' mono' : ''}">${value}</span></div>`
/** A block that starts folded to one line: its title and the gist of what it holds. */
const folded = (title: string, gist: string, body: string) => `<details class="inspector-block folded"><summary><h3>${title}</h3><span class="folded-gist">${gist}</span>${icon('down', 'icon folded-mark')}</summary>${body}</details>`
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
  const timeout = `${Number(step.timeout_ms ?? 15000) / 1000} s`, gist = write ? 'One write' : 'Up to 3 attempts'
  return folded('Retry policy', `${gist} · ${timeout} timeout`, `${rows.join('')}${field('Timeout', timeout, false)}${field('On error', step.on_error === 'continue' ? 'Continue the run' : 'Stop the run', false)}`)
}

function request(input: { method?: string; url: string }) {
  let host = input.url, rest = ''
  try { const url = new URL(input.url.replace(/\{\{[^}]*\}\}/g, 'x')); host = url.host; rest = decodeURIComponent(input.url.slice(input.url.indexOf(url.host) + url.host.length)) } catch { /* a mapped URL shows whole */ }
  const [path, query] = rest.split(/\?(.*)/s), short = (text: string) => `<span title="${esc(text)}">${esc(text.length > 60 ? text.slice(0, 57) + '…' : text)}</span>`
  const method = esc(String(input.method ?? 'GET').toUpperCase())
  return folded('Request', `${method} ${esc(host)}`, `${field('Method', method)}${field('Host', esc(host))}${path ? field('Path', short(path)) : ''}${query ? field('Query', short(query)) : ''}`)
}

function setup(ctx: InspectorContext) {
  const { node } = ctx, step = node.step
  if (node.trigger) {
    const poll = ctx.triggerState?.poll, subscription = ctx.triggerState?.subscription
    const pollFields = poll ? field('Initial records', esc(node.trigger.backfill === 'existing' ? 'Process existing' : 'Start from now'), false) + field('Last successful poll', ctx.triggerState.last_successful_poll ? timestamp(ctx.triggerState.last_successful_poll) : 'None yet', false) + field('Next poll', timestamp(poll.next_due_at), false) + field('Poll status', esc(poll.last_error ?? poll.last_status ?? 'Not started'), false) : ''
    const subscriptionFields = subscription ? field('Subscription', esc(subscription.status), false) + field('Subscription expiry', timestamp(subscription.expires_at), false) + (subscription.error ? field('Next action', esc(subscription.error), false) : '') : ''
    const t = node.trigger as any, active = ctx.hooks.filter(h => h.active).length
    return `<section class="inspector-block"><h3>Trigger</h3>${field('Type', esc(t.type), false)}${pollFields}${subscriptionFields}${t.watched_fields ? field('Watched fields', esc(t.watched_fields.join(', ')), false) : ''}${t.signature ? field('Signature', `${esc(t.signature.preset)} · verified on the raw body`, false) : ''}${t.dedup?.key ? field('Dedup key', esc(t.dedup.key)) : ''}${t.type === 'webhook' ? field('Webhook URLs', active ? `${active} active` : 'None yet', false) : ''}${t.every_minutes ? field('Every', `${esc(t.every_minutes)} min`, false) : ''}${t.at ? field('At', `${esc(t.at)} ${esc(t.timezone ?? '')}`, false) : ''}</section>`
  }
  const connection = ctx.connections.find(c => c.id === step!.connection_id)
  const mapping = step!.input && typeof step!.input === 'object' ? mappingRows(step!.input).filter(([key]) => key && !(step!.type === 'http' && ['method', 'url'].includes(key))) : []
  const parts = [
    connection ? `<section class="inspector-block connection-line"><h3>Connection</h3>${chip(connection.status, connection.status === 'active' ? 'Connected' : connection.status.replace('_', ' '))}<span class="muted" title="${esc(connection.label)}">${esc(connection.account_name || connection.label)}</span></section>` : '',
    step!.type === 'filter' ? `<section class="inspector-block"><h3>Continue only if</h3>${rules(step!.when)}</section>` : '',
    step!.type === 'paths' ? `<section class="inspector-block"><h3>Paths</h3>${field('Mode', esc(step!.mode), false)}${(node.branches ?? []).map(b => `<p class="rule-branch">${esc(b.name)}</p>${b.kind === 'rule' ? rules((step!.branches as any[]).find(x => x.id === b.id)?.when) : field('Runs', b.kind === 'always' ? 'After the matched path, every time' : 'When no path matches', false)}`).join('')}</section>` : '',
    step!.type === 'approval' && typeof step!.instructions === 'string' ? `<section class="inspector-block"><h3>Instructions</h3><p class="inspector-note">${esc(step!.instructions)}</p>${Array.isArray(step!.editable) ? field('Editable', esc((step!.editable as string[]).join(', ')), false) : ''}</section>` : '',
    step!.type === 'http' && typeof (step!.input as any)?.url === 'string' ? request(step!.input as any) : '',
    mapping.length ? `<section class="inspector-block"><h3>Field mapping</h3>${mapping.map(([key, value]) => field(rowLabel(key), mapped(value))).join('')}</section>` : '',
    step!.type === 'custom.request' ? `<section class="inspector-block"><h3>Reviewed custom operation</h3>${field('Connector',esc(step!.connector_id))}${field('Pinned version',esc(step!.connector_version))}${field('Operation',esc(step!.operation))}${step!.gateway_id ? field('Gateway',esc(step!.gateway_id))+field('Environment',esc(step!.environment),false) : ''}<p class="muted">Current scopes and exact-version sandbox evidence are checked before production. Private credentials stay on the enrolled gateway.</p></section>` : '',
    step!.type === 'code' ? `<section class="inspector-block"><h3>Code executor</h3>${field('Language',esc(step!.language),false)}${field('Executor',esc(step!.executor_url),false)}${field('Wall limit',`${esc(step!.timeout_ms)} ms`,false)}${field('Address space per process',`${esc(step!.memory_mb)} MiB`,false)}${field('Network','Disabled',false)}<details><summary>Source</summary><pre>${esc(step!.source)}</pre></details>${step!.output_schema !== undefined ? `<details><summary>Declared output schema</summary><pre>${json(step!.output_schema)}</pre></details>` : ''}</section>` : '',
    retryPolicy(node),
  ]
  return parts.join('')
}

function lastResult(ctx: InspectorContext) {
  const found = ctx.node.trigger ? (ctx.runs[0] ? { run: ctx.runs[0], record: null as any } : null) : lastRecord(ctx.runs, ctx.node.path)
  const head = `<div class="result-head"><h3>Last result</h3>${ctx.canPrepare ? `<a class="btn btn-secondary btn-small" href="?step=${encodeURIComponent(ctx.node.path)}&amp;tab=test">Test step</a>` : ''}</div>`
  if (!found) return `<section class="inspector-block last-result">${head}<p class="muted">No run has reached this step yet.</p></section>`
  const status = found.record?.status ?? 'succeeded', at = found.record?.finished_at ?? found.record?.started_at ?? found.run.received_at
  const result = found.record ? summaryOfResult(ctx.node, found.record, ctx.people) : null
  const summary = found.record?.error ? `<p class="result-error">${causeHtml(found.record.error, renameOf(found.record.error, ctx.node.path, ctx.live))}</p>`
    : result ? `<div class="result-card" data-state="${esc(status)}"><span class="tile tile-result" aria-hidden="true">${icon(STATE_ICON[status] ?? 'check')}</span><div>${summaryHtml(result)}</div></div>`
    : found.record?.status === 'waiting' && ctx.node.step?.type === 'code' ? '<p class="muted">Waiting for the owner-deployed executor. Cron checks the same task.</p>' : found.record?.status === 'waiting' && ctx.node.step?.type==='custom.request' ? '<p class="muted">Waiting for the enrolled private gateway. Completed pages stay checkpointed; Cron continues this exact task.</p>' : found.record?.status === 'waiting' ? '<p class="muted">Waiting for an owner’s decision in Approvals.</p>' : ''
  return `<section class="inspector-block last-result">${head}<p class="result-status" data-state="${esc(status)}">${icon(STATE_ICON[status] ?? 'check', 'icon state-mark')}<strong>${esc(STEP_STATE[status] ?? status)}</strong> <span class="muted">${ago(at, ctx.now)}</span></p>${summary}<a class="result-link" href="/app/workflow-runs/${esc(found.run.id)}">Open run ${esc(found.run.id.slice(0, 8))} ${icon('chevron')}</a></section>`
}

function data(ctx: InspectorContext) {
  const found = ctx.node.trigger ? null : lastRecord(ctx.runs, ctx.node.path)
  if (ctx.node.trigger) return ctx.runs[0]?.trigger !== undefined ? `<section class="inspector-block"><h3>Latest event</h3><pre>${json(ctx.runs[0].trigger)}</pre></section>` : '<section class="inspector-block"><p class="muted">No events yet, or your role cannot read payloads.</p></section>'
  if (!found) return '<section class="inspector-block"><p class="muted">No run has reached this step yet.</p></section>'
  return `<section class="inspector-block"><h3>Input</h3>${found.record.input === undefined ? '<p class="muted">Restricted for your role.</p>' : `<pre>${json(found.record.input)}</pre>`}</section>${found.record.output !== undefined && found.record.output !== null ? `<section class="inspector-block"><h3>Output</h3><pre>${json(found.record.output)}</pre></section>` : ''}${found.record.error ? `<section class="inspector-block"><h3>Error</h3><pre>${json(found.record.error)}</pre></section>` : ''}`
}

function test(ctx: InspectorContext) {
  const results = ctx.preview ? `<section class="inspector-block"><h3>Preview result</h3><p class="inspector-note">On a ${esc(ctx.preview.sample_source)}; nothing was sent.</p><ol class="preview-list">${(ctx.preview.steps as any[]).map(s => { const at = findNode(ctx.graph, s.path), outcome = String(s.outcome ?? 'mapped'), matched = (s.matched as string[] | undefined)?.map(id => at?.branches?.find(b => b.id === id)?.name ?? id)
    return `<li data-outcome="${esc(outcome)}"><strong>${esc(at ? `${appOf(at, ctx.connections).title} · ${summaryOf(at)}` : s.path)}</strong><span>${esc(outcome.charAt(0).toUpperCase() + outcome.slice(1))}${matched?.length ? ` · ${esc(matched.join(', '))}` : ''}</span><p class="inspector-note">Sources: ${esc((s.sources ?? [s.source]).filter(Boolean).map((source:any)=>source.label).join(' + '))}</p>${s.output !== undefined ? `<pre>${json(s.output)}</pre>` : ''}${s.trace ? `<details><summary>Condition details</summary><pre>${json(s.trace)}</pre></details>` : ''}${s.error ? `<small>${causeHtml(s.error, null)}</small>` : ''}</li>` }).join('')}</ol></section>` : ''
  if (!ctx.canPrepare) return '<section class="inspector-block"><p class="muted">Owners and admins can preview a flow on a sample.</p></section>'
  const base = `/api/crank/workflows/${ctx.workflowId}/samples`, back = `/app/workflows/${ctx.workflowId}?step=${encodeURIComponent(ctx.node.path)}&tab=test`
  const allSamples = ctx.sampleData?.samples ?? [], samples = allSamples.filter((s:any)=>s.step_path===ctx.node.path), selected = samples.find((s:any)=>s.selected), trigger = allSamples.find((s:any)=>s.selected && s.step_path==='trigger')
  const actionForm = (suffix:string, title:string, fields:string) => `<form method="post" action="/app/action">${hidden('path',base+suffix)}${hidden('return_to',back)}${fields}<button class="btn btn-secondary">${title}</button></form>`
  const retained = samples.length ? `<section class="inspector-block"><h3>Retained ${ctx.node.trigger ? 'trigger samples' : 'step outputs'}</h3>${selected ? `<p class="inspector-note">Selected: ${esc(selected.label)}${selected.source_time ? ` · ${timestamp(selected.source_time)}` : ''}</p>` : '<p>No trigger sample selected.</p>'}${actionForm('/select','Use selected sample',`<label>Saved sample<select name="sample_id">${samples.map((s:any)=>`<option value="${esc(s.id)}"${s.selected?' selected':''}>${esc(s.step_path)} · ${esc(s.label)}</option>`).join('')}</select></label>`)}${selected ? `<details><summary>Captured data</summary><pre>${json(selected.payload)}</pre></details><form method="post" action="/app/workflows/${esc(ctx.workflowId)}/preview">${hidden('step',ctx.node.path)}${hidden('sample_id',trigger?.id ?? '')}<button class="btn btn-primary"${trigger ? '' : ' disabled'}>Preview selected sample</button></form>` : ''}<details><summary>Remove a sample</summary>${actionForm('/delete','Delete sample',`<label>Sample to delete<select name="sample_id">${samples.map((s:any)=>`<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</select></label>`)}</details></section>` : ''
  const capture = ctx.node.trigger?.type === 'webhook' ? `<section class="inspector-block"><h3>Capture webhook sample</h3><p>Wait for one POST on a separate draft URL. No production run starts.</p>${actionForm('/listen','Wait for webhook','')}<a href="${esc(back)}">Refresh captured samples</a></section>` : ''
  const history = ctx.runs.length ? `<details class="inspector-block"><summary>Load from run history</summary>${actionForm('','Load history sample',`${hidden('source','history')}${hidden('step_path',ctx.node.path)}<label>Earlier run<select name="run_id">${ctx.runs.map(r=>`<option value="${esc(r.id)}">${esc(r.id)} · ${timestamp(r.received_at)}</option>`).join('')}</select></label>`)}</details>` : ''
  return `${results}${retained}${allSamples.some((s:any)=>s.step_path!=='trigger') ? `<details class="inspector-block"><summary>Step schema samples</summary>${allSamples.filter((s:any)=>s.step_path!=='trigger').map((s:any)=>`<p>${esc(s.step_path)} · ${esc(s.label)}</p><pre>${json(s.payload)}</pre>`).join('')}</details>` : ''}${capture}${history}<section class="inspector-block"><h3>Test on a sample</h3><p class="inspector-note">Filters, paths and formatters run on the selected source. Saved step outputs carry previews past app steps without calling them. Schema samples have not been tested.</p>${actionForm('','Save sample',`<label>Sample source<select name="source"><option value="manual">Manual sample</option><option value="schema">Schema sample · not tested</option></select></label>${hidden('step_path',ctx.node.path)}<label>Sample JSON<textarea name="sample" rows="8" spellcheck="false" required>${esc(ctx.sample)}</textarea></label>`)}<details><summary>Preview without saving</summary><form method="post" action="/app/workflows/${esc(ctx.workflowId)}/preview">${hidden('step',ctx.node.path)}<label>Manual sample JSON<textarea name="sample" rows="8" spellcheck="false" required>${esc(ctx.sample)}</textarea></label><button class="btn btn-secondary">Run preview</button></form></details><details><summary>Expected trigger fields</summary>${actionForm('/fields','Refresh expected fields','<label>Field paths, separated by commas<input name="fields" placeholder="body.email, body.new_question"></label>')}</details></section>`

}

export function inspector(ctx: InspectorContext) {
  const app = appOf(ctx.node, ctx.connections), tabs = [['setup', 'Setup'], ['data', 'Data'], ['test', 'Test']]
  const link = (tab: string) => `?step=${encodeURIComponent(ctx.node.path)}&amp;tab=${tab}`
  const body = ctx.tab === 'data' ? data(ctx) : ctx.tab === 'test' ? test(ctx) : setup(ctx) + lastResult(ctx)
  return `<section class="panel inspector" aria-label="Selected step"><div class="inspector-head">${tile(app)}<div><h2>${esc(app.title)}</h2><p>${esc(summaryOf(ctx.node))}</p></div></div><nav class="tabs" aria-label="Step details">${tabs.map(([id, name]) => `<a href="${link(id)}"${ctx.tab === id ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav><div class="inspector-body">${body}</div></section>`
}
