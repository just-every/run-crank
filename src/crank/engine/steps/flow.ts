import { compare, parseDecimal } from '../decimal'
import { addTime, parseDate, requireUnit, requireZone } from '../dates'
import { businessCalendar } from '../calendar'
import { StepError } from '../errors'
import type { StepType } from '../types'
import { isObject } from '../values'

const iso = (ms: number) => new Date(ms).toISOString()
const MAX_WAIT_MS = 366 * 86400000

function expiry(step: Record<string, unknown>, from: number, zone: string): string | null {
  if (!isObject(step.expires_after)) return null
  return iso(addTime(from, Number(step.expires_after.amount), requireUnit(step.expires_after.unit), zone, step.calendar))
}

/** WORK-004: durable delays (for, until, business days) and named delay queues. */
export const delay: StepType = {
  mutating: false,
  validate(step) {
    if (!['for', 'until', 'queue'].includes(step.mode as string)) throw new StepError('validation', `Delay ${step.id}: mode must be for, until or queue`)
    if (step.timezone !== undefined) requireZone(step.timezone)
    if (step.calendar !== undefined) businessCalendar(step.calendar)
    if (step.mode === 'queue') {
      const input = isObject(step.input) ? step.input : {}
      if (typeof input.queue !== 'string' || !/^[A-Za-z0-9 _.-]{1,64}$/.test(input.queue)) throw new StepError('validation', `Delay ${step.id}: name the delay queue`)
      if (!Number.isInteger(input.spacing_seconds) || (input.spacing_seconds as number) < 1 || (input.spacing_seconds as number) > 86400) throw new StepError('validation', `Delay ${step.id}: spacing_seconds must be 1 to 86400`)
    }
  },
  async execute(step, ctx) {
    const zone = requireZone(step.timezone, ctx.zone)
    if (step.mode === 'queue') return { status: 'waiting', wait: { kind: 'queue', queue: { name: String(ctx.input.queue), spacingSeconds: Number(ctx.input.spacing_seconds) } } }
    let due: number
    if (step.mode === 'for') {
      const amount = Number(ctx.input.amount)
      if (!Number.isInteger(amount) || amount < 0) throw new StepError('validation', `Delay ${step.id}: amount must be a whole number`)
      due = addTime(ctx.now, amount, requireUnit(ctx.input.unit), zone, step.calendar)
    } else {
      const parsed = parseDate(ctx.input.until, zone)
      if (!parsed) throw new StepError('validation', `Delay ${step.id}: "until" could not be parsed: ${JSON.stringify(ctx.input.until)}`)
      due = parsed.ms
      if (due <= ctx.now) {
        if (step.if_past === 'fail') throw new StepError('validation', `Delay ${step.id}: the time has already passed`)
        return { status: 'succeeded', output: { due_at: iso(due), released_at: iso(ctx.now), skipped: true } }
      }
    }
    if (due - ctx.now > MAX_WAIT_MS) throw new StepError('validation', `Delay ${step.id}: waits are limited to 366 days`)
    return { status: 'waiting', wait: { kind: 'delay', dueAt: iso(due), expiresAt: expiry(step, due, zone) } }
  },
  async resume(step, ctx) {
    const resolution = JSON.parse(ctx.wait.resolution_json ?? '{}')
    if (resolution.expired && step.on_expired === 'fail') throw new StepError('validation', `Delay ${step.id} expired before it could be released`)
    return { status: 'succeeded', output: { due_at: ctx.wait.due_at, released_at: ctx.wait.resolved_at, ...resolution } }
  },
}

/** Waits for a callback to the run's resume URL; late or duplicate callbacks are ignored. */
export const waitForCallback: StepType = {
  mutating: false,
  validate(step) {
    if (!isObject(step.timeout)) throw new StepError('validation', `Wait ${step.id}: set a timeout`)
    requireUnit(step.timeout.unit)
  },
  async execute(step, ctx) {
    const zone = requireZone(step.timezone, ctx.zone), timeout = step.timeout as Record<string, unknown>
    const expires = addTime(ctx.now, Number(timeout.amount), requireUnit(timeout.unit), zone, step.calendar)
    if (expires - ctx.now > MAX_WAIT_MS || expires <= ctx.now) throw new StepError('validation', `Wait ${step.id}: the timeout must be in the next 366 days`)
    return { status: 'waiting', wait: { kind: 'callback', dueAt: iso(expires), expiresAt: iso(expires) } }
  },
  async resume(_step, ctx) { return { status: 'succeeded', output: JSON.parse(ctx.wait.resolution_json ?? '{}') } },
}

export function checkCaps(step: Record<string, unknown>, proposal: Record<string, unknown>) {
  if (!isObject(step.caps)) return
  for (const [field, cap] of Object.entries(step.caps)) {
    if (!isObject(cap) || cap.max_usd === undefined) continue
    const max = parseDecimal(cap.max_usd), value = parseDecimal(proposal[field])
    if (!max) throw new StepError('validation', `Cap on ${field} is not an amount`)
    if (!value) throw new StepError('validation', `${field} is not an amount: ${JSON.stringify(proposal[field])}`)
    if (compare(value, max) > 0) throw new StepError('validation', `${field} ${proposal[field]} exceeds the cap of ${cap.max_usd}`, { field, cap: cap.max_usd })
  }
}

/** TEAM-005: an optional approval step; reviewers may edit allowed fields within caps. */
export const approval: StepType = {
  mutating: false,
  validate(step) {
    const input = isObject(step.input) ? step.input : {}
    if (step.editable !== undefined && (!Array.isArray(step.editable) || step.editable.some(field => typeof field !== 'string' || !(field in input)))) throw new StepError('validation', `Approval ${step.id}: editable fields must be fields of its proposal`)
    if (step.on_reject !== undefined && !['stop', 'continue'].includes(step.on_reject as string)) throw new StepError('validation', `Approval ${step.id}: on_reject must be stop or continue`)
  },
  async execute(step, ctx) {
    checkCaps(step, ctx.input)
    return { status: 'waiting', wait: { kind: 'approval', proposal: ctx.input, reason: typeof step.instructions === 'string' ? step.instructions.slice(0, 500) : 'approval step' } }
  },
  async resume(step, ctx) {
    const resolution = JSON.parse(ctx.wait.resolution_json ?? '{}')
    if (resolution.approved) return { status: 'succeeded', output: resolution }
    if (step.on_reject === 'continue') return { status: 'succeeded', output: { ...resolution, proposal: resolution.original } }
    return { status: 'rejected', reason: resolution.reason ?? 'rejected' }
  },
}
