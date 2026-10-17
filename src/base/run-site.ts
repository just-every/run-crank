// The run site's shared pages: the Run page (Direction A: centred headline, two
// stacked step cards, the facts under them), a small composed homepage for
// seeds without an approved one (Base's references), and the not-found page.
// /contract is in contract-page.ts, built from the same document and header.
// They are static HTML strings for `rer build --site`; the seed's site entry
// renders them with its own RunData and edition identity, and a seed with an
// approved homepage renders that page instead of siteHomeHtml.
// Visual authority: the 12ui Run page picks.
// This file is copied unchanged to src/base by both maintained exporters.
import { checkIdentity, type EditionIdentity } from './identity'
import { ink } from './theme-frame'
import type { SeedContract } from './seed-contract.mjs'

/** Every Run page string and command for one seed. */
export interface RunData {
  /** The seed's name: "Cradle". */
  name: string
  /** The public source repository: "https://github.com/just-every/cradle". */
  repository: string
  /**
   * The start line for someone who already has Node 22 or later:
   * "npx -y @runeditrun/rer dev just-every/cradle". The Run page's step 2 is the
   * same command without npx ("rer dev just-every/cradle"), which runs on what
   * the installer in step 1 gives and nothing else.
   */
  clone: string
  /** The folder the start line clones into, where `rer dev` restarts it: "cradle". */
  folder: string
  /** Platforms and tools: "Runs on macOS, Linux or Windows with WSL2, with git. The installer brings Node when it is missing, and rer brings pnpm." */
  requirements: string
  /** "MIT". */
  licence: string
  /** Whether the run site carries /docs. */
  docs: boolean
  /** Hosted options, shown as cards under the steps. Empty until hosting opens. */
  hosted: HostedOption[]
}
export interface HostedOption { title: string; body: string; href: string; action: string }

/** Step 1 of every Run page: the installer, which brings its own Node when there is none. */
export const installRer = 'curl -fsSL https://runeditrun.com/install.sh | sh'
const npxStart = 'npx -y @runeditrun/rer '
/** Step 2: the clone line run by the rer the installer put in ~/.local/bin, not by npx. */
const rerStart = (run: RunData) => `rer ${run.clone.slice(npxStart.length)}`

export const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

