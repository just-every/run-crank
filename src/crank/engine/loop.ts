import { StepError } from './errors'
import { resolve, type Scope } from './mapping'
import type { StepRecord } from './records'
import type { ExecutionOutcome, Step } from './types'
import { isObject } from './values'

export interface LoopExecution {
  records: Map<string, StepRecord>
  scope: Scope
  save(step: Step, path: string, status: StepRecord['status'], extra: { input?: unknown; output?: unknown; trace?: unknown; error?: unknown }): Promise<void>
  fork(steps: Step[], prefix: string, item: unknown, index: number): Promise<LoopExecution>
  walk(steps: Step[], prefix: string): Promise<ExecutionOutcome>
}
interface ItemResult { index: number; status: 'succeeded' | 'failed' | 'stopped' | 'waiting' | 'paused' | 'rejected'; output?: unknown; error?: unknown }

export function validateLoop(step: Step) {
  if (step.on_error !== undefined) throw new StepError('validation', `Loop ${step.id}: use item_errors to declare item failure behavior`)
  if (!isObject(step.input) || step.input.items === undefined) throw new StepError('validation', `Loop ${step.id}: map input.items to an array`)
  if (!Number.isInteger(step.max_items) || Number(step.max_items) < 1 || Number(step.max_items) > 1000) throw new StepError('validation', `Loop ${step.id}: max_items must be 1 to 1000`)
  if (!Number.isInteger(step.concurrency) || Number(step.concurrency) < 1 || Number(step.concurrency) > 8) throw new StepError('validation', `Loop ${step.id}: concurrency must be 1 to 8`)
  if (step.order !== 'input') throw new StepError('validation', `Loop ${step.id}: order must be input`)
  if (!['allow', 'error'].includes(String(step.empty))) throw new StepError('validation', `Loop ${step.id}: empty must be allow or error`)
  if (!['stop', 'continue'].includes(String(step.item_errors))) throw new StepError('validation', `Loop ${step.id}: item_errors must be stop or continue`)
  if (!Array.isArray(step.steps) || !step.steps.length) throw new StepError('validation', `Loop ${step.id}: add child steps`)
  if (step.result === undefined) throw new StepError('validation', `Loop ${step.id}: declare the per-item result mapping`)
}

const encodeSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const failure = (error: unknown) => error instanceof StepError ? error.toJSON() : { category: 'provider', message: 'Loop item failed unexpectedly' }

/** Inputs and item ordinals are retained before any child runs. A resumed item walks
 * its existing child checkpoints, so successful effects keep their operation keys. */
export async function executeLoop(step: Step, path: string, host: LoopExecution): Promise<ExecutionOutcome> {
  const previous = host.records.get(path)
  if (previous?.status === 'succeeded') { host.scope.steps[step.id] = JSON.parse(previous.output_json!); return { kind: 'completed' } }
  if (previous?.status === 'failed') return { kind: 'failed', error: JSON.parse(previous.error_json!) }
  let input: { items: unknown[] }
  try {
    const resolved = previous?.input_json ? JSON.parse(previous.input_json) : resolve(step.input, host.scope)
    if (!isObject(resolved) || !Array.isArray(resolved.items)) throw new StepError('validation', `Loop ${step.id}: input.items must be an array`, { outcome: 'invalid loop input' })
    input = { items: resolved.items }
    if (input.items.length > Number(step.max_items) || encodeSize(input) > 1024 * 1024) throw new StepError('validation', `Loop ${step.id}: input exceeds its declared item or retained byte bound`, { outcome: 'loop input limit' })
    if (!input.items.length && step.empty === 'error') throw new StepError('validation', `Loop ${step.id}: input is empty`, { outcome: 'empty loop input' })
    if (!previous) await host.save(step, path, 'running', { input })
  } catch (error) {
    const problem = failure(error)
    await host.save(step, path, 'failed', { error: problem })
    return { kind: 'failed', error: problem }
  }
  const items: ItemResult[] = new Array(input.items.length), outcomes: (ExecutionOutcome | undefined)[] = new Array(input.items.length)
  let next = 0, halted = false
  const worker = async () => {
    while (!halted && next < input.items.length) {
      const index = next++, itemPath = `${path}/items/${index}`, old = host.records.get(itemPath)
      if (old && ['succeeded', 'failed', 'stopped'].includes(old.status)) {
        items[index] = JSON.parse(old.output_json!)
        if (items[index].status === 'failed' && step.item_errors === 'stop') { outcomes[index] = { kind: 'failed', error: items[index].error }; halted = true }
        if (items[index].status === 'rejected') { outcomes[index] = { kind: 'rejected', reason: 'An item approval was rejected' }; halted = true }
        continue
      }
      const child = await host.fork(step.steps as Step[], `${itemPath}/`, input.items[index], index)
      let outcome: ExecutionOutcome, output: unknown
      try {
        outcome = await child.walk(step.steps as Step[], `${itemPath}/`)
        if (outcome.kind === 'completed') output = resolve(step.result, child.scope) ?? null
        if (encodeSize(output ?? null) > 512 * 1024) throw new StepError('validation', `Loop ${step.id}: item result exceeds its retained byte bound`, { outcome: 'loop result limit' })
      } catch (error) { outcome = { kind: 'failed', error: failure(error) } }
      const status = outcome.kind === 'completed' ? 'succeeded' : outcome.kind
      const result: ItemResult = { index, status, ...(outcome.kind === 'completed' ? { output } : {}), ...(outcome.kind === 'failed' ? { error: outcome.error } : {}) }
      items[index] = result; outcomes[index] = outcome
      await host.save(step, itemPath, status === 'paused' ? 'waiting' : status === 'rejected' ? 'stopped' : status, { input: { item: input.items[index] }, output: result, ...(outcome.kind === 'failed' ? { error: outcome.error } : {}) })
      // Workers already in flight finish and checkpoint before the run is settled.
      if (['waiting', 'paused', 'rejected'].includes(outcome.kind) || outcome.kind === 'failed' && step.item_errors === 'stop') halted = true
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(Number(step.concurrency), input.items.length) }, worker))
  const broken = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (broken) throw broken.reason
  const retained = items.filter((item): item is ItemResult => item !== undefined)
  const output = { items: retained, results: retained.filter(item => item.status === 'succeeded').map(item => item.output), total: input.items.length }
  const blocking = outcomes.find(outcome => outcome?.kind === 'failed' && step.item_errors === 'stop')
    ?? outcomes.find(outcome => outcome?.kind === 'rejected')
    ?? outcomes.find(outcome => outcome?.kind === 'paused')
    ?? (outcomes.some(outcome => outcome?.kind === 'waiting') ? { kind: 'waiting' as const, approval: outcomes.some(outcome => outcome?.kind === 'waiting' && outcome.approval) } : undefined)
  if (encodeSize(output) > 1024 * 1024) {
    const error = new StepError('validation', `Loop ${step.id}: aggregate exceeds its retained byte bound`, { outcome: 'loop result limit' }).toJSON()
    await host.save(step, path, 'failed', { input, error })
    return { kind: 'failed', error }
  }
  if (blocking) {
    await host.save(step, path, blocking.kind === 'failed' ? 'failed' : 'running', { input, output, ...(blocking.kind === 'failed' ? { error: blocking.error } : {}) })
    return blocking
  }
  await host.save(step, path, 'succeeded', { input, output })
  host.scope.steps[step.id] = output
  return { kind: 'completed' }
}
