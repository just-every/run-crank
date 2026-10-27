import { workflowEstimateView } from '../usage'
import { validateGraph, type Graph } from '../../engine/graph'
import { completeGrant } from '../../team/policy'
import { customGatewayIds } from '../../custom/use-scope'
import { canonical } from '../../model'
import { action, chip, clock, esc, hidden, personName } from '../document'
import { renameOf, renamesBetween } from '../failure'
import { icon } from '../icons'
import type { Page } from '../shell'
import { canvas } from './canvas'
import { inspector } from './inspector'
import { changedPaths, findNode, flatten, mappingRows, mappingText, nodes, rowLabel, summaryOf, type Connection, type RunDetail, type Version } from './model'
import { runsStrip } from './runs'
import { restorePanel } from './restore'

export interface EditorData {
  triggerState?: any; workflow: any; current: Version | null; previous: Version | null; graphs: Map<string, Graph>; runs: RunDetail[]; connections: Connection[]
  today: { runs: number; failed: number; awaiting_approval: number }; tokens: any[]; actor: any; params: URLSearchParams; preview?: any; customPicker?:string; approvals: number; people: { id: string; name: string }[]
}

/** Field-level differences of each changed step between two versions. */
function changesPanel(current: Graph, previous: Version, changed: Set<string>, number: number) {
  const before = new Map(flatten(nodes(previous.graph)).map(n => [n.path, n]))
  const items = flatten(nodes(current)).filter(n => changed.has(n.path)).map(node => {
    const old = before.get(node.path), rows = (n: typeof node | undefined) => new Map(n?.step ? mappingRows({ ...n.step, id: undefined, type: undefined, name: undefined, branches: undefined, fallback: undefined, always: undefined, ...(n.step.type === 'paths' ? { when: (n.step.branches as any[]).map(b => b.when) } : {}) }).filter(([k]) => k) : [])
    const a = rows(old), b = rows(node), keys = [...new Set([...a.keys(), ...b.keys()])].filter(k => canonical(a.get(k)) !== canonical(b.get(k)))
    return `<li><strong>${esc(summaryOf(node))}</strong>${keys.map(k => `<div class="diff-row"><span class="field-key" title="${esc(k)}">${esc(rowLabel(k))}</span>${a.has(k) ? `<code class="diff-old">− ${esc(mappingText(a.get(k)))}</code>` : ''}${b.has(k) ? `<code class="diff-new">+ ${esc(mappingText(b.get(k)))}</code>` : ''}</div>`).join('') || '<p class="muted">Changed outside its fields.</p>'}</li>`
  })
  return `<section class="panel changes" id="changes" aria-labelledby="changes-title"><div class="changes-head"><h2 id="changes-title">${icon('diff')}Version ${number} changes</h2><a class="btn btn-secondary btn-small" href="?">Close</a></div><p class="muted">Compared with version ${previous.number}, published ${clock(previous.published_at)}. Undo puts version ${previous.number} back in the draft; publish it to make it live.</p><ul class="diff-list">${items.join('') || '<li class="muted">No step changed.</li>'}</ul></section>`
}

/** The agents card: the live version's change in words (with View changes and Undo), what runs on
 * it have done since, and the agent credentials. Crank runs no model; agents are outside programs. */
