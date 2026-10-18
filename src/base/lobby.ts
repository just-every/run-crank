import { iconHead } from './icon-head'
import { rejectedResponse } from './rejected-response'
// The Lobby: what an installed instance serves at / when its edition identity
// says installedHome: 'lobby'. A centred lockup, one line, one button and the
// seed's floor art. Claimed, the button is Sign in; before the owner's claim it
// is Finish setup. It reveals nothing but that state, is the same for every
// visitor and works without JavaScript. Visual authority: the 12ui Lobby.
// This file is copied unchanged to src/base by both maintained exporters.
import { checkIdentity, type EditionIdentity } from './identity'
import { admitted, baseOwnerClaim, setupState, type ClaimRead, type SetupState } from './setup-state'
import { ink } from './theme-frame'

interface LobbyBindings { DB: D1Database; AUTH_ORIGIN: string }

// Every colour, face and radius is the seed's declared --rer-* token, each with
// a readable neutral when the theme cannot load.
const STYLE = '*,*::before,*::after{box-sizing:border-box}html,body{margin:0;min-height:100%}'
  + 'body{--lobby-ink:var(--rer-text,#172033);--lobby-accent:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)));--lobby-accent-ink:var(--rer-accent-text,var(--rer-brand-accent-text,var(--rer-surface,#fff)));'
  + 'background:radial-gradient(120% 80% at 18% -12%,rgba(255,255,255,.75),transparent 58%),var(--rer-page,#f3f5f8);color:var(--lobby-ink);font-family:var(--rer-font-body,system-ui,sans-serif);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}'
  + '.door{position:relative;min-height:100vh;min-height:100dvh;overflow:hidden;isolation:isolate;display:flex;align-items:flex-start;justify-content:center;padding:22vh 16px 32vh}'
  + '.door-art{position:absolute;left:0;right:0;bottom:0;height:29vh;min-height:150px;pointer-events:none;z-index:-1}.door-art img{width:100%;height:100%;display:block;object-fit:cover;object-position:center bottom}'
  + '.door-card{display:flex;flex-direction:column;align-items:center;text-align:center;max-width:640px}'
  + 'h1{margin:0;font-size:clamp(40px,6vw,68px);font-weight:inherit;line-height:1}'
  + '.lockup{display:inline-flex;align-items:center;gap:.3em;max-width:100%;color:var(--lobby-ink);text-decoration:none}.mark{flex:none;width:1.16em;height:1.16em;display:block}'
  + '.word{font-family:var(--rer-font-heading,var(--rer-font-body,inherit));font-weight:var(--rer-wordmark-weight,600);letter-spacing:var(--rer-wordmark-tracking,-.02em);line-height:1;text-wrap:balance}'
  + '.line{margin:30px 0 0;font-size:25px;line-height:1.5;max-width:36ch;text-wrap:balance}'
  + '.btn{margin-top:36px;display:inline-flex;align-items:center;justify-content:center;gap:14px;min-height:58px;padding:0 32px;border-radius:var(--rer-button-radius,999px);'
  + 'background:linear-gradient(180deg,color-mix(in srgb,var(--lobby-accent) 90%,white),var(--lobby-accent));color:var(--lobby-accent-ink);text-decoration:none;font-size:19px;font-weight:600;letter-spacing:.005em;'
  + 'box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 14px 28px -16px color-mix(in srgb,var(--lobby-ink) 70%,transparent)}.btn svg{width:19px;height:19px}'
  + '.credit{margin:28px 0 0;font-size:15px;color:var(--rer-muted,#475569)}'
  + '.credit a{color:inherit;text-decoration:underline;text-underline-offset:4px;text-decoration-thickness:1.5px;text-decoration-color:color-mix(in srgb,var(--lobby-accent) 70%,var(--lobby-ink))}'
  + ':focus-visible{outline:3px solid var(--rer-focus,currentColor);outline-offset:3px;border-radius:4px}.btn:focus-visible{border-radius:var(--rer-button-radius,999px)}'
  + '@media(max-width:640px){.door{padding:168px 16px 210px}.door-art{height:200px}h1{font-size:min(54px,11vw)}.line{font-size:21px;margin-top:26px}.btn{margin-top:32px;padding:0 30px;min-height:56px;font-size:18px}.credit{font-size:14px}}'

const ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>'
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
const hashes = new Map<string, Promise<string>>()
const digest = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))

