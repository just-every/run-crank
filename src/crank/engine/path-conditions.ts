import { evaluate, type Evaluation, type Groups } from './conditions'
import { StepError } from './errors'
import { branchesOf } from './graph'
import type { Scope } from './mapping'
import type { Step } from './types'

/** Preview and execution must choose the same branches, including mismatch routes. */
export function evaluatePaths(step: Step, scope: Scope, zone: string, time: number) {
  const branches = branchesOf(step)
  const trace: { branch: string; pass: boolean; trace: Evaluation }[] = []
  let mismatch: string | undefined
  for (const branch of branches.filter(branch => branch.kind === 'rule')) {
    const evaluation = evaluate(branch.when as Groups, scope, zone, time)
    trace.push({ branch: branch.id, pass: evaluation.pass, trace: evaluation })
    if (evaluation.mismatch && !mismatch) mismatch = `type mismatch in path ${step.id}/${branch.id}: ${evaluation.mismatch.field} (${evaluation.mismatch.message})`
  }
  let matched: string[]
  if (mismatch) {
    if (step.on_type_mismatch === undefined || step.on_type_mismatch === 'halt') {
      return { matched: [], trace, error: new StepError('type_mismatch', mismatch, { outcome: 'type mismatch', trace }) }
    }
    matched = [String(step.on_type_mismatch)]
  } else {
    const passing = trace.filter(result => result.pass).map(result => result.branch)
    matched = step.mode === 'exclusive' ? passing.slice(0, 1) : passing
    if (!matched.length && branches.some(branch => branch.kind === 'fallback')) matched = ['fallback']
  }
  if (branches.some(branch => branch.kind === 'always')) matched.push('always')
  return { matched, trace }
}
