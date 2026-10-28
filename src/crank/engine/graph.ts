import { mappingTableIds } from '../tables/mapping'
import { pollRate, validateTrigger } from '../triggers/definition'
import { validateGroups } from './conditions'
import { requireZone } from './dates'
import { StepError } from './errors'
import { STEP_TYPES } from './steps'
import { validateLoop } from './loop'
import type { Step } from './types'
import { isObject } from './values'
import { validateCap } from './caps'
import { validateRetryPolicy } from '../connectors/retry'

/** Path groups allow at least 20 branches and 5 levels (Zapier: 10 and 3). */
export const PATH_LIMITS = { branches: 25, depth: 8 } as const
const MAX_STEPS = 250
export interface Graph { trigger: Record<string, unknown> & { type: string }; steps: Step[]; settings?: Record<string, unknown> }
export interface Declared { steps: { path: string; id: string; type: string; connection_id?: string }[]; connections: string[] }
export interface Validation { graph: Graph; declared: Declared; warnings: string[] }

const named = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 80
/** Checks a whole graph before it is saved or published; errors name the step. */
export function validateGraph(value: unknown): Validation {
  if (!isObject(value)) throw new StepError('validation', 'graph must be an object with trigger and steps')
  if (!isObject(value.trigger) || typeof value.trigger.type !== 'string') throw new StepError('validation', 'graph.trigger needs a type')
  if (!Array.isArray(value.steps)) throw new StepError('validation', 'graph.steps must be a list')
  mappingTableIds(value.steps)
  const settings = isObject(value.settings) ? value.settings : {}
  if (settings.timezone !== undefined) requireZone(settings.timezone)
  if (settings.priority !== undefined && (!Number.isInteger(settings.priority) || (settings.priority as number) < -100 || (settings.priority as number) > 100)) throw new StepError('validation', 'settings.priority must be a whole number from -100 to 100')
  if (settings.max_steps !== undefined && (!Number.isInteger(settings.max_steps) || (settings.max_steps as number) < 1 || (settings.max_steps as number) > 10000)) throw new StepError('validation', 'settings.max_steps must be a whole number from 1 to 10000')
  if (settings.max_concurrency !== undefined && (!Number.isInteger(settings.max_concurrency) || (settings.max_concurrency as number) < 1 || (settings.max_concurrency as number) > 100)) throw new StepError('validation', 'settings.max_concurrency must be a whole number from 1 to 100')
  if (settings.waiting_runs !== undefined && !['continue', 'cancel_on_pause', 'cancel_on_new_version'].includes(settings.waiting_runs as string)) throw new StepError('validation', 'settings.waiting_runs must be continue, cancel_on_pause or cancel_on_new_version')
  if (settings.run_columns !== undefined && (!Array.isArray(settings.run_columns) || settings.run_columns.length > 4 || settings.run_columns.some(c => !isObject(c) || typeof c.label !== 'string' || !c.label || c.label.length > 40 || c.value === undefined))) throw new StepError('validation', 'settings.run_columns lists up to 4 {label, value} columns shown beside each run')
  if (value.trigger.name !== undefined && !named(value.trigger.name)) throw new StepError('validation', 'trigger.name is text of at most 80 characters')
  const warnings: string[] = [], declared: Declared = { steps: [], connections: [] }, ids = new Set<string>()
  let expanded = 0
  validateTrigger(value.trigger)
  const rate = pollRate(value.trigger)
  if (rate?.warning) warnings.push(rate.warning)
  if (value.trigger.type === 'app_poll' && value.trigger.any_field === true) warnings.push('Any field is selected: every record edit can start a run')
  if (typeof value.trigger.connection_id === 'string') declared.connections.push(value.trigger.connection_id)
  if (typeof value.trigger.signing_connection_id === 'string') declared.connections.push(value.trigger.signing_connection_id)
  if (isObject(value.trigger.header_auth) && typeof value.trigger.header_auth.connection_id === 'string') declared.connections.push(value.trigger.header_auth.connection_id)
  const walk = (steps: unknown[], prefix: string, depth: number, expansion = 1) => {
    steps.forEach((raw, index) => {
      if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') throw new StepError('validation', `${prefix || 'steps'}[${index}] needs an id and a type`)
      const step = raw as Step
      expanded += expansion
      if (expanded > 10000) throw new StepError('validation', 'Workflow loop bounds allow at most 10000 expanded step invocations')
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(step.id)) throw new StepError('validation', `Step id ${step.id} must be lower case letters, digits and underscores`)
      if (ids.has(step.id)) throw new StepError('validation', `Step id ${step.id} is used twice`)
      if (step.id === 'trigger') throw new StepError('validation', 'trigger is reserved')
      ids.add(step.id)
      if (step.name !== undefined && !named(step.name)) throw new StepError('validation', `Step ${step.id}: name is text of at most 80 characters`)
      if (ids.size > MAX_STEPS) throw new StepError('validation', `A workflow has at most ${MAX_STEPS} steps`)
      if (step.on_error !== undefined && !['stop', 'continue'].includes(step.on_error as string)) throw new StepError('validation', `Step ${step.id}: on_error must be stop or continue`)
      const path = prefix + step.id
      if (step.retry_policy !== undefined) validateRetryPolicy(step.retry_policy)
      if (step.type === 'loop') {
        if (depth > PATH_LIMITS.depth) throw new StepError('validation', `Loops and paths nest at most ${PATH_LIMITS.depth} levels`)
        validateLoop(step)
        declared.steps.push({ path, id: step.id, type: step.type })
        walk(step.steps as unknown[], `${path}/items/*/`, depth + 1, expansion * Number(step.max_items))
        return
      }
      if (step.type === 'paths') {
        validatePaths(step, depth, warnings)
        declared.steps.push({ path, id: step.id, type: step.type })
        for (const branch of branchesOf(step)) walk(branch.steps, `${path}/${branch.id}/`, depth + 1, expansion)
        return
      }
      const type = STEP_TYPES[step.type]
      if (!type) throw new StepError('validation', `Step ${step.id}: unknown type ${step.type}`)
      if (step.input !== undefined && !isObject(step.input)) throw new StepError('validation', `Step ${step.id}: input must be an object of mapped fields`)
      if (type.connection === 'required' && typeof step.connection_id !== 'string') throw new StepError('validation', `Step ${step.id}: choose a connection`)
      if (step.connection_id !== undefined) {
        if (typeof step.connection_id !== 'string' || !type.connection) throw new StepError('validation', `Step ${step.id}: this step does not use a connection`)
        if (!declared.connections.includes(step.connection_id)) declared.connections.push(step.connection_id)
      }
      validateCap(step)
      type.validate?.(step)
      declared.steps.push({ path, id: step.id, type: step.type, ...(typeof step.connection_id === 'string' ? { connection_id: step.connection_id } : {}) })
    })
  }
  walk(value.steps, '', 1)
  return { graph: value as unknown as Graph, declared, warnings }
}

