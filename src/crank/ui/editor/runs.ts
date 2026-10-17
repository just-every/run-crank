import { resolve } from '../../engine/mapping'
import type { Graph } from '../../engine/graph'
import { clock, esc, plural } from '../document'
import { icon } from '../icons'
import { appOf, flatten, nodes, summaryOf, type Connection, type RunDetail } from './model'

export const RUN_STATE: Record<string, string> = {
  queued: 'Queued', running: 'Running', waiting: 'Waiting', awaiting_approval: 'Waiting for approval', paused: 'Paused', succeeded: 'Success', failed: 'Failed',
  stopped_by_filter: 'Stopped by filter', stopped_by_search: 'Stopped by search', cancelled: 'Cancelled', rejected: 'Rejected',
}
const tone = (status: string) => status === 'succeeded' ? 'good' : status === 'failed' || status === 'rejected' ? 'bad' : ['awaiting_approval', 'waiting', 'paused', 'queued', 'running'].includes(status) ? 'wait' : 'quiet'
export const duration = (from: string | null, to: string | null) => {
  if (!from || !to) return '—'
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

/** Dots for each step of the run's version, in order: done, failed, waiting or not reached. */
function dots(run: RunDetail, graph: Graph | undefined) {
  if (!graph) return ''
  const steps = flatten(nodes(graph)).filter(n => !n.trigger)
  return `<span class="dots" aria-label="${run.steps.filter(s => s.status === 'succeeded').length} of ${steps.length} steps done">${steps.map(n => {
    const s = run.steps.find(r => r.path === n.path)?.status
    return `<i data-state="${esc(s ?? 'none')}" title="${esc(summaryOf(n))}">${s === 'succeeded' ? icon('check') : s === 'failed' || s === 'uncertain' ? '!' : s === 'waiting' ? icon('clock') : ''}</i>`
  }).join('')}</span>`
}

const NUMERIC = /^-?[$€£]?\d[\d,]*(\.\d+)?$/
/** The run's column values as its own version declares them (`settings.run_columns`). */
function columnValues(run: RunDetail, graph: Graph | undefined, labels: string[]): string[] {
  const declared = (graph?.settings?.run_columns ?? []) as { label: string; value: unknown }[]
  return labels.map(label => {
    const column = declared.find(c => c.label === label)
    if (!column || run.trigger === undefined) return ''
    let value: unknown
    try { value = resolve(column.value, { trigger: run.trigger, steps: {}, run: { id: run.id } }) } catch { value = undefined }
    return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

function note(run: RunDetail, graph: Graph | undefined) {
  const node = (path: string) => graph ? flatten(nodes(graph)).find(n => n.path === path) : undefined
  if (run.status === 'failed' && run.error) { const failed = run.steps.find(s => s.status === 'failed' || s.status === 'uncertain'); const at = failed && node(failed.path); return `${at ? `${esc(summaryOf(at))}: ` : ''}${esc(run.error.message)}` }
  if (run.status === 'awaiting_approval') return 'Waiting in Approvals'
  if (run.status === 'paused' && run.error) return esc(run.error.message)
  if (run.steps.some(s => (s.output as any)?.reconciled)) return 'Response lost; read back found the record, not written twice'
  return ''
}

export interface RunsContext { workflowId: string; runs: RunDetail[]; graphs: Map<string, Graph>; current: Graph; connections: Connection[]; today: { runs: number; failed: number; awaiting_approval: number }; q: string; status: string; selected: string }

export function runsStrip(ctx: RunsContext) {
  const labels = ((ctx.current.settings?.run_columns ?? []) as { label: string }[]).map(c => c.label)
  const trigger = appOf({ path: 'trigger', step: null, trigger: ctx.current.trigger }, ctx.connections).title
  const statuses = ['', 'succeeded', 'failed', 'awaiting_approval', 'paused', 'stopped_by_filter', 'cancelled', 'rejected']
  const values = ctx.runs.map(run => columnValues(run, ctx.graphs.get(run.version_id), labels))
  const numeric = labels.map((_, i) => values.some(v => v[i]) && values.every(v => !v[i] || NUMERIC.test(v[i])))
  const rows = ctx.runs.map((run, r) => {
    const graph = ctx.graphs.get(run.version_id), extra = note(run, graph)
    return `<tr><td data-label="Run"><a class="mono" href="/app/workflow-runs/${esc(run.id)}">${esc(run.id.slice(0, 8))}</a></td><td class="nowrap" data-label="Trigger">${esc(trigger.toLowerCase().includes(run.trigger_kind) ? trigger : `${trigger} ${run.trigger_kind}`)}</td>${values[r].map((v, i) => `<td data-label="${esc(labels[i])}"${numeric[i] ? ' class="num"' : ''}>${v ? esc(v) : '<span class="muted">—</span>'}</td>`).join('')}<td data-label="Steps">${dots(run, graph)}</td><td class="nowrap" data-label="Duration">${duration(run.received_at, run.finished_at)}</td><td class="nowrap" data-label="Time">${clock(run.received_at)}</td><td class="run-status" data-label="Status"><span class="status" data-tone="${tone(run.status)}">${esc(RUN_STATE[run.status] ?? run.status)}</span>${extra ? `<small>${extra}</small>` : ''}</td><td><a class="row-open" href="/app/workflow-runs/${esc(run.id)}" aria-label="Open run ${esc(run.id.slice(0, 8))}">${icon('chevron')}</a></td></tr>`
  }).join('')
  const counter = `<div class="counter" role="group" aria-label="Runs today"><strong>${ctx.today.runs.toLocaleString('en-US')}</strong><span class="counter-facts"><span data-tone="${ctx.today.failed ? 'bad' : 'good'}">${plural(ctx.today.failed, 'failed', 'failed')}</span>${ctx.today.awaiting_approval ? `<span data-tone="wait">${ctx.today.awaiting_approval.toLocaleString('en-US')} waiting</span>` : ''}</span></div>`
  const filters = `<form class="run-filters" method="get" action="/app/workflows/${esc(ctx.workflowId)}" role="search"><input type="hidden" name="step" value="${esc(ctx.selected)}"><label class="search-field">${icon('search')}<span class="sr-only">Search runs</span><input type="search" name="q" value="${esc(ctx.q)}" placeholder="Search runs, customers or errors"></label><label><span class="sr-only">Status</span><select name="status">${statuses.map(s => `<option value="${s}"${ctx.status === s ? ' selected' : ''}>${s ? esc(RUN_STATE[s]) : 'All statuses'}</option>`).join('')}</select></label><button class="btn btn-secondary">Filter</button></form>`
  return `<section class="panel runs-strip" aria-labelledby="runs-today"><div class="runs-head"><h2 id="runs-today">Runs today</h2>${counter}${filters}</div><div class="table-scroll"><table class="runs-table"><thead><tr><th>Run</th><th>Trigger</th>${labels.map((l, i) => `<th${numeric[i] ? ' class="num"' : ''}>${esc(l)}</th>`).join('')}<th>Steps</th><th>Duration</th><th>Time</th><th>Status</th><th><span class="sr-only">Open</span></th></tr></thead><tbody>${rows || `<tr><td colspan="${8 + labels.length}" class="empty-row">${ctx.q || ctx.status ? 'No runs match this search.' : 'No runs yet. Runs appear here as events arrive.'}</td></tr>`}</tbody></table></div><a class="strip-more" href="/app/runs?workflow=${esc(ctx.workflowId)}">All runs of this flow ${icon('chevron')}</a></section>`
}
