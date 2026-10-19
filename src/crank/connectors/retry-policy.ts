import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'

export const RETRY_POLICY = { read_attempts: 6, idempotent_write_attempts: 2, elapsed_ms: 60000, base_delay_ms: 60000, write_base_delay_ms: 500, jitter_ms: 250, max_wait_ms: 3600000, run_parked_ms: 86400000 }

export function validateRetryPolicy(value: unknown) {
  if (!isObject(value) || Object.keys(value).some(key => !['read_attempts', 'base_delay_ms'].includes(key))) throw new StepError('validation', 'retry_policy accepts read_attempts and base_delay_ms')
  for (const [key, maximum] of [['read_attempts', 10], ['base_delay_ms', RETRY_POLICY.max_wait_ms]] as const) if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > maximum)) throw new StepError('validation', `retry_policy.${key} must be a whole number from 1 to ${maximum}`)
}

export const retryExhausted = (category: 'network' | 'rate_limit' | 'provider', reason: string) => new StepError(category,
  `Request retry budget exhausted: ${reason}`, { exhausted: true, next_owner_action: 'Inspect the retained attempts, correct the provider or account issue, then deliberately start a new run.' })

/** Retry-After is a lower bound. Policy backoff saturates at the hour cap; a
 * longer provider wait is refused rather than capped to an early send. */
export function retryDelay(attempt: number, header: string | null, base: number) {
  const backoff = Math.min(RETRY_POLICY.max_wait_ms, base * 2 ** (attempt - 1) + Math.random() * RETRY_POLICY.jitter_ms)
  if (header === null || !header.trim()) return backoff
  const numeric = /^\d+(?:\.\d+)?$/.test(header.trim())
  const seconds = numeric ? Number(header) * 1000 : NaN
  if (numeric && !Number.isFinite(seconds)) return Infinity
  const date = Number.isFinite(seconds) ? seconds : Date.parse(header) - Date.now()
  return Math.max(backoff, Number.isFinite(date) ? date : 0)
}
