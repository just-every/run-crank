import { orbitBinding, assertOrbitDestination } from './orbit-binding'
import { siblingBinding, assertSiblingDestination } from './sibling-binding'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'
import { hostAllowed } from './apps'
import { freshToken } from './oauth'
import { connectionDomains, credential, storeSecret, type ConnectionRow, type Secret } from './store'

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
export async function hmac(algorithm: 'sha256' | 'sha1', secret: string | Uint8Array<ArrayBuffer>, message: string | Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', typeof secret === 'string' ? new TextEncoder().encode(secret) : secret, { name: 'HMAC', hash: algorithm === 'sha1' ? 'SHA-1' : 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, typeof message === 'string' ? new TextEncoder().encode(message) : message)
}

async function clientCredentials(env: CrankEnv, row: ConnectionRow, secret: Secret): Promise<string> {
  if (secret.access_token && secret.expires_at && Date.parse(secret.expires_at) - Date.now() > 60000) return secret.access_token
  const form: Record<string, string> = { grant_type: 'client_credentials', client_id: secret.client_id, client_secret: secret.client_secret }
  if (secret.scope) form.scope = secret.scope
  const tokenUrl = new URL(secret.token_url)
  if (!hostAllowed(tokenUrl.hostname, connectionDomains(row))) throw new StepError('egress', 'The token URL is outside this connection’s API domains')
  const response = await boundedFetch(tokenUrl.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), maxBytes: 65536 })
  let body: unknown
  try { body = JSON.parse(utf8(response.bytes)) } catch { body = null }
  if (response.status !== 200 || !isObject(body) || typeof body.access_token !== 'string') throw new StepError('auth', 'The token endpoint refused the client credentials')
  const expires = new Date(Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000).toISOString()
  await storeSecret(env, row, { ...secret, access_token: body.access_token, expires_at: expires }, expires)
  return body.access_token
}

/** Applies a stored connection's credential to one outgoing request, only inside the
 * connection's declared API domains. Credentials never enter the graph or run history. */
export async function authorizeRequest(env: CrankEnv, connectionId: string, url: URL, headers: Headers, body: string | Uint8Array<ArrayBuffer> | null, method = 'GET') {
  const { row, secret: stored } = await credential(env, connectionId)
  if (row.app === 'nook') {
    assertSiblingDestination(siblingBinding(JSON.parse(row.sibling_binding_json ?? 'null')), url)
    if (!JSON.parse(row.scopes_json).includes('messages:write')) throw new StepError('connection', 'Nook posting requires messages:write on the current connection', { connection_id: row.id, reconnect: true })
  }
  if (row.app === 'orbit') assertOrbitDestination(orbitBinding(JSON.parse(row.sibling_binding_json ?? 'null')), JSON.parse(row.scopes_json), url, method, body, headers)
  if (!hostAllowed(url.hostname, connectionDomains(row))) throw new StepError('egress', `${url.hostname} is outside the API domains of connection "${row.label}"`, { connection_id: row.id })
  let secret = stored
  switch (row.auth_kind) {
    case 'bearer': headers.set('authorization', 'Bearer ' + secret.token); break
    case 'basic': headers.set('authorization', 'Basic ' + btoa(`${secret.username}:${secret.password}`)); break
    case 'api_key':
      if (secret.query) url.searchParams.set(secret.query, secret.key)
      else headers.set(secret.header ?? 'x-api-key', secret.key)
      break
    case 'oauth2': secret = await freshToken(env, row, secret); headers.set('authorization', 'Bearer ' + secret.access_token); break
    case 'oauth2_client_credentials': headers.set('authorization', 'Bearer ' + await clientCredentials(env, row, secret)); break
    case 'hmac': {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const payload = body ?? ''
      const signed = secret.timestamp_header ? `${timestamp}.${typeof payload === 'string' ? payload : new TextDecoder().decode(payload)}` : payload
      const signature = await hmac(secret.algorithm === 'sha1' ? 'sha1' : 'sha256', secret.secret, signed)
      if (secret.timestamp_header) headers.set(secret.timestamp_header, timestamp)
      headers.set(secret.header ?? 'x-signature', (secret.prefix ?? '') + (secret.encoding === 'base64' ? b64(signature) : hex(signature)))
      break
    }
    default: throw new StepError('config', `A ${row.auth_kind} connection cannot authorize requests`)
  }
  return { row, secret }
}
