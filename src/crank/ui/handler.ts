import { operationsView } from './operations'
import { crankApi } from '../api'
import { workflowApi } from '../workflows/api'
import { importApi } from '../import-api'
import { importDoor } from '../import-door'
import { dataApi } from '../data'
import { encryptionPanel, retentionPanels, retentionPreview, sensitivePanel } from './retention-view'
import { authorize, requireOwner, requireWriteOrigin } from '../access'
import { type CrankEnv } from '../model'
import { authResponse } from '../../auth.server'
import { document, esc } from './document'
import { flowsView, runsView } from './flows'
import { runView } from './run'
import { accessView, accountView, dataView, restoreSummary } from './settings'
import { appliedView, importView, previewView, refusalView } from './move-in-view'
import { erasurePanels, subjectPreview } from './erasure-view'
import { applyReviewed, DoorRefusal, undoPlan, uploadAndPlan } from './move-in'
import { connectionsView } from './connections'
import { approvalsView, workflowRunView } from './workflow-run'
import { editorView } from './editor'
import { runGraphs, workflowData } from './workflow-data'

const redirect = (location:string) => new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
// A form may name where to return after its action: a path inside the app, nothing else.
const safeReturn = (value:unknown) => typeof value==='string' && /^\/app(\/[A-Za-z0-9/_.-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/.test(value) ? value : null
export async function productApi(request:Request,env:CrankEnv):Promise<Response|null> {
  return await importDoor(request,env) ?? await importApi(request,env) ?? await dataApi(request,env) ?? await workflowApi(request,env) ?? await crankApi(request,env)
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
      if (path.startsWith('/api/operator/import/')) headers.set('X-Import-Source','n8n')
      const forwarded = new Request(url.origin+path,{method:input===undefined?'GET':'POST',headers,...(input===undefined?{}:{body:JSON.stringify(input)})})
      return (path.startsWith('/auth/') ? await authResponse(forwarded,env) : await productApi(forwarded,env))!
    }
    const read = async (path:string) => { const response = await call(path), value:any = await response.json(); if(!response.ok) throw Object.assign(new Error(value.error ?? 'Unavailable'),{status:response.status}); return value }
    const page = async (title:string,content:string,options:any={},status=200) => {
      const state = options.state ?? await read('/api/crank/state'), waiting = await read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')
      return document(title,content,actor,status,{...options,state:undefined,approvals:state.runs.filter((r:any)=>r.state==='pending').length+waiting.runs.length})
    }
    const editorPage = async (id:string,params:URLSearchParams,preview?:unknown) => {
      const [data,state,waiting] = await Promise.all([workflowData(read,id,params,actor),read('/api/crank/state'),read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')])
      const view = editorView({...data,preview,tokens:state.tokens ?? [],people:state.people ?? [],approvals:state.runs.filter((r:any)=>r.state==='pending').length+waiting.runs.length})
      return document(data.workflow.name,view.content,actor,200,view.page)
    }
    if (request.method === 'POST') {
      requireWriteOrigin(request,env,actor)
      if (url.pathname === '/app/signout') {
        const response = await call('/auth/signout',{}), cookie = response.headers.get('set-cookie')
        if(!response.ok) return page('Sign out refused','<p class="notice">Sign out could not be confirmed. Close this browser window to end the session.</p><a href="/app/account">Return to account</a>',{},response.status)
        return new Response(null,{status:303,headers:{location:'/signin','cache-control':'no-store',...(cookie?{'set-cookie':cookie}:{})}})
      }
      const form = await formValues(request)
      if (url.pathname === '/app/data/subject') {
        requireOwner(actor)
        const response = await call('/api/crank/data/subject',{subject:form.subject}), preview:any = await response.json()
        if(!response.ok) return page('Erasure refused',`<p class="notice">${esc(preview.error)}</p><a href="/app/data">Back to Data</a>`,{},response.status)
        return page('Erasure preview',subjectPreview(form.subject ?? '',preview))
      }
      if (url.pathname === '/app/data/keys/export') {
        requireOwner(actor)
        const response = await call('/api/crank/data/keys/export',{passphrase:form.passphrase,confirm:form.confirm}), value:any = await response.json()
        if(response.status===403 && value.error==='step_up_required') return page('Confirm by email',`<p class="notice">Downloading the key file needs a fresh confirmation. Send yourself a link, open it in this browser, then download again within 10 minutes.</p><form method="post" action="/auth/step-up"><input type="hidden" name="action" value="export"><input type="hidden" name="returnTo" value="/app/data"><button class="btn btn-secondary">Email me a confirmation link</button></form><a href="/app/data">Back to Data</a>`,{},403)
        if(!response.ok) return page('Key file refused',`<p class="notice">${esc(value.error)}</p><a href="/app/data">Back to Data</a>`,{},response.status)
        return new Response(JSON.stringify(value),{headers:{'content-type':'application/json','content-disposition':'attachment; filename="crank-keys.json"','cache-control':'no-store'}})
      }
      if (url.pathname === '/app/data/retention') {
        requireOwner(actor)
        const response = await call('/api/crank/data/retention/preview',{payload_days:form.payload_days,attachment_days:form.attachment_days,history_days:form.history_days}), preview:any = await response.json()
        if(!response.ok) return page('Retention refused',`<p class="notice">${esc(preview.error)}</p><a href="/app/data">Back to Data</a>`,{},response.status)
        return page('Retention dry run',retentionPreview(preview))
      }
      if (url.pathname.startsWith('/app/import/')) {
        requireOwner(actor)
        try {
          if (url.pathname === '/app/import/preview') return page('Import preview',previewView(await uploadAndPlan(call,form.source ?? '')))
          if (url.pathname === '/app/import/apply') { const done = await applyReviewed(call,form.planId ?? '',form.reviewedFingerprint ?? ''); return page('Import applied',appliedView(done.report)) }
          if (url.pathname === '/app/import/undo') { await undoPlan(call,form.planId ?? ''); return redirect('/app/import') }
          if (url.pathname === '/app/import/settings') { const r = await call('/api/operator/import-settings',{enabled:form.enabled==='true'}); if(!r.ok) throw new DoorRefusal(r.status,await r.json()); return redirect('/app/import') }
        } catch (error) {
          if (!(error instanceof DoorRefusal)) throw error
          return page('Import refused',refusalView(error.body),{},error.status)
        }
      }
      const preview = /^\/app\/workflows\/([^/]+)\/preview$/.exec(url.pathname)
      if (preview) {
        let sample:unknown
        const id = decodeURIComponent(preview[1])
        try { sample = JSON.parse(form.sample ?? '') } catch { return page('Invalid sample',`<p class="notice">The sample must be JSON.</p><a href="/app/workflows/${esc(id)}">Back to the flow</a>`,{},400) }
        const response = await call(`/api/crank/workflows/${encodeURIComponent(id)}/preview`,{sample}), result:any = await response.json()
        if(!response.ok) return page('Preview refused',`<p class="notice">${esc(result.error)}</p><a href="/app/workflows/${esc(id)}">Back to the flow</a>`,{},response.status)
        return editorPage(id,new URLSearchParams({step:form.step ?? '',tab:'test'}),result)
      }
      if (url.pathname !== '/app/action' || (!/^\/api\/crank\/[A-Za-z0-9/_-]+$/.test(form.path ?? '') && !['/auth/invite','/auth/operator/status','/auth/operator/role'].includes(form.path))) return page('Not found','<a href="/app">Return to flows</a>',{},404)
      const path = form.path, back = safeReturn(form.return_to); delete form.path; delete form.return_to
      const input:Record<string,unknown> = {...form}
      if(form.input) { try {input.input=JSON.parse(form.input)} catch {return page('Invalid event','<p>Event input must be a JSON object.</p><a href="/app">Return to flows</a>',{},400)} }
      if(form.graph) { try {input.graph=JSON.parse(form.graph)} catch {return page('Invalid workflow','<p class="notice">The workflow graph must be JSON.</p><a href="/app">Return to flows</a>',{},400)} }
      if(form.restore_snapshot) {
        input.restore_decisions = Object.fromEntries(Object.entries(form).filter(([key]) => key.startsWith('restore_run_')).map(([key, value]) => [key.slice('restore_run_'.length), value]))
        for (const key of Object.keys(input)) if (key.startsWith('restore_run_')) delete input[key]
      }
      if(form.sink_token) { input.secret={token:form.sink_token}; delete input.sink_token }
      if(form.confirm_business_outcome==='true') input.confirm_business_outcome=true
      if(form.step_path!==undefined) { input.path=form.step_path; delete input.step_path }
      if(input.reason==='') delete input.reason
      if(input.flow_id==='') delete input.flow_id
      const response = await call(path,input)
      if(path==='/api/crank/data/export' && response.ok) return response
      const result:any = await response.json()
      if(!response.ok) return page('Action refused',`<p class="notice">${esc(result.error)}</p><p>No success was reported. Review the latest state before retrying.</p><a href="${back ?? (path.includes('/imports')?'/app/import':'/app')}">Return to workspace</a>`,{},response.status)
      if(result.token) return page('Credential created',`<section class="panel"><p>Shown once. Save this in a private file for your agent. Crank stores only its hash.</p><label>Credential<input type="password" value="${esc(result.token)}" readonly aria-label="Credential"></label><p class="muted">You can select and copy the hidden value. Do not share it in chat or commit it. Local dev credentials additionally need the local gate described in the README.</p><a class="btn btn-secondary" href="/app/access">Return to access</a></section>`)
      if(back) return redirect(back)
      if(path.startsWith('/api/crank/imports')) return redirect('/app/import')
      if(path.startsWith('/api/crank/tokens')) return redirect('/app/access')
      if(path.startsWith('/auth/')) return redirect('/app/access')
      if(path.startsWith('/api/crank/data')) return page('Data operation complete',`<p class="notice">${path.endsWith('/erase')?'The run and its dependent data have been erased. Existing destination effects remain there.':'Your archive has been restored. Every workflow is paused or draft and waits for your review at publish; flows are drafts and connections need reconnecting.'}</p>${restoreSummary(result)}<a href="/app">Return to flows</a>`)
      if(path.startsWith('/api/crank/workflow-runs/') || /^\/api\/crank\/workflows\/[^/]+\/run$/.test(path)) return redirect('/app/workflow-runs/'+encodeURIComponent(result.id))
      if(path==='/api/crank/workflows') return redirect('/app/workflows/'+encodeURIComponent(result.id))
      if(result.flow_id) return redirect('/app/runs/'+result.id)
      return redirect('/app')
    }
    if(request.method !== 'GET') return page('Method not allowed','<a href="/app">Return to flows</a>',{},405)
    const state = await read('/api/crank/state'), owner = actor.role==='owner'
    if(url.pathname==='/app') {
      const [workflows,connections] = await Promise.all([read('/api/crank/workflows'),read('/api/crank/connections')])
      return page('Flows',flowsView(state,env.CRANK_TARGET_ORIGIN ?? (env.AUTH_LOCAL==='true'?'http://127.0.0.1:9051':'https://inbox.example.com'),workflows,connections),{state,intro:'Workflows run unattended once published; approval steps and approval flows wait for an owner.'})
    }
    const workflowPath = /^\/app\/workflows\/([^/]+)$/.exec(url.pathname)
    if(workflowPath) return editorPage(decodeURIComponent(workflowPath[1]),url.searchParams)
    if(url.pathname==='/app/runs') {
      const q = url.searchParams.get('q') ?? '', status = url.searchParams.get('status') ?? '', workflow = url.searchParams.get('workflow') ?? ''
      const search = new URLSearchParams({limit:'50'}); if(q) search.set('q',q); if(status) search.set('status',status); if(workflow) search.set('workflow',workflow); for (const key of ['before','business_key','from','to','error']) { const value = url.searchParams.get(key); if(value) search.set(key,value) }
      const [runs,workflows] = await Promise.all([read('/api/crank/workflow-runs?'+search),read('/api/crank/workflows')])
      const {graphs,live} = await runGraphs(read,runs.runs)
      return page('Runs',runsView(state,url.searchParams.get('flow'),{runs:runs.runs,next:runs.next,workflows,q,status,workflow,graphs,live,params:url.searchParams}),{state,intro:'Every run keeps its own record: workflow runs step by step, approval flow runs with their decision and delivery.'})
    }
    if(/^\/app\/runs\/[^/]+$/.test(url.pathname)) return page('Run details',runView(state,url.pathname.split('/')[3]),{state,crumbs:[['Runs','/app/runs']]})
    const runPath = /^\/app\/workflow-runs\/([^/]+)$/.exec(url.pathname)
    if(runPath) {
      const run = await read('/api/crank/workflow-runs/'+runPath[1]), workflow = await read('/api/crank/workflows/'+encodeURIComponent(run.workflow_id))
      const versions = `/api/crank/workflows/${encodeURIComponent(run.workflow_id)}/versions/`, liveNumber = workflow.versions?.find((v:any)=>v.id===workflow.published_version_id)?.number
      const [graph,live] = await Promise.all([run.version ? read(versions+run.version.number).then((v:any)=>v.graph) : undefined, liveNumber ? read(versions+liveNumber).then((v:any)=>({graph:v.graph,number:liveNumber})) : null])
      const compareId = url.searchParams.get('older') || url.searchParams.get('compare'), comparison = compareId ? await read('/api/crank/workflow-runs/'+encodeURIComponent(compareId)) : null
      if(comparison && comparison.workflow_id !== run.workflow_id) throw Object.assign(new Error('Compare runs of the same workflow'),{status:422})
      const prior = await read('/api/crank/workflow-runs?'+new URLSearchParams({workflow:run.workflow_id,limit:'50'}))
      return page('Workflow run',workflowRunView(run,workflow,graph,live,await read('/api/crank/connections'),actor,state.people ?? [],comparison,prior.runs),{state,crumbs:[['Runs','/app/runs']]})
    }
    if(url.pathname==='/app/approvals') {
      const waiting = await read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')
      const details = await Promise.all(waiting.runs.map(async (r:any)=>({run:await read('/api/crank/workflow-runs/'+r.id),workflow:await read('/api/crank/workflows/'+encodeURIComponent(r.workflow_id))})))
      return page('Approvals',approvalsView(state,details),{state,intro:'Decisions that only a person can make. Everything else runs on its own.'})
    }
    if(url.pathname==='/app/account') { const session = await read('/auth/session'); return page('Account',accountView(session,owner),{state,intro:'Who is signed in on this browser, and what that role may do.'}) }
    if(url.pathname==='/app/connections') return page('Connections',connectionsView(await read('/api/crank/connections'),owner),{state,intro:'The apps your workflows act on, each with one stored credential.'})
    requireOwner(actor)
    if(url.pathname==='/app/operations') return page('Operations',operationsView(await read('/api/crank/reports/operations?'+url.searchParams),await read('/api/crank/workflows'),url.searchParams),{state,intro:'Execution health, business obligations and delivery to your own logs.'})
    if(url.pathname==='/app/access') {const people=await call('/auth/operators'); return page('Access',accessView({...state,people:people.ok?await people.json():[]}),{state,intro:'Credentials for agents and sending apps, and the people who can sign in.'})}
    if(url.pathname==='/app/data') { const [retention,workflows] = await Promise.all([read('/api/crank/data/retention'),read('/api/crank/workflows')]); return page('Data',dataView()+retentionPanels(retention,workflows)+sensitivePanel(retention.sensitive,workflows)+encryptionPanel(retention.sensitive)+erasurePanels((people=>Array.isArray(people)?people:people.operators??[])(await read('/auth/operators'))),{state,intro:'Export, restore and erase. Your data stays on this installation.'}) }
    if(url.pathname==='/app/import') { const jobs=await call('/api/crank/imports'); if(!jobs.ok) throw new Error('Import journal unavailable'); return page('Move in',importView(await jobs.json() as any[],await read('/api/operator/import-settings')),{state,intro:'Bring workflows from another tool as drafts you review first.'}) }
    return page('Not found','<a href="/app">Return to flows</a>',{state},404)
  } catch(error:any) {
    if(error.status===401) return redirect('/signin?returnTo='+encodeURIComponent(url.pathname))
    return document('Unable to continue',`<p class="notice">${esc(error.status?error.message:'This operation could not be confirmed. Return to the workspace and inspect its current state.')}</p><a href="/app">Return to flows</a>`,actor,error.status || 400)
  }
}
