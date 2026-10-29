import type { Principal, Runtime } from './types.ts'

/** Native grants may remove token authority, but never add to it. */
export async function narrowPrincipal(rt: Runtime, principal: Principal): Promise<Principal> {
  const current = rt.options.currentScopes ? await rt.options.currentScopes(principal) : principal.scopes
  if (!Array.isArray(current) || current.some(scope => typeof scope !== 'string')) throw new TypeError('Invalid current scopes')
  return { ...principal, scopes: [...new Set(principal.scopes)].filter(scope => current.includes(scope)) }
}
