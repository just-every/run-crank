import { StepError } from '../errors'
import type { Args, Transform } from './args'
import { dateTransforms } from './datetime'
import { numberTransforms } from './numbers'
import { textTransforms } from './text'
import { utilityTransforms } from './utilities'
import { n8nConditions, n8nSwitchIndex } from './n8n-conditions'
import { n8nSplit } from './n8n-split'
import { n8nFilterStream } from './n8n-filter-stream'
import { n8nStream } from './n8n-stream'
import { n8nItems, n8nJsonBody } from './n8n-items'

/** WORK-012: deterministic built-in transforms; no code, model call or network request. */
export const TRANSFORMS: Record<string, Transform> = { ...textTransforms, ...numberTransforms, ...dateTransforms, ...utilityTransforms, 'n8n.split': n8nSplit, 'n8n.stream': n8nStream, 'n8n.filter_stream': n8nFilterStream, 'n8n.json_body': n8nJsonBody, 'n8n.items': n8nItems, 'n8n.conditions': n8nConditions, 'n8n.switch_index': n8nSwitchIndex }

export function runTransform(name: string, args: Args): unknown {
  const transform = TRANSFORMS[name]
  if (!transform) throw new StepError('validation', `Unknown transform ${name}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new StepError('validation', `${name} needs named inputs`)
  return transform(args)
}
