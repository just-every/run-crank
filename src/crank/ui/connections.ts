import { APPS } from '../connections/apps'
import { action, chip, esc, timestamp } from './document'
import { tile } from './editor/canvas'
import { icon } from './icons'

const TILE: Record<string, [string, string]> = { slack: ['slack', 'chat'], google: ['sheets', 'sheet'], hubspot: ['hubspot', 'http'], webhook: ['tool', 'key'], http: ['tool', 'http'] }
const STATUS: Record<string, string> = { active: 'Connected', revoked: 'Revoked', needs_reconnect: 'Needs reconnect' }
const AUTH: Record<string, string> = { bearer: 'API token', basic: 'User name and password', api_key: 'API key', hmac: 'Signed requests', oauth2: 'OAuth sign-in', oauth2_client_credentials: 'OAuth client', signing_secret: 'Signing secret' }

export function connectionsView(connections: any[], owner: boolean) {
  if (!connections.length) return `<div class="empty-state">${icon('connections', 'icon empty-icon')}<h3>No connections yet</h3><p>A connection holds one app’s credential, sealed on this installation and never shown again. Owners add one with <code>POST /api/crank/connections</code>, or start Slack, HubSpot or Google sign-in with <code>POST /api/crank/oauth/start</code>; see docs/API.md.</p></div>`
  return `<section class="panel"><div class="panel-head"><h2>Your connections</h2><span class="muted">Credentials are encrypted and never returned. Steps may call only a connection’s own domains.</span></div><ul class="list">${connections.map(c => {
    const [t, glyph] = c.app === 'http' && c.domains.some((d: string) => /intuit\.com$/.test(d)) ? ['quickbooks', 'invoice'] : TILE[c.app] ?? ['tool', 'http']
    return `<li class="settings-row">${tile({ tile: t, glyph })}<span class="row-main"><strong>${esc(c.label)}</strong><span class="muted">${esc(APPS[c.app]?.name ?? c.app)} · ${esc(AUTH[c.auth_kind] ?? c.auth_kind.replace(/_/g, ' '))}${c.account_name ? ` · ${esc(c.account_name)}` : ''}</span>${c.domains.length ? `<span class="mono flow-id">${esc(c.domains.join(', '))}</span>` : ''}<span class="muted flow-id">Added ${timestamp(c.created_at)}</span></span>${chip(c.status === 'active' ? 'active' : c.status === 'revoked' ? 'revoked' : 'pending', STATUS[c.status] ?? c.status)}${owner && c.status !== 'revoked' ? action(`/api/crank/connections/${c.id}/revoke`, 'Revoke', { return_to: '/app/connections' }, 'secondary') : ''}</li>`
  }).join('')}</ul></section>`
}