const accentStyle = (identity: EditionIdentity) => identity.accentColor ? `:root{--rer-brand-accent:${identity.accentColor};--rer-brand-accent-text:${ink(identity.accentColor)}}` : ''

/**
 * The Lobby document for one state. Identity and state shape it; `loginHint`,
 * the claimed owner's email on a local instance only, rides on the Sign in link
 * as ?login_hint= so the sign-in form opens with it filled in.
 */
export function lobbyHtml(identity: EditionIdentity, state: SetupState, loginHint?: string): string {
  checkIdentity(identity)
  const claimed = state === 'claimed', product = escape(identity.product)
  const line = claimed ? 'The owner is set up. Sign in to continue.' : `This ${product} is waiting for its owner.`
  const action = claimed ? `<a class="btn" href="${escape(identity.signInPath)}${loginHint ? `?login_hint=${encodeURIComponent(loginHint)}` : ''}">Sign in${ARROW}</a>` : `<a class="btn" href="/setup">Finish setup${ARROW}</a>`
  const ownerHelp = claimed ? '<p class="credit">Owners can also run <code>rer signin</code> from the project folder.</p>' : ''
  const credit = claimed
    ? `<p class="credit">Powered by <a href="${escape(identity.runSite)}">${product}</a>, free and open source</p>`
    : identity.manualSetupTokenClaim ? '<p class="credit">You’ll need the setup token from your install.</p>' : ''
  const title = claimed ? `${escape(identity.deployment)} · ${product}` : `Finish setup · ${product}`
  const art = identity.band ? `<div class="door-art" aria-hidden="true"><img src="${escape(identity.band)}" alt=""></div>` : ''
  return `<!doctype html><html lang="en" data-state="${state}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `${iconHead}${identity.fonts ? `<link rel="stylesheet" href="${escape(identity.fonts)}">` : ''}<link rel="stylesheet" href="${escape(identity.theme)}"><style>${accentStyle(identity)}${STYLE}</style></head>`
    + `<body><main class="door">${art}<section class="door-card"><h1><a class="lockup" href="/"><img class="mark" src="${escape(identity.mark)}" alt=""><span class="word" data-rer-name>${product}</span></a></h1>`
    + `<p class="line">${line}</p>${action}${ownerHelp}${credit}</section></main></body></html>`
}

const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:[a-z0-9-]+\.)+localhost)$/

/**
 * The claimed owner's email when exactly one active owner exists and the
 * instance is served on this computer. The Lobby is the same page for every
 * visitor of a hosted instance and never names its owner; locally the visitor
 * is the person at this computer, who just claimed it.
 */
async function localOwnerEmail(db: D1Database, origin: string): Promise<string | undefined> {
  try {
    if (!loopbackHost.test(new URL(origin).hostname)) return undefined
    const { results } = await db.prepare("SELECT email FROM oa_operators WHERE role = 'owner' AND status = 'active' LIMIT 2").all<{ email: string }>()
    return results.length === 1 ? results[0].email : undefined
  } catch { return undefined }
}

/**
 * Answer GET or HEAD / with the Lobby, rendered on the server from the stored
 * claim state (`claimed`: the same read the seed gives setupStateResponse).
 * Returns null for every other path and when the edition keeps its own page
 * at / (installedHome: 'page').
 */
export async function lobbyResponse(request: Request, bindings: LobbyBindings, identity: EditionIdentity, claimed: ClaimRead = baseOwnerClaim): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/' || identity.installedHome !== 'lobby') return null
  const base = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-rer-document': 'lobby' }
  // Another origin or Host gets the app's ordinary document 404.
  if (!admitted(request, bindings.AUTH_ORIGIN)) return rejectedResponse(request, new Response('Not found', { status: 404, headers: base }))
  if (request.method !== 'GET' && request.method !== 'HEAD') return rejectedResponse(request, new Response(null, { status: 405, headers: { ...base, allow: 'GET, HEAD' } }))
  let state: SetupState
  try { state = await setupState(bindings.DB, claimed) } catch { return Response.json({ error: 'setup_unavailable' }, { status: 503, headers: base }) }
  const style = accentStyle(identity) + STYLE
  if (!hashes.has(style)) hashes.set(style, digest(style))
  const policy = `default-src 'none'; style-src 'self' 'sha256-${await hashes.get(style)}'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  return new Response(request.method === 'HEAD' ? null : lobbyHtml(identity, state, state === 'claimed' ? await localOwnerEmail(bindings.DB, bindings.AUTH_ORIGIN) : undefined), { headers: { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': policy } })
}
