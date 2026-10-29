import { esc, hidden } from '../document'
import type { Graph } from '../../engine/graph'
import type { Step } from '../../engine/types'
import { isObject } from '../../engine/values'
import { destinations, EDIT_OPERATORS, namedFields, nativeGraph, NATIVE_TYPES, positionOf, reference, type NamedField } from './native'

export interface EditFeedback { form: Record<string,string>; field: string; message: string }
export interface NativeContext { workflowId: string; graph: Graph; digest: string; feedback?: EditFeedback }
type Values = Record<string, unknown>
let serial = 0
function builder(ctx: NativeContext, operation: string, identity: Values = {}) {
  const fields = {operation,...identity}, submitted = ctx.feedback?.form
  const active = submitted && Object.entries(fields).every(([key,value]) => String(value) === submitted[key])
  const error = active ? ctx.feedback : undefined
  const formId = 'native-' + ++serial
  const value = (key: string, fallback: unknown) => active && submitted[key] !== undefined ? submitted[key] : fallback
  const input = (key: string, label: string, initial: unknown, attrs = '') => {
    const invalid = error?.field === key, errorId = formId + '-' + key + '-error'
    return `<label for="${formId}-${key}">${esc(label)}</label><input id="${formId}-${key}" name="${key}" value="${esc(value(key,initial))}" ${attrs}${invalid ? ` aria-invalid="true" aria-describedby="${errorId}"` : ''}>${invalid ? `<p class="field-error" id="${errorId}">${esc(error.message)}</p>` : ''}`
  }
  const select = (key: string, label: string, initial: unknown, options: {value:string;label:string}[]) => {
    const invalid = error?.field === key, errorId = formId + '-' + key + '-error'
    return `<label for="${formId}-${key}">${esc(label)}</label><select id="${formId}-${key}" name="${key}"${invalid ? ` aria-invalid="true" aria-describedby="${errorId}"` : ''}>${options.map(o=>`<option value="${esc(o.value)}"${String(value(key,initial))===o.value?' selected':''}>${esc(o.label)}</option>`).join('')}</select>${invalid ? `<p class="field-error" id="${errorId}">${esc(error.message)}</p>` : ''}`
  }
  const form = (body: string, label: string, danger=false) => `<form class="native-form" method="post" action="/app/workflows/${esc(ctx.workflowId)}/edit" novalidate>${hidden('draft_digest',ctx.digest)}${Object.entries(fields).map(([k,v])=>hidden(k,v)).join('')}${error && !body.includes('aria-invalid') ? `<p role="alert" class="field-error">${esc(error.message)}</p>` : ''}${body}<button class="btn btn-${danger?'danger':'secondary'} btn-small">${esc(label)}</button></form>`
  return {input,select,form}
}
const options = (items: Record<string,string>) => Object.entries(items).map(([value,label])=>({value,label}))
function valueControls(b: ReturnType<typeof builder>, value: unknown, fields: NamedField[]) {
  const ref=reference(value), literal=isObject(value) && '$literal' in value?value.$literal:value
  const type=ref?'field':literal===null?'null':typeof literal==='number'?'number':typeof literal==='boolean'?'boolean':'text'
  return b.select('value_kind','Value type',type,options({text:'Text',number:'Number',boolean:'Boolean',null:'Null',field:'Named field'}))+
    b.input('value','Literal value',ref?'':literal===null?'':String(literal??''),'maxlength="4000"')+
    b.select('reference','Named source field',ref??'',[{value:'',label:'Choose an earlier field'},...fields.map(f=>({value:f.ref,label:f.label+' · '+f.kind}))])
}
export function addStepPanel(ctx: NativeContext) {
  if(!nativeGraph(ctx.graph))return ''
  const b=builder(ctx,'add'), selected=ctx.feedback?.form.operation==='add'
  return `<details class="panel native-add"${selected?' open':''}><summary>Add step</summary><p>Choose a connection by step or route name. Changes stay in the draft.</p>${b.form(
    b.select('type','Step type','map',options(NATIVE_TYPES))+
    b.select('after','Connect after',destinations(ctx.graph).at(-1)!.value,destinations(ctx.graph)), 'Add step')}</details>`
}
function conditionControls(ctx: NativeContext, step: Step, holder: any, branch?: string) {
  const fields=namedFields(ctx.graph,step.id), identity={step:step.id,...(branch?{branch}:{})}
  const groups=holder.when as any[][]
  return groups.map((group,g)=>`<fieldset class="native-rules"><legend>${g?'OR group '+(g+1):'When'}</legend>${group.map((rule,r)=>{
    const b=builder(ctx,'rule',{...identity,group:g,rule:r}), remove=builder(ctx,'remove-rule',{...identity,group:g,rule:r})
    const supported=rule.op in EDIT_OPERATORS && fields.some(f=>f.ref===rule.field) && (rule.value===undefined || reference(rule.value) || rule.value===null || typeof rule.value!=='object' || isObject(rule.value)&&'$literal' in rule.value)
    return `<details${ctx.feedback?.form.operation==='rule' && ctx.feedback.form.step===step.id?' open':''}><summary>${r?'AND · ':''}${esc(fields.find(f=>f.ref===rule.field)?.label??'Existing condition')} · ${esc(EDIT_OPERATORS[rule.op]??rule.op)}</summary>${supported?b.form(
      b.select('source','Condition field',rule.field,fields.map(f=>({value:f.ref,label:f.label+' · '+f.kind})))+
      b.select('operator','Condition',rule.op,options(EDIT_OPERATORS))+
      valueControls(b,rule.value,fields),'Save condition'):'<p>This existing condition is preserved. Its advanced options are outside the native controls.</p>'}${remove.form('','Remove condition',true)}</details>`
  }).join('')}${builder(ctx,'add-rule',{...identity,group:g}).form('','Add AND condition')}</fieldset>`).join('')+
    builder(ctx,'add-group',identity).form('','Add OR group')
}
export function nativeSettings(ctx: NativeContext, step: Step | null) {
  if(!step || !nativeGraph(ctx.graph))return ''
  const fields=namedFields(ctx.graph,step.id), b=builder(ctx,'save-step',{step:step.id})
  let body=b.input('name','Step name',step.name??NATIVE_TYPES[step.type as keyof typeof NATIVE_TYPES],'maxlength="80" required')
  if(step.type==='delay')body+=b.input('amount','Delay amount',(step.input as any)?.amount??0,'type="number" min="0" step="1" required')+b.select('unit','Delay unit',(step.input as any)?.unit??'seconds',options({seconds:'Seconds',minutes:'Minutes',hours:'Hours',days:'Days'}))
  if(step.type==='respond')body+=b.input('status','Response status',(step.input as any)?.status??200,'type="number" min="200" max="599" required')+valueControls(b,(step.input as any)?.body,fields)
  if(step.type==='paths')body+=b.select('mode','Matching routes',step.mode,options({exclusive:'First matching route',parallel:'All matching routes'}))+b.select('otherwise','Extra route',step.fallback?'fallback':step.always?'always':'none',options({fallback:'Fallback when none match',always:'Always run',none:'No extra route'}))
  let settings=b.form(body,'Save step')
  if(step.type==='map' && isObject(step.input)) {
    const row=(key:string,value:unknown) => {
      const b=builder(ctx,'field',{step:step.id,key}), remove=builder(ctx,'remove-field',{step:step.id,key})
      const supported=value===null || typeof value!=='object' || reference(value) || isObject(value)&&'$literal' in value && (value.$literal===null || typeof value.$literal!=='object')
      return `<details${ctx.feedback?.form.operation==='field' && ctx.feedback.form.key===key?' open':''}><summary>${esc(key||'Add a field')}</summary>${supported?b.form(b.input('field_name','Field name',key,'maxlength="40" required')+valueControls(b,value,fields),key?'Save field':'Add field'):'<p>Existing structured mapping preserved.</p>'}${key?remove.form('','Remove field',true):''}</details>`
    }
    settings+=`<h3>Mapped output fields</h3>${Object.entries(step.input).map(([k,v])=>row(k,v)).join('')}${row('','')}`
  }
  if(step.type==='filter')settings+=conditionControls(ctx,step,step)
  if(step.type==='paths') {
    settings+=(step.branches as any[]).map(branch=>{
      const rename=builder(ctx,'rename-branch',{step:step.id,branch:branch.id})
      return `<details class="native-route"${ctx.feedback?.form.branch===branch.id?' open':''}><summary>${esc(branch.name??branch.id)}</summary>${rename.form(rename.input('branch_name','Route name',branch.name??branch.id,'maxlength="80" required'),'Rename route')}${conditionControls(ctx,step,branch,branch.id)}${builder(ctx,'branch-up',{step:step.id,branch:branch.id}).form('','Route earlier')}${builder(ctx,'branch-down',{step:step.id,branch:branch.id}).form('','Route later')}${builder(ctx,'remove-branch',{step:step.id,branch:branch.id}).form('<p>Removing this route also removes its draft steps.</p>','Remove route',true)}</details>`
    }).join('')
    const branch=builder(ctx,'add-branch',{step:step.id})
    settings+=branch.form(branch.input('branch_name','New route name','','maxlength="80" required'),'Add route')
  }
  const move=builder(ctx,'move',{step:step.id})
  settings+=`<details><summary>Order and connections</summary>${move.form(move.select('after','Connect after',positionOf(ctx.graph,step.id),destinations(ctx.graph,step.id)),'Connect step')}<div class="native-actions">${builder(ctx,'up',{step:step.id}).form('','Move earlier')}${builder(ctx,'down',{step:step.id}).form('','Move later')}</div>${builder(ctx,'remove',{step:step.id}).form('<p>Remove this step and any routes it contains from the draft.</p>','Remove step',true)}</details>`
  return `<section class="inspector-block native-settings" id="native-settings"><h3>Step settings</h3><p>Saved changes do not run or change a published version.</p>${settings}</section>`
}
