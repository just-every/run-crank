import { prepareHttpRequest, httpRequest } from './connectors/http-step'
import { branchesOf, validateGraph, type Graph } from './engine/graph'
import { workspaceSettings } from './ops/settings'
import { StepError } from './engine/errors'
import { resolve, type Scope } from './engine/mapping'
import { evaluatePaths } from './engine/path-conditions'
import { filter, map } from './engine/steps/core'
import type { RunRow, Step, StepContext } from './engine/types'
import { isObject } from './engine/values'
import type { CrankEnv } from './model'

export interface WriteIntent { path: string; destination: string; method: string; headers: Record<string,string>; body: unknown; body_text: string | null }
export interface ShadowResult { outcome: 'completed' | 'stopped'; outputs: Record<string,unknown>; intents: WriteIntent[] }

/** Validate the entire graph, including branches that this sample will not take.
 * HTTP is terminal. No fabricated response can feed another step or branch. */
export function shadowGraph(value: unknown): Graph {
  const graph = validateGraph(value).graph
  if (!['manual','webhook'].includes(graph.trigger.type)) throw new StepError('validation','Comparison supports manual and webhook imported drafts only')
  const walk = (steps: Step[]) => steps.forEach((step,index) => {
    if (!['map','filter','paths','http'].includes(step.type)) throw new StepError('validation',`Comparison refuses unsupported step ${step.id} (${step.type})`)
    if (step.on_error && step.on_error !== 'stop') throw new StepError('validation','Comparison refuses error continuations')
    if (['http','paths'].includes(step.type) && index !== steps.length-1) throw new StepError('validation',`Comparison requires terminal ${step.type}: ${step.id}`)
    if (step.type === 'paths') for (const branch of branchesOf(step)) walk(branch.steps)
    if (step.type === 'http') {
      const input = isObject(step.input) ? step.input : {}
      if (!['POST','PUT','PATCH','DELETE'].includes(String(input.method).toUpperCase()) || (step.body_kind ?? 'json') !== 'json') throw new StepError('validation','Comparison supports terminal JSON write intents only')
      if (['pagination','readback','success','business_failures','idempotency_header'].some(key=>step[key]!==undefined)) throw new StepError('validation','Comparison refuses response policies and generated request headers')
      httpRequest.validate?.(step)
    }
  })
  walk(graph.steps)
  const httpIds:string[] = []
  const collect=(steps:Step[])=>steps.forEach(step=>{if(step.type==='http')httpIds.push(step.id);if(step.type==='paths')for(const branch of branchesOf(step))collect(branch.steps)})
  collect(graph.steps)
  const references=(value:unknown):void=>{
    if(typeof value==='string' && httpIds.some(id=>new RegExp('steps\\.'+id+'(?:\\.|\\[|\\s*}}|$)').test(value))) throw new StepError('validation','Comparison refuses mappings dependent on an HTTP response')
    if(Array.isArray(value))value.forEach(references)
    else if(isObject(value) && !Object.hasOwn(value,'$literal'))Object.values(value).forEach(references)
  }
  references(graph.steps)
  return graph
}

/** Native mapping, conditions, path choice and HTTP serialization, without a run,
 * credential lookup, request admission, provider response or dispatch capability. */
export async function evaluateImportShadow(env: CrankEnv, value: unknown, input: unknown, identity: string): Promise<ShadowResult> {
  const graph = shadowGraph(value), outputs: Record<string,unknown> = {}, intents: WriteIntent[] = []
  const settings = await workspaceSettings(env), time = Date.now()
  const scope: Scope = { trigger: input, steps: {}, run: {id:identity} }
  const walk = async (steps: Step[], prefix: string): Promise<boolean> => {
    for (const step of steps) {
      const path = prefix + step.id
      const ctx: StepContext = { comparison:true, env, scope, path, operationKey:identity+':'+path,
        run:{id:identity,mode:'comparison'} as RunRow, now:time, zone:String(graph.settings?.timezone ?? settings.timezone),
        input:(resolve(step.input ?? {},scope) ?? {}) as Record<string,unknown>, requests:{next:0},
        respond:async()=>{throw new StepError('authority','Comparison cannot respond as a provider')},
      }
      if (step.type === 'paths') {
        const choice = evaluatePaths(step,scope,ctx.zone,ctx.now)
        if (choice.error) throw choice.error
        if (!choice.matched.length) return false
        scope.steps[step.id] = {matched:choice.matched}; outputs[path] = scope.steps[step.id]
        const outcomes:boolean[] = []
        for (const branch of branchesOf(step).filter(branch=>choice.matched.includes(branch.id))) outcomes.push(await walk(branch.steps,path+'/'+branch.id+'/'))
        if (outcomes.every(completed=>!completed)) return false
      } else if (step.type === 'http') {
        const prepared = await prepareHttpRequest(step,ctx)
        const body = prepared.body ? new TextDecoder().decode(prepared.body) : null
        intents.push({path,destination:prepared.url.href,method:prepared.method,headers:Object.fromEntries(prepared.headers),body:body===null?null:JSON.parse(body),body_text:body})
      } else {
        const result = await (step.type === 'map' ? map : filter).execute(step,ctx)
        if (result.status === 'stopped') return false
        if (result.status !== 'succeeded') throw new StepError('validation','Comparison only evaluates immediate native steps')
        scope.steps[step.id] = result.output; outputs[path] = result.output
      }
    }
    return true
  }
  const completed = await walk(graph.steps,'')
  return { outcome:completed?'completed':'stopped', outputs, intents }
}