function agentCard(d: EditorData, changed: Set<string>, undo: string) {
  const agents = d.tokens.filter(t => t.scope === 'agent'), current = d.current, previous = d.previous
  let change = ''
  if (current && previous) {
    const renames = renamesBetween(previous.graph, current.graph, changed), since = d.runs.filter(r => r.version?.number === current.number)
    const counts = [['succeeded', 'succeeded'], ['awaiting_approval', 'waiting for approval'], ['failed', 'failed']].map(([status, words]) => [since.filter(r => r.status === status).length, words] as const).filter(([n]) => n)
    change = `<div class="agent-change"><p class="agent-line">${icon('diff')}<span><strong>Version ${current.number}</strong> published ${clock(current.published_at)} by ${esc(personName(d.people, current.published_by))}${renames.length ? `: reads ${renames.map(r => `<code>${esc(r.to)}</code> where version ${previous.number} read <code>${esc(r.from)}</code>, in ${r.steps} step${r.steps === 1 ? '' : 's'}`).join('; ')}.` : `: ${changed.size} step${changed.size === 1 ? '' : 's'} changed from version ${previous.number}.`}</span></p>
      ${renames.map(r => `<div class="diff-pair"><code class="diff-old">− ${esc(r.from)}</code><code class="diff-new">+ ${esc(r.to)}</code></div>`).join('')}
      ${since.length ? `<p class="agent-since">The latest ${since.length === 1 ? 'run' : `${since.length} runs`} on version ${current.number}: ${counts.map(([n, words]) => `${n} ${words}`).join(', ')}.</p>` : ''}
      <div class="agent-actions"><a class="btn btn-secondary btn-small" href="?changes=1#changes">View changes</a>${undo}</div></div>`
  }
  return `<section class="panel agent-card" aria-labelledby="agent-title"><h2 id="agent-title">${icon('spark')}Agents</h2>${change}<p class="agent-note">Agents with an Access credential draft changes and start runs; an owner publishes.</p><ul class="agent-list">${agents.length ? agents.map(t => `<li>${icon('key')}<span>${esc(t.label)}</span>${chip(t.revoked_at ? 'revoked' : 'active', t.revoked_at ? 'Revoked' : 'Active')}</li>`).join('') : '<li class="muted">No agent credentials yet.</li>'}</ul><a class="agent-link" href="/app/access">Manage agent credentials ${icon('chevron')}</a></section>`
}

