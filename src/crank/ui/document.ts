import { fontHead } from '../../base/font-head'
import { shell, type Page } from './shell'
export const esc = (value:unknown) => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export const json = (value:unknown) => esc(JSON.stringify(value,null,2))
export const hidden = (name:string,value:unknown) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
/** Button kinds: primary (navy), secondary (quiet outline), danger (outline in red). */
export type ButtonKind = 'primary'|'secondary'|'danger'
export const action = (path:string,label:string,fields:Record<string,unknown>={},kind:ButtonKind='primary',className='') => `<form method="post" action="/app/action" class="inline">${hidden('path',path)}${Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')}<button class="btn btn-${kind}${className?' '+className:''}">${esc(label)}</button></form>`
export const chip = (state:unknown,label:unknown=state) => `<span class="chip" data-state="${esc(state)}">${esc(label)}</span>`
// US style ("Oct 14, 2026, 9:12 AM UTC"); public/crank.js redraws it in the viewer's zone.
const utcTime = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })
export const timestamp = (value:unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? esc(value) : `<time datetime="${esc(value)}" title="UTC">${utcTime.format(date)} UTC</time>`
}
// Clock time only ("9:14 AM"), redrawn in the viewer's zone by public/crank.js.
const utcClock = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', hour:'numeric', minute:'2-digit' })
export const clock = (value:unknown) => {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : `<time datetime="${esc(value)}" data-format="clock" title="UTC">${utcClock.format(date)}</time>`
}
export const parse = (value:unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return value } }
export const plural = (count:number, one:string, many=one+'s') => `${count.toLocaleString('en-US')} ${count===1?one:many}`
export async function document(title:string,content:string,actor?:any,status=200,page:Page={}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Crank</title><link rel="icon" href="/brand/mark.svg">${fontHead}<link rel="stylesheet" href="/rer-theme.css"><link rel="stylesheet" href="/ui/shell.css"><link rel="stylesheet" href="/ui/pages.css">${page.editor?'<link rel="stylesheet" href="/ui/editor.css">':''}<script src="/crank.js" defer></script></head><body class="crank-app">${shell(title,content,actor,page)}</body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'strict-origin','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}})
}