export function checkRunData(run: RunData): RunData {
  for (const key of ['name', 'clone', 'folder', 'requirements', 'licence'] as const) if (typeof run[key] !== 'string' || !run[key].trim()) throw new Error(`Run data needs ${key}.`)
  if (!run.clone.startsWith(`${npxStart}dev `)) throw new Error(`Run data clone is the npx start line: ${npxStart}dev <owner>/<repo>.`)
  if (!/^https:\/\/[^\s"<>]+$/.test(run.repository)) throw new Error('Run data repository is an https URL.')
  if (!/^[A-Za-z0-9._/-]+$/.test(run.folder) || run.folder.split('/').some(part => !part || part === '..')) throw new Error('Run data folder is a relative folder.')
  if (typeof run.docs !== 'boolean' || !Array.isArray(run.hosted)) throw new Error('Run data declares docs and hosted.')
  for (const option of run.hosted) if (!option?.title || !option.body || !option.action || !/^https:\/\//.test(option.href)) throw new Error('A hosted option has a title, body, action and https link.')
  return run
}

// Shared by the three pages: tokens from the seed's rer-theme.css, readable
// neutrals when it cannot load, the header and the floor art.
const BASE = '*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}'
  + 'body{--art:max(26vh,150px);--site-ink:var(--rer-text,#172033);--site-body:var(--rer-muted,#475569);--site-accent:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)));--site-accent-ink:var(--rer-accent-text,var(--rer-brand-accent-text,var(--rer-surface,#fff)));'
  + '--site-line:color-mix(in srgb,var(--rer-border,#64748b) 28%,transparent);--site-mono:var(--rer-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);'
  + 'margin:0;min-height:100vh;min-height:100dvh;position:relative;overflow-x:clip;background:radial-gradient(120% 80% at 18% -12%,rgba(255,255,255,.75),transparent 58%),var(--rer-page,#f3f5f8);color:var(--site-ink);font:400 17px/1.55 var(--rer-font-body,system-ui,sans-serif);-webkit-font-smoothing:antialiased}'
  + 'h1,h2,p,ol{margin:0;padding:0}ol{list-style:none}a{color:inherit;text-decoration:none}'
  + 'a:focus-visible,button:focus-visible{outline:3px solid var(--rer-focus,var(--site-ink));outline-offset:3px;border-radius:8px}'
  + '.art{position:absolute;left:0;right:0;bottom:0;height:var(--art);pointer-events:none;z-index:0}.art img{width:100%;height:100%;display:block;object-fit:cover;object-position:center bottom}'
  + '.bar,main{position:relative;z-index:1}.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:1360px;margin:0 auto;padding:26px 56px 0}'
  + '.brand{display:inline-flex;align-items:center;gap:12px;font:600 28px/1 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:var(--rer-wordmark-tracking,-.02em);color:var(--site-ink)}.brand img{width:40px;height:40px}'
  + '.bar nav{display:flex;gap:36px;font-weight:500;font-size:16px}.bar nav a:hover{text-decoration:underline;text-underline-offset:4px}'
  + 'h1{font:600 64px/1.08 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.03em;color:var(--site-ink);text-wrap:balance}'
  + '.sub{margin-top:24px;color:var(--site-body);font-size:21px;text-wrap:pretty}'
  + '@media(max-width:760px){body{font-size:16px;--art:180px}.bar{padding:18px 16px 0}.brand{font-size:23px;gap:9px}.brand img{width:32px;height:32px}.bar nav{gap:22px;font-size:15px}h1{font-size:38px;line-height:1.12}.sub{font-size:16.5px;margin-top:16px}}'

const HOME = 'main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px);text-align:center}.hero{padding-top:18vh;display:flex;flex-direction:column;align-items:center}.hero h1{max-width:20ch}.hero .sub{max-width:640px}'
  + '.actions{margin-top:40px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:16px 28px}'
  + '.btn{display:inline-flex;align-items:center;justify-content:center;gap:14px;min-height:58px;padding:0 32px;border-radius:var(--rer-button-radius,999px);'
  + 'background:linear-gradient(180deg,color-mix(in srgb,var(--site-accent) 90%,white),var(--site-accent));color:var(--site-accent-ink);font-size:19px;font-weight:600;'
  + 'box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 14px 28px -16px color-mix(in srgb,var(--site-ink) 70%,transparent)}.btn svg{width:19px;height:19px}'
  + '.link{font-weight:500;text-decoration:underline;text-underline-offset:4px}'
  + '@media(max-width:760px){main{padding:0 16px calc(var(--art) + 40px)}.hero{padding-top:96px}.btn{min-height:56px;font-size:18px}}'

const RUN = 'body{--art:max(20vh,150px)}main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px)}.intro{text-align:center;padding-top:36px}.intro h1{font-size:58px}.intro .sub{margin-inline:auto;max-width:760px;margin-top:20px}'
  + '.steps{max-width:990px;margin:34px auto 0;display:grid;gap:18px}'
  + '.step{position:relative;display:grid;grid-template-columns:62px 1fr;gap:0 32px;padding:24px 30px 24px 28px;border-radius:24px;background:color-mix(in srgb,var(--rer-surface,#fff) 86%,transparent);border:1px solid var(--site-line);box-shadow:0 24px 48px -36px color-mix(in srgb,var(--site-ink) 45%,transparent);backdrop-filter:blur(6px)}'
  + '.step.option{grid-template-columns:1fr;padding-left:124px}.body{min-width:0}'
  + '.num{display:grid;place-items:center;width:62px;height:62px;border-radius:50%;background:var(--site-accent);color:var(--site-accent-ink);font:600 28px/1 var(--rer-font-heading,var(--rer-font-body,inherit))}'
  + '.step h2{margin-top:10px;font:600 26px/1.25 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.02em;color:var(--site-ink)}.step.option h2{margin-top:0}'
  + '.body>p{color:var(--site-body);font-size:18px;margin-top:6px}.body>p.alt{margin-top:14px;font-size:16px}.body>p.note{margin-top:14px;font-size:17px}.body>p.go{margin-top:14px}.go a{font-weight:600;text-decoration:underline;text-underline-offset:4px}'
  + 'code{font-family:var(--site-mono);font-size:.92em;color:var(--site-ink)}.alt code{margin-left:.2em}.note code{margin-right:.1em}'
  + '.code{position:relative;margin-top:16px;border-radius:12px;background:var(--rer-code-background,var(--site-ink));color:var(--rer-code-text,var(--rer-page,#f3f5f8))}'
  + '.code pre{margin:0;padding:18px 108px 18px 22px;overflow-x:auto;font:500 16px/1.75 var(--site-mono);white-space:pre}.code pre code{color:inherit;font-size:inherit}'
  + '.copy{position:absolute;top:50%;right:14px;transform:translateY(-50%);display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 14px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:999px;background:transparent;color:inherit;font:500 14px/1 var(--rer-font-body,inherit);cursor:pointer}'
  + '.copy:hover{background:color-mix(in srgb,currentColor 12%,transparent)}.copy svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4}'
  + '.facts{margin-top:32px;color:var(--site-body);font-size:14px;display:grid;gap:6px;text-align:center}.facts a{text-decoration:underline;text-underline-offset:3px}'
  + '@media(max-width:760px){body{--art:180px}main{padding:0 16px calc(var(--art) + 40px)}.intro{padding-top:34px}.intro h1{font-size:38px}.steps{margin-top:28px}'
  + '.step,.step.option{padding:20px 18px;border-radius:18px;grid-template-columns:1fr;gap:0}.num{position:absolute;top:18px;left:18px;width:34px;height:34px;font-size:16px}'
  + '.step h2{margin:3px 0 0 46px;min-height:30px;font-size:20px}.step.option h2{margin-left:0}.body>p,.body>p.note{font-size:15.5px}.body>p.alt{font-size:14.5px}'
  + '.code{margin-top:12px}.code pre{padding:46px 14px 14px;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}'
  + '.copy{top:8px;right:8px;transform:none;min-height:32px;padding:0 12px;font-size:13px}.facts{font-size:13px;margin-top:28px}}'

const COPY_SCRIPT = "document.addEventListener('click',async event=>{const button=event.target.closest('.copy');if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);const label=button.querySelector('span');label.textContent='Copied';setTimeout(()=>{label.textContent='Copy'},1600)}catch{}})"
const ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>'

export function document(identity: EditionIdentity, title: string, description: string, style: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}">`
    + `<link rel="icon" href="${escape(identity.mark)}">${identity.fonts ? `<link rel="stylesheet" href="${escape(identity.fonts)}">` : ''}<link rel="stylesheet" href="${escape(identity.theme)}"><style>${identity.accentColor ? `:root{--rer-brand-accent:${identity.accentColor};--rer-brand-accent-text:${ink(identity.accentColor)}}` : ''}${BASE}${style}</style></head>`
    + `<body>${identity.band ? `<div class="art" aria-hidden="true"><img src="${escape(identity.band)}" alt=""></div>` : ''}${body}${script ? `<script>${script}</script>` : ''}</body></html>`
}
/** Docs, Contract and Source: Docs when the site has /docs, Contract when the seed has a CONTRACT.md. */
export function siteLinks(run: RunData, contract: SeedContract | undefined, current?: 'contract'): string {
  return `${run.docs ? '<a href="/docs">Docs</a>' : ''}${contract ? `<a href="/contract"${current === 'contract' ? ' aria-current="page"' : ''}>Contract</a>` : ''}<a href="${escape(run.repository)}">Source</a>`
}
export function header(identity: EditionIdentity, run: RunData, contract?: SeedContract, current?: 'contract'): string {
  return `<header class="bar"><a class="brand" href="/"><img src="${escape(identity.mark)}" alt="" width="40" height="40"><span>${escape(identity.product)}</span></a>`
    + `<nav aria-label="Site">${siteLinks(run, contract, current)}</nav></header>`
}
const codeBlock = (lines: string[], label: string) => `<div class="code"><pre aria-label="${escape(label)}"><code>${lines.map(escape).join('\n')}</code></pre>`
  + `<button class="copy" type="button" data-copy="${escape(lines.join('\n'))}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H10"/></svg><span>Copy</span></button></div>`

/** The Run page at /run. `contract`, the seed's parsed CONTRACT.md, links /contract from the header. */
export function runPageHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  const name = escape(run.name), source = escape(run.repository.replace(/^https:\/\//, ''))
  const hosted = run.hosted.map(option => `<li class="step option"><div class="body"><h2>${escape(option.title)}</h2><p>${escape(option.body)}</p><p class="go"><a href="${escape(option.href)}">${escape(option.action)}</a></p></div></li>`).join('')
  const body = `${header(identity, run, contract)}<main><div class="intro"><h1>Run ${name} on your computer.</h1><p class="sub">100% free and open source. Two lines, and ${name} opens in your browser.</p></div>`
    + `<ol class="steps"><li class="step"><span class="num" aria-hidden="true">1</span><div class="body"><h2>Install rer</h2>${codeBlock([installRer], 'Install rer')}`
    + `<p class="note">It installs rer for you alone, with its own Node if you have no Node 22 or later. It changes no shell settings: if its last line puts rer on your PATH, run that line before step 2.</p></div></li>`
    + `<li class="step"><span class="num" aria-hidden="true">2</span><div class="body"><h2>Start ${name}</h2>${codeBlock([rerStart(run)], `Start ${run.name}`)}`
    + `<p class="note">rer gets ${name}, installs everything, makes you the owner and prints a link that opens ${name} signed in. To start it again later: <code>${escape(`cd ${run.folder} && rer dev`)}</code></p>`
    + `<p class="alt">Already have Node 22 or later? <code>${escape(run.clone)}</code> does both steps in one line.</p></div></li>${hosted}</ol>`
    + `<footer class="facts"><p>${escape(run.requirements)}</p><p>Source: <a href="${escape(run.repository)}">${source}</a> · ${escape(run.licence)} license</p></footer></main>`
  return document(identity, `Run ${run.name}`, `Run ${run.name} on your computer. 100% free and open source.`, RUN, body, COPY_SCRIPT)
}

/** Base's composed homepage for a seed without an approved one: its primary action is Run <Seed>. */
export function siteHomeHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  const body = `${header(identity, run, contract)}<main><div class="hero"><h1>${escape(identity.tagline)}</h1><p class="sub">100% free and open source.</p>`
    + `<div class="actions"><a class="btn" href="/run">Run ${escape(identity.product)}${ARROW}</a>${run.docs ? '<a class="link" href="/docs">Read the docs</a>' : ''}</div></div></main>`
  return document(identity, identity.product, identity.tagline, HOME, body)
}

/** 404.html: the static host serves it for every path the site does not have. */
export function siteNotFoundHtml(identity: EditionIdentity, run: RunData, contract?: SeedContract): string {
  checkIdentity(identity); checkRunData(run)
  const body = `${header(identity, run, contract)}<main><div class="hero"><h1>Page not found</h1><p class="sub">This page is not part of the ${escape(identity.product)} site.</p><div class="actions"><a class="link" href="/">Go to the homepage</a></div></div></main>`
  return document(identity, `Not found · ${identity.product}`, identity.tagline, HOME, body)
}

/** What a seed's site entry returns: each page by path, and the public files they use. */
export interface SiteBuild { pages: { path: string; html: string }[]; assets: string[] }

/**
 * What `rer build --site` passes to sitePages(): `styles`, the site paths of the
 * stylesheets the entry's CSS imports compiled to (empty when it imports none).
 * A page whose components import CSS links them in its head. `clients` maps
 * each declared island name to its bundled module URL; `styles` also includes
 * the client entries' compiled stylesheets. `contract` is the seed's
 * CONTRACT.md as parseContract reads it, absent when the seed has none; rer
 * stops the build, naming the line, when it does not parse. The entry renders
 * it at /contract with contractPageHtml and passes it to the other pages.
 */
export interface SiteContext { styles: string[]; clients: Record<string, string>; contract?: SeedContract }
