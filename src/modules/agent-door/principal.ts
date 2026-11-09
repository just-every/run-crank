import type { Principal, Runtime, ToolContext } from './types.ts'

/** Native grants may remove token authority, but never add to it. */
export async function narrowPrincipal(rt: Runtime, principal: Principal): Promise<Principal> {
  const current = rt.options.currentScopes ? await rt.options.currentScopes(principal) : principal.scopes
  if (!Array.isArray(current) || current.some(scope => typeof scope !== 'string')) throw new TypeError('Invalid current scopes')
  return { ...principal, scopes: [...new Set(principal.scopes)].filter(scope => current.includes(scope)) }
}

/**
 * Principals saved before rer 0.2.96 carry no `source`. In those versions a Business token was admitted only with a
 * nonempty `consent` id, a local credential never carried one, and embedded calls (which a Business stop does not
 * end) are the only other door. A held principal with no source that cannot be shown to be local or embedded
 * is therefore Business-admitted and ends with its Business like a tagged one.
 */
export function savedPrincipal(principal: Principal, door: ToolContext['door']): Principal {
  if (principal.source === 'business' || principal.source === 'local' || door === 'embedded' || principal.consent === undefined) return principal
  return { ...principal, source: 'business' }
}
