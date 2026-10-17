import { guardedBatch, requireOwner } from '../access'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { digest, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { createConnection, getConnection, rotateConnection, storeSecret, type ConnectionRow, type Secret } from './store'
import { open, randomToken, seal } from './vault'

/** Provider OAuth 2.0 authorization-code endpoints, from each provider's documentation. */
interface Provider { authorize: string; token: string; separator: ' ' | ','; pkce: boolean; extra?: Record<string, string>; tokenAuth: 'body' | 'basic' }
export const PROVIDERS: Record<string, Provider> = {
  // https://api.slack.com/authentication/oauth-v2
  slack: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', separator: ',', pkce: false, tokenAuth: 'body' },
  // https://developers.hubspot.com/docs/api/oauth-quickstart-guide
  hubspot: { authorize: 'https://app.hubspot.com/oauth/authorize', token: 'https://api.hubapi.com/oauth/v1/token', separator: ' ', pkce: false, tokenAuth: 'body' },
  // https://developers.google.com/identity/protocols/oauth2/web-server
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', separator: ' ', pkce: true, extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }, tokenAuth: 'body' },
}
const redirectUri = (env: CrankEnv) => new URL('/api/crank/oauth/callback', env.AUTH_ORIGIN).href
const b64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The owner's own OAuth app registration for a provider (client ID and secret). */
export async function setOauthApp(env: CrankEnv, actor: Actor, app: string, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(PROVIDERS[app], `No OAuth flow for ${app}`)
  const sealed = await seal(env, `crank-oauth-app:${app}`, { client_secret: text(input.client_secret, 'client_secret', 2048) })
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_oauth_apps(app,client_id,secret_iv,secret_ciphertext,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(app) DO UPDATE SET client_id=excluded.client_id,secret_iv=excluded.secret_iv,secret_ciphertext=excluded.secret_ciphertext,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      app, text(input.client_id, 'client_id', 512), sealed.iv, sealed.ciphertext, actor.id, now()),
    auditStatement(env, actor.id, 'oauth_app.set', 'oauth_app', app),
  ])
  return { app, client_id: text(input.client_id, 'client_id', 512), redirect_uri: redirectUri(env) }
}
async function oauthApp(env: CrankEnv, app: string) {
  const row = await stmt(env, 'SELECT * FROM crank_oauth_apps WHERE app=?', app).first<{ client_id: string; secret_iv: string; secret_ciphertext: string }>()
  requireValue(row, `Register your ${app} OAuth app first (client ID and secret)`, 409)
  return { client_id: row.client_id, ...(await open<{ client_secret: string }>(env, `crank-oauth-app:${app}`, row.secret_iv, row.secret_ciphertext)) }
}

/** Starts consent: exact scopes are shown at the provider; state and PKCE bind the callback. */
export async function startOauth(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const app = text(input.app, 'app', 40), provider = PROVIDERS[app]
  requireValue(provider, `No OAuth flow for ${app}`)
  const scopes = Array.isArray(input.scopes) ? input.scopes.map(scope => text(scope, 'scope', 200)) : []
  requireValue(scopes.length > 0, 'Choose the scopes to request')
  const client = await oauthApp(env, app), state = randomToken(), verifier = randomToken(48), at = Date.now()
  let connectionId: string | null = null
  if (input.connection_id !== undefined) { connectionId = text(input.connection_id, 'connection_id'); requireValue((await getConnection(env, connectionId)).app === app, 'That connection is for another app') }
  const sealed = await seal(env, `crank-oauth-state:${await digest(state)}`, { verifier })
  await guardedBatch(env, actor, 'owner', [stmt(env, 'INSERT INTO crank_oauth_states(state_hash,app,label,scopes_json,connection_id,verifier_iv,verifier_ciphertext,actor_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    await digest(state), app, text(input.label, 'label'), JSON.stringify(scopes), connectionId, sealed.iv, sealed.ciphertext, actor.id, new Date(at).toISOString(), new Date(at + 600000).toISOString())])
  const url = new URL(provider.authorize)
  url.searchParams.set('client_id', client.client_id); url.searchParams.set('redirect_uri', redirectUri(env)); url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scopes.join(provider.separator)); url.searchParams.set('state', state)
  if (provider.pkce) { url.searchParams.set('code_challenge', b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))); url.searchParams.set('code_challenge_method', 'S256') }
  for (const [key, value] of Object.entries(provider.extra ?? {})) url.searchParams.set(key, value)
  return { authorize_url: url.href, redirect_uri: redirectUri(env), scopes, expires_at: new Date(at + 600000).toISOString() }
}

