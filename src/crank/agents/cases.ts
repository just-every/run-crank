import { requireOwner } from '../access'
import { canonical, requireValue, type Actor, type CrankEnv } from '../model'
import { runDetail } from '../workflows/runs'
import { fieldValue, normalize, type Operation } from './normalization'

/** Read samples in place: normal payload sealing, expiry and erasure still apply. */
export async function retainedCases(env: CrankEnv, actor: Actor, workflowId: string, versionId: string, stepId: string, field: string, runIds: string[]) {
  requireOwner(actor)
  const cases = []
  for (const runId of runIds) {
    const run = await runDetail(env, actor, runId)
    requireValue(run.workflow_id === workflowId && run.version_id === versionId && run.mode === 'production', 'Samples must belong to the selected published workflow version', 409)
    requireValue(!run.payload_expired_at, 'A selected sample expired under the owner’s retention policy', 409)
    const step = run.steps.find(s => s.path === stepId)
    requireValue(step?.status === 'succeeded', 'Each case must have a successful retained outcome, including corrected failures', 409)
    const revisions = run.revisions.filter(r => r.path === stepId)
    const correction = revisions.find(r => r.corrected)
    requireValue(!revisions.length || correction, 'A retried case without a manual correction cannot teach a skill', 409)
    const expected = fieldValue(step.input, field), input = correction ? fieldValue(correction.prior_input, field) : expected
    // A correction to a different field cannot be silently attributed to this field.
    if (correction) {
      const before = structuredClone(correction.prior_input), after = structuredClone(step.input)
      const remove = (value: any) => { const parts = field.replace(/\[(\d+)\]/g, '.$1').split('.'); const leaf = parts.pop()!; let parent = value; for (const p of parts) parent = parent?.[p]; if (parent) delete parent[leaf] }
      remove(before); remove(after)
      requireValue(canonical(before) === canonical(after) && input !== expected, 'Select corrections to this field alone', 409)
    }
    cases.push({ run_id: runId, corrected: !!correction, error: correction?.prior_error ?? null, input, expected })
  }
  const corrected = cases.filter(c => c.corrected)
  requireValue(corrected.length >= 2 && cases.some(c => !c.corrected), 'Select at least two corrected failures and a passing counterexample', 422)
  const signatures = new Set(corrected.map(c => canonical({ category: c.error?.category, status: c.error?.status, code: c.error?.code })))
  requireValue(signatures.size === 1, 'Selected corrections belong to different error clusters', 422)
  return cases
}
export function evaluateCases(cases: Awaited<ReturnType<typeof retainedCases>>, pipeline: Operation[]) {
  return cases.map(c => { const proposed = normalize(c.input, pipeline); return { ...c, proposed, pass: canonical(proposed) === canonical(c.expected) } })
}
