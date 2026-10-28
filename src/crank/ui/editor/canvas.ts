import { namedFields, reference } from './native'
import type { Graph } from '../../engine/graph'
import { clock, esc, json } from '../document'
import { icon } from '../icons'
import { appOf, lastRecord, nodes, summaryOf, type Connection, type Node, type RunDetail } from './model'

export const STEP_STATE: Record<string, string> = { succeeded: 'Success', failed: 'Failed', waiting: 'Waiting', stopped: 'Stopped', uncertain: 'Uncertain', skipped: 'Skipped', running: 'Running' }
const LETTERS: Record<string, string> = { stripe: 'S', slack: '#', quickbooks: 'qb', hubspot: 'H', shopify: 'S', github: 'GH', calendly: 'C', typeform: 'T', twilio: 'T' }

/** A tinted app tile with a letter or a generic glyph, never a trademark. */
export function tile(app: { tile: string; glyph: string }) {
  const letter = LETTERS[app.tile]
  return `<span class="tile tile-${esc(app.tile)}" aria-hidden="true">${letter ? esc(letter) : icon(app.glyph)}</span>`
}

/** `repaired`: steps where a run of an older version failed on a field the live version (`changedIn`) reads under its new name. */
export interface CanvasContext { preview?: {source:{label:string;source_time?:string};trigger:unknown;steps:{path:string;output?:unknown;outcome?:string;error?:{message?:string}}[]}; graph?: Graph; workflowId: string; connections: Connection[]; runs: RunDetail[]; selected: string; repaired: Set<string>; changedIn: number | null; query: string }

function card(node: Node, ctx: CanvasContext) {
  const app = appOf(node, ctx.connections), found = node.trigger ? (ctx.runs[0] ? { run: ctx.runs[0], record: null } : null) : lastRecord(ctx.runs, node.path)
  const state = node.trigger ? (found ? 'succeeded' : '') : found?.record?.status ?? ''
  const at = node.trigger ? found?.run.received_at : found?.record?.finished_at ?? found?.record?.started_at
  const reconciled = (found?.record?.output as any)?.reconciled === true
  const repaired = ctx.repaired.has(node.path) && state === 'succeeded'
  const mark = state === 'succeeded' ? 'check' : state === 'failed' || state === 'uncertain' ? 'warning' : state === 'stopped' || state === 'skipped' ? 'stop' : 'clock'
  const foot = state ? `<span class="step-foot"><span class="state" data-state="${esc(state)}"${repaired ? ` title="A run of an earlier version failed here; version ${ctx.changedIn} reads the renamed field and its runs succeed"` : ''}>${icon(mark, 'icon state-mark')}${esc(repaired ? 'Repaired' : reconciled ? 'Read back' : STEP_STATE[state] ?? state)}</span>${at ? clock(at) : ''}</span>` : '<span class="step-foot"><span class="state">No runs yet</span></span>'
  const fields = ctx.graph && node.step ? namedFields(ctx.graph,node.step.id) : []
  const refs = node.step?.input && typeof node.step.input === 'object' ? Object.values(node.step.input).map(reference).filter(Boolean) : []
  const lineage = refs.map(ref=>fields.find(field=>field.ref===ref)?.label).filter(Boolean)
  const href = `/app/workflows/${encodeURIComponent(ctx.workflowId)}?step=${encodeURIComponent(node.path)}${ctx.query}`
  return `<a class="step-card${ctx.selected === node.path ? ' is-selected' : ''}" href="${esc(href)}"${ctx.selected === node.path ? ' aria-current="true"' : ''}><span class="step-head">${tile(app)}<span class="step-text"><strong>${esc(app.title)}</strong><span>${esc(summaryOf(node))}</span></span></span>${lineage.length ? `<span class="step-lineage">Reads ${esc(lineage.join('; '))}</span>` : ''}${node.branches && node.step?.type !== 'loop' ? '' : foot}</a>`
}

function edgeSample(node: Node, ctx: CanvasContext) {
  const preview=ctx.preview
  if(!preview)return ''
  const result=preview.steps.find(step=>step.path===node.path), value=node.trigger?preview.trigger:result?.output
  const available=node.trigger || result && Object.hasOwn(result,'output')
  const status=available?'Sample data':result?.outcome ?? 'Not reached in this preview'
  return `<details class="edge-sample" data-step="${esc(node.path)}"><summary>${esc(status)}</summary><p>${esc(preview.source.label)}${preview.source.source_time?` · ${clock(preview.source.source_time)}`:''}</p>${available?`${result?.outcome?`<p>${esc(result.outcome)}</p>`:''}<pre>${json(value)}</pre>`:`<p>${esc(result?.error?.message ?? (result?.outcome==='not run in preview'?'App actions and waits need a separate step test.':'This route produced no sample output.'))}</p>`}</details>`
}
function column(list: Node[], ctx: CanvasContext): string {
  return `<ol class="chain">${list.map(node => `<li class="link${node.branches ? ' has-branches' : ''}"><div class="step-node">${card(node, ctx)}${edgeSample(node,ctx)}</div>${node.branches ? `<div class="branches">${node.branches.map(branch => `<section class="branch" aria-label="${esc(branch.name)}"><span class="branch-label">${esc(branch.name)}</span>${branch.nodes.length ? column(branch.nodes, ctx) : '<p class="branch-empty">No steps</p>'}</section>`).join('')}</div>` : ''}</li>`).join('')}</ol>`
}

/** The steps in order; a path group's branches stack in a column to its right. */
export function canvas(graph: any, ctx: CanvasContext) {
  return `<section class="canvas" aria-label="Steps">${column(nodes(graph), {...ctx,graph})}</section>`
}
