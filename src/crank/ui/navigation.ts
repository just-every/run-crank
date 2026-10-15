import { esc } from './document'
const icons:Record<string,string> = {
 Flows:'<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/>',
 Runs:'<path d="M8 5h13M8 12h13M8 19h13"/><path d="M3 5h.01M3 12h.01M3 19h.01"/>',
 'Move in':'<path d="M13 3h7v18h-7M3 12h13m-5-5 5 5-5 5"/>',
 Access:'<circle cx="12" cy="7" r="4"/><path d="M3 21v-3a9 9 0 0 1 18 0v3Z"/>',
 Data:'<ellipse cx="12" cy="5" rx="9" ry="4"/><path d="M3 5v14c0 5 18 5 18 0V5M3 12c0 5 18 5 18 0"/>',
 Account:'<path d="m9 3 1-2h4l1 2 3 2 2 1v4l-2 2-1 3v3l-3 2-3-1-3-1H5l-2-3 1-3V9L3 6l3-3Z"/><circle cx="12" cy="11" r="3"/>',
}
export function navigation(title:string,owner:boolean) {
 const current=title==='Run details'?'Runs':title==='Import preview'||title==='Import refused'?'Move in':title==='Credential created'?'Access':title
 const links=[['Flows','/app'],['Runs','/app/runs'],...(owner?[['Move in','/app/import'],['Access','/app/access'],['Data','/app/data']]:[]),['Account','/auth/settings/identity']]
 return `<nav aria-label="Workspace">${links.map(([name,href])=>`<a href="${href}"${current===name?' aria-current="page"':''}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>${esc(name)}</a>`).join('')}</nav>`
}
