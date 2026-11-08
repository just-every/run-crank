import { StepError } from '../errors'
import { resolve } from '../mapping'
import { isObject } from '../values'
import type { Args } from './args'
import { n8nConditions } from './n8n-conditions'

function bounded(items: unknown, maxItems: number): asserts items is Record<string, unknown>[] {
  if (!Array.isArray(items) || items.length > maxItems || items.some(item => !isObject(item))) throw new StepError('validation', 'n8n Filter requires a bounded JSON object stream')
  let bytes: number
  try { bytes = new TextEncoder().encode(JSON.stringify(items)).length }
  catch { throw new StepError('validation', 'n8n Filter requires a serializable JSON object stream') }
  if (bytes > 1024 * 1024) throw new StepError('validation', 'n8n Filter stream exceeds the retained byte bound')
}

/** Evaluate a complete source node before releasing any retained downstream items. */
export function n8nFilterStream(args: Args): Record<string, unknown>[] {
  const maxItems = args.max_items ?? 1000, condition = args.condition
  if (!Number.isSafeInteger(maxItems) || Number(maxItems) < 1 || Number(maxItems) > 1000) throw new StepError('validation', 'n8n Filter requires an item bound from 1 to 1000')
  if (!isObject(condition) || Object.keys(condition).some(key => !['sets', 'inputs', 'all_matching'].includes(key)) || !isObject(condition.inputs) || condition.all_matching !== false) throw new StepError('validation', 'n8n Filter requires one literal condition group')
  const descriptor = condition.sets
  if (!isObject(descriptor) || Object.keys(descriptor).length !== 1 || !Array.isArray(descriptor.$literal) || descriptor.$literal.length !== 1) throw new StepError('validation', 'n8n Filter requires one literal condition group')
  bounded(args.items, Number(maxItems))
  const retained: Record<string, unknown>[] = []
  for (const item of args.items) {
    try {
      const resolved = resolve(condition, { trigger: {}, steps: {}, run: {}, item })
      if (!isObject(resolved) || !Array.isArray(resolved.sets) || resolved.sets.length !== 1 || resolved.all_matching !== false) throw new StepError('validation', 'n8n Filter requires one condition group')
      if (n8nConditions(resolved)[0] === true) retained.push(item)
    } catch (error) {
      if (error instanceof StepError) throw error
      throw new StepError('mapping', 'n8n Filter condition could not evaluate its JSON stream')
    }
  }
  bounded(retained, Number(maxItems))
  return retained
}
