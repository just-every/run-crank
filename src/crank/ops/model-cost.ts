import { usdUnits, unitsUsd } from './usage-money'
import { requireValue } from '../model'
/** Pinned text-model list prices: USD 0.40 input and USD 1.60 output per million tokens.
 * A computed estimate is never recorded as a provider-reported charge. */
export function modelCost(inputTokens: number, outputTokens: number): string {
  return unitsUsd(BigInt(inputTokens) * 40n + BigInt(outputTokens) * 160n)
}

/** Reserve a whole graph's bounded native model calls, including loop items and
 * all possible branches, before publication admits any billed execution. */
export function assertModelQuote(graph: any, components: {kind:string;usd_per_run:string}[]) {
  const cost = (steps: any[]): bigint => steps.reduce((sum, step) => sum + (step.type === 'ai.classify' ? BigInt(usdUnits(modelCost(Number(step.max_input_tokens ?? 8192), Number(step.max_output_tokens ?? 128))))
    : step.type === 'loop' ? BigInt(step.max_items) * cost(step.steps)
    : step.type === 'paths' ? cost([...(step.branches ?? []).flatMap((branch:any)=>branch.steps), ...(step.fallback?.steps ?? []), ...(step.always?.steps ?? [])]) : 0n), 0n)
  const minimum = cost(graph.steps ?? [])
  requireValue(BigInt(usdUnits(components.find(c=>c.kind==='models')!.usd_per_run)) >= minimum, `Model estimate must reserve at least USD ${unitsUsd(minimum)} for this graph's bounded classification calls`, 409)
}
