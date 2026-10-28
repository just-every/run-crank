import { branchesOf, validateGraph, type Graph } from '../../engine/graph'
import type { Step } from '../../engine/types'
import { isObject } from '../../engine/values'
import { id } from '../../model'

export const NATIVE_TYPES = { map: 'Map fields', filter: 'Filter', paths: 'Paths', delay: 'Delay', respond: 'Respond' } as const
type NativeType = keyof typeof NATIVE_TYPES
export class EditError extends Error {
  status = 422
  constructor(public field: string, message: string) { super(message) }
}
const fail = (field: string, message: string): never => { throw new EditError(field, message) }
const generated = () => 's_' + id().replaceAll('-', '').slice(0, 30)
const title = (value: string | undefined, field = 'name') => {
  if (!value?.trim() || value.length > 80) return fail(field, 'Enter a name of 1 to 80 characters.')
  return value.trim()
}
interface Location { step: Step; list: Step[]; index: number; path: string }
export function locations(graph: Graph): Location[] {
  const walk = (list: Step[], prefix = ''): Location[] => list.flatMap((step, index) => [
    { step, list, index, path: prefix + step.id },
    ...(step.type === 'paths' ? branchesOf(step).flatMap(b => walk(b.steps, prefix + step.id + '/' + b.id + '/')) : []),
  ])
  return walk(graph.steps)
}
export const nativeGraph = (graph: Graph) => graph.trigger.type === 'manual' && locations(graph).every(({step}) => Object.hasOwn(NATIVE_TYPES,step.type) && (step.type !== 'delay' || step.mode === 'for'))

type Kind = 'text' | 'number' | 'boolean' | 'null' | 'object' | 'list'
export interface NamedField { ref: string; label: string; kind: Kind }
const kindOf = (value: unknown): Kind => value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' ? 'object' : 'text'
export const reference = (value: unknown): string | null => isObject(value) && typeof value.$ref === 'string' ? value.$ref : typeof value === 'string' ? /^\{\{\s*([\w.\-[\]]+)\s*\}\}$/.exec(value)?.[1] ?? null : null

/** Only declared outputs that are guaranteed earlier on this route are offered.
 * A sibling route never supplies an unconditional mapping source. */
