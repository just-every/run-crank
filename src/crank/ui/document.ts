import { themeFrame } from '../../base/theme-frame'
import { fontHead } from '../../base/font-head'
export const esc = (value:unknown) => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export const json = (value:unknown) => esc(JSON.stringify(value,null,2))
export const hidden = (name:string,value:unknown) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
export const action = (path:string,label:string,fields:Record<string,unknown>={},kind='') => `<form method="post" action="/app/action" class="inline">${hidden('path',path)}${Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')}<button class="${kind}">${esc(label)}</button></form>`
export const parse = (value:unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return value } }
export async function document(title:string,content:string,actor?:any,status=200) {
  const frame = await themeFrame({href:'/rer-theme.css',productName:'Crank',accentColor:'#356c60'})
  return new Response(`<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Crank</title>${fontHead}${frame.head}<link rel="stylesheet" href="/crank.css"></head><body><main class="crank"><header>${frame.brand}<p>Workflows with a person in control</p>${actor?`<p class="identity">${esc(actor.name)} · ${esc(actor.role)}</p>`:''}</header><nav aria-label="Workspace"><a href="/app">Flows</a><a href="/app/runs">Runs</a>${actor?.role==='owner'?'<a href="/app/import">Move in</a><a href="/app/access">Access</a><a href="/app/data">Data</a>':''}<a href="/auth/settings/identity">Account</a></nav><h1>${esc(title)}</h1>${content}<footer>Crank · Human approval required before delivery</footer></main></body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'strict-origin','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; ${frame.policy}`}})
}
