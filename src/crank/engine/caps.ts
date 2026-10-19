import type { WorkspaceSettings } from '../ops/settings'
import { compare, parseDecimal } from './decimal'
import { StepError } from './errors'
import { resolve, type Scope } from './mapping'
import type { Step } from './types'
import { isObject } from './values'

/** Every supplied address counts, including duplicates; lists are never parsed
 * from a delimited string. The transport still validates its own address syntax. */
function recipientCount(value: unknown, stepId: string) {
  const entries = Array.isArray(value) ? value : [value]
  if (entries.some(entry => typeof entry !== 'string' || !entry.trim() || /[,;\s]/.test(entry))) throw new StepError('validation', `Step ${stepId}: recipients must be an array of addresses or one address; delimiters are not parsed`)
  return entries.length
}

export function validateCap(step: Step) {
  if (step.cap === undefined) return
  const cap = step.cap
  if (!isObject(cap) || (cap.max_usd === undefined && cap.max_recipients === undefined)) throw new StepError('validation', `Step ${step.id}: a cap needs max_usd or max_recipients`)
  if (cap.max_usd !== undefined && (cap.amount === undefined || !parseDecimal(cap.max_usd))) throw new StepError('validation', `Step ${step.id}: a USD cap needs amount and max_usd`)
  if (cap.max_recipients !== undefined && (cap.recipients === undefined || !Number.isSafeInteger(cap.max_recipients) || (cap.max_recipients as number) < 0)) throw new StepError('validation', `Step ${step.id}: a recipient cap needs recipients and a nonnegative whole max_recipients`)
}

/** Opt-in workspace and per-step caps both apply; neither can widen the other. */
export function cappedProposal(step: Step, input: Record<string, unknown>, scope: Scope, caps: WorkspaceSettings['caps']) {
  const own = isObject(step.cap) ? step.cap : {}, workspace = caps.filter(cap => cap.category === step.category)
  const usd = [own.max_usd, ...workspace.map(cap => cap.max_usd)].filter(value => value !== undefined)
  const recipientLimits = [own.max_recipients, ...workspace.map(cap => cap.max_recipients)].filter(value => value !== undefined) as number[]
  const proposal: Record<string, unknown> = {step: step.id, type: step.type, input}, reasons: string[] = []
  if (usd.length) {
    const raw = resolve(own.amount ?? step.amount, scope), amount = parseDecimal(raw)
    if (!amount) throw new StepError('validation', `Step ${step.id}: the capped amount is not a number`)
    const limit = usd.reduce((strictest, value) => {
      const a = parseDecimal(strictest), b = parseDecimal(value)
      if (!a || !b) throw new StepError('validation', `Step ${step.id}: the USD cap is not a number`)
      return compare(a, b) <= 0 ? strictest : value
    })
    const max = parseDecimal(limit)
    if (!max) throw new StepError('validation', `Step ${step.id}: the USD cap is not a number`)
    proposal.amount = raw; proposal.cap = limit
    if (compare(amount, max) > 0) reasons.push(`amount exceeds the ${limit} cap`)
  }
  if (recipientLimits.length) {
    const count = recipientCount(resolve(own.recipients ?? step.recipients, scope), step.id)
    const limit = Math.min(...recipientLimits)
    proposal.recipient_count = count; proposal.recipient_cap = limit
    if (count > limit) reasons.push(`${count} recipients exceeds the ${limit} cap`)
  }
  if (!reasons.length) return null
  return {proposal, reason: reasons.join('; ')}
}