export function namedFields(graph: Graph, target: string): NamedField[] {
  let found: NamedField[] = []
  const walk = (steps: Step[], incoming: NamedField[]) => {
    const fields = [...incoming]
    for (const step of steps) {
      if (step.id === target) { found = fields; return true }
      const name = String(step.name ?? NATIVE_TYPES[step.type as NativeType] ?? step.type)
      if (step.type === 'paths') {
        fields.push({ref:'steps.' + step.id + '.matched',label:name + ' · matched routes',kind:'list'})
        for (const branch of branchesOf(step)) if (walk(branch.steps, fields)) return true
      }
      if (step.type === 'map' && isObject(step.input)) {
        const leaves = (value: unknown, path: string, label: string, depth = 0) => {
          if (depth > 8) return
          const ref = reference(value), literal = isObject(value) && '$literal' in value ? value.$literal : value
          if (ref) fields.push({ref: path, label, kind: fields.find(f => f.ref === ref)?.kind ?? 'text'})
          else if (isObject(literal) && !('$fn' in literal)) {
            fields.push({ref: path, label, kind: 'object'})
            for (const [key, item] of Object.entries(literal)) if (/^[\w-]+$/.test(key)) leaves(item, path + '.' + key, label + ' · ' + key, depth + 1)
          } else fields.push({ref: path, label, kind: kindOf(literal)})
        }
        for (const [key, value] of Object.entries(step.input)) if (/^[\w-]+$/.test(key)) leaves(value, 'steps.' + step.id + '.' + key, name + ' · ' + key)
      }
      if (step.type === 'filter') fields.push({ref:'steps.' + step.id + '.passed',label:name + ' · passed',kind:'boolean'})
      if (step.type === 'delay') for (const key of ['due_at','released_at']) fields.push({ref:'steps.' + step.id + '.' + key,label:name + ' · ' + key.replaceAll('_',' '),kind:'text'})
      if (step.type === 'respond') {
        const body = (step.input as Record<string, unknown> | undefined)?.body, ref = reference(body)
        const kind = ref ? fields.find(f => f.ref === ref)?.kind ?? 'text' : kindOf(isObject(body) && '$literal' in body ? body.$literal : body ?? null)
        fields.push({ref:'steps.' + step.id + '.status',label:name + ' · status',kind:'number'}, {ref:'steps.' + step.id + '.body',label:name + ' · body',kind})
      }
    }
    return false
  }
  walk(graph.steps, [{ref:'run.id',label:'Run · identifier',kind:'text'}])
  return found
}
export function destinations(graph: Graph, exclude?: string) {
  const out = [{value:'start',label:'Start of workflow'}]
  const excluded = new Set<string>()
  const selected = locations(graph).find(l => l.step.id === exclude)
  if (selected) for (const l of locations({trigger:graph.trigger,steps:[selected.step]})) excluded.add(l.step.id)
  for (const {step} of locations(graph)) {
    if (excluded.has(step.id)) continue
    out.push({value:'after:' + step.id,label:'After ' + String(step.name ?? NATIVE_TYPES[step.type as NativeType])})
    if (step.type === 'paths') for (const branch of branchesOf(step)) out.push({value:'branch:' + step.id + ':' + branch.id,label:String(step.name ?? 'Paths') + ' → ' + branch.name + ' · start'})
  }
  return out
}
export function positionOf(graph: Graph, target: string) {
  const l = locations(graph).find(l => l.step.id === target)!
  if (l.index) return 'after:' + l.list[l.index - 1].id
  if (l.list === graph.steps) return 'start'
  for (const {step} of locations(graph)) if (step.type === 'paths') for (const b of branchesOf(step)) if (b.steps === l.list) return 'branch:' + step.id + ':' + b.id
  return 'start'
}
function insert(graph: Graph, step: Step, destination: string) {
  if (!destinations(graph).some(d => d.value === destination)) return fail('after', 'Choose a current connection.')
  if (destination === 'start') { graph.steps.unshift(step); return }
  const [kind, target, branch] = destination.split(':')
  const at = locations(graph).find(l => l.step.id === target)!
  if (kind === 'after') at.list.splice(at.index + 1, 0, step)
  else branchesOf(at.step).find(b => b.id === branch)!.steps.unshift(step)
}
export const EDIT_OPERATORS: Record<string, string> = {
  'text.equals':'Text equals', 'text.not_equals':'Text differs', 'text.contains':'Text contains', 'text.starts_with':'Text starts with',
  'number.eq':'Number equals', 'number.gt':'Number greater than', 'number.gte':'Number at least', 'number.lt':'Number less than', 'number.lte':'Number at most',
  'boolean.is_true':'Boolean is true', 'boolean.is_false':'Boolean is false', exists:'Has a value', not_exists:'Has no value', is_empty:'Is empty', not_empty:'Is not empty',
}
function valueOf(form: Record<string,string>, fields: NamedField[]): unknown {
  if (form.value_kind === 'field') {
    if (!fields.some(f => f.ref === form.reference)) return fail('reference', 'Choose an earlier named field on this route.')
    return {$ref:form.reference}
  }
  if (form.value_kind === 'null') return null
  if (form.value_kind === 'boolean') {
    if (!['true','false'].includes(form.value ?? '')) return fail('value', 'Choose true or false.')
    return form.value === 'true'
  }
  if (form.value_kind === 'number') {
    if (!form.value?.trim() || !Number.isFinite(Number(form.value))) return fail('value', 'Enter a finite number.')
    return Number(form.value)
  }
  if (form.value_kind !== 'text') return fail('value_kind', 'Choose a value type.')
  if ((form.value ?? '').length > 4000) return fail('value', 'Text is limited to 4000 characters.')
  // Text entered in a literal control is data, even when it resembles a mapping.
  return {$literal:form.value ?? ''}
}
function ruleOf(form: Record<string,string>, fields: NamedField[]) {
  const source = fields.find(f => f.ref === form.source)
  if (!source) return fail('source', 'Choose an earlier named field on this route.')
  const op = form.operator
  if (!Object.hasOwn(EDIT_OPERATORS,op)) return fail('operator', 'Choose a supported condition.')
  const family = op.split('.')[0], expected = family === 'text' ? 'text' : family
  if (['text','number','boolean'].includes(family) && source.kind !== expected) return fail('operator', 'Choose a condition matching the field type: ' + source.kind + '.')
  if (family === 'boolean') return {field:source.ref,op,value_type:'boolean'}
  if (!op.includes('.')) return {field:source.ref,op}
  const value = valueOf(form, fields), ref = reference(value), literal = isObject(value) && '$literal' in value ? value.$literal : value
  const rightKind = ref ? fields.find(f => f.ref === ref)!.kind : kindOf(literal)
  if (rightKind !== expected) return fail('value_kind', 'The comparison value must be ' + expected + '.')
  return {field:source.ref,op,value,value_type:family === 'text' ? 'string' : 'number'}
}
function links(graph: Graph, editField: string) {
  for (const {step} of locations(graph)) {
    const fields = namedFields(graph, step.id), available = new Set(fields.map(f => f.ref))
    const conditions = (groups: unknown) => {
      if (!Array.isArray(groups)) return
      for (const group of groups) for (const rule of group) {
        const expected = rule.value_type === 'string' ? 'text' : rule.value_type
        if (!expected) continue
        const left = fields.find(f => f.ref === rule.field), right = fields.find(f => f.ref === reference(rule.value))
        if (left && left.kind !== expected || right && right.kind !== expected) fail(editField, 'This change would invalidate a typed condition in ' + String(step.name ?? step.type) + '. Update that condition first.')
      }
    }
    const check = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(check); return }
      if (isObject(value) && '$literal' in value) return
      const ref = reference(value)
      if (ref?.startsWith('steps.') && !available.has(ref)) fail('after', 'This change disconnects a field used by ' + String(step.name ?? step.type) + '. Reconnect its mapping first.')
      if (isObject(value)) {
        if (typeof value.field === 'string' && value.field.startsWith('steps.') && !available.has(value.field)) fail('after','This change disconnects a condition in ' + String(step.name ?? step.type) + '.')
        Object.values(value).forEach(check)
      }
      if (typeof value === 'string') for (const match of value.matchAll(/\{\{\s*(steps\.[\w.\-[\]]+)\s*\}\}/g)) if (!available.has(match[1])) fail('after', 'This change disconnects a mapped field. Reconnect it first.')
    }
    check(step.input)
    check(step.when); conditions(step.when)
    if (step.type === 'paths') for (const branch of branchesOf(step)) {check(branch.when); conditions(branch.when)}
  }
}
const defaultRule = () => [[{field:'run.id',op:'exists'}]]

