// /docs/hosting on every run site: how to run a seed and put it online, in the
// Run chooser's order: run it yourself with the one line, let Run Edit Run do it
// (Assisted), Managed when the seed's listing offers it, then the do-it-yourself
// walkthrough on the owner's own Cloudflare account (modelled on Pantry's). The
// plan copy, sign-up state and links are the chooser's PATHS. Every per-seed fact
// in the walkthrough (the Worker name, token permissions, resources and deploy
// file lines) is what `rer build --site` read from the seed's own deploy, setup
// and mail declarations, the ones `rer deploy` reads (cli/site-hosting.mjs); the
// page adds only Base's wording. This file is copied unchanged to src/base by
// both maintained exporters.
import { coldRunBudget } from './run-data.mjs'
import { checkIdentity, type EditionIdentity } from './identity'
import { PATHS, checkRunData, document, escape, header, pipelines, startLine, type HomepageHeader, type RunData } from './run-site'
import type { SeedContract } from './seed-contract.mjs'

/** What `rer build --site` reads for this page from the seed's declarations: names and permissions, never values. */
export interface SiteHosting {
  /** The deploy declaration rer deploy reads: "deploy.json". */
  declaration: string
  /** The production Worker ("pantry-production") when rer's owner-account deploy runs the whole deploy (`managesHostedOwner`); absent when a seed's own hook does. */
  worker?: string
  /** The account API token permissions rer deploy needs: "Workers Scripts: Edit", "D1: Edit". */
  permissions: string[]
  /** How many of each resource the deploy creates on the account. */
  resources: { d1: number; r2: number; kv: number; queues: number; durableObjects: number; crons: number }
  /** The environment name of the hosted owner's email, when the deploy claims an owner: "OWNER_EMAIL". */
  ownerEmail?: string
  /** Production sign-in mail, when the hosted app needs it. */
  mail?: {
    /** The providers the seed declares for an owner's own account ("resend", "sendgrid", "cloudflare"); empty when it declares none. */
    providers: string[]
    /** Environment names the deploy file sets; an absent one is fixed in the deploy declaration's vars. */
    provider?: string
    from?: string
    key: string
    accountId?: string
    /** The provider the deploy declaration fixes, when the deploy file cannot choose one. */
    fixedProvider?: string
  }
  /** Other inputs a real deploy needs from the owner, by environment name, with the setup manifest's label and help. */
  required: { name: string; label?: string; help?: string }[]
  /** The seed's own deploy guide (deploy.json deployGuide), when it names one. */
  guide?: string
}

const npxDev = 'npx -y @runeditrun/rer dev '
const envName = /^[A-Z][A-Z0-9_]*$/
const PROVIDERS: Record<string, string> = { resend: 'Resend', sendgrid: 'SendGrid', cloudflare: 'Cloudflare Email Sending' }

