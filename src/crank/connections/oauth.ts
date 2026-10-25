import { guardedBatch, requireOwner } from '../access'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { credential, createConnection, getConnection, rotateConnection, storeSecret, type ConnectionRow, type Secret } from './store'
import { open, randomToken, seal } from './vault'

/** Provider OAuth 2.0 authorization-code endpoints, from each provider's documentation. */
interface Provider { authorize: string; token: string; separator: ' ' | ','; pkce: boolean; extra?: Record<string, string>; tokenAuth: 'body' | 'basic' }
export const PROVIDERS: Record<string, Provider> = {
  quickbooks: { authorize: 'https://appcenter.intuit.com/connect/oauth2', token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', separator: ' ', pkce: false, tokenAuth: 'basic' },
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
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }), fields = { ...form }
  if (provider.tokenAuth === 'basic') { headers.set('authorization', 'Basic ' + btoa(`${fields.client_id}:${fields.client_secret}`)); delete fields.client_id; delete fields.client_secret }
  const response = await boundedFetch(provider.token, { method: 'POST', headers, body: new URLSearchParams(fields).toString(), timeoutMs: 15000, maxBytes: 65536 })
  let body: unknown
  try { body = JSON.parse(utf8(response.bytes)) } catch { throw new StepError('auth', `${app} returned an unreadable token response`) }
  if (response.status !== 200 || !isObject(body) || body.ok === false || typeof body.access_token !== 'string') throw new StepError('auth', `${app} refused the token request; reconnect the account`)
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
  const realm = row.app === 'quickbooks' ? params.get('realmId') : null
  if (row.app === 'quickbooks') requireValue(realm && /^[0-9]{1,30}$/.test(realm), 'QuickBooks returned no sandbox company realmId')
  if (row.app === 'quickbooks' && row.connection_id) requireValue((await getConnection(env, row.connection_id)).account_name === realm, 'Reconnect the original QuickBooks company; use a new connection for another company', 409)
  const token = await tokenRequest(row.app, form)
  const scopes = token.granted ?? JSON.parse(row.scopes_json)
  const input = { app: row.app, label: row.label, auth_kind: 'oauth2', secret: token.secret }
  return row.connection_id
    ? rotateConnection(env, actor, row.connection_id, input, { scopes, expiresAt: token.expires })
    : createConnection(env, actor, input, { scopes, account: realm ?? token.team, expiresAt: token.expires })
}

/** Refresh custody is separate from request capacity. Exactly one caller may use
 * a rotating refresh token; waiters re-read the winning sealed credential. A stale
 * claim whose credential never changed is uncertain, so it requires reconnecting. */
export async function freshToken(env: CrankEnv, initialRow: ConnectionRow, initialSecret: Secret): Promise<Secret> {
  const fresh = (secret: Secret) => !secret.expires_at || Date.parse(secret.expires_at) - Date.now() > 60000
  if (initialRow.auth_kind !== 'oauth2' || fresh(initialSecret)) return initialSecret
  const deadline = Date.now() + 20000
  for (;;) {
    const { row, secret } = await credential(env, initialRow.id)
    if (fresh(secret)) return secret
    if (!secret.refresh_token) throw new StepError('auth', `The ${row.app} token expired and has no refresh token; reconnect it`, { connection_id: row.id, reconnect: true })
    const at = now(), lease = id(), fingerprint = await digest(row.secret_ciphertext!)
    const prior = await stmt(env, 'SELECT lease_id,credential_digest,expires_at FROM crank_oauth_refresh_leases WHERE connection_id=?', row.id).first<{ lease_id: string; credential_digest: string; expires_at: string }>()
    if (prior && prior.expires_at <= at) {
      // A committed rotation/renewal already reconciles the old claim. Otherwise
      // the provider may have consumed the refresh token before the interruption.
      if (fingerprint !== prior.credential_digest) {
        await stmt(env, 'DELETE FROM crank_oauth_refresh_leases WHERE connection_id=? AND lease_id=?', row.id, prior.lease_id).run()
        continue
      }
      await stmt(env, `UPDATE crank_connections SET status='needs_reconnect' WHERE id=? AND status='active' AND secret_ciphertext=?
        AND EXISTS(SELECT 1 FROM crank_oauth_refresh_leases WHERE connection_id=? AND lease_id=? AND expires_at<=?)`, row.id, row.secret_ciphertext, row.id, prior.lease_id, at).run()
      throw new StepError('connection', 'Token renewal was interrupted; reconnect before another provider operation', { connection_id: row.id, reconnect: true })
    }
    const claim = await stmt(env, `INSERT INTO crank_oauth_refresh_leases(connection_id,lease_id,credential_digest,started_at,expires_at)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`, row.id, lease, fingerprint, at, new Date(Date.now() + 30000).toISOString()).run()
    if (claim.meta.changes !== 1) {
      if (Date.now() >= deadline) throw new StepError('connection', 'Token renewal is still in progress; resume after it finishes', { connection_id: row.id })
      await new Promise(resolve => setTimeout(resolve, 100)); continue
    }
    try {
      // The row may have changed between the first read and the lease claim.
      const current = await credential(env, row.id)
      if (fresh(current.secret)) return current.secret
      if (current.row.secret_ciphertext !== row.secret_ciphertext) continue
      const client = await oauthApp(env, row.app)
      let token: Awaited<ReturnType<typeof tokenRequest>>
      try { token = await tokenRequest(row.app, { grant_type: 'refresh_token', refresh_token: secret.refresh_token, client_id: client.client_id, client_secret: client.client_secret }) }
      catch {
        await stmt(env, "UPDATE crank_connections SET status='needs_reconnect' WHERE id=? AND status='active' AND secret_ciphertext=?", row.id, row.secret_ciphertext).run()
        throw new StepError('connection', 'Token renewal could not be confirmed; reconnect before another provider operation', { connection_id: row.id, reconnect: true })
      }
      const scopes: string[] = JSON.parse(row.scopes_json)
      if (token.granted && token.granted.some(scope => !scopes.includes(scope))) {
        await stmt(env, "UPDATE crank_connections SET status='needs_reconnect' WHERE id=? AND status='active' AND secret_ciphertext=?", row.id, row.secret_ciphertext).run()
        throw new StepError('connection', 'The provider returned new scopes during renewal; fresh owner consent is required', { connection_id: row.id, reconnect: true })
      }
      const next: Secret = { ...secret, ...token.secret, refresh_token: token.secret.refresh_token ?? secret.refresh_token }
      if (!token.expires) delete next.expires_at
      await storeSecret(env, row, next, token.expires, token.granted)
      return next
    } finally { await stmt(env, 'DELETE FROM crank_oauth_refresh_leases WHERE connection_id=? AND lease_id=?', row.id, lease).run() }
  }
}