/** Edits build a new graph only. The caller saves via the authorized draft API. */
export function editNative(source: Graph, form: Record<string,string>): {graph: Graph; selected: string} {
  if (!nativeGraph(source)) return fail('operation', 'This editor supports manual workflows with native map, filter, paths, delay and respond steps.')
  const graph = structuredClone(source), operation = form.operation
  const location = locations(graph).find(l => l.step.id === form.step)
  let selected = form.step ?? 'trigger'
  if (operation === 'add') {
    if (!Object.hasOwn(NATIVE_TYPES,form.type)) return fail('type','Choose a native step type.')
    const type = form.type as NativeType, step:Step = {id:generated(),type,name:NATIVE_TYPES[type]}
    if (type === 'map') step.input = {}
    if (type === 'filter') step.when = defaultRule()
    if (type === 'paths') { step.mode='exclusive'; step.branches=[{id:generated(),name:'Matching route',when:defaultRule(),steps:[]}]; step.fallback={steps:[]} }
    if (type === 'delay') { step.mode='for'; step.input={amount:0,unit:'seconds'} }
    if (type === 'respond') step.input={status:200,body:{$literal:''}}
    insert(graph,step,form.after)
    selected=step.id
  } else {
    if (!location) return fail('step','Select a current step.')
    const {step,list,index} = location, fields = namedFields(graph,step.id)
    if (operation === 'remove') { list.splice(index,1); selected='trigger' }
    else if (operation === 'move') {
      if (!destinations(graph, step.id).some(d=>d.value===form.after)) return fail('after','A step cannot connect to itself or one of its descendants.')
      list.splice(index,1);insert(graph,step,form.after)
    } else if (operation === 'up' || operation === 'down') {
      const next=index+(operation==='up'?-1:1)
      if (next<0 || next>=list.length) return fail('after','This step is already at the end of this route.')
      ;[list[index],list[next]]=[list[next],list[index]]
    } else if (operation === 'save-step') {
      step.name=title(form.name)
      if (step.type === 'delay') {
        const amount=Number(form.amount), units:Record<string,number>={seconds:1,minutes:60,hours:3600,days:86400}
        if (!form.amount?.trim() || !Number.isSafeInteger(amount) || amount<0 || !units[form.unit] || amount*units[form.unit]>366*86400) return fail('amount','Choose a whole duration from zero to 366 days.')
        step.mode='for';step.input={...step.input as object,amount,unit:form.unit}
      }
      if (step.type === 'respond') {
        const status=Number(form.status)
        if (!/^\d{3}$/.test(form.status) || status<200 || status>599) return fail('status','Choose a response status from 200 to 599.')
        step.input={...step.input as object,status,body:valueOf(form,fields)}
      }
      if (step.type === 'paths') {
        if (!['exclusive','parallel'].includes(form.mode)) return fail('mode','Choose first matching or all matching routes.')
        if (!['fallback','always','none'].includes(form.otherwise)) return fail('otherwise','Choose a fallback policy.')
        const extra=(step.fallback ?? step.always) as {steps:Step[]} | undefined
        if (form.otherwise==='none' && extra?.steps.length) return fail('otherwise','Move or remove the steps in the extra route before removing it.')
        delete step.fallback;delete step.always
        if (form.otherwise!=='none') step[form.otherwise]=extra??{steps:[]}
        step.mode=form.mode
      }
    } else if (operation === 'field' || operation === 'remove-field') {
      if (step.type !== 'map' || !isObject(step.input)) return fail('operation','Choose a map step.')
      const input=step.input
      if (form.key && !Object.hasOwn(input,form.key)) return fail('field_name','That field no longer exists.')
      if (operation==='remove-field') delete input[form.key]
      else {
        const key=form.field_name?.trim()
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key??'') || ['__proto__','constructor','prototype'].includes(key)) return fail('field_name','Use a field name starting with a letter, with up to 40 letters, digits or underscores.')
        if (key!==form.key && Object.hasOwn(input,key)) return fail('field_name','That field name is already used.')
        const value=valueOf(form,fields)
        if (form.key && form.key!==key) delete input[form.key]
        input[key]=value
      }
    } else if (['add-branch','remove-branch','rename-branch','branch-up','branch-down'].includes(operation)) {
      if (step.type!=='paths') return fail('operation','Choose a paths step.')
      const branches=step.branches as any[], at=branches.findIndex(b=>b.id===form.branch)
      if (operation==='add-branch') branches.push({id:generated(),name:title(form.branch_name,'branch_name'),when:defaultRule(),steps:[]})
      else {
        if (at<0) return fail('branch_name','Choose a current route.')
        if (operation==='rename-branch') branches[at].name=title(form.branch_name,'branch_name')
        else if (operation==='branch-up' || operation==='branch-down') {
          const next=at+(operation==='branch-up'?-1:1)
          if(next<0 || next>=branches.length)return fail('branch_name','This route is already at the end of the matching order.')
          ;[branches[at],branches[next]]=[branches[next],branches[at]]
        }
        else if (branches.length===1) return fail('branch_name','Keep at least one matching route.')
        else branches.splice(at,1)
      }
    } else if (['rule','add-rule','remove-rule','add-group'].includes(operation)) {
      const holder=step.type==='filter'?step:step.type==='paths'?(step.branches as any[]).find(b=>b.id===form.branch):null
      if (!holder) return fail('source','Choose a filter or a matching route.')
      const groups=holder.when as any[][], g=Number(form.group??0), r=Number(form.rule??0)
      if (operation==='add-group') groups.push(defaultRule()[0])
      else {
        if (!Number.isInteger(g) || !groups[g]) return fail('source','Choose a current condition group.')
        if (operation==='add-rule') groups[g].push(defaultRule()[0][0])
        else {
          if (!Number.isInteger(r) || !groups[g][r]) return fail('source','Choose a current condition.')
          if (operation==='rule') groups[g][r]={...groups[g][r],...ruleOf(form,fields),...(!form.operator?.includes('.') || form.operator.startsWith('boolean.')?{value:undefined,...(form.operator.startsWith('boolean.')?{}:{value_type:undefined})}:{})}
          else if (groups[g].length>1) groups[g].splice(r,1)
          else if (groups.length>1) groups.splice(g,1)
          else return fail('source','Keep at least one condition.')
        }
      }
    } else return fail('operation','Choose an editing action.')
  }
  links(graph, operation === 'field' || operation === 'save-step' ? 'value_kind' : 'after')
  try {validateGraph(graph)} catch(error:any) {return fail('operation',error.message)}
  const selectedLocation=locations(graph).find(l=>l.step.id===selected)
  return {graph,selected:selectedLocation?.path??'trigger'}
}
