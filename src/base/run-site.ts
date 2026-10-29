import { iconHead } from './icon-head'
import { RUN_CHOOSER } from './run-chooser-style'
// The run site's shared pages: the three-way Run chooser, a composed homepage for
// seeds without an approved one (Base's references), and the not-found page.
// /contract is in contract-page.ts, built from the same document and header.
// They are static HTML strings for `rer build --site`; the seed's site entry
// renders them with its own RunData and edition identity, and a seed with an
// approved homepage renders that page instead of siteHomeHtml.
// Visual authority: the 12ui Run page picks.
// This file is copied unchanged to src/base by both maintained exporters.
import { checkIdentity, type EditionIdentity } from './identity'
import { ink } from './theme-frame'
import type { SiteHosting } from './hosting-page'
import type { SeedContract } from './seed-contract.mjs'

/** Every Run page string and command for one seed. */
export interface RunData {
  /** The seed's name: "Cradle". */
  name: string
  /** The public source repository: "https://github.com/just-every/cradle". */
  repository: string
  /**
   * The start line for someone who already has Node 22 or later:
   * "npx -y @runeditrun/rer dev just-every/cradle". The Run page's one line is
   * the same `dev just-every/cradle` handed to the installer (startLine).
   */
  clone: string
  /** "MIT". */
  licence: string
  /** Whether the run site carries /docs. */
  docs: boolean
  paths: RunPaths
  /** The one price per paid door and their shared label, used by PATHS. */
  pricing: { assisted: string; managed: string; note: string }
}
export interface RunPaths {
  /** The app listing id; null holds both paid doors closed. */
  product: string | null
  requirementsExtra?: string
  assisted?: { open?: boolean }
  managed?: { open?: boolean }
}

const npxStart = 'npx -y @runeditrun/rer '
const repoStart = `${npxStart}dev `
// GitHub repository ids: up to 39 owner characters with single internal
// hyphens, and up to 100 repository characters (excluding dot directories).
const repositoryId = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
// Escape independently of validation; repository ids need no escaping in POSIX shells.
const shellArgument = (value: string) => /[^A-Za-z0-9_./-]/.test(value) ? `'${value.replaceAll("'", "'\"'\"'")}'` : value
/**
 * The one line on every Run page, homepage snippet and getting-started page: the
 * installer (which brings its own Node when there is none) installs rer, then
 * runs `rer dev <owner>/<repo>` in the same line.
 */
export const startLine = (run: RunData) => {
  checkRunData(run)
  return PATHS.self.command(run.clone.slice(repoStart.length))
}
/** The one requirements sentence: rer clones with git; the installer brings Node and rer the pinned pnpm. */
export const runRequirements = 'git is required; rer brings Node and pnpm.'

export const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

/** Chooser copy and destinations, reading prices from RunData; shared with /docs/hosting. */
export const PATHS = {
  title: (n: string) => `Run ${n}`,
  heading: (n: string) => `Run ${n}.`,
  meta: (n: string) => `Three ways to run ${n}: on your own computer, Assisted or Managed.`,
  self: {
    badge: '100% free', title: 'Run it yourself',
    body: (n: string) => `One line in your terminal gets ${n} running on your computer, with you as its owner.`,
    command: (repo: string) => `curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev ${shellArgument(repo)}`,
    copy: { idle: 'Copy', done: 'Copied', ms: 1600 },
    alt: 'Have Node 22 or later?',
    requirements: `macOS, Linux or Windows with WSL2. ${runRequirements}`,
    email: 'This free copy runs only on your computer: nobody else can open it, and it sends no email until you set up a mail provider.',
    guide: { label: 'Walk me through it', href: '/docs/getting-started' },
    start: 'You paste the line',
    steps: (n: string) => ['rer installs itself', `Gets ${n}`, 'Sets up its database', `Starts ${n} and prints a link that signs you in`],
    pasteTitle: 'Now paste it into your terminal.', note: 'A first start takes a few minutes.',
  },
  assisted: { title: 'Assisted', lead: 'We set it up with you and keep it updated.',
    rest: 'It stays yours, on your computer or your own cloud.', price: (run: RunData) => run.pricing.assisted, action: 'Set it up with us' },
  managed: { title: 'Managed', lead: 'We run it for you.',
    rest: 'Nothing to install.', price: (run: RunData) => run.pricing.managed, action: 'Have us run it' },
  entry: (plan: 'assisted' | 'managed', product: string) =>
    `https://app.runeditrun.com/?${new URLSearchParams({ product, plan })}`,
  closed: { chip: 'By request', line: 'For now, sign-ups are by request.', action: 'Request access' },
  signups: 'request' as 'request' | 'app',
  priceNote: (run: RunData) => run.pricing.note,
  business: { lead: 'Setting up several tools?', action: 'Set up your business once',
    href: 'https://app.runeditrun.com/business' },
  facts: { source: 'Source:', licence: 'license' },
}

