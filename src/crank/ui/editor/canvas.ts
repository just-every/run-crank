import { clock, esc } from '../document'
import { icon } from '../icons'
import { appOf, lastRecord, nodes, summaryOf, type Connection, type Node, type RunDetail } from './model'

export const STEP_STATE: Record<string, string> = { succeeded: 'Success', failed: 'Failed', waiting: 'Waiting', stopped: 'Stopped', uncertain: 'Uncertain', skipped: 'Skipped', running: 'Running' }
const LETTERS: Record<string, string> = { stripe: 'S', slack: '#', quickbooks: 'qb', hubspot: 'H', shopify: 'S', github: 'GH', calendly: 'C', typeform: 'T', twilio: 'T' }

/** A tinted app tile with a letter or a generic glyph, never a trademark. */
export function tile(app: { tile: string; glyph: string }) {
  const letter = LETTERS[app.tile]
  return `<span class="tile tile-${esc(app.tile)}" aria-hidden="true">${letter ? esc(letter) : icon(app.glyph)}</span>`
}

export interface CanvasContext { workflowId: string; connections: Connection[]; runs: RunDetail[]; selected: string; changed: Set<string>; changedIn: number | null; query: string }

function card(node: Node, ctx: CanvasContext) {
  const app = appOf(node, ctx.connections), found = node.trigger ? (ctx.runs[0] ? { run: ctx.runs[0], record: null } : null) : lastRecord(ctx.runs, node.path)
  const state = node.trigger ? (found ? 'succeeded' : '') : found?.record?.status ?? ''
  const at = node.trigger ? found?.run.received_at : found?.record?.finished_at ?? found?.record?.started_at
  const reconciled = (found?.record?.output as any)?.reconciled === true
  const foot = state ? `<span class="step-foot"><span class="state" data-state="${esc(state)}">${state === 'succeeded' || state === 'failed' ? icon(state === 'succeeded' ? 'check' : 'warning', 'icon state-mark') : icon('clock', 'icon state-mark')}${esc(reconciled ? 'Read back' : STEP_STATE[state] ?? state)}</span>${at ? clock(at) : ''}</span>` : '<span class="step-foot"><span class="state">No runs yet</span></span>'
  const changed = ctx.changed.has(node.path) && ctx.changedIn ? `<span class="changed-badge" title="Changed in version ${ctx.changedIn}">${icon('diff')}Changed in v${ctx.changedIn}</span>` : ''
  const href = `/app/workflows/${encodeURIComponent(ctx.workflowId)}?step=${encodeURIComponent(node.path)}${ctx.query}`
  return `<a class="step-card${ctx.selected === node.path ? ' is-selected' : ''}" href="${esc(href)}"${ctx.selected === node.path ? ' aria-current="true"' : ''}><span class="step-head">${tile(app)}<span class="step-text"><strong>${esc(app.title)}</strong><span>${esc(summaryOf(node))}</span></span></span>${changed}${node.branches ? '' : foot}</a>`
}

function column(list: Node[], ctx: CanvasContext): string {
  return `<ol class="chain">${list.map(node => `<li class="link${node.branches ? ' has-branches' : ''}">${card(node, ctx)}${node.branches ? `<div class="branches">${node.branches.map(branch => `<section class="branch" aria-label="${esc(branch.name)}"><span class="branch-label">${esc(branch.name)}</span>${branch.nodes.length ? column(branch.nodes, ctx) : '<p class="branch-empty">No steps</p>'}</section>`).join('')}</div>` : ''}</li>`).join('')}</ol>`
}

/** The steps in order; a path group's branches stack in a column to its right. */
export function canvas(graph: any, ctx: CanvasContext) {
  return `<section class="canvas" aria-label="Steps">${column(nodes(graph), ctx)}</section>`
}
