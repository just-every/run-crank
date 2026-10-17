import { themeFrame } from '../../base/theme-frame'
import { fontHead } from '../../base/font-head'
import { navigation } from './navigation'
export const esc = (value:unknown) => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export const json = (value:unknown) => esc(JSON.stringify(value,null,2))
export const hidden = (name:string,value:unknown) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
export const action = (path:string,label:string,fields:Record<string,unknown>={},kind='dark-pill') => `<form method="post" action="/app/action" class="inline">${hidden('path',path)}${Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')}<button class="${kind==='secondary'?'outline-pill':kind==='danger'?'outline-pill danger':kind}">${esc(label)}</button></form>`
export const chip = (state:unknown,label:unknown=state) => `<span class="status-chip" data-state="${esc(state)}">${esc(label)}</span>`
// US style ("Oct 14, 2026, 9:12 AM UTC"); public/crank.js redraws it in the viewer's zone.
const utcTime = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })
export const timestamp = (value:unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? esc(value) : `<time datetime="${esc(value)}" title="UTC">${utcTime.format(date)} UTC</time>`
}
export const parse = (value:unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return value } }
export async function document(title:string,content:string,actor?:any,status=200) {
  const frame = await themeFrame({href:'/rer-theme.css',productName:'Crank',accentColor:'#C1D806'})
  return new Response(`<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Crank</title>${fontHead}${frame.head}<link rel="stylesheet" href="/crank.css"><script src="/crank.js" defer></script></head><body><main class="crank"><header><a class="brand-link" href="/" aria-label="Crank lobby">${frame.brand}</a>${actor?`<p class="identity">${esc(actor.name)} · ${esc(actor.role)}</p><a class="identity-initial" href="/auth/settings/identity" aria-label="${esc(actor.name)} · ${esc(actor.role)}">${esc(actor.name?.slice(0,1).toUpperCase())}</a>`:''}</header><div class="workspace">${navigation(title,actor?.role==='owner')}<div class="workspace-content"><h1>${esc(title)}</h1>${content}</div></div><footer>Crank · Published workflows run unattended; approval steps are optional</footer></main></body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'strict-origin','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}`}})
}
