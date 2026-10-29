import { createAgentDoor, type Trust } from '../../modules/agent-door/index.ts'
import { runtimeBindings, type Bindings } from '../../auth.server'
import { peopleAdapter, localCredentials } from './people'
import { crankTools } from './tools'

export const capabilities = ['tools', 'policy', 'pause', 'audit', 'idempotency'] as const

function installationTrust(env: Bindings): Trust | null {
  const issuer = env.RER_OWNER_CLAIM_ISSUER
  const installationId = env.RER_OWNER_CLAIM_INSTALLATION_ID
  const publicKeys = env.RER_OWNER_CLAIM_PUBLIC_KEYS
  if (![issuer, installationId, publicKeys].some(Boolean)) return null
  if (!issuer || !installationId || !publicKeys) throw new Error('Incomplete installation trust')
  return { issuer, installationId, appOrigin: env.AUTH_ORIGIN, publicKeys: JSON.parse(publicKeys) }
}

/** One registry and policy pipeline for Business, local preparation and person review. */
export function crankAgentDoor(bindings: Bindings) {
  const env = runtimeBindings(bindings)
  return createAgentDoor({
    seed: 'crank', name: 'Crank', specialist: 'Automation operations lead',
    db: env.DB, origin: env.AUTH_ORIGIN, trust: installationTrust(env),
    capabilities: [...capabilities], people: peopleAdapter(env),
    tools: crankTools(env), resources: [],
    paths: ['/api/crank/v1/mcp'],
    localCredentials: request => localCredentials(env, request),
    notTools: [
      { clauses: ['PLATFORM-002'], reason: 'connector' },
      { clauses: ['DATA-001'], reason: 'import-door' },
      { clauses: ['BASE-002'], reason: 'installation' },
    ],
  })
}

/** Construct native adapters only for paths owned by the shared door. */
export async function crankAgentResponse(request: Request, env: Bindings): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/api/rer/agent-policy', '/mcp', '/api/crank/v1/mcp', '/agents'].includes(path)
    && !path.startsWith('/agents/api/') && !/^\/agents\/approvals\/[^/]+$/.test(path)) return null
  return crankAgentDoor(env).handle(request)
}