export function checkRunData(run: RunData): RunData {
  if (!run || typeof run !== 'object' || !run.paths || typeof run.paths !== 'object' || Array.isArray(run.paths)
      || 'hosted' in run || 'requirements' in run) throw new Error('Run data needs paths; migrate the old RunData to paths.')
  for (const key of ['name', 'clone', 'licence'] as const) if (typeof run[key] !== 'string' || !run[key].trim()) throw new Error(`Run data needs ${key}.`)
  const repo = run.clone.slice(repoStart.length)
  if (!run.clone.startsWith(repoStart) || repositoryId.exec(repo)?.[0] !== repo) throw new Error(`Run data clone must be ${repoStart}<owner>/<repo> with a valid repository id.`)
  if (!/^https:\/\/[^\s"<>]+$/.test(run.repository)) throw new Error('Run data repository is an https URL.')
  if (typeof run.docs !== 'boolean') throw new Error('Run data declares docs.')
  for (const key of ['assisted', 'managed', 'note'] as const) {
    if (typeof run.pricing?.[key] !== 'string' || !run.pricing[key].trim()) throw new Error(`Run data needs pricing.${key}.`)
  }
  const { product, requirementsExtra } = run.paths
  if (product !== null && (typeof product !== 'string' || /^[a-z0-9][a-z0-9-]*$/.exec(product)?.[0] !== product)) throw new Error('Run data paths.product is a listing id or null.')
  if (requirementsExtra !== undefined && (typeof requirementsExtra !== 'string' || !requirementsExtra.trim() || /free|\$0/i.test(requirementsExtra))) throw new Error('Run data paths.requirementsExtra is a sentence without free or $0.')
  for (const id of ['assisted', 'managed'] as const) {
    const door = run.paths[id]
    if (door !== undefined && (!door || typeof door !== 'object' || Array.isArray(door) || Object.keys(door).some(key => key !== 'open') || door.open !== undefined && typeof door.open !== 'boolean')) throw new Error(`Run data paths.${id} is { open?: boolean }.`)
  }
  return run
}

// Shared by the three pages: tokens from the seed's rer-theme.css, readable
// neutrals when it cannot load, the header and the floor art.
const BASE = '*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}'
  + 'body{--art:max(26vh,150px);--site-ink:var(--rer-text,#172033);--site-body:var(--rer-muted,#475569);--site-accent:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)));--site-accent-ink:var(--rer-accent-text,var(--rer-brand-accent-text,var(--rer-surface,#fff)));'
  + '--site-line:color-mix(in srgb,var(--rer-border,#64748b) 28%,transparent);--site-mono:var(--rer-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);'
  + 'margin:0;min-height:100vh;min-height:100dvh;position:relative;overflow-x:clip;background:var(--rer-page,#f3f5f8);color:var(--site-ink);font:400 17px/1.55 var(--rer-font-body,system-ui,sans-serif);-webkit-font-smoothing:antialiased}'
  + 'h1,h2,p,ol{margin:0;padding:0}ol{list-style:none}a{color:inherit;text-decoration:none}'
  + 'a:focus-visible,button:focus-visible{outline:3px solid var(--rer-focus,var(--site-ink));outline-offset:3px;border-radius:8px}'
  + '.art{position:absolute;left:0;right:0;bottom:0;height:var(--art);pointer-events:none;z-index:0}.art img{width:100%;height:100%;display:block;object-fit:cover;object-position:center bottom}'
  + '.bar,main{position:relative;z-index:1}.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;max-width:1440px;margin:0 auto;padding:26px 56px 0}'
  + '.brand{display:inline-flex;align-items:center;gap:12px;font:600 28px/1 var(--rer-font-heading,var(--rer-font-body,inherit));font-weight:var(--rer-wordmark-weight,600);letter-spacing:var(--rer-wordmark-tracking,-.02em);color:var(--site-ink)}.brand img{width:40px;height:40px}'
  // The brand takes only its narrowest width when deciding whether the nav still fits beside it, so a long name wraps the nav onto its own row instead of pushing it past the viewport.
  + '.bar .brand{flex:1 1 0;max-width:max-content}.bar nav{display:flex;flex-wrap:wrap;gap:36px;font-weight:500;font-size:16px}.bar nav a:hover,.bar nav a[aria-current=page]{text-decoration:underline;text-underline-offset:4px}.bar nav a[aria-current=page]{text-decoration-color:var(--site-accent);text-decoration-thickness:2px}'
  + 'h1{font:600 64px/1.08 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.03em;color:var(--site-ink);text-wrap:balance}'
  + '.sub{margin-top:24px;color:var(--site-body);font-size:21px;text-wrap:pretty}'
  + '@media(max-width:760px){body{font-size:16px;--art:180px}.bar{padding:18px 16px 0}.brand{font-size:23px;gap:9px}.brand img{width:32px;height:32px}.bar nav{gap:22px;font-size:15px}.bar nav a{min-height:24px}h1{font-size:38px;line-height:1.12}.sub{font-size:16.5px;margin-top:16px}}'

const HOME = 'main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px);text-align:center}.hero{padding-top:18vh;display:flex;flex-direction:column;align-items:center}.hero h1{max-width:20ch}.hero .sub{max-width:640px}'
  + '.actions{margin-top:40px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:16px 28px}'
  + '.btn{display:inline-flex;align-items:center;justify-content:center;gap:14px;min-height:58px;padding:0 32px;border-radius:var(--rer-button-radius,999px);'
  + 'background:linear-gradient(180deg,color-mix(in srgb,var(--site-accent) 90%,white),var(--site-accent));color:var(--site-accent-ink);font-size:19px;font-weight:600;'
  + 'box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 14px 28px -16px color-mix(in srgb,var(--site-ink) 70%,transparent)}.btn svg{width:19px;height:19px}'
  + '.link{font-weight:500;text-decoration:underline;text-underline-offset:4px}'
  + '@media(max-width:760px){main{padding:0 16px calc(var(--art) + 40px)}.hero{padding-top:96px}.btn{min-height:56px;font-size:18px}}'

const COPY_SCRIPT = `const words=${JSON.stringify(PATHS.self.copy)};
document.querySelectorAll('.copy').forEach(button=>{button.hidden=false});
document.addEventListener('click',async event=>{
  const button=event.target.closest('.copy');if(!button)return;
  try{await navigator.clipboard.writeText(button.dataset.copy)}catch{return}
  clearTimeout(button.copyTimer);
  button.querySelector('span').textContent=words.done;button.dataset.copied='true';
  const card=button.closest('.self');card.dataset.copied='true';
  card.querySelector('[role=status]').textContent=words.done;
  button.copyTimer=setTimeout(()=>{button.querySelector('span').textContent=words.idle;delete button.dataset.copied},words.ms);
})`
const ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>'

/**
 * A seed's approved homepage header, so every page of its run site wears the one header: `html` as the homepage
 * renders it (marking the current page as that header does) and `styles`, the stylesheets that style it (the
 * `styles` sitePages receives). Without one, the pages carry Base's header, the one Base's own homepage carries.
 */
export interface HomepageHeader { html: string; styles: string[] }

export function document(identity: EditionIdentity, title: string, description: string, style: string, body: string, script = '', styles: string[] = [], head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${escape(title)}</title><meta name="description" content="${escape(description)}">`
    + `${iconHead}${identity.fonts ? `<link rel="stylesheet" href="${escape(identity.fonts)}">` : ''}<link rel="stylesheet" href="${escape(identity.theme)}"><style>${identity.accentColor ? `:root{--rer-brand-accent:${identity.accentColor};--rer-brand-accent-text:${ink(identity.accentColor)}}` : ''}${BASE}${style}</style>`
    + `${styles.map(href => `<link rel="stylesheet" href="${escape(href)}">`).join('')}</head>`
    + `<body>${identity.band ? `<div class="art" aria-hidden="true"><img src="${escape(identity.band)}" alt=""></div>` : ''}${body}${script ? `<script>${script}</script>` : ''}</body></html>`
}
/** Docs, Roadmap and Source: Docs when the site has /docs, Roadmap (/contract) when the seed has a CONTRACT.md. */
export function siteLinks(run: RunData, contract: SeedContract | undefined, current?: 'contract'): string {
  return `${run.docs ? '<a href="/docs">Docs</a>' : ''}${contract ? `<a href="/contract"${current === 'contract' ? ' aria-current="page"' : ''}>Roadmap</a>` : ''}<a href="${escape(run.repository)}">Source</a>`
}
export function header(identity: EditionIdentity, run: RunData, contract?: SeedContract, current?: 'contract'): string {
  return `<header class="bar"><a class="brand" href="/"><img src="${escape(identity.mark)}" alt="" width="40" height="40"><span>${escape(identity.product)}</span></a>`
    + `<nav aria-label="Site">${siteLinks(run, contract, current)}</nav></header>`
}
// The one-line alternative can break only before the repository; keep plain spaces for copying.
const inlineStart = (run: RunData) => `<code><span class="code-word">${escape(npxStart)}dev</span> <span class="code-word">${escape(run.clone.slice(repoStart.length))}</span></code>`
// Preserve install.sh | sh as one code word at narrow widths (also the one line on /docs/hosting).
export const pipelines = (line: string) => escape(line).replace(/[^\s/]+(?: \| \S+)+/g, words => `<span class="code-word">${words}</span>`).replace('https://runeditrun.com/', 'https://runeditrun.com/<wbr>').replace(/ ([^ ]+)$/, ' <span class="code-repo">$1</span>')
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>'
const codeBlock = (command: string, label: string) => `<div class="code"><pre aria-label="${escape(label)}"><code>${pipelines(command)}</code></pre>`
  + `<button class="copy" type="button" data-copy="${escape(command)}" hidden>${TICK}<span>${escape(PATHS.self.copy.idle)}</span></button><span class="sr-only" role="status" aria-live="polite"></span></div>`
const action = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}${ARROW}</a>`

/** The one chooser template on every seed's /run. */
export function runPageHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract, homepage?: HomepageHeader): string {
  checkIdentity(identity); checkRunData(run)
  const repo = run.clone.slice(repoStart.length), slug = repo.split('/').at(-1)!.replace(/^run-/, '')
  const product = run.paths.product ?? `run-${slug}`, self = PATHS.self, steps = self.steps(run.name)
  const stops = (labels: string[], numbered = false) => `<ol class="${numbered ? 'paste-stops' : 'timeline-stops'}">${labels.map((label, i) => `<li><span class="stop" aria-hidden="true">${numbered ? i + 1 : i === labels.length - 1 ? TICK : ''}</span><span class="stop-label">${escape(label)}</span></li>`).join('')}</ol>`
  const doors = (['assisted', 'managed'] as const).map(id => {
    const path = PATHS[id], closed = PATHS.signups === 'request' || run.paths.product === null || run.paths[id]?.open === false
    return `<section class="door ${id}" aria-labelledby="${id}"><div class="door-heading"><h2 id="${id}">${escape(path.title)}</h2>${closed ? `<span class="chip">${escape(PATHS.closed.chip)}</span>` : ''}</div>`
      + `<p class="door-body">${escape(path.lead + ' ' + (closed ? PATHS.closed.line : path.rest))}</p><p class="price">${escape(path.price(run))} · ${escape(PATHS.priceNote(run))}</p><p class="door-action">${action(PATHS.entry(id, product), closed ? PATHS.closed.action : path.action)}</p></section>`
  }).join('')
  const body = `${homepage?.html ?? header(identity, run, contract)}<main><div class="intro"><h1>${escape(PATHS.heading(run.name))}</h1></div><div class="chooser">`
    + `<section class="self" aria-labelledby="self"><div class="self-heading"><span class="badge">${escape(self.badge)}</span><h2 id="self">${escape(self.title)}</h2><p class="self-body">${escape(self.body(run.name))}</p></div>`
    + codeBlock(startLine(run), self.title)
    + `<section class="paste-panel" aria-labelledby="paste-title"><h3 id="paste-title">${escape(self.pasteTitle)}</h3><div class="paste-track">${stops(steps, true)}<p class="track-note">${escape(self.note)}</p></div></section>`
    + `<details class="other-ways"><summary>Other ways to run locally</summary><p class="alt"><span>${escape(self.alt)}</span>${inlineStart(run)}</p><div class="alt"><span>To install rer separately:</span><pre><code>curl -fsSL https://runeditrun.com/install.sh | sh</code></pre><span>Then run:</span><pre><code>$HOME/.local/bin/rer dev ${escape(repo)}</code></pre></div><p class="alt"><span>Optional, for future terminals: add <code>$HOME/.local/bin</code> to your shell’s PATH. The one-line launch above already finds rer for this run; you can do this later.</span></p></details><p class="requirements">${escape(self.requirements)}${run.paths.requirementsExtra ? ' ' + escape(run.paths.requirementsExtra) : ''}</p><p class="email-note">${escape(self.email)}</p>`
    + `<div class="timeline">${stops([self.start, ...steps])}<span class="track-divider" aria-hidden="true"></span><p class="track-note">${escape(self.note)}</p></div>`
    + (run.docs ? `<p class="guide">${action(self.guide.href, self.guide.label)}</p>` : '')
    + `</section><div class="doors">${doors}</div><div class="quiet"><p>${escape(PATHS.business.lead)} ${action(PATHS.business.href, PATHS.business.action)}</p></div>`
    + `<footer class="facts"><p>${escape(PATHS.facts.source)} <a href="${escape(run.repository)}">${escape(run.repository.replace(/^https:\/\//, ''))}</a> · ${escape(run.licence)} ${escape(PATHS.facts.licence)}</p></footer></div></main>`
  return document(identity, PATHS.title(run.name), PATHS.meta(run.name), RUN_CHOOSER, body, COPY_SCRIPT, homepage?.styles)
}

/** Base's composed homepage for a seed without an approved one: its primary action is Run <Seed>. */
export function siteHomeHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  const body = `${header(identity, run, contract)}<main><div class="hero"><h1>${escape(identity.tagline)}</h1><p class="sub">100% free and open source.</p>`
    + `<div class="actions"><a class="btn" href="/run">Run ${escape(identity.product)}${ARROW}</a>${run.docs ? '<a class="link" href="/docs">Read the docs</a>' : ''}</div></div></main>`
  return document(identity, identity.product, identity.tagline, HOME, body)
}

/**
 * A docs page that moved, for a static host with no redirect rules: it sends the
 * browser on to `to` at once and links it for anyone it does not. The seed's
 * site entry serves it at /docs/install with to = '/docs/getting-started'
 * whenever its docs have no install page of their own.
 */
export function docsMovedHtml(identity: EditionIdentity, run: RunData, to: string, title: string, contract?: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  if (!/^\/docs\/[a-z0-9-]+$/.test(to)) throw new Error('A moved docs page points to /docs/<slug>.')
  const body = `${header(identity, run, contract)}<main><div class="hero"><h1>${escape(title)}</h1><p class="sub">This page moved.</p><div class="actions"><a class="btn" href="${to}">${escape(title)}${ARROW}</a></div></div></main>`
  return document(identity, `${title} · ${identity.product}`, identity.tagline, HOME, body, '', [], `<meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}">`)
}

/** 404.html: the static host serves it for every path the site does not have. */
export function siteNotFoundHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract, homepage?: HomepageHeader): string {
  checkIdentity(identity); checkRunData(run)
  const body = `${homepage?.html ?? header(identity, run, contract)}<main><div class="hero"><h1>Page not found</h1><p class="sub">This page is not part of the ${escape(identity.product)} site.</p><div class="actions"><a class="link" href="/">Go to the homepage</a></div></div></main>`
  return document(identity, `Not found · ${identity.product}`, identity.tagline, HOME, body, '', homepage?.styles)
}

/** What a seed's site entry returns: each page by path, and the public files they use. */
export interface SiteBuild {
 pages: { path: string; html: string }[]; assets: string[];
 /** Sections from the same render, using its published heading ids. */
 searchPages?: { href: string; searchSections: { anchor: string; titlePath: string[]; text: string }[] }[];
}

/**
 * What `rer build --site` passes to sitePages(): `styles`, the site paths of the
 * stylesheets the entry's CSS imports compiled to (empty when it imports none).
 * A page whose components import CSS links them in its head. `clients` maps
 * each declared island name to its bundled module URL; `styles` also includes
 * the client entries' compiled stylesheets. `contract` is the seed's
 * CONTRACT.md as parseContract reads it, absent when the seed has none; rer
 * stops the build, naming the line, when it does not parse. The entry renders
 * it at /contract with contractPageHtml and passes it to the other pages.
 * `hosting` is what rer read from the seed's deploy, setup and mail
 * declarations for /docs/hosting (hostingPageHtml): null when the seed does
 * not deploy to Workers from them.
 */
export interface SiteContext { styles: string[]; clients: Record<string, string>; contract?: SeedContract; hosting?: SiteHosting | null }
