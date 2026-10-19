import { getConnection } from '../connections/store'
import type { CrankEnv } from '../model'
import type { RunRow, Step } from './types'

/** Live tests against production accounts stop at the exact mapped effect.
 * Test-marked accounts are an owner's declaration, never provider verification. */
export async function liveTestProposal(env: CrankEnv, run: RunRow, step: Step, input: Record<string, unknown>) {
  if (run.mode !== 'test') return null
  const connection = typeof step.connection_id === 'string' ? await getConnection(env, step.connection_id) : null
  if (connection?.purpose === 'test') return null
  return {
    proposal: { test: true, step: step.id, type: step.type, account: connection ? { id: connection.id, label: connection.label, name: connection.account_name } : { label: 'Direct HTTP destination', url: input.url }, input, sample: JSON.parse(run.trigger_json) },
    reason: `Confirm live test: ${step.type} on ${connection?.account_name || connection?.label || String(input.url ?? 'the production destination')}. This can create a real effect.`,
  }
}