export function checkHosting(hosting: SiteHosting): SiteHosting {
  const names = [hosting.ownerEmail, hosting.mail?.provider, hosting.mail?.from, hosting.mail?.key, hosting.mail?.accountId, ...hosting.required.map(item => item.name)].filter(name => name !== undefined)
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/.test(hosting.declaration) || hosting.declaration.split('/').includes('..')) throw new Error('Hosting names its deploy declaration file.')
  if (hosting.worker !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(hosting.worker)) throw new Error('Hosting worker is a Worker name.')
  if (!hosting.permissions.length || !hosting.permissions.every(item => /^[A-Za-z0-9 ]+: Edit$/.test(item))) throw new Error('Hosting lists the token permissions.')
  if (!Object.values(hosting.resources).every(count => Number.isInteger(count) && count >= 0)) throw new Error('Hosting resources are counts.')
  if (!names.every(name => envName.test(name!))) throw new Error('Hosting settings are environment names.')
  if (hosting.mail && (!hosting.mail.providers.every(item => Object.hasOwn(PROVIDERS, item)) || hosting.mail.fixedProvider !== undefined && !Object.hasOwn(PROVIDERS, hosting.mail.fixedProvider))) throw new Error('Hosting mail providers are resend, sendgrid or cloudflare.')
  if (hosting.guide !== undefined && !/^https:\/\/[^\s"<>]+$/.test(hosting.guide)) throw new Error('Hosting guide is an https URL.')
  return hosting
}

// Shared look with the Run page: the seed's theme tokens, Base's fallbacks.
// The floor art's room is kept only when the seed has the art.
const STYLE = 'main{max-width:840px;margin:0 auto;padding:0 56px 64px}body:has(> .art) main{padding-bottom:calc(var(--art) + 56px)}.intro{padding-top:40px}.intro h1{font-size:52px}.intro .sub{max-width:680px}'
  + 'h2{font:600 30px/1.2 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.02em;color:var(--site-ink)}'
  + 'h3{margin:0;font:600 21px/1.3 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.01em;color:var(--site-ink)}'
  + 'section{margin-top:40px}section>p,section li,.walk p{color:var(--site-body);font-size:17px}section>p,.walk p{margin-top:12px}strong{color:var(--site-ink);font-weight:600}'
  + 'ul,.steps{margin:12px 0 0;padding-left:1.3em}ul{list-style:disc}.steps{list-style:decimal}li+li{margin-top:8px}li::marker{color:var(--site-body)}'
  + 'section a,.walk a{text-decoration:underline;text-underline-offset:3px;color:var(--rer-link,var(--site-ink))}'
  + '.card{padding:30px 34px;border-radius:var(--rer-radius,22px);background:color-mix(in srgb,var(--rer-surface,#fff) 88%,transparent);border:1px solid var(--site-line);box-shadow:0 24px 48px -36px color-mix(in srgb,var(--site-ink) 45%,transparent)}.card+.card{margin-top:24px}'
  + '.card .kicker{margin:0 0 4px;font-size:15px;font-weight:600;color:var(--site-body)}'
  + '.card .lead{margin-top:10px;font-size:19px;color:var(--site-ink)}.card h3{margin-top:22px;font-size:17px}.card ul{margin-top:8px}'
  // The Node alternative reads as on the Run page: plain monospace under its lead-in, wrapping only between words.
  + '.self .alt{display:grid;justify-items:start;gap:2px;margin-top:16px;font-size:15px}.self .alt code{padding:0;border-radius:0;background:none;font:400 15px/1.5 var(--site-mono);color:var(--site-ink)}'
  + '.self .note{margin-top:10px;font-size:15px}.self .guide{margin-top:16px;font-weight:600}'
  + '.code-repo{display:inline-block;max-width:100%;vertical-align:top;white-space:normal;overflow-wrap:anywhere}'
  + '.go{margin-top:22px;display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px}.go p{margin:0;flex:1 1 260px;font-size:15px;color:var(--site-body)}'
  + '.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 26px;border-radius:var(--rer-button-radius,999px);background:var(--site-accent);color:var(--site-accent-ink);font-size:17px;font-weight:600;text-decoration:none}'
  + '.diy>p.lead{margin-top:10px;font-size:19px;color:var(--site-ink)}.need{margin-top:28px}'
  + '.walk{margin-top:8px;counter-reset:walk}.walk>li{position:relative;counter-increment:walk;margin-top:36px;padding-left:54px}'
  + '.walk>li::before{content:counter(walk);position:absolute;left:0;top:-3px;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--site-accent);color:var(--site-accent-ink);font:600 17px/1 var(--rer-font-heading,var(--rer-font-body,inherit))}'
  + 'p code,li code{padding:.08em .32em;border-radius:6px;background:color-mix(in srgb,var(--site-ink) 7%,transparent);font:500 .9em var(--site-mono);color:var(--site-ink)}.code-word{white-space:nowrap}'
  + '.code{position:relative;container-type:inline-size;margin-top:14px;border-radius:12px;background:var(--rer-code-background,var(--site-ink));color:var(--rer-code-text,var(--rer-page,#f3f5f8))}'
  + '.code pre{margin:0;padding:16px 104px 16px 20px;font:500 15px/1.7 var(--site-mono)}.code pre code,.output pre code{padding:0;border-radius:0;background:none;font:inherit;color:inherit}'
  + '.output{margin-top:14px;border-radius:12px;background:color-mix(in srgb,var(--site-ink) 6%,transparent)}.output pre{margin:0;padding:14px 20px;font:500 15px/1.7 var(--site-mono);color:var(--site-ink)}'
  // A seed theme can outrank .code pre (Buoy keeps a command on one line on phones), so the page's own classes keep every block wrapping.
  + '.self .code pre.line,.diy .walk .code pre,.diy .walk .output pre{white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:visible}'
  + '.copy{position:absolute;top:10px;right:10px;min-height:34px;padding:0 14px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:999px;background:transparent;color:inherit;font:500 14px/1 var(--rer-font-body,inherit);cursor:pointer}'
  + '.copy:hover{background:color-mix(in srgb,currentColor 12%,transparent)}.copy:focus-visible{outline-color:var(--rer-code-text,var(--rer-page,#f3f5f8))}'
  + '@container (max-width:560px){.code pre{padding:52px 16px 14px;font-size:14px}}'
  + '@media(max-width:760px){main{padding:0 16px 48px}body:has(> .art) main{padding-bottom:calc(var(--art) + 40px)}.intro{padding-top:28px}.intro h1{font-size:36px}h2{font-size:25px}h3{font-size:19px}'
  + '.output pre{padding:12px 16px;font-size:14px}section{margin-top:32px}section>p,section li,.walk p{font-size:16px}.card{padding:22px 18px}.card+.card{margin-top:20px}.card .lead,.diy>p.lead{font-size:17px}.self .alt code{font-size:14px}.walk>li{padding-left:0}.walk>li>h3:first-child{padding-left:42px;min-height:30px}.walk>li::before{top:-2px;width:30px;height:30px;font-size:15px}.btn{min-height:46px;font-size:16px}}'

// Copy buttons are drawn hidden and shown once this runs, so none is dead without script.
const COPY = "document.querySelectorAll('.copy').forEach(b=>{b.hidden=false;b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copied';setTimeout(()=>{b.textContent='Copy'},1600)}catch{}})})"

// An inline command or name keeps each word whole, wrapping only at its spaces.
const code = (value: string) => `<code>${escape(value).replace(/\S+/g, word => `<span class="code-word">${word}</span>`)}</code>`
const command = (lines: string[], label: string) => `<div class="code"><pre aria-label="${escape(label)}"><code>${escape(lines.join('\n'))}</code></pre><button class="copy" type="button" hidden data-copy="${escape(lines.join('\n'))}">Copy</button></div>`
const output = (lines: string[], label: string) => `<div class="output"><pre aria-label="${escape(label)}"><code>${escape(lines.join('\n'))}</code></pre></div>`
const list = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
const either = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
const count = (n: number, one: string, many: string) => n === 1 ? one : `${n} ${many}`

function resources({ d1, r2, kv, queues, durableObjects, crons }: SiteHosting['resources']): string[] {
  return [d1 && count(d1, 'a D1 database', 'D1 databases'), r2 && count(r2, 'an R2 bucket', 'R2 buckets'), kv && count(kv, 'a KV namespace', 'KV namespaces'),
    queues && count(queues, 'a queue', 'queues'), durableObjects && 'Durable Objects', crons && 'a schedule'].filter((item): item is string => Boolean(item))
}

/**
 * /docs/hosting: the one line, Run Edit Run's Assisted plan, Managed when the seed is listed and its Managed door is
 * not held closed, then the do-it-yourself walkthrough. `hosting` is the one sitePages receives: null when the seed
 * does not deploy to Workers from its declarations, which leaves the walkthrough out. `run.paths.product` is the
 * listing id the chooser's entry links carry.
 */
export function hostingPageHtml(identity: EditionIdentity, run: RunData, hosting: SiteHosting | null, contract?: SeedContract, homepage?: HomepageHeader): string {
  checkIdentity(identity); checkRunData(run)
  if (hosting) checkHosting(hosting)
  const name = escape(run.name), repo = run.clone.slice(npxDev.length), folder = repo.split('/').at(-1)!, slug = folder.replace(/^run-/, '')
  const product = run.paths.product ?? `run-${slug}`, line = startLine(run)
  const managed = run.paths.product !== null && run.paths.managed?.open !== false
  // A paid plan's action, in the state the chooser shows it: by request until sign-ups open for this listing.
  const go = (id: 'assisted' | 'managed') => {
    const closed = PATHS.signups === 'request' || run.paths.product === null || run.paths[id]?.open === false
    return `<div class="go"><a class="btn" href="${escape(PATHS.entry(id, product))}">${escape(closed ? PATHS.closed.action : PATHS[id].action)}</a>`
      + (closed ? `<p>${escape(PATHS.closed.line)} The link asks for access with ${name} and ${escape(PATHS[id].title)} already chosen, and we email you about the next steps.</p>` : '')
      + '</div>'
  }

  const self = `<section class="card self" aria-labelledby="self"><h2 id="self">${escape(PATHS.self.title)}</h2><p>${escape(PATHS.self.body(run.name))}</p>`
    + `<div class="code"><pre class="line" aria-label="${escape(PATHS.self.title)}"><code>${pipelines(line)}</code></pre><button class="copy" type="button" hidden data-copy="${escape(line)}">Copy</button></div>`
    + `<p class="alt"><span>Already have Node 22 or later?</span>${code(run.clone)}</p>`
    + `<p class="note">${escape(PATHS.self.requirements)}${run.paths.requirementsExtra ? ` ${escape(run.paths.requirementsExtra)}` : ''}</p>`
    + `<p class="note">${name} then runs only on your computer: nobody else can open it, and it sends no email. To start it again later, run the same line from the same folder.</p>`
    + (run.docs ? `<p class="guide"><a href="${escape(PATHS.self.guide.href)}">${escape(PATHS.self.guide.label)}</a></p>` : '')
    + '</section>'
  const assisted = `<section class="card assisted" aria-labelledby="assisted"><p class="kicker">${escape(PATHS.assisted.title)}</p><h2 id="assisted">Let Run Edit Run do it</h2>`
    + `<p class="lead">${escape(`${PATHS.assisted.lead} ${PATHS.assisted.rest}`)}</p><p>Either way, we guide you through the setup.</p>`
    + `<h3>What stays yours</h3><ul><li>The code: ${name} is ${escape(run.licence)} licensed, so you can change it and run it without us.</li><li>The data: it stays on your computer or in your own Cloudflare account.</li><li>If you stop, your repository and your Cloudflare account stay yours.</li></ul>`
    + `${go('assisted')}</section>`
  const hosted = managed
    ? `<section class="card managed" aria-labelledby="managed"><p class="kicker">${escape(PATHS.managed.title)}</p><h2 id="managed">Let Run Edit Run host it</h2>`
      + `<p class="lead">${escape(`${PATHS.managed.lead} ${PATHS.managed.rest}`)}</p><p>${name} runs on Run Edit Run's cloud instead of yours. The code stays ${escape(run.licence)} licensed, so you can still run it yourself.</p>`
      + `${go('managed')}</section>`
    : ''

  const online = `Run Edit Run can set it up with you${managed ? ' or run it for you' : ''}${hosting ? ', or you can do it yourself on your own Cloudflare account' : ''}`
  const body = (sections: string) => `${homepage?.html ?? header(identity, run, contract)}<main><div class="intro"><h1>Put ${name} online</h1><p class="sub">${name} runs on your own computer first. To use it from anywhere, put it online: ${online}.</p><p class="sub">${escape(coldRunBudget)}</p></div>${sections}</main>`
  const page = (sections: string) => document(identity, `Put ${run.name} online`, `Run ${run.name} on your own computer with one line, or put it online: ${online}.`, STYLE, body(self + assisted + hosted + sections), COPY, homepage?.styles)
  if (!hosting) return page('')

  const env = `.env.${slug}`, made = resources(hosting.resources), mail = hosting.mail
  const address = hosting.worker ? `https://${hosting.worker}.yourname.workers.dev` : undefined
  // Cloudflare Email Sending also needs its account ID, so it is a choice only where the deploy file can set one.
  const choices = mail ? (mail.fixedProvider ? [mail.fixedProvider] : mail.providers.filter(item => item !== 'cloudflare' || mail.accountId)) : []

  const lines = [
    ...(hosting.ownerEmail ? [`${hosting.ownerEmail}=you@example.com`] : []),
    'CLOUDFLARE_ACCOUNT_ID=your account ID',
    'CLOUDFLARE_API_TOKEN=the token',
    ...(mail?.provider ? [`${mail.provider}=${choices[0] ?? 'your provider'}`] : []),
    ...(mail ? [`${mail.key}=your mail provider's API key`] : []),
    ...(mail?.from ? [`${mail.from}=hello@example.com`] : []),
    ...hosting.required.map(item => `${item.name}=`),
  ]
  const notes = [
    ...(hosting.ownerEmail ? [`${code(hosting.ownerEmail)} is your own mailbox: the hosted ${name}'s owner, where your sign-in links go. Without it, rer deploy uses the owner ${name} on this computer was set up with, which is a placeholder ending in ${code('.test')} if you started it with the one line, and no mail reaches that.`] : []),
    ...(mail?.provider ? [`${code(mail.provider)} is ${choices.length ? either(choices.map(code)) : `your provider as rer deploy names it: ${either(['resend', 'sendgrid', 'cloudflare'].map(code))}`}.${mail.accountId && choices.includes('cloudflare') ? ` With ${code('cloudflare')}, add ${code(`${mail.accountId}=`)} and your Cloudflare account ID too.` : ''}`] : []),
    ...(mail?.from ? [`${code(mail.from)} is a sender address on the domain you verified with your mail provider.`] : []),
    ...hosting.required.map(item => `${code(item.name)}${item.label ? `: ${escape(item.label)}` : ''}${item.help ? `. ${escape(item.help.replace(/\.$/, ''))}.` : '.'}`),
  ]
  const fixedSender = mail && !mail.from
    ? `<p>${name} reads its sender from ${code(hosting.declaration)}, not from this file. Under ${code('vars')} there, set ${code('MAIL_FROM')} to a sender address on your verified domain, then commit the change, because rer deploy publishes the last commit:</p>${command(['git commit -am "Send mail from my own domain"'], 'Commit the sender')}`
    : ''

  const need = [
    `${name} on this computer, started with <a href="#self">the line above</a>. It installs ${code('rer')}; if you started with npx instead, put ${code('npx -y @runeditrun/rer')} wherever this page says ${code('rer')}.`,
    `A Cloudflare account (<a href="https://dash.cloudflare.com/sign-up">sign up</a>). ${name} runs on Cloudflare Workers${made.length ? ` with ${list(made)}` : ''}; <a href="https://developers.cloudflare.com/workers/platform/pricing/">Cloudflare's pricing</a> lists what each plan includes.${hosting.resources.r2 ? ' Turn on R2 once in the dashboard (<strong>R2 Object Storage</strong>) before the first deploy.' : ''}`,
    ...(mail ? [`${choices.length ? `A ${either(choices.map(item => PROVIDERS[item]))} account` : 'A mail provider account'} with a domain of your own verified there, so the hosted ${name} can email sign-in links.`] : []),
  ]

  const steps = [
    `<h3 id="workers-dev">Give your Cloudflare account a workers.dev address</h3><p>In the Cloudflare dashboard, open <strong>Workers &amp; Pages</strong>. The first time, Cloudflare asks you to choose your account's ${code('workers.dev')} subdomain, for example ${code('yourname')}.${address ? ` ${name} will answer at:</p>${output([address], `${run.name}'s address`)}<p>` : ' '}Without it, rer deploy stops with ${code('workers-subdomain-missing')}.</p>`,
    `<h3 id="token">Find your account ID and make an API token</h3><ol class="steps"><li>In <strong>Workers &amp; Pages</strong>, copy your <strong>Account ID</strong>.</li><li>Open <a href="https://dash.cloudflare.com/profile/api-tokens">API Tokens</a> (<strong>My Profile → API Tokens</strong>), choose <strong>Create Token</strong>, then <strong>Create Custom Token</strong>.</li>`
      + `<li>Name it ${code(`${run.name} deploy`)} and add ${hosting.permissions.length === 1 ? 'this account permission' : 'these account permissions'}: ${list(hosting.permissions.map(item => `<strong>${escape(item)}</strong>`))}. Under <strong>Account Resources</strong>, choose your account. No zone permission is needed.</li>`
      + '<li>Choose <strong>Continue to summary</strong>, then <strong>Create Token</strong>, and copy the token. Cloudflare shows it once.</li></ol>'
      + `<p>If a permission is missing, the deploy stops with an error such as ${code(`token-scope-missing-${hosting.permissions.includes('D1: Edit') ? 'd1' : 'workers'}`)}: add that permission to the token and run the same command again.</p>`,
    `<h3 id="deploy-file">Write the deploy file</h3><p>In the ${code(folder)} folder, create a file named ${code(env)} with these lines, each value replaced with yours:</p>${command(lines, 'The deploy file')}`
      + (notes.length ? `<ul>${notes.map(note => `<li>${note}</li>`).join('')}</ul>` : '')
      + `<p>Make it readable only by you; rer deploy refuses it otherwise. Never add it to a commit.</p>${command([`chmod 600 ${env}`], 'Make it private')}${fixedSender}`,
    `<h3 id="deploy">Deploy</h3><p>Stop ${name} on this computer first: rer deploy refuses while it runs. To start it again later, run the same line from the same folder; its data stays as you left it.</p>${command(['rer dev --stop', `rer deploy --env-file ${env}`], 'Deploy')}`
      + `<p>rer deploy builds ${name}, creates ${list(['its Worker', ...made])} on your account and checks that it answers. ${address ? `It ends with ${hosting.ownerEmail ? 'these lines' : 'this line'}:</p>${output([`Your application is live on your Cloudflare account at ${address}.`, ...(hosting.ownerEmail ? [`Claimed the hosted owner (you@example.com); the one-time setup token was removed. Sign in by email at ${address}.`] : [])], 'What rer deploy prints')}` : `It ends with the address, after ${code('Sign in by email at')}.</p>`}`
      + `<p>Open that address and sign in with your owner email: ${name} emails you a sign-in link. If it does not arrive, look for the message in your mail provider's dashboard. The hosted ${name} starts with its own, empty data; the data on this computer stays where it is.</p>`,
  ]

  const current = [
    `<strong>Update ${name}:</strong> in the ${code(folder)} folder, run ${code('git pull')}, then ${code(`rer deploy --env-file ${env}`)} again. The hosted data stays.`,
    `<strong>Change one setting:</strong> put the new value in ${code(env)}, then run ${code(`rer deploy --set-secret NAME --env-file ${env}`)} with the setting's name.`,
    `<strong>Keep the ${code('.rer')} folder.</strong> It records what rer deploy created on your account, so later deploys update the same ${name}. Deploy from the same folder each time.`,
    `<strong>Take it down:</strong> ${code(`rer deploy --remove --yes --env-file ${env}`)} deletes the Worker and everything rer created for it, with its data, and checks that none of it remains. Save what you need first.`,
  ]
  const guide = hosting.guide && hosting.guide !== `${identity.runSite}/docs/hosting` ? `<p>${name}'s own <a href="${escape(hosting.guide)}">deploy guide</a> covers the details.</p>` : ''

  const diy = `<section class="diy" aria-labelledby="diy"><h2 id="diy">Put it online yourself</h2><p class="lead">Put ${name} on your own Cloudflare account from a terminal. rer deploy does the work from the ${code(folder)} folder on your computer.</p>`
    + `<h3 class="need" id="need">What you need</h3><ul>${need.map(item => `<li>${item}</li>`).join('')}</ul>`
    + `<ol class="walk">${steps.map(step => `<li>${step}</li>`).join('')}</ol>`
    + `<h3 class="need" id="keep-current">Keep it current</h3><ul>${current.map(item => `<li>${item}</li>`).join('')}</ul>${guide}</section>`

  return page(diy)
}
