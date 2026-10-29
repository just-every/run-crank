import type { AgentDoorOptions, Principal } from './types.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid encoding')
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
  const canonical = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  if (canonical !== segment) throw new Error('Invalid encoding')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function json(segment: string): unknown {
  return JSON.parse(decoder.decode(decode(segment)))
}

/** A recognizable Business header must never fall through to local credentials. */
export function isBusinessCredential(token: string): boolean {
  try {
    const segment = token.split('.')[0] ?? ''
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(segment)) return false
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
    return record(JSON.parse(decoder.decode(Uint8Array.from(binary, character => character.charCodeAt(0)))))
  } catch {
    return false
  }
}

/** ES256 uses the fixed-width IEEE P1363 signature accepted by Web Crypto. */
export async function verifyJws(
  token: string,
  typ: string,
  publicKeys: Record<string, JsonWebKey>,
): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]
    const header = json(encodedHeader)
    if (!record(header) || Object.keys(header).length !== 3 || header.alg !== 'ES256' ||
      header.typ !== typ || !nonempty(header.kid) ||
      !Object.prototype.hasOwnProperty.call(publicKeys, header.kid)) return null
    const jwk = publicKeys[header.kid]
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d !== undefined) return null
    const signature = decode(encodedSignature)
    if (signature.byteLength !== 64) return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, signature,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    )
    if (!verified) return null
    const claims = json(encodedPayload)
    return record(claims) ? claims : null
  } catch {
    return null
  }
}

export async function authenticate(
  options: AgentDoorOptions,
  request: Request,
  business: string | null,
): Promise<Principal | null> {
  try {
    const authorization = request.headers.get('authorization')
    const bearer = authorization?.match(/^Bearer[ \t]+([^\s]+)/i)?.[1]
    if (bearer && isBusinessCredential(bearer)) {
      if (!options.trust || !/^Bearer[ \t]+[^\s]+$/i.test(authorization!)) return null
      const claims = await verifyJws(bearer, 'at+jwt', options.trust.publicKeys)
      const now = (options.now ?? Date.now)() / 1000
      if (!claims || claims.iss !== options.trust.issuer || claims.aud !== `${options.origin}/mcp` ||
        !nonempty(claims.sub) || !nonempty(claims.email) ||
        claims.email !== claims.email.trim().toLowerCase() ||
        !record(claims.act) || !nonempty(claims.act.sub) || !nonempty(claims.act.name) ||
        (claims.act.specialist !== undefined && claims.act.specialist !== null && !nonempty(claims.act.specialist)) ||
        !nonempty(claims.client_id) || !nonempty(claims.business) || !nonempty(claims.jti) ||
        (business !== null && claims.business !== business) || typeof claims.scope !== 'string' ||
        (claims.scope !== '' && !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(claims.scope)) ||
        !Number.isFinite(now) || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) ||
        typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.iat > now + 30 ||
        claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 900) return null
      if (!nonempty(claims.consent)) return null
      const person = await options.people.sponsor({ sub: claims.sub })
      // A token outlives no change of address: its email must still be the subject's current native email.
      if (!person?.active || person.email.trim().toLowerCase() !== claims.email) return null
      return {
        person,
        agent: { id: claims.act.sub, name: claims.act.name, specialist: claims.act.specialist as string | null | undefined },
        scopes: claims.scope === '' ? [] : claims.scope.split(' '), clientId: claims.client_id, consent: claims.consent,
      }
    }
    const local = await options.localCredentials?.(request)
    if (!local || !nonempty(local.sponsor.id) || !nonempty(local.agent.id) || !nonempty(local.agent.name) ||
      (local.agent.specialist !== undefined && local.agent.specialist !== null && !nonempty(local.agent.specialist)) ||
      (local.clientId !== undefined && !nonempty(local.clientId)) ||
      !Array.isArray(local.scopes) || !local.scopes.every(nonempty)) return null
    const person = await options.people.person(local.sponsor.id)
    if (!person?.active) return null
    return { person, agent: local.agent, scopes: local.scopes, clientId: local.clientId }
  } catch {
    return null
  }
}
