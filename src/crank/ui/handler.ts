import { crankApi } from '../api'
import { workflowApi } from '../workflows/api'
import { importApi } from '../import-api'
import { dataApi } from '../data'
import { authorize, requireOwner, requireWriteOrigin } from '../access'
import { type CrankEnv } from '../model'
import { authResponse } from '../../auth.server'
import { document, esc } from './document'
import { flowsView, runsView } from './flows'
import { runView } from './run'
import { accessView, importView, previewView, dataView } from './settings'

const redirect = (location:string) => new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
export async function productApi(request:Request,env:CrankEnv):Promise<Response|null> {
  return await importApi(request,env) ?? await dataApi(request,env) ?? await workflowApi(request,env) ?? await crankApi(request,env)
}
async function formValues(request:Request) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new Error('Use a form submission.')
  const reader = request.body!.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder()
  for (;;) { const part = await reader.read(); if(part.done) break; bytes += part.value.length; if(bytes>512*1024) {await reader.cancel(); throw new Error('Form is too large. Use the CLI for large archives.')} text += decoder.decode(part.value,{stream:true}) }
  text += decoder.decode(); return Object.fromEntries(new URLSearchParams(text))
}
export async function appResponse(request:Request,env:CrankEnv):Promise<Response|null> {
  const url = new URL(request.url)
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null
  let actor:any
  try {
    actor = await authorize(request,env)
    if (actor.kind==='agent'||actor.kind==='trigger') return document('Use the API','<p>Machine credentials use the documented JSON API.</p>',undefined,403)
    const call = async (path:string,input?:unknown) => {
      const headers = new Headers(request.headers); headers.delete('content-length'); headers.set('content-type','application/json')
      const forwarded = new Request(url.origin+path,{method:input===undefined?'GET':'POST',headers,...(input===undefined?{}:{body:JSON.stringify(input)})})
      return (path.startsWith('/auth/') ? await authResponse(forwarded,env) : await productApi(forwarded,env))!
    }
    if (request.method === 'POST') {
      requireWriteOrigin(request,env,actor)
      const form = await formValues(request)
      if (url.pathname === '/app/import/preview') {
        requireOwner(actor)
        const response = await call('/api/crank/imports/plan',form), plan:any = await response.json()
        if(!response.ok) return document('Import refused',`<p class="notice">${esc(plan.error)}</p><a href="/app/import">Back to move in</a>`,actor,response.status)
        return document('Import preview',previewView(plan,form.source,form.namespace),actor)
      }
      if (url.pathname !== '/app/action' || (!/^\/api\/crank\/[A-Za-z0-9/_-]+$/.test(form.path ?? '') && !['/auth/invite','/auth/operator/status','/auth/operator/role'].includes(form.path))) return document('Not found','<a href="/app">Return to flows</a>',actor,404)
      const path = form.path; delete form.path
      const input:Record<string,unknown> = {...form}
      if(form.input) { try {input.input=JSON.parse(form.input)} catch {return document('Invalid event','<p>Event input must be a JSON object.</p><a href="/app">Return to flows</a>',actor,400)} }
      if(input.flow_id==='') delete input.flow_id
      const response = await call(path,input)
      if(path==='/api/crank/data/export' && response.ok) return response
      const result:any = await response.json()
      if(!response.ok) return document('Action refused',`<p class="notice">${esc(result.error)}</p><p>No success was reported. Review the latest state before retrying.</p><a href="${path.includes('/imports')?'/app/import':'/app'}">Return to workspace</a>`,actor,response.status)
      if(result.token) return document('Credential created',`<section><p>Shown once. Save this in a private file for your agent. Crank stores only its hash.</p><label>Credential<input type="password" value="${esc(result.token)}" readonly aria-label="Credential"></label><p>You can select and copy the hidden value. Do not share it in chat or commit it. Local dev credentials additionally need the local gate described in the README.</p><a href="/app/access">Return to access</a></section>`,actor)
      if(path.startsWith('/api/crank/imports')) return redirect('/app/import')
      if(path.startsWith('/api/crank/tokens')) return redirect('/app/access')
      if(path.startsWith('/auth/')) return redirect('/app/access')
      if(path.startsWith('/api/crank/data')) return document('Data operation complete',`<p class="notice">${path.endsWith('/erase')?'The run and its dependent data have been erased. Existing destination effects remain there.':'Your archive has been restored. Review the draft flows before activating them.'}</p><a href="/app">Return to flows</a>`,actor)
      if(result.flow_id) return redirect('/app/runs/'+result.id)
      return redirect('/app')
    }
    if(request.method !== 'GET') return document('Method not allowed','<a href="/app">Return to flows</a>',actor,405)
    const response = await call('/api/crank/state'), state:any = await response.json()
    if(!response.ok) return document('Workspace unavailable',`<p>${esc(state.error)}</p>`,actor,response.status)
    if(url.pathname==='/app') return document('Flows',flowsView(state,env.CRANK_TARGET_ORIGIN ?? (env.AUTH_LOCAL==='true'?'http://127.0.0.1:9051':'https://inbox.example.com')),actor)
    if(url.pathname==='/app/runs') return document('Runs',runsView(state,url.searchParams.get('flow')),actor)
    if(/^\/app\/runs\/[^/]+$/.test(url.pathname)) return document('Run details',runView(state,url.pathname.split('/')[3]),actor)
    requireOwner(actor)
    if(url.pathname==='/app/access') {const people=await call('/auth/operators'); return document('Access',accessView({...state,people:people.ok?await people.json():[]}),actor)}
    if(url.pathname==='/app/data') return document('Data',dataView(),actor)
    if(url.pathname==='/app/import') { const jobs=await call('/api/crank/imports'); if(!jobs.ok) throw new Error('Import journal unavailable'); return document('Move in',importView(await jobs.json() as any[]),actor) }
    return document('Not found','<a href="/app">Return to flows</a>',actor,404)
  } catch(error:any) {
    if(error.status===401) return redirect('/signin?returnTo='+encodeURIComponent(url.pathname))
    return document('Unable to continue',`<p class="notice">${esc(error.status?error.message:'This operation could not be confirmed. Return to the workspace and inspect its current state.')}</p><a href="/app">Return to flows</a>`,actor,error.status || 400)
  }
}
