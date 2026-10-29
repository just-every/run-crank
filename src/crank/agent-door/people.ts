import { operatorAuth, runtimeBindings } from '../../auth.server'
import { operatorAuthPeople } from '../../modules/agent-door/index'
import type { AgentDoorOptions, PeopleAdapter } from '../../modules/agent-door/types'
import { stmt, type CrankEnv } from '../model'

export const LOCAL_AGENT_PREFIX = 'crank-token:'
const localScopes = ['workflows:read', 'workflows:prepare', 'runs:read', 'connections:read', 'catalog:read']

/** Business subjects retain the settings module's durable native-operator bindings. */
export function peopleAdapter(original: CrankEnv): PeopleAdapter {
  const env = runtimeBindings(original) as CrankEnv
  return operatorAuthPeople({ db: env.DB, session: request => operatorAuth(env).getSession(request) })
}

/** Only existing preparation credentials enter this door; execution grants and
 * flow-bound trigger credentials retain their separate native purposes. */
export async function localCredentials(original: CrankEnv, request: Request): ReturnType<NonNullable<AgentDoorOptions['localCredentials']>> {
  if (!/^Bearer crk_[A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') ?? '')) return null
  const env = runtimeBindings(original) as CrankEnv
  const { authorize } = await import('../access')
  const actor = await authorize(request, env)
  if (actor.kind !== 'agent' || !actor.tokenId || actor.flowId) return null
  const token = await stmt(env, "SELECT label FROM crank_tokens WHERE id=? AND scope='agent' AND flow_id IS NULL AND revoked_at IS NULL", actor.tokenId).first<{ label: string }>()
  if (!token) return null
  return {
    sponsor: { id: actor.id },
    agent: { id: LOCAL_AGENT_PREFIX + actor.tokenId, name: token.label },
    scopes: [...localScopes],
  }
}
