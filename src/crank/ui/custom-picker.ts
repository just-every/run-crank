import type { CustomOperation } from '../custom/definition'
import { esc, hidden } from './document'
import { rowLabel } from './editor/model'

type PickerResult={run_id:string;status:string;draft_digest:string;options:{value:string;label:string;context?:string}[];loaded_at:string;query:string;has_next_page:boolean;error?:string}
interface PickerView {workflowId:string;stepPath:string;operation:CustomOperation;values:Record<string,unknown>;draftDigest:string;result?:PickerResult;resultInput?:string;searchableInputs?:string[];clearedInputs?:string[];error?:string}

/** Names are loaded only after the owner asks. Reading this panel never calls a provider. */
export function customPickerPanel(view:PickerView) {
  const resources=Object.entries(view.operation.inputs).filter(([,input])=>input.resource)
  if(!resources.length)return ''
  const parents=new Set(resources.flatMap(([,input])=>Object.values(input.resource!.parents??{})))
  const valueOf=(name:string)=>{const value=view.values[name];return value && typeof value==='object' && '$literal' in value?(value as {$literal:unknown}).$literal:value}
  const common=(name:string)=>hidden('workflow_id',view.workflowId)+hidden('step_path',view.stepPath)+hidden('input_name',name)
  const custom=(name:string,disabled=false)=>`<form class="form-row" method="post" action="/app/custom-connectors/selection">${common(name)}${hidden('draft_digest',view.draftDigest)}<label>Custom ${esc(rowLabel(name))}<input name="value" required maxlength="8192"${disabled?' disabled':''} value="${esc(typeof valueOf(name)==='string'?valueOf(name):'')}"></label><button class="btn btn-secondary"${disabled?' disabled':''}>Use custom ${esc(rowLabel(name))}</button></form>`
  const fields=resources.map(([name,input])=>{
    const label=rowLabel(name),result=view.resultInput===name?view.result:undefined
    const parentNames=Object.values(input.resource!.parents??{})
    const missing=parentNames.filter(parent=>valueOf(parent)===undefined || valueOf(parent)==='')
    const disabled=missing.length?' disabled':''
    const back=`/app/workflows/${encodeURIComponent(view.workflowId)}?step=${encodeURIComponent(view.stepPath)}&picker_input=${encodeURIComponent(name)}&picker_run=${encodeURIComponent(result?.run_id??'')}`
    const loaded=result?.status==='succeeded'?`<form class="form-row" method="post" action="/app/custom-connectors/selection">${common(name)}${hidden('draft_digest',result.draft_digest)}${hidden('source_run_id',result.run_id)}<label>Choose ${esc(label)}<select name="value" required><option value="">Choose a current name</option>${result.options.map(option=>`<option value="${esc(option.value)}"${option.value===valueOf(name)?' selected':''}>${esc(option.label)} — ${esc(option.value)}${option.context?` — ${esc(option.context)}`:''}</option>`).join('')}</select></label>${result.options.length?'':'<p class="muted">The account returned no resources for these parent choices.</p>'}<button class="btn btn-secondary"${result.options.length?'':' disabled'}>Use ${esc(label)}</button></form>`
      :result?(['queued','running','waiting'].includes(result.status)?`<p class="muted">Resource read: ${esc(result.status)}. A private gateway may still be completing it.</p><a class="btn btn-secondary" href="${esc(back)}">Check loaded ${esc(label)}</a>`:`<p class="notice">${esc(result.error??'Resource read '+result.status+'. Inspect the run, then load current names again.')}</p>`):''
    const paging=result?.status==='succeeded'?`<p class="muted">Loaded <time datetime="${esc(result.loaded_at)}">${esc(result.loaded_at)}</time>${result.query?` · Search: ${esc(result.query)}`:''}. Names reflect this read.</p>${result.has_next_page?`<form method="post" action="/app/custom-connectors/pickers">${common(name)}${hidden('cursor_run_id',result.run_id)}<button class="btn btn-secondary">Next ${esc(label)} page</button></form>`:''}`:''
    const search=view.searchableInputs?.includes(name)?`<label>Search ${esc(label)}<input name="query" maxlength="200" value="${esc(result?.query??'')}"${disabled}></label>`:''
    return `<section class="inspector-block"><h3>${esc(label)}</h3><p class="muted">Current value: ${esc(typeof valueOf(name)==='string'?valueOf(name):'Not chosen')}</p>${parentNames.length?`<p class="muted">Depends on ${esc(parentNames.map(rowLabel).join(', '))}. Changing a parent clears this choice.</p>`:''}<form method="post" action="/app/custom-connectors/pickers">${common(name)}${search}<button class="btn btn-secondary"${disabled}>Load current ${esc(label)}</button></form>${missing.length?`<p class="notice">Choose ${esc(missing.map(rowLabel).join(', '))} first.</p>`:''}${paging}${loaded}${custom(name,!!missing.length)}</section>`
  }).join('')
  const literalParents=[...parents].filter(name=>!view.operation.inputs[name].resource && view.operation.inputs[name].type==='string').map(name=>`<section class="inspector-block"><h3>${esc(rowLabel(name))}</h3>${custom(name)}</section>`).join('')
  return `<section class="panel"><h2>Choose account resources</h2><p class="muted">Load names from the reviewed connector and current account. Choices update this draft; publishing stays a separate decision.</p>${view.clearedInputs?.length?`<p class="notice">Cleared dependent choices: ${esc(view.clearedInputs.map(rowLabel).join(', '))}. Load names for the new parent.</p>`:''}${view.error?`<p class="notice">${esc(view.error)}</p>`:''}${literalParents}${fields}${view.result?`<p><a href="/app/workflow-runs/${esc(encodeURIComponent(view.result.run_id))}">Inspect resource read</a></p>`:''}</section>`
}
