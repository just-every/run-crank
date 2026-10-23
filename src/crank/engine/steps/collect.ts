import { addTime, requireUnit, requireZone } from '../dates'
import { parseDecimal, round, toText } from '../decimal'
import { StepError } from '../errors'
import type { Step, StepType } from '../types'
import { isObject } from '../values'

type Field = { type: 'text' | 'number' | 'usd' | 'date' | 'choice' | 'checkbox'; required?: boolean; choices?: string[] }
const types = ['text', 'number', 'usd', 'date', 'choice', 'checkbox']
export function collectFields(step: Step): Record<string, Field> { return step.fields as Record<string, Field> }

/** Pure typed answers: no coercion of currency or dates, and no unknown fields.
 * Values stay in the run's existing sealed, indexed, erasable wait/step records. */
export function collectAnswers(step: Step, input: Record<string, unknown>) {
  const fields = collectFields(step), result: Record<string, unknown> = {}
  for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) throw new StepError('validation', `${name} is not a field of this question`)
  for (const [name, field] of Object.entries(fields)) {
    const value = input[name]
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new StepError('validation', `${name} is required`)
      result[name] = null; continue
    }
    if (field.type === 'text') {
      if (typeof value !== 'string' || value.length > 2000) throw new StepError('validation', `${name} must be text of at most 2000 characters`)
      result[name] = value.trim()
      if (field.required && result[name] === '') throw new StepError('validation', `${name} is required`)
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new StepError('validation', `${name} must be a finite JSON number`)
      result[name] = value
    } else if (field.type === 'usd') {
      if (typeof value !== 'string' || !/^-?\d{1,12}(\.\d{1,2})?$/.test(value)) throw new StepError('validation', `${name} must be a USD decimal string with at most two fractional digits`)
      result[name] = toText(round(parseDecimal(value)!, 2))
    } else if (field.type === 'date') {
      const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00.000Z') : null
      if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new StepError('validation', `${name} must be a real YYYY-MM-DD date`)
      result[name] = value
    } else if (field.type === 'choice') {
      if (typeof value !== 'string' || !field.choices!.includes(value)) throw new StepError('validation', `${name} must be one of this question's choices`)
      result[name] = value
    } else {
      if (typeof value !== 'boolean') throw new StepError('validation', `${name} must be true or false`)
      result[name] = value
    }
  }
  return result
}

/** Native owner question. It uses the existing decision wait, which already
 * supports durable contact references, one resolution, sealing and inactive restore.
 * Assigning a person/role or an external recipient is not silently approximated. */
export const collect: StepType = {
  mutating: false,
  validate(step) {
    if (!isObject(step.fields) || !Object.keys(step.fields).length || Object.keys(step.fields).length > 30) throw new StepError('validation', 'Collect fields must name 1 to 30 typed fields')
    for (const [name, value] of Object.entries(step.fields)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || !isObject(value) || !types.includes(String(value.type))) throw new StepError('validation', 'Collect fields need an identifier and text, number, usd, date, choice or checkbox type')
      if (value.required !== undefined && typeof value.required !== 'boolean') throw new StepError('validation', `${name}: required must be boolean`)
      if (value.type === 'choice' && (!Array.isArray(value.choices) || !value.choices.length || value.choices.length > 30 || value.choices.some(choice => typeof choice !== 'string' || !choice || choice.length > 200) || new Set(value.choices).size !== value.choices.length)) throw new StepError('validation', `${name}: name 1 to 30 distinct choices`)
    }
    if (step.assignee !== undefined && step.assignee !== 'owner') throw new StepError('validation', 'Collect currently requires the native owner; person, role and external-link assignments are not implemented')
    if (step.on_timeout !== undefined && !['stop', 'continue'].includes(String(step.on_timeout))) throw new StepError('validation', 'Collect on_timeout must be stop or continue')
    if (step.timeout !== undefined) {
      if (!isObject(step.timeout) || !Number.isInteger(step.timeout.amount) || Number(step.timeout.amount) <= 0) throw new StepError('validation', 'Collect timeout needs a positive whole amount and unit')
      requireUnit(step.timeout.unit)
    }
  },
  async execute(step, ctx) {
    for (const name of Object.keys(ctx.input)) if (!Object.hasOwn(collectFields(step), name)) throw new StepError('validation', `${name} is not a field of this question`)
    const initial: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(collectFields(step))) initial[name] = ctx.input[name] ?? (field.type === 'number' ? 0 : field.type === 'checkbox' ? false : '')
    const timeout = isObject(step.timeout) ? step.timeout : null
    const expires = timeout ? addTime(ctx.now, Number(timeout.amount), requireUnit(timeout.unit), requireZone(step.timezone, ctx.zone), step.calendar) : null
    if (expires !== null && (expires <= ctx.now || expires - ctx.now > 366 * 86400000)) throw new StepError('validation', 'Collect timeout must fall within the next 366 days')
    return { status: 'waiting', wait: { kind: 'approval', proposal: initial, reason: typeof step.instructions === 'string' ? step.instructions.slice(0, 500) : 'Information needed from the owner', expiresAt: expires === null ? null : new Date(expires).toISOString() } }
  },
  async resume(step, ctx) {
    const resolution = JSON.parse(ctx.wait.resolution_json ?? '{}')
    if (resolution.timed_out) {
      if (step.on_timeout === 'continue') return { status: 'succeeded', output: { answered: false, timed_out: true, answers: null } }
      return { status: 'rejected', reason: 'The information request timed out' }
    }
    if (!resolution.approved) return { status: 'rejected', reason: 'The information request was cancelled' }
    return { status: 'succeeded', output: { answered: true, timed_out: false, answers: collectAnswers(step, resolution.proposal), answered_by: resolution.reviewer, answered_at: resolution.decided_at } }
  },
}