async function tokenRequest(app: string, form: Record<string, string>) {
  const provider = PROVIDERS[app]
  const response = await boundedFetch(provider.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), timeoutMs: 15000, maxBytes: 65536 })
  let body: unknown
  try { body = JSON.parse(utf8(response.bytes)) } catch { throw new StepError('auth', `${app} returned an unreadable token response`) }
  if (response.status !== 200 || !isObject(body) || body.ok === false || typeof body.access_token !== 'string') throw new StepError('auth', `${app} refused the token request${isObject(body) && typeof body.error === 'string' ? ` (${body.error.slice(0, 80)})` : ''}`)
  const expires = typeof body.expires_in === 'number' ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null
  const granted = typeof body.scope === 'string' ? body.scope.split(/[ ,]+/).filter(Boolean) : null
  const team = isObject(body.team) && typeof body.team.name === 'string' ? body.team.name : typeof body.hub_domain === 'string' ? body.hub_domain : ''
  const secret: Secret = { access_token: body.access_token, token_type: typeof body.token_type === 'string' ? body.token_type : 'bearer' }
  if (typeof body.refresh_token === 'string') secret.refresh_token = body.refresh_token
  if (expires) secret.expires_at = expires
  return { secret, expires, granted, team }
}

/** The redirect back from the provider; one use, ten minutes, the starting owner only. */
export async function finishOauth(env: CrankEnv, actor: Actor, params: URLSearchParams) {
  requireOwner(actor)
  const state = params.get('state') ?? '', code = params.get('code') ?? ''
  requireValue(state && !params.get('error'), `The provider did not grant access${params.get('error') ? ` (${params.get('error')!.slice(0, 80)})` : ''}`, 400)
  const hash = await digest(state)
  const row = await stmt(env, 'SELECT * FROM crank_oauth_states WHERE state_hash=?', hash).first<{ app: string; label: string; scopes_json: string; connection_id: string | null; verifier_iv: string; verifier_ciphertext: string; actor_id: string; expires_at: string; used_at: string | null }>()
  requireValue(row && !row.used_at && row.actor_id === actor.id && row.expires_at > now(), 'This authorization link is expired, used or belongs to someone else', 400)
  const claimed = await stmt(env, 'UPDATE crank_oauth_states SET used_at=? WHERE state_hash=? AND used_at IS NULL', now(), hash).run()
  requireValue(claimed.meta.changes === 1, 'This authorization link was already used', 409)
  requireValue(code, 'The provider returned no authorization code', 400)
  const { verifier } = await open<{ verifier: string }>(env, `crank-oauth-state:${hash}`, row.verifier_iv, row.verifier_ciphertext)
  const client = await oauthApp(env, row.app)
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env), client_id: client.client_id, client_secret: client.client_secret }
  if (PROVIDERS[row.app].pkce) form.code_verifier = verifier
  const token = await tokenRequest(row.app, form)
  const scopes = token.granted ?? JSON.parse(row.scopes_json)
  const input = { app: row.app, label: row.label, auth_kind: 'oauth2', secret: token.secret }
  return row.connection_id
    ? rotateConnection(env, actor, row.connection_id, input, { scopes, expiresAt: token.expires })
    : createConnection(env, actor, input, { scopes, account: token.team, expiresAt: token.expires })
}

/** Refreshes an OAuth access token shortly before expiry and keeps the rotated pair. */
export async function freshToken(env: CrankEnv, row: ConnectionRow, secret: Secret): Promise<Secret> {
  if (row.auth_kind !== 'oauth2' || !secret.expires_at || Date.parse(secret.expires_at) - Date.now() > 60000) return secret
  if (!secret.refresh_token) throw new StepError('auth', `The ${row.app} token expired and has no refresh token; reconnect it`, { connection_id: row.id, reconnect: true })
  const client = await oauthApp(env, row.app)
  const token = await tokenRequest(row.app, { grant_type: 'refresh_token', refresh_token: secret.refresh_token, client_id: client.client_id, client_secret: client.client_secret })
  const next = { ...secret, ...token.secret, refresh_token: token.secret.refresh_token ?? secret.refresh_token }
  await storeSecret(env, row, next, token.expires)
  return next
}
