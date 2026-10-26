import { StepError } from '../errors'
import type { Args, Transform } from './args'
import { dateTransforms } from './datetime'
import { numberTransforms } from './numbers'
import { textTransforms } from './text'
import { utilityTransforms } from './utilities'
import { n8nItems } from './n8n-items'

/** WORK-012: deterministic built-in transforms; no code, model call or network request. */
export const TRANSFORMS: Record<string, Transform> = { ...textTransforms, ...numberTransforms, ...dateTransforms, ...utilityTransforms, 'n8n.items': n8nItems }

export function runTransform(name: string, args: Args): unknown {
  const transform = TRANSFORMS[name]
  if (!transform) throw new StepError('validation', `Unknown transform ${name}`)
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new StepError('validation', `${name} needs named inputs`)
  return transform(args)
}
