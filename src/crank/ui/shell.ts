import { esc } from './document'
import { icon } from './icons'
import { navigation } from './navigation'

/** How a screen sits in the shell: its breadcrumb, top-bar actions and header. */
export interface Page {
  /** Breadcrumb before the title, as [label, href]. */
  crumbs?: [string, string][]
  /** Top-bar controls beside the breadcrumb (Live, Test, Publish on the editor). */
  bar?: string
  /** Controls at the right of the page heading. */
  tools?: string
  /** One line under the heading. */
  intro?: string
  /** Waiting approvals, shown as the rail's badge. */
  approvals?: number
  /** The rail item this screen belongs to, when its title is not one. */
  section?: string
  /** The editor: three columns, its own heading and stylesheet. */
  editor?: boolean
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'
const shortName = (name: string) => { const [first, last] = name.split(/\s+/); return last ? `${first} ${last[0]}.` : first ?? name }

function topBar(title: string, actor: any, page: Page) {
  const crumbs = page.crumbs?.length ? `<nav class="crumbs" aria-label="Breadcrumb">${page.crumbs.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a><span aria-hidden="true">/</span>`).join('')}<strong aria-current="page">${esc(title)}</strong></nav>` : ''
  const person = actor ? `<a class="search control-tooltip" href="/app/runs#run-search" aria-label="Search runs" aria-describedby="search-tooltip"><span class="control-tooltip-label" role="tooltip" id="search-tooltip">Search runs</span>${icon('search')}</a><a class="person control-tooltip" href="/app/account" aria-describedby="account-tooltip" aria-label="${esc(actor.name)} · ${esc(actor.team?.role ?? actor.product_role ?? actor.role)}"><span class="control-tooltip-label" role="tooltip" id="account-tooltip">Your account</span><span class="avatar" aria-hidden="true">${esc(initials(actor.name ?? ''))}</span><span class="person-name">${esc(shortName(actor.name ?? ''))}<small>${esc(actor.team?.role ?? actor.product_role ?? actor.role)}</small></span></a>` : ''
  return `<header class="top-bar${page.bar ? ' has-bar' : ''}"><a class="lockup" href="/app" aria-label="Crank flows"><img src="/brand/mark.svg" alt="" width="44" height="44"><span data-rer-name>Crank</span></a>${crumbs}${page.bar ? `<div class="bar-actions">${page.bar}</div>` : ''}<div class="top-person">${person}</div></header>`
}

export function shell(title: string, content: string, actor: any, page: Page) {
  const heading = page.editor ? '' : `<div class="page-head"><div><h1>${esc(title)}</h1>${page.intro ? `<p class="page-intro">${page.intro}</p>` : ''}</div>${page.tools ? `<div class="page-tools">${page.tools}</div>` : ''}</div>`
  return `${topBar(title, actor, page)}<div class="app-frame${page.editor ? ' is-editor' : ''}">${actor ? navigation(title, actor.role === 'owner', page.approvals ?? 0, page.section) : ''}<main class="crank" id="main">${heading}${content}<footer class="app-footer">Crank · Published workflows run unattended; approval steps are optional</footer></main></div>`
}
