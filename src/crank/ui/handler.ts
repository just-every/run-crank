import { watchedFieldsPanel } from './watched-fields'
import { unitsUsd } from '../ops/usage-money'
import { mcpClientsPanel, mcpCredentialView } from './mcp-clients'
import { clientApi } from '../mcp/client-api'
import { driftApi } from '../agents/drift-api'
import { driftListView, driftReviewView } from './drift'
import { gatewayScopeId } from '../custom/use-scope'
import { serviceAccountsPanel } from './service-accounts'
const gatewayConfirmation=()=>`<section class="panel"><h2>Confirm connection access</h2><p>Use your native owner session. Email yourself a confirmation link, open it in this browser, then create the gateway code or service account within five minutes.</p><form method="post" action="/auth/step-up"><input type="hidden" name="action" value="credentials:mint"><input type="hidden" name="returnTo" value="/app/connections"><button class="btn btn-secondary">Email me a confirmation link</button></form><a href="/app/connections">Return to connections</a></section>`
import { customPickerPanel } from './custom-picker'
import { findNode, flatten, nodes } from './editor/model'
import { customConnectionsPanel, proposalReview } from './custom-connectors'
import { customApi } from '../custom/api'
import { followupApi } from '../agents/followups/api'
import { followupsPanel, inboxPanel } from './followups'
import { decisionEdits } from './decision-fields'
import { teamApi } from '../team/api'
import { teamPanel } from './team'
import { grantsPanel } from './grants'
import { usageView, usageHoldView } from './usage'
import { operationsView } from './operations'
import { crankApi } from '../api'
import { workflowApi } from '../workflows/api'
import { versionedApi } from '../platform/versioned'
import { importApi } from '../import-api'
import { importDoor } from '../import-door'
import { dataApi } from '../data'
import { encryptionPanel, retentionPanels, retentionPreview, sensitivePanel } from './retention-view'
import { authorize, requireOwner, requireWriteOrigin } from '../access'
import { canonical, digest, type CrankEnv } from '../model'
import { authResponse } from '../../auth.server'
import { document, esc } from './document'
import { flowsView, runsView } from './flows'
import { runView } from './run'
import { accessView, accountView, dataView, restoreSummary } from './settings'
import { appliedView, importView, previewView, refusalView } from './move-in-view'
import { erasurePanels, subjectPreview } from './erasure-view'
import { applyReviewed, DoorRefusal, undoPlan, uploadAndPlan } from './move-in'
import { connectionsView } from './connections'
import { providerConsentView } from './provider-consent'
import { dataFlowsPanel } from './data-flows'
import { approvalsView, workflowRunView } from './workflow-run'
import { editorView } from './editor'
import { runGraphs, workflowData } from './workflow-data'
import { skillsView, skillView } from './skills'
import { recurringApi } from '../agents/recurring-api'
import { recurringPanel, recurringTaskView } from './recurring'
import { authoringCreateView, authoringInput, authoringPath, authoringView } from './authoring'

