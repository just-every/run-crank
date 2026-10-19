import { StepError } from '../errors'
import type { StepType } from '../types'
import { lookup } from '../values'

type Key = string | number
interface Entry { key: Key; value: unknown }
const MAX_ITEMS = 10000

function index(items: unknown[], path: string, side: 'left' | 'right') {
  const entries = new Map<Key, Entry>()
  for (const [position, value] of items.entries()) {
    const { found, value: key } = lookup(value, path)
    if (!found || !(typeof key === 'string' && key.trim() !== '' || typeof key === 'number' && Number.isFinite(key))) {
      throw new StepError('validation', `Join ${side} item ${position}: ${path} must be a nonempty string or finite number`, { outcome: 'invalid join key', side, index: position, key_path: path })
    }
    if (entries.has(key)) throw new StepError('validation', `Join ${side} item ${position}: duplicate key at ${path}`, { outcome: 'duplicate join key', side, index: position, key_path: path })
    entries.set(key, { key, value })
  }
  return entries
}

/** Bounded, one-to-one joins. Keys retain their type; rows retain both source records. */
export const join: StepType = {
  mutating: false,
  validate(step) {
    if (!['inner', 'left', 'full'].includes(String(step.policy))) throw new StepError('validation', `Join ${step.id}: policy must be inner, left or full`)
    for (const field of ['left_key', 'right_key']) if (typeof step[field] !== 'string' || !String(step[field]).trim() || String(step[field]).length > 256) throw new StepError('validation', `Join ${step.id}: ${field} needs a field path`)
    if (step.duplicate_keys !== 'error') throw new StepError('validation', `Join ${step.id}: duplicate_keys must be error`)
    if (step.order !== 'left_then_right') throw new StepError('validation', `Join ${step.id}: order must be left_then_right`)
    if (!['allow', 'error'].includes(String(step.empty))) throw new StepError('validation', `Join ${step.id}: empty must be allow or error`)
  },
  async execute(step, ctx) {
    const { left, right } = ctx.input
    if (!Array.isArray(left) || !Array.isArray(right)) throw new StepError('validation', `Join ${step.id}: left and right must be arrays`, { outcome: 'invalid join input' })
    if (left.length + right.length > MAX_ITEMS) throw new StepError('validation', `Join ${step.id}: combined inputs exceed ${MAX_ITEMS} items`, { outcome: 'join input limit' })
    if (step.empty === 'error' && (!left.length || !right.length)) throw new StepError('validation', `Join ${step.id}: an input array is empty`, { outcome: 'empty join input' })
    // Validate both complete streams before producing any result, even for inner joins.
    const lhs = index(left, String(step.left_key), 'left'), rhs = index(right, String(step.right_key), 'right')
    const rows: { key: Key; left: unknown; right: unknown }[] = [], unmatchedLeft: unknown[] = [], unmatchedRight: unknown[] = []
    for (const entry of lhs.values()) {
      const other = rhs.get(entry.key)
      if (other) rows.push({ key: entry.key, left: entry.value, right: other.value })
      else {
        unmatchedLeft.push(entry.value)
        if (step.policy !== 'inner') rows.push({ key: entry.key, left: entry.value, right: null })
      }
    }
    for (const entry of rhs.values()) if (!lhs.has(entry.key)) {
      unmatchedRight.push(entry.value)
      if (step.policy === 'full') rows.push({ key: entry.key, left: null, right: entry.value })
    }
    return { status: 'succeeded', output: { rows, unmatched_left: unmatchedLeft, unmatched_right: unmatchedRight } }
  },
}
