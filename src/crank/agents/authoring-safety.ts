import { getConnection } from '../connections/store'
import { requireValue, type CrankEnv } from '../model'
import { authoringState } from './authoring-record'
import { scopedGraph } from './authoring-schema'

/** Applied to every native test door, including callers outside the authoring UI. */
export async function authoringTestScope(env: CrankEnv, workflowId: string, graph: unknown, bindings: Record<string, unknown>) {
  const state = await authoringState(env, workflowId)
  scopedGraph(graph, state.record.scope)
  for (const [from, app] of [[state.record.scope.crm_connection_id, 'crm'], [state.record.scope.quickbooks_connection_id, 'quickbooks']]) {
    requireValue(typeof bindings[from] === 'string', 'Explicitly bind both authoring accounts', 422)
    const target = await getConnection(env, bindings[from] as string), original = await getConnection(env, from)
    requireValue(target.status === 'active' && target.app === original.app && target.purpose === 'test' && target.environment === 'sandbox', 'Authoring tests require explicit active sandbox accounts declared for testing', 422)
    if (app === 'quickbooks') requireValue(target.account_name === state.record.scope.realm_id, 'The sandbox company must match the approved invoice realm', 422)
  }
  return true
}
