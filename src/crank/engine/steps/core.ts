import { evaluate, validateGroups, type Groups } from '../conditions'
import { StepError } from '../errors'
import { missingField } from '../mapping'
import { TRANSFORMS, runTransform } from '../transforms'
import type { StepType } from '../types'
import { isObject } from '../values'

export const filter: StepType = {
  mutating: false,
  validate(step) { validateGroups(step.when, `Filter ${step.id}`) },
  async execute(step, ctx) {
    const result = evaluate(step.when as Groups, ctx.scope, ctx.zone, ctx.now)
    if (result.mismatch) throw new StepError('type_mismatch', `type mismatch in filter "${step.id}": rule ${result.mismatch.rule + 1} on ${result.mismatch.field} (${result.mismatch.message})`, { outcome: 'type mismatch', trace: result })
    return result.pass ? { status: 'succeeded', output: { passed: true }, trace: result } : { status: 'stopped', reason: 'filter', trace: result }
  },
}

export const transform: StepType = {
  mutating: false,
  validate(step) {
    if (typeof step.fn !== 'string' || !TRANSFORMS[step.fn]) throw new StepError('validation', `Transform ${step.id}: unknown function ${String(step.fn)}`)
  },
  async execute(step, ctx) {
    try { return { status: 'succeeded', output: runTransform(step.fn as string, ctx.input) } } catch (error) { throw missingField(step.input, ctx.scope, error) ?? error }
  },
}

/** Named mapped values in one step, for example a payload assembled for later steps. */
export const map: StepType = {
  mutating: false,
  async execute(_step, ctx) { return { status: 'succeeded', output: ctx.input } },
}

/** Pure response validation shared by execution and the no-send preview. */
export function responseOf(input: Record<string, unknown>) {
  const status = input.status === undefined ? 200 : Number(input.status)
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new StepError('validation', 'Response status must be 200 to 599')
  const headers: Record<string, string> = {}
  if (input.headers !== undefined) {
    if (!isObject(input.headers)) throw new StepError('validation', 'Response headers must be an object')
    for (const [name, value] of Object.entries(input.headers)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /^(set-cookie|content-length|transfer-encoding|connection)$/i.test(name)) throw new StepError('validation', `Response header ${name} is not allowed`)
      headers[name.toLowerCase()] = String(value)
    }
  }
  return { status, headers, body: input.body ?? null }
}

/** The synchronous webhook response (TRIG-001), sent when the sender is still waiting. */
export const respond: StepType = {
  mutating: false,
  async execute(_step, ctx) {
    const response = responseOf(ctx.input)
    await ctx.respond(response)
    return { status: 'succeeded', output: response }
  },
}