export interface Branch { id: string; name: string; when?: unknown; steps: Step[]; kind: 'rule' | 'fallback' | 'always' }
export function branchesOf(step: Step): Branch[] {
  const list: Branch[] = (Array.isArray(step.branches) ? step.branches : []).map((b: any) => ({ id: b.id, name: b.name ?? b.id, when: b.when, steps: b.steps ?? [], kind: 'rule' as const }))
  if (isObject(step.fallback)) list.push({ id: 'fallback', name: 'Fallback', steps: (step.fallback.steps ?? []) as Step[], kind: 'fallback' })
  if (isObject(step.always)) list.push({ id: 'always', name: 'Always run', steps: (step.always.steps ?? []) as Step[], kind: 'always' })
  return list
}
function validatePaths(step: Step, depth: number, warnings: string[]) {
  if (depth > PATH_LIMITS.depth) throw new StepError('validation', `Path groups nest at most ${PATH_LIMITS.depth} levels`)
  if (!['exclusive', 'parallel'].includes(step.mode as string)) throw new StepError('validation', `Path group ${step.id}: mode must be exclusive or parallel`)
  if (!Array.isArray(step.branches) || step.branches.length === 0) throw new StepError('validation', `Path group ${step.id}: add at least one branch`)
  if (step.branches.length > PATH_LIMITS.branches) throw new StepError('validation', `Path group ${step.id}: at most ${PATH_LIMITS.branches} branches`)
  if (step.fallback !== undefined && step.always !== undefined) throw new StepError('validation', `Path group ${step.id}: choose a fallback or an always-run branch, not both`)
  const seen = new Set<string>()
  for (const branch of step.branches) {
    if (!isObject(branch) || typeof branch.id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(branch.id) || ['fallback', 'always'].includes(branch.id)) throw new StepError('validation', `Path group ${step.id}: each branch needs an id`)
    if (seen.has(branch.id)) throw new StepError('validation', `Path group ${step.id}: branch ${branch.id} is used twice`)
    seen.add(branch.id)
    validateGroups(branch.when, `Path ${step.id}/${branch.id}`)
    if (!Array.isArray(branch.steps)) throw new StepError('validation', `Path ${step.id}/${branch.id}: steps must be a list`)
  }
  for (const key of ['fallback', 'always'] as const) if (step[key] !== undefined && (!isObject(step[key]) || !Array.isArray((step[key] as Record<string, unknown>).steps))) throw new StepError('validation', `Path group ${step.id}: ${key} needs steps`)
  if (step.on_type_mismatch !== undefined && step.on_type_mismatch !== 'halt' && !seen.has(step.on_type_mismatch as string) && step.on_type_mismatch !== 'fallback') throw new StepError('validation', `Path group ${step.id}: on_type_mismatch must be halt or a branch id`)
  if (step.on_type_mismatch === 'fallback' && step.fallback === undefined) throw new StepError('validation', `Path group ${step.id}: add a fallback branch before routing type mismatches to it`)
  if (step.fallback === undefined) warnings.push(`Path group ${step.id} has no fallback branch: a run that matches no branch ends as stopped by filter`)
}

/** Native subflows share the public graph validator, without provider capabilities. */
export function validateSubflowGraph(steps: Step[]) {
  return validateGraph({trigger:{type:'manual'},steps,settings:{max_steps:2000}}).graph
}