export function editorView(d: EditorData): { content: string; page: Page } {
  const wf = d.workflow, graph = wf.draft as Graph, owner = d.actor.role === 'owner'
  const draftAccounts = [...validateGraph(graph).declared.connections, ...customGatewayIds(graph).map(id => 'gateway:' + id)]
  const liveAuthority = wf.versions.find((v:any)=>v.id===wf.published_version_id)?.authority
  const liveAccounts = [...(liveAuthority?.connections ?? []), ...(liveAuthority?.gateways ?? []).map((id:string)=>'gateway:' + id)]
  const canPrepare = d.actor.team ? !!completeGrant(d.actor,'prepare',wf.id) : ['owner','admin'].includes(d.actor.role)
  const canPublish = d.actor.team ? !!completeGrant(d.actor,'publish',wf.id,draftAccounts) : owner
  const canStart = d.actor.team ? !!completeGrant(d.actor,'start',wf.id,liveAccounts) : ['owner','admin'].includes(d.actor.role)
  const all = flatten(nodes(graph)), requested = d.params.get('step') ?? '', fallback = all.at(-1)!.path
  const node = findNode(graph, requested) ?? findNode(graph, fallback)!
  const tab = ['setup', 'data', 'test'].includes(d.params.get('tab') ?? '') ? d.params.get('tab')! : d.preview ? 'test' : 'setup'
  const changed = d.current && d.previous ? changedPaths(d.current.graph, d.previous.graph) : new Set<string>()
  const unpublished = !d.current || canonical(d.current.graph) !== canonical(graph)
  const q = d.params.get('q') ?? '', status = d.params.get('status') ?? ''
  const query = `${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`
  const sample = d.runs[0]?.trigger !== undefined ? JSON.stringify(d.runs[0].trigger, null, 2) : '{}'

  const live = wf.status === 'published' ? ['Live', 'live'] : wf.status === 'paused' ? ['Paused', 'paused'] : ['Draft', 'draft']
  const liveControl = owner && !wf.restore && wf.published_version_id
    ? `<details class="menu live-menu"><summary class="pill" data-state="${live[1]}"><span class="pill-dot"></span>${live[0]}${icon('down')}</summary><div class="menu-body">${action(`/api/crank/workflows/${wf.id}/${wf.status === 'paused' ? 'resume' : 'pause'}`, wf.status === 'paused' ? 'Resume flow' : 'Pause flow', { return_to: `/app/workflows/${wf.id}` }, 'secondary')}<p>${wf.status === 'paused' ? 'New events are held for review while paused.' : 'Pausing holds new events for review.'}</p></div></details>`
    : `<span class="pill" data-state="${live[1]}"><span class="pill-dot"></span>${live[0]}</span>`
  const bar = `${liveControl}${canPrepare ? `<a class="btn btn-secondary" href="?step=${encodeURIComponent(node.path)}&amp;tab=test">Test</a>` : ''}${canStart && wf.status === 'published' && graph.trigger.type === 'manual' ? `<details class="menu run-menu"><summary class="btn btn-secondary">Run now</summary><div class="menu-body"><form method="post" action="/app/action">${hidden('path', `/api/crank/workflows/${wf.id}/run`)}<label>Run input (JSON object)<textarea name="input" rows="4" spellcheck="false" required>{}</textarea></label><button class="btn btn-primary">Start run</button></form></div></details>` : ''}${canPublish && (!wf.restore || owner) ? (wf.restore ? '<a class="btn btn-secondary" href="#restore-review">Review restore</a>' : unpublished ? action(`/api/crank/workflows/${wf.id}/publish`, 'Publish', { return_to: `/app/workflows/${wf.id}` }) : '<button class="btn btn-primary" disabled title="The draft matches the live version">Published</button>') : ''}`

  const undo = (small = false) => d.previous && canPrepare ? action(`/api/crank/workflows/${wf.id}/draft`, 'Undo', { graph: JSON.stringify(d.previous.graph), return_to: `/app/workflows/${wf.id}` }, 'secondary', small ? 'btn-undo btn-small' : 'btn-undo') : ''
  const tools = `${d.previous ? `<a class="btn btn-secondary" href="?changes=1#changes">View changes</a>` : ''}${undo()}`
  // A step is repaired when a run of an older version failed on a field there that the live version now reads under its new name.
  const repaired = new Set(d.runs.filter(r => d.current && r.version?.number !== d.current.number).flatMap(r => r.steps.filter(s => s.status === 'failed' && changed.has(s.path) && renameOf(s.error, s.path, d.current)).map(s => s.path)))
  const head = `<div class="editor-head"><div class="editor-title"><h1>${esc(wf.name)}</h1>${unpublished && d.current ? chip('pending', 'Unpublished changes') : ''}${!d.current ? chip('draft', 'Draft') : ''}</div><div class="page-tools">${tools}</div>${wf.description ? `<p class="page-intro">${esc(wf.description)}</p>` : ''}</div>${wf.poll_rate?.warning ? `<p class="notice" role="alert">${esc(wf.poll_rate.warning)}</p>` : ''}`
  const changes = d.params.get('changes') && d.current && d.previous ? changesPanel(d.current.graph, d.previous, changed, d.current.number) : ''
  const strip = runsStrip({ workflowId: wf.id, runs: d.runs, graphs: d.graphs, current: graph, live: d.current, connections: d.connections, today: d.today, q, status, selected: node.path })
  const content = `<div class="editor"><div class="editor-main">${head}${owner ? restorePanel(wf) + workflowEstimateView(wf, wf.estimate) : ''}${changes}${canvas(graph, { workflowId: wf.id, connections: d.connections, runs: d.runs, selected: node.path, repaired, changedIn: d.current?.number ?? null, query })}${strip}</div><div class="editor-side">${inspector({ triggerState: d.triggerState, workflowId: wf.id, graph, live: d.current, node, tab, connections: d.connections, runs: d.runs, hooks: wf.hooks ?? [], canPrepare, preview: d.preview, sample, now: Date.now(), people: d.people })}${d.customPicker??''}${agentCard(d, changed, undo(true))}</div></div>`
  return { content, page: { editor: true, crumbs: [['Flows', '/app']], bar, approvals: d.approvals, section: 'Flows' } }
}