const redirect = (location:string) => new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
// A form may name where to return after its action: a path inside the app, nothing else.
const safeReturn = (value:unknown) => typeof value==='string' && /^\/app(\/[A-Za-z0-9/_.-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/.test(value) ? value : null
export async function productApi(request:Request,env:CrankEnv,nativeBrowser=false):Promise<Response|null> {
  return await recurringApi(request,env) ?? await clientApi(request,env) ?? await driftApi(request,env) ?? await customApi(request,env,nativeBrowser) ?? await followupApi(request,env) ?? await teamApi(request,env) ?? await versionedApi(request,env) ?? await importDoor(request,env) ?? await importApi(request,env) ?? await dataApi(request,env) ?? await workflowApi(request,env) ?? await crankApi(request,env)
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
      return (path.startsWith('/auth/') ? await authResponse(forwarded,env) : await productApi(forwarded,env,true))!
    }
    const read = async (path:string) => { const response = await call(path), value:any = await response.json(); if(!response.ok) throw Object.assign(new Error(value.error ?? 'Unavailable'),{status:response.status}); return value }
    const page = async (title:string,content:string,options:any={},status=200) => {
      const state = options.state ?? await read('/api/crank/state'), waiting = await read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')
      return document(title,content,actor,status,{...options,state:undefined,approvals:state.runs.filter((r:any)=>r.state==='pending').length+waiting.runs.length})
    }
    const editorPage = async (id:string,params:URLSearchParams,preview?:unknown) => {
      const [data,state,waiting] = await Promise.all([workflowData(read,id,params,actor),read('/api/crank/state'),read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')])
      let customPicker=''
      const selected=findNode(data.workflow.draft,params.get('step')??'')??flatten(nodes(data.workflow.draft)).at(-1)
      if(actor.role==='owner' && ['native','dev'].includes(actor.kind) && selected?.step?.type==='custom.request') {
        const connector=await read(`/api/crank/custom-connectors/${encodeURIComponent(String(selected.step.connector_id))}/versions/${Number(selected.step.connector_version)}`)
        const operation=connector.definition.operations.find((op:any)=>op.id===selected.step!.operation)
        if(operation && Object.values(operation.inputs).some((input:any)=>input.resource)) {
          let result:any,error:string|undefined
          if(params.get('picker_run') && params.get('picker_input')) {
            const query=new URLSearchParams({workflow_id:id,step_path:selected.path,input_name:params.get('picker_input')!})
            const response=await call(`/api/crank/custom-connectors/pickers/${encodeURIComponent(params.get('picker_run')!)}?${query}`),value:any=await response.json()
            if(response.ok)result=value;else error=value.error??'Resource read was refused; load current names again.'
          }
          customPicker=customPickerPanel({workflowId:id,stepPath:selected.path,operation,values:selected.step.input as Record<string,unknown>??{},draftDigest:await digest(canonical(data.workflow.draft)),result,searchableInputs:Object.entries(operation.inputs).filter(([,input]:any)=>connector.definition.operations.find((op:any)=>op.id===input.resource?.operation)?.resource_page).map(([name])=>name),clearedInputs:params.get('cleared')?.split(','),resultInput:params.get('picker_input')??undefined,error})
        }
      }
      if (selected?.trigger?.type === 'app_poll' && (actor.role === 'owner' || ['admin','builder'].includes(actor.team?.role))) {
        let result:any, error:string|undefined
        if(params.get('watch_fields')) { const response=await call(`/api/crank/workflows/${encodeURIComponent(id)}/trigger/fields`);const value:any=await response.json();if(response.ok)result=value;else error=value.error }
        customPicker += watchedFieldsPanel(id,data.workflow.draft.trigger,result,error)
      }
      const view = editorView({...data,preview,customPicker,tokens:state.tokens ?? [],people:state.people ?? [],approvals:state.runs.filter((r:any)=>r.state==='pending').length+waiting.runs.length})
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
      if(url.pathname==='/app/custom-connectors/pickers' || url.pathname==='/app/custom-connectors/selection') {
        requireOwner(actor)
        const input=Object.fromEntries(['workflow_id','step_path','input_name','value','draft_digest','source_run_id','query','cursor_run_id'].filter(key=>form[key]!==undefined && form[key]!=='').map(key=>[key,form[key]]))
        const response=await call('/api/crank/custom-connectors/'+url.pathname.split('/').at(-1),input),result:any=await response.json()
        const back='/app/workflows/'+encodeURIComponent(form.workflow_id??'')+'?step='+encodeURIComponent(form.step_path??'')
        if(!response.ok)return page('Resource choice refused',`<p class="notice">${esc(result.error)}</p><a href="${esc(back)}">Return to this draft</a>`,{},response.status)
        return redirect(back+(result.run_id?'&picker_input='+encodeURIComponent(form.input_name??'')+'&picker_run='+encodeURIComponent(result.run_id):'')+(result.cleared_inputs?.length?'&cleared='+encodeURIComponent(result.cleared_inputs.join(',')):''))
      }
      if(url.pathname==='/app/custom-connectors/propose' || url.pathname==='/app/custom-connectors/install') {
        requireOwner(actor)
        let input:Record<string,unknown>
        try {
          if(url.pathname.endsWith('/propose')) input={openapi:JSON.parse(form.openapi ?? '')}
          else {
            const definition=JSON.parse(form.definition ?? '')
            input={definition,reviewed_digest:form.reviewed_digest,granted_scopes:definition.auth.scopes.filter((_:string,index:number)=>form['scope_'+index]==='true'),disclosure_confirmed:form.disclosure_confirmed==='true'}
          }
        } catch {return page('Invalid connector description','<p class="notice">Supply a complete JSON connector description.</p><a href="/app/connections">Return to connections</a>',{},400)}
        const response=await call(url.pathname.endsWith('/propose')?'/api/crank/custom-connectors/propose':'/api/crank/custom-connectors',input),result:any=await response.json()
        if(!response.ok)return page('Connector refused',`<p class="notice">${esc(result.error)}</p><a href="/app/connections">Return to connections</a>`,{},response.status)
        if(url.pathname.endsWith('/propose'))return page('Review connector',proposalReview({...result,source:form.openapi}))
        return redirect('/app/connections')
      }
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
        try { sample = form.sample_id ? undefined : JSON.parse(form.sample ?? '') } catch { return page('Invalid sample',`<p class="notice">The sample must be JSON.</p><a href="/app/workflows/${esc(id)}">Back to the flow</a>`,{},400) }
        const response = await call(`/api/crank/workflows/${encodeURIComponent(id)}/preview`,{sample,...(form.sample_id ? {sample_id:form.sample_id} : {})}), result:any = await response.json()
        if(!response.ok) return page('Preview refused',`<p class="notice">${esc(result.error)}</p><a href="/app/workflows/${esc(id)}">Back to the flow</a>`,{},response.status)
        return editorPage(id,new URLSearchParams({step:form.step ?? '',tab:'test'}),result)
      }
      if (url.pathname !== '/app/action' || (!/^\/api\/crank\/[A-Za-z0-9/_.%-]+$/.test(form.path ?? '') && !['/auth/invite','/auth/operator/status','/auth/operator/role'].includes(form.path))) return page('Not found','<a href="/app">Return to flows</a>',{},404)
      const path = form.path, back = safeReturn(form.return_to); delete form.path; delete form.return_to
      const authoringAction = /^\/api\/crank\/authoring(?:\/([^/]+)\/(revise|test|promote))?$/.exec(path)
      const authoringEstimate = form.authoring_id && path === '/api/crank/workflows/' + encodeURIComponent(form.authoring_id) + '/estimate'
      if(authoringAction || authoringEstimate) {
        requireOwner(actor)
        const id = authoringEstimate ? form.authoring_id : authoringAction?.[1] ? decodeURIComponent(authoringAction[1]) : null
        const connections = await read('/api/crank/connections')
        const review = async (error:string,status:number) => page(id ? 'Review generated workflow' : 'Create workflow', id ? authoringView(await read('/api/crank/authoring/' + encodeURIComponent(id)),connections,form,error) : authoringCreateView(connections,form,error,(await read('/api/crank/data/flows')).flows.find((flow:any)=>flow.kind==='authoring')), {section:'Skills',crumbs:[['Skills','/app/skills']]}, status)
        let input:Record<string,unknown>
        try { input = authoringInput(path,form) }
        catch(error:any) { return review(error.message,422) }
        const response = await call(path,input), result:any = await response.json()
        if(!response.ok) return review(result.error ?? 'This action was refused. Review the retained entries below.',response.status)
        return redirect(authoringPath(id ?? result.workflow_id))
      }
      const input:Record<string,unknown> = {...form}
      if(form.watch_selection==='true') {
        input.watched_fields=Object.entries(form).filter(([key])=>/^watch_\d+$/.test(key)).map(([,value])=>value);input.any_field=form.watch_mode==='any'
        for(const key of Object.keys(input))if(key.startsWith('watch_'))delete input[key]
      }
      const sampleRequest = /\/workflows\/[^/]+\/samples(?:\/[^/]+)?$/.test(path)
      if (sampleRequest) {
        try { if(form.sample) input.sample=JSON.parse(form.sample); if(form.fields !== undefined) input.fields=form.fields.split(',').map(field=>field.trim()).filter(Boolean) }
        catch { return page('Invalid sample','<p>Enter a JSON object for the sample.</p>',{},422) }
      }
      if(path.startsWith('/api/crank/gateways/') || path.startsWith('/api/crank/custom-connectors/')) {
        requireOwner(actor)
        try {
          if(form.connector_binding){const [id,version]=JSON.parse(form.connector_binding);input.connector_id=id;input.connector_version=version;delete input.connector_binding}
          for(const key of ['operations','destinations','readbacks','granted_scopes'])if(form[key])input[key]=JSON.parse(form[key])
        } catch{return page('Invalid connector selection','<p class="notice">Review the JSON selections and connector version.</p><a href="/app/connections">Return to connections</a>',{},400)}
      }
      if(path.startsWith('/api/crank/drift')) {
        requireOwner(actor)
        if(path.endsWith('/test')) { input.bindings=Object.fromEntries(Object.entries(form).filter(([key])=>key.startsWith('binding_')).map(([key,value])=>[key.slice(8),value])); for(const key of Object.keys(input))if(key.startsWith('binding_'))delete input[key] }
        if(form.business_meaning_confirmed) input.business_meaning_confirmed=form.business_meaning_confirmed==='true'
        try { for(const key of ['bindings','scopes']) if(form[key]) input[key]=JSON.parse(form[key]) } catch { return page('Invalid repair choices','<p>Review the account bindings and scopes.</p>',{},422) }
      }
      if(form.team_scope_form==='true') {
        for(const key of Object.keys(input)) if(key==='team_scope_form' || key.startsWith('workflow_') || key.startsWith('connection_')) delete input[key]
        input.workflow_ids=Object.keys(form).filter(key=>key.startsWith('workflow_') && form[key]==='true').map(key=>key.slice('workflow_'.length))
        input.connection_ids=Object.keys(form).filter(key=>key.startsWith('connection_') && form[key]==='true').map(key=>key.slice('connection_'.length))
      }
      if(form.followup_form==='true') {
        if(form.followup_wait) {const wait=JSON.parse(form.followup_wait);input.run_id=wait.run_id;input.path=wait.path;delete input.followup_wait}
        if(input.escalate_at==='') delete input.escalate_at
        for(const [prefix,key] of [['recipient_','recipient_ids'],['escalation_','escalation_ids']]) input[key]=Object.keys(form).filter(name=>name.startsWith(prefix) && form[name]==='true').map(name=>name.slice(prefix.length))
        for(const key of Object.keys(input)) if(key==='followup_form' || key.startsWith('recipient_') && key!=='recipient_ids' || key.startsWith('escalation_') && key!=='escalation_ids') delete input[key]
      }
      if(path.startsWith('/api/crank/followups/people/')) {
        input.weekdays=(form.weekdays ?? '').split(',').filter(Boolean).map(Number)
        input.holiday_dates=(form.holiday_dates ?? '').split(',').map(day=>day.trim()).filter(Boolean)
        if(form.interval_minutes!==undefined) input.interval_minutes=Number(form.interval_minutes)
        if(form.daily_limit!==undefined) input.daily_limit=Number(form.daily_limit)
      }
      if (/\/workflow-runs\/[^/]+\/approve$/.test(path)) {const edits=decisionEdits(form);if(edits) input.edits=edits}
      if (path === '/api/crank/regulated-operations/consent') { input.consent = form.consent === 'true'; input.credential_authority_generation = Number(form.credential_authority_generation) }
      for(const key of Object.keys(input)) if(key.startsWith('decision_edit_') || key.startsWith('decision_kind_')) delete input[key]
      if(path==='/api/crank/grants' || path==='/api/crank/mcp-clients') {
        requireOwner(actor)
        try { input.policy=JSON.parse(form.policy ?? ''); if(path==='/api/crank/mcp-clients') input.tools=JSON.parse(form.tools ?? '') } catch { return page('Invalid grant','<p>The grant policy must be JSON.</p><a href="/app/access">Return to access</a>',{},422) }
        input.version_id=(await read('/api/crank/workflows/'+encodeURIComponent(form.workflow_id))).published_version_id
      }
      if(form.service_account_scope_form==='true') {
        input.workflow_ids=Object.entries(form).filter(([key,value])=>key.startsWith('service_workflow_') && value==='true').map(([key])=>key.slice('service_workflow_'.length))
        input.connection_ids=Object.entries(form).filter(([key,value])=>key.startsWith('service_connection_') && value==='true').map(([key])=>key.slice('service_connection_'.length))
        input.expires_in_days=Number(form.expires_in_days)
        for(const key of Object.keys(input))if(key.startsWith('service_'))delete input[key]
      }
      if(form.recurring_form==='true') {
        delete input.recurring_form
        if(!input.skill_id) delete input.skill_id
        if(input.eval_cases) { try { input.eval_cases=JSON.parse(String(input.eval_cases)) } catch { return page('Invalid evaluation cases','<p class="notice">Enter evaluation cases as JSON.</p><a href="/app/recurring">Return to recurring skills</a>',{},422) } }
        if(input.objective_realm_id!==undefined) {
          input.objective={realm_id:input.objective_realm_id,invoice_id:input.objective_invoice_id,interval_minutes:Number(input.objective_interval_minutes)}
          for(const key of ['objective_realm_id','objective_invoice_id','objective_interval_minutes']) delete input[key]
        }
      }
      if(path.startsWith('/api/crank/skills')) requireOwner(actor)
      if(path==='/api/crank/skills') input.run_ids=(form.run_ids ?? '').split(',').map(id=>id.trim()).filter(Boolean)
      if(/^\/api\/crank\/workflows\/[^/]+\/rollback$/.test(path)) input.version=Number(form.version)
      if(form.maxParts !== undefined) input.maxParts=Number(form.maxParts)
      if(form.input) { try {input.input=JSON.parse(form.input)} catch {return page('Invalid event','<p>Event input must be a JSON object.</p><a href="/app">Return to flows</a>',{},400)} }
      if(form.graph) { try {input.graph=JSON.parse(form.graph)} catch {return page('Invalid workflow','<p class="notice">The workflow graph must be JSON.</p><a href="/app">Return to flows</a>',{},400)} }
      if(form.restore_snapshot) {
        input.restore_decisions = Object.fromEntries(Object.entries(form).filter(([key]) => key.startsWith('restore_run_')).map(([key, value]) => [key.slice('restore_run_'.length), value]))
        for (const key of Object.keys(input)) if (key.startsWith('restore_run_')) delete input[key]
      }
      if(form.sink_token) { input.secret={token:form.sink_token}; delete input.sink_token }
      if(form.disclosure_confirmed==='true')input.disclosure_confirmed=true
      if(form.confirm_business_outcome==='true') input.confirm_business_outcome=true
      if(form.step_path!==undefined && !sampleRequest && !/^\/api\/crank\/workflows\/[^/]+\/test$/.test(path)) { input.path=form.step_path; delete input.step_path }
      if (form.all !== undefined) input.all = form.all === 'true'
      if (Object.keys(form).some(key => /^hold_item_\d+$/.test(key))) {
        input.items = Object.entries(form).filter(([key]) => /^hold_item_\d+$/.test(key)).map(([,value]) => value)
        for (const key of Object.keys(input)) if (key.startsWith('hold_item_')) delete input[key]
      }
      if (form.items !== undefined) { try { input.items = JSON.parse(form.items) } catch { return page('Invalid selection', '<p>Select held items again.</p>', {}, 400) } }
      if (form.estimate_orchestration_usd_per_run !== undefined) {
        input.cost = { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: form[`estimate_${kind}_usd_per_run`], assumption: form[`estimate_${kind}_assumption`] })) }
        for (const key of Object.keys(input)) if (key.startsWith('estimate_') && key !== 'estimate_fingerprint') delete input[key]
      }
      if(input.reason==='') delete input.reason
      if(input.flow_id==='') delete input.flow_id
      if (/^\/api\/crank\/workflows\/[^/]+\/test$/.test(path) && form.step_path) {
        input.bindings = form.test_binding ? { [form.test_binding]: form.test_connection } : {}
        delete input.test_binding; delete input.test_connection
      }
      const response = await call(path,input)
      if(path==='/api/crank/data/export' && response.ok) return response
      const result:any = await response.json()
      if(response.status===403 && result.error==='step_up_required')return page('Confirm by email',gatewayConfirmation(),{},403)
      if(!response.ok) return page('Action refused',`<p class="notice">${esc(result.error)}</p><p>No success was reported. Review the latest state before retrying.</p><a href="${back ?? (path.includes('/imports')?'/app/import':'/app')}">Return to workspace</a>`,{},response.status)
      if(result.url && /\/samples\/listen$/.test(path)) return page('Waiting for webhook',`<section class="panel"><h2>Waiting for one sample</h2><p>Send a POST to this draft URL before ${esc(result.expires_at)}. The URL is shown once and never starts a production run.</p><label>Draft sample URL<input readonly value="${esc(result.url)}"></label><a class="btn btn-secondary" href="${esc(back ?? '/app')}">Refresh captured samples</a></section>`)
      if(result.code && path==='/api/crank/gateways')return page('Gateway enrollment',`<section class="panel"><h2>Enroll your gateway</h2><p>This code is shown once and expires ${esc(result.expires_at)}. Its authority is bound to environment ${esc(result.gateway.environment)}. Use the customer gateway CLI and save its state in a private file.</p><label>Single-use enrollment code<input type="text" autocomplete="off" readonly aria-label="Enrollment code" value="${esc(result.code)}"></label><p>Private database and storage credentials stay in the gateway manifest.</p><a href="/app/connections">Return to connections</a></section>`)
      if(result.credential && path==='/api/crank/mcp-clients') return page('Client server created',mcpCredentialView(result))
      if(result.credential) result.token=result.credential
      if(result.token) {
        const scopedService=path==='/api/crank/service-accounts'
        return page('Credential created',`<section class="panel"><p>Shown once. Save this in a private file for your agent. Crank stores only its hash.</p><label>Credential<input type="${scopedService?'text':'password'}" ${scopedService?'autocomplete="off" ':''}value="${esc(result.token)}" readonly aria-label="Credential"></label><p class="muted">${scopedService?'Select and copy this one-time credential into a private file. It can only read and prepare its named workflows.':'You can select and copy the hidden value. Do not share it in chat or commit it. Local dev credentials additionally need the local gate described in the README.'}</p><a class="btn btn-secondary" href="/app/access">Return to access</a></section>`)
      }
      if (result.held && (result.hold_id || result.holdId)) return redirect('/app/holds/' + encodeURIComponent(result.hold_id || result.holdId))
      if(path==='/api/crank/drift') return redirect('/app/drift/'+encodeURIComponent(result.proposal.id))
      if(path==='/api/crank/recurring-tasks') return redirect('/app/recurring/'+encodeURIComponent(result.id))
      if(path.startsWith('/api/crank/recurring-')) return redirect(back ?? '/app/recurring')
      if(path==='/api/crank/skills') return redirect('/app/skills/'+encodeURIComponent(result.id))
      if(back) return redirect(back)
      if(path.startsWith('/api/crank/imports')) return redirect('/app/import')
      if(path.startsWith('/api/crank/grants')) return redirect('/app/access')
      if(path.startsWith('/api/crank/followups')) return redirect('/app/followups')
      if(path.startsWith('/api/crank/team')) return redirect('/app/access')
      if(path.startsWith('/api/crank/tokens')) return redirect('/app/access')
      if(path.startsWith('/auth/')) return redirect('/app/access')
      if(path.startsWith('/api/crank/data')) return page('Data operation complete',`<p class="notice">${path.endsWith('/erase')?'The run and its dependent data have been erased. Existing destination effects remain there.':'Your archive has been restored. Every workflow is paused or draft and waits for your review at publish; flows are drafts and connections need reconnecting.'}</p>${restoreSummary(result)}<a href="/app">Return to flows</a>`)
      if(path.startsWith('/api/crank/workflow-runs/') || /^\/api\/crank\/workflows\/[^/]+\/(?:run|test)$/.test(path)) return redirect('/app/workflow-runs/'+encodeURIComponent(result.id))
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
      const reconciliation = owner && url.searchParams.get('reconcile') ? await read('/api/crank/workflow-runs/'+run.id+'/reconcile?'+new URLSearchParams({path:url.searchParams.get('reconcile')!})) : null
      return page('Workflow run',workflowRunView(run,workflow,graph,live,await read('/api/crank/connections'),actor,state.people ?? [],comparison,prior.runs,owner ? await read('/api/crank/notices/deliveries?run_id='+encodeURIComponent(run.id)) : [],reconciliation),{state,crumbs:[['Runs','/app/runs']]})
    }
    if(url.pathname==='/app/approvals') {
      const waiting = await read('/api/crank/workflow-runs?status=awaiting_approval&limit=100')
      const details = await Promise.all(waiting.runs.map(async (r:any)=>({run:await read('/api/crank/workflow-runs/'+r.id),workflow:await read('/api/crank/workflows/'+encodeURIComponent(r.workflow_id))})))
      return page('Approvals',approvalsView(state,details),{state,intro:'Decisions that only a person can make. Everything else runs on its own.'})
    }
    if(url.pathname==='/app/audit' && actor.team?.role==='auditor') return page('Audit history',`<section class="panel"><h2>Value-free audit history</h2><ul class="list">${(await read('/api/crank/audit')).map((row:any)=>`<li>${esc(row.at)} · ${esc(row.action)} · ${esc(row.subject_kind)}</li>`).join('')}</ul></section>`,{state})
    if(url.pathname==='/app/billing' && actor.team?.role==='billing') return page('Billing usage',`<section class="panel"><h2>Aggregate usage</h2><ul class="list">${(await read('/api/crank/reports/usage')).map((row:any)=>`<li>${esc(row.month)} · ${row.runs} runs · USD ${esc(unitsUsd(BigInt(row.accounted_units??'0')))} accounted usage</li>`).join('')}</ul></section>`,{state})
    if(url.pathname==='/app/account') { const session = await read('/auth/session'); return page('Account',accountView(session,owner,actor.team?.role),{state,intro:'Who is signed in on this browser, and what that role may do.'}) }
    if(url.pathname==='/app/gateway-confirmation')return page('Confirm by email',gatewayConfirmation(),{state})
    if(url.pathname==='/app/connections') {
      const nativeOwner=actor.role==='owner' && ['native','dev'].includes(actor.kind)
      const [connections,custom,gateways,accounts,workflows]=await Promise.all([read('/api/crank/connections'),nativeOwner?read('/api/crank/custom-connectors'):[],nativeOwner?read('/api/crank/gateways'):{gateways:[],grants:[]},nativeOwner?read('/api/crank/service-accounts'):[],nativeOwner?read('/api/crank/workflows'):[]])
      return page('Connections',connectionsView(connections,owner)+(nativeOwner?customConnectionsPanel(custom,gateways,true)+serviceAccountsPanel(accounts,workflows,[...connections,...gateways.gateways.filter((g:any)=>g.status==='active').map((g:any)=>({...g,id:gatewayScopeId(g.id)}))]):''),{state,intro:'The apps your workflows act on, each with one stored credential.'})
    }
    if(url.pathname==='/app/inbox') return page('Inbox',inboxPanel(await read('/api/crank/inbox')),{state,intro:'In-app requests addressed to you. The original workflow controls access and every decision.'})
    requireOwner(actor)
    if(url.pathname==='/app/authoring') {
      const [connections,disclosures] = await Promise.all([read('/api/crank/connections'),read('/api/crank/data/flows')])
      return page('Create workflow',authoringCreateView(connections,{},undefined,disclosures.flows.find((flow:any)=>flow.kind==='authoring')),{state,section:'Skills',crumbs:[['Skills','/app/skills']],intro:'Describe a business result, review the draft, then test and approve its exact version.'})
    }
    const authoringDetail = /^\/app\/authoring\/([^/]+)$/.exec(url.pathname)
    if(authoringDetail) {
      const [proposal,connections] = await Promise.all([read('/api/crank/authoring/' + encodeURIComponent(decodeURIComponent(authoringDetail[1]))),read('/api/crank/connections')])
      return page('Review generated workflow',authoringView(proposal,connections),{state,section:'Skills',crumbs:[['Skills','/app/skills']]})
    }
    const driftWorkflow=/^\/app\/workflows\/([^/]+)\/drift$/.exec(url.pathname), driftReview=/^\/app\/drift\/([^/]+)$/.exec(url.pathname)
    if(driftWorkflow) { const workflow=await read('/api/crank/workflows/'+driftWorkflow[1]); return page('Provider drift',driftListView(workflow,await read('/api/crank/drift')),{state,crumbs:[['Workflow','/app/workflows/'+workflow.id]]}) }
    if(driftReview) { const review=await read('/api/crank/drift/'+driftReview[1]); return page(review.proposal.kind==='scope'?'Review requested scopes':'Review mapping repair',driftReviewView(review,await read('/api/crank/connections')),{state}) }
    if(url.pathname==='/app/settings/mcp') {
      const selected=url.searchParams.get('client') ?? undefined
      const [clients,workflows,calls]=await Promise.all([read('/api/crank/mcp-clients'),read('/api/crank/workflows'),selected?read('/api/crank/mcp-clients/'+encodeURIComponent(selected)+'/calls'):[]])
      return page('AI clients',mcpClientsPanel(clients,workflows,calls,selected),{state,section:'Access',crumbs:[['Access','/app/access']]})
    }
    if(url.pathname==='/app/settings/provider-consent') {
      const connections=await read('/api/crank/connections')
      const disclosure=url.searchParams.get('connection_id') && url.searchParams.get('company_id') ? await read('/api/crank/regulated-operations?'+url.searchParams) : null
      return page('Provider consent',providerConsentView(connections,disclosure),{state,section:'Account',crumbs:[['Account','/app/account']]})
    }
    if(url.pathname==='/app/followups') {
      const [people,waiting,workflows,followups]=await Promise.all([read('/auth/operators'),read('/api/crank/workflow-runs?status=awaiting_approval&limit=100'),read('/api/crank/workflows'),read('/api/crank/followups')])
      const runs=await Promise.all(waiting.runs.map(async (run:any)=>({...await read('/api/crank/workflow-runs/'+encodeURIComponent(run.id)),workflow_name:workflows.find((w:any)=>w.id===run.workflow_id)?.name})))
      return page('Follow-ups',followupsPanel(followups,people as any[],runs),{state,intro:'Name native people and working hours for reminders. Only a person decides the waiting step.'})
    }
    if(url.pathname==='/app/recurring') {
      const [recurring,workflows,grants]=await Promise.all([read('/api/crank/recurring-skills'),read('/api/crank/workflows'),read('/api/crank/grants')])
      return page('Recurring invoice skills',recurringPanel(recurring.skills,recurring.tasks,workflows,grants),{state,section:'Skills',crumbs:[['Skills','/app/skills']]})
    }
    const recurringPath=/^\/app\/recurring\/([^/]+)$/.exec(url.pathname)
    if(recurringPath) {
      const [task,recurring,grants]=await Promise.all([read('/api/crank/recurring-tasks/'+encodeURIComponent(decodeURIComponent(recurringPath[1]))),read('/api/crank/recurring-skills'),read('/api/crank/grants')])
      return page('Recurring invoice task',recurringTaskView(task,recurring.skills,grants),{state,section:'Skills',crumbs:[['Skills','/app/skills'],['Recurring skills','/app/recurring']]})
    }
    if(url.pathname==='/app/skills') {
      const [proposals,workflows] = await Promise.all([read('/api/crank/skills'),read('/api/crank/workflows')])
      return page('Skills',skillsView(proposals,workflows),{state,intro:'Review retained exceptions and corrections, then stage reusable normalizations for an owner to publish.'})
    }
    const skillPath = /^\/app\/skills\/([^/]+)$/.exec(url.pathname)
    if(skillPath) return page('Normalization proposal',skillView(await read('/api/crank/skills/'+encodeURIComponent(decodeURIComponent(skillPath[1])))),{state,section:'Skills',crumbs:[['Skills','/app/skills']]})
    if(url.pathname==='/app/operations') {
      const workflows = await read('/api/crank/workflows')
      const choices = [...workflows, ...state.flows.map((flow:any) => ({ ...flow, kind: 'flow' }))]
      return page('Operations', usageView(await read('/api/crank/reports/usage?' + url.searchParams), choices) + operationsView(await read('/api/crank/reports/operations?' + url.searchParams), workflows, url.searchParams), {state,intro:'Execution health, business obligations and delivery to your own logs.'})
    }
    const heldPath = /^\/app\/holds\/([^/]+)$/.exec(url.pathname)
    if (heldPath) return page('Held work', usageHoldView(await read('/api/crank/holds/' + encodeURIComponent(heldPath[1]))), {state})
    if(url.pathname==='/app/access') {const response=await call('/auth/operators'), people=response.ok?await response.json():[]; return page('Access','<section class="panel"><h2>AI clients</h2><a href="/app/settings/mcp">Manage client tool servers</a></section>'+accessView({...state,people})+teamPanel(await read('/api/crank/team'),people as any[],await read('/api/crank/workflows'),[...await read('/api/crank/connections'),...(actor.role==='owner'?(await read('/api/crank/gateways')).gateways.filter((g:any)=>g.status==='active').map((g:any)=>({...g,id:gatewayScopeId(g.id)})):[])])+grantsPanel(await read('/api/crank/grants'),await read('/api/crank/workflows'),people as any[]),{state,intro:'Credentials for agents and sending apps, and the people who can sign in.'})}
    if(url.pathname==='/app/data') { const [retention,workflows,flows] = await Promise.all([read('/api/crank/data/retention'),read('/api/crank/workflows'),read('/api/crank/data/flows')]); return page('Data',dataFlowsPanel(flows)+dataView()+retentionPanels(retention,workflows)+sensitivePanel(retention.sensitive,workflows)+encryptionPanel(retention.sensitive)+erasurePanels((people=>Array.isArray(people)?people:people.operators??[])(await read('/auth/operators'))),{state,intro:'Export, restore and erase. Your data stays on this installation.'}) }
    if(url.pathname==='/app/import') { const jobs=await call('/api/crank/imports'); if(!jobs.ok) throw new Error('Import journal unavailable'); return page('Move in',importView(await jobs.json() as any[],await read('/api/operator/import-settings')),{state,intro:'Bring workflows from another tool as drafts you review first.'}) }
    return page('Not found','<a href="/app">Return to flows</a>',{state},404)
  } catch(error:any) {
    if(error.status===401) return redirect('/signin?returnTo='+encodeURIComponent(url.pathname))
    return document('Unable to continue',`<p class="notice">${esc(error.status?error.message:'This operation could not be confirmed. Return to the workspace and inspect its current state.')}</p><a href="/app">Return to flows</a>`,actor,error.status || 400)
  }
}
