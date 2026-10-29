import { operatorAuth, runtimeBindings } from '../../auth.server'
import { operatorAuthPeople } from '../../modules/agent-door/index'
import type { AgentDoorOptions, PeopleAdapter, Person } from '../../modules/agent-door/types'
import { stmt, type CrankEnv } from '../model'

export const LOCAL_AGENT_PREFIX = 'crank-token:'
const localScopes = ['workflows:read', 'workflows:prepare', 'runs:read', 'connections:read', 'catalog:read']

/** Business subjects retain the settings module's durable native-operator bindings. */
export function peopleAdapter(original: CrankEnv): PeopleAdapter {
  const env = runtimeBindings(original) as CrankEnv
  const native = operatorAuthPeople({ db: env.DB, session: request => operatorAuth(env).getSession(request) })
  // A native role transfer cannot move an already-bound Business subject.
  const owner = () => stmt(env, 'SELECT claim_id AS id FROM oa_bootstrap WHERE singleton=1').first<{ id: string }>()
  const member: NonNullable<PeopleAdapter['businessMember']> = async person => {
    const settings = await stmt(env, 'SELECT owner_id FROM bs_settings WHERE singleton=1 AND stopped=0').first<{ owner_id: string | null }>()
    if (!settings) return null
    if (settings.owner_id && (await owner())?.id === person.id) return { id: settings.owner_id, role: 'owner' }
    const row = await stmt(env, "SELECT business_id,business_role FROM bs_team WHERE operator_id=? AND state<>'conflict' AND business_id IS NOT NULL", person.id).first<{ business_id: string; business_role: string }>()
    return row ? { id: row.business_id, role: row.business_role === 'admin' ? 'editor' : null } : null
  }
  // Person-page policy roles follow signed Business membership too. Native roles
  // remain on Person for the seed's own tools and are re-read at native execution.
  const roles = new WeakMap<Person, 'owner' | 'editor' | null>()
  const read = async (id: string) => {
    const person = await native.person(id)
    if (person) roles.set(person, (await member(person))?.role ?? null)
    return person
  }
  return {
    person: read, businessMember: member,
    businessRole: person => env.RER_OWNER_CLAIM_PUBLIC_KEYS ? roles.get(person) ?? null
      : person.role === 'owner' ? 'owner' : person.role === 'admin' ? 'editor' : null,
    async session(request) {
      const person = await native.session(request)
      return person ? read(person.id) : null
    },
    async sponsor(claim) {
      const settings = await stmt(env, 'SELECT owner_id FROM bs_settings WHERE singleton=1 AND stopped=0').first<{ owner_id: string | null }>()
      if (!settings) return null
      if (settings.owner_id === claim.sub) {
        const bound = await owner()
        return bound ? read(bound.id) : null
      }
      const person = await native.sponsor(claim)
      return person ? read(person.id) : null
    },
  }
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
