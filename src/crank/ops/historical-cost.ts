import { add, compare, fromInt, multiply, parseDecimal, round, toText } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'

const KINDS = ['orchestration', 'connectors', 'models', 'executors'] as const
interface CostComponent { kind: typeof KINDS[number]; usd_per_run: string; assumption: string }
function fail(message: string): never { throw new StepError('validation', message) }

/** All four components are explicit owner estimates, including any quoted zeros.
 * Component amounts are bounded at USD 1 billion and eight decimal places. */
export function historicalCost(input: unknown, count: number) {
  if (!Number.isSafeInteger(count) || count < 0) fail('Historical cost count must be a nonnegative safe integer')
  if (!isObject(input) || Object.keys(input).some(key => key !== 'components') || !Array.isArray(input.components) || input.components.length !== KINDS.length) fail('Historical cost requires exactly four explicitly quoted components')
  const raw = (input as { components: unknown[] }).components
  const components: CostComponent[] = [], seen = new Set<string>()
  let perRun = fromInt(0)
  for (const value of raw) {
    if (!isObject(value) || Object.keys(value).some(key => !['kind', 'usd_per_run', 'assumption'].includes(key))) fail('Historical cost components contain unsupported fields')
    const component = value as Record<string, unknown>
    if (typeof component.kind !== 'string' || !KINDS.includes(component.kind as CostComponent['kind']) || seen.has(component.kind)) fail('Historical cost needs orchestration, connectors, models and executors exactly once each')
    if (typeof component.usd_per_run !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(component.usd_per_run)) fail('usd_per_run must be a nonnegative decimal string with at most eight decimal places')
    const amount = parseDecimal(component.usd_per_run)!
    if (compare(amount, fromInt(1_000_000_000)) > 0) fail('usd_per_run must not exceed USD 1 billion')
    if (typeof component.assumption !== 'string' || !component.assumption.trim() || component.assumption.length > 500) fail('Each historical cost component requires an owner assumption of 1 to 500 characters')
    seen.add(component.kind as string)
    perRun = add(perRun, amount)
    components.push({ kind: component.kind as CostComponent['kind'], usd_per_run: component.usd_per_run as string, assumption: component.assumption as string })
  }
  return {
    currency: 'USD' as const,
    source: 'owner estimate; not provider-verified' as const,
    per_run_usd: toText(perRun),
    total_usd: toText(round(multiply(perRun, fromInt(count)), 2, 'half_up')),
    rounding: 'half-up to cents after summing components and multiplying count' as const,
    components,
  }
}
