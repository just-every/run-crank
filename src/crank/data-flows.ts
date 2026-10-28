import { listConnections } from './connections/store'
import { PROVIDERS } from './connections/oauth'
import { graphDataFlows } from './data-flow-graphs'
import { stmt, type CrankEnv } from './model'
import { retentionPolicy } from './ops/retention'
import { aiConfig } from '../modules/ai/index.mjs'

import { type DataFlow, recipient, queryFields, providerFlow } from './data-flow-types'

/** BASE-001: a projection of configuration, never a provider certification or
 * additional authorization. The existing owner-only Data door guards access. */
export async function dataFlows(env: CrankEnv) {
  const connections = await listConnections(env), flows: DataFlow[] = []
  const custom=await stmt(env,'SELECT id,version,definition_json,status FROM crank_custom_versions ORDER BY id,version').all<{id:string;version:number;definition_json:string;status:string}>()
  for(const c of custom.results){const d=JSON.parse(c.definition_json),x=d.disclosure;flows.push({id:`custom:${c.id}:${c.version}`,kind:'custom',label:d.name,state:c.status,recipients:[x.recipient],purpose:x.purpose,fields:x.fields,credentials:d.operations.some((o:any)=>o.gateway)?'Installation-bound gateway service credential; private DB/file credentials stay on the customer gateway':'Explicit workflow connection; credential values stay on this installation',region:x.region+' (owner declared; provider terms unverified)',retention:x.retention+' (owner declared; provider terms unverified)'})}
  const add = (flow: Omit<DataFlow, 'region' | 'retention'> & Partial<Pick<DataFlow, 'region' | 'retention'>>) => {
    flows.push(providerFlow(flow))
  }
  const credential = (connectionId: unknown) => {
    const c = connections.find(c => c.id === connectionId)
    return c ? `${c.label}: ${c.auth_kind} (${c.status}); credential values stay server-side` : 'No stored connection; only declared noncredential request fields'
  }
  const mailLocal = env.RER_DEMO === '1' || env.AUTH_LOCAL === 'true' && env.MAIL_PROVIDER === 'development'
  const model = aiConfig(env as unknown as Record<string, unknown>)
  const transport = model.direct ?? model.models
  if (model.enabled && transport?.baseUrl) add({ id: 'authoring-model', kind: 'authoring', label: 'Workflow proposal model', state: 'owner initiated only',
    recipients: [recipient(transport.baseUrl)], purpose: 'Propose an inactive editable workflow within owner-selected connector scope; no app credential or execution authority is sent',
    fields: ['business prompt', 'owner-selected connector schemas', 'owner-submitted samples', 'allowed account identifiers and mappings'],
    credentials: 'Installation AI_API_KEY or MODELS_KEY; credentials remain server-side' })
  add({ id: 'workflow-samples', kind: 'sample', label: 'Retained workflow samples', state: 'explicit preview only', recipients: [], purpose: 'Owner-started draft webhook capture and authorized manual, history and schema previews; no production admission', fields: ['sample fields, body, safe headers, query and file content', 'source identity, time and declared field paths'], credentials: 'No app credential; single-use draft URL expires after ten minutes and never travels in archives', region: 'This installation', retention: 'Retained until explicitly deleted; history copies follow source-run erasure and payload expiry. Archives restore samples unselected, without a receiving URL.' })
  const mailHosts = { resend: 'https://api.resend.com', sendgrid: 'https://api.sendgrid.com', cloudflare: 'https://api.cloudflare.com' }
  add({ id: 'mail', kind: 'mail', label: 'Installation mail', state: mailLocal ? 'suppressed' : env.MAIL_PROVIDER && env.MAIL_PROVIDER !== 'development' ? 'configured' : 'unconfigured',
    recipients: mailLocal ? [] : env.MAIL_PROVIDER && env.MAIL_PROVIDER in mailHosts ? [mailHosts[env.MAIL_PROVIDER as keyof typeof mailHosts]] : [],
    purpose: 'Native sign-in, invitations, confirmation links and workflow-owner notices',
    fields: ['sender and recipient email', 'subject', 'sign-in or confirmation link', 'notice text, workflow/connection labels and app links'],
    credentials: mailLocal ? 'None; development mail is suppressed' : 'Installation MAIL_API_KEY; Cloudflare also requires MAIL_ACCOUNT_ID',
    ...(mailLocal ? { region: 'This installation', retention: 'Development sends are suppressed, not stored or delivered' } : {}) })
  for (const c of connections) add({ id: `connection:${c.id}`, kind: 'connection', label: c.label, state: c.status,
    recipients: 'binding' in c && c.binding ? [c.binding.origin] : c.domains.map((d: string) => `${d} (including subdomains)`), purpose: `${c.app} API access, connection verification and credential refresh when applicable`,
    fields: ['credential authentication', 'verification account identity', 'workflow-selected fields listed in the workflow entries'], credentials: credential(c.id) })
  const noticeRoutes = await stmt(env, 'SELECT workflow_id,connection_id,enabled FROM crank_notice_routes ORDER BY workflow_id').all<{ workflow_id: string; connection_id: string; enabled: number }>()
  for (const route of noticeRoutes.results) add({ id: `notice:${route.workflow_id}`, kind: 'notice', label: 'Owner-authorized Slack operational notices', state: route.enabled ? 'enabled' : 'disabled', recipients: ['https://slack.com'], purpose: 'Failure and approval notices to the exact owner-consented conversation; no approval or continuation authority', fields: ['conversation ID', 'notice kind and category', 'owner reference', 'authenticated run link'], credentials: credential(route.connection_id) })
  const apps = await stmt(env, 'SELECT app FROM crank_oauth_apps ORDER BY app').all<{ app: string }>()
  for (const { app } of apps.results) {
    const p = PROVIDERS[app]
    add({ id: `oauth:${app}`, kind: 'oauth', label: `${app} OAuth`, state: 'configured', recipients: [recipient(p.authorize), recipient(p.token)],
      purpose: 'Owner-initiated provider consent, token exchange and refresh', fields: ['client identity', 'requested scopes', 'redirect URI', 'state/PKCE', 'authorization code or refresh token'], credentials: 'Owner-registered client ID and sealed client secret; provider-issued tokens' })
  }
  const providers = await stmt(env, 'SELECT provider_id,status,issuer,jwks_uri,authorization_endpoint,token_endpoint FROM oa_identity_providers ORDER BY provider_id').all<Record<string, string>>()
  for (const p of providers.results) add({ id: `identity:${p.provider_id}`, kind: 'identity', label: p.provider_id, state: p.status,
    recipients: [...new Set([p.issuer, p.jwks_uri, p.authorization_endpoint, p.token_endpoint].map(recipient))], purpose: 'Optional linked identity-provider sign-in and key discovery',
    fields: ['client identity', 'openid/email/profile scopes', 'redirect URI and state/PKCE', 'authorization code', 'provider identity claims'], credentials: 'Configured identity-provider client authentication' })
  if (env.IDENTITY_PROVIDER) add({ id: 'identity-discovery', kind: 'identity', label: 'Configured identity provider', state: 'configured', recipients: [recipient(env.IDENTITY_PROVIDER)],
    purpose: 'Identity-provider discovery and optional linking', fields: ['discovery and public-key requests', 'installation origin'], credentials: 'Owner-configured identity link' })
  const links = await stmt(env, 'SELECT interface,issuer,metadata,needs_relink FROM rer_dependency_link ORDER BY interface').all<{ interface: string; issuer: string; metadata: string; needs_relink: number }>()
  for (const link of links.results) {
    const metadata = JSON.parse(link.metadata)
    const endpoints = [link.issuer, metadata.jwks, metadata.authorization, metadata.token, ...Object.values(metadata.link ?? {})].filter(value => typeof value === 'string' && /^https?:/.test(value))
    add({ id: `dependency:${link.interface}`, kind: 'identity', label: `Linked ${link.interface}`, state: link.needs_relink ? 'needs relink' : 'linked', recipients: [...new Set(endpoints.map(recipient))],
      purpose: 'Provider discovery/link redemption, sign-in, key refresh, inbound identity validation and explicit unlink deregistration', fields: ['link code', 'client identity', 'installation origin/callback and sector ID', 'signed installation assertion', 'authorization code and identity claims'], credentials: 'Installation private signing key; only signed assertions leave' })
  }
  const pending = await stmt(env, 'SELECT interface,issuer FROM rer_dependency_pending WHERE expires_at>? ORDER BY interface', Date.now()).all<{ interface: string; issuer: string }>()
  for (const p of pending.results) add({ id: `pending:${p.interface}`, kind: 'identity', label: `Pending ${p.interface} link`, state: 'owner-approved pending link', recipients: [recipient(p.issuer)], purpose: 'Owner-approved discovery and link redemption', fields: ['client identity', 'link code', 'installation origin/callback and sector ID', 'signed installation assertion'], credentials: 'Installation signing key; private key stays here' })
  if (env.AUTH_LOCAL === 'true' && (env.RER_MODELS_SERVICE || env.RER_MODELS_KEY)) add({ id: 'development-ai', kind: 'development-ai', label: 'Local development live AI', state: env.RER_MODELS_SERVICE && env.RER_MODELS_KEY ? 'local-only configured' : 'incomplete configuration; sends refused', recipients: env.RER_MODELS_SERVICE ? [recipient(env.RER_MODELS_SERVICE)] : [],
    purpose: 'Explicit gated development chat, responses and embeddings; absent from deployed Worker', fields: ['caller-supplied model, messages, prompts, tools, files or embedding input', 'optional feature label'], credentials: 'Installation RER_MODELS_KEY' })
  const sinks = await stmt(env, 'SELECT id,label,kind,endpoint,enabled,config_json FROM crank_log_sinks ORDER BY id').all<{ id: string; label: string; kind: string; endpoint: string; enabled: number; config_json: string }>()
  for (const s of sinks.results) {
    const config = JSON.parse(s.config_json)
    add({ id: `log:${s.id}`, kind: 'log', label: s.label, state: s.enabled ? 'enabled' : 'disabled', recipients: [recipient(s.endpoint)], purpose: 'External operational/audit metadata delivery; no event payload or audit detail',
      fields: ['event_id', ...config.fields], credentials: s.kind === 's3' ? 'Sealed S3 access/signing key and optional session token' : `Sealed ${s.kind} token`,
      ...(config.region ? { region: `${config.region} (owner-configured; not provider-verified)` } : {}) })
  }
  const legacy = await stmt(env, 'SELECT id,name,status,target_url FROM crank_flows ORDER BY id').all<{ id: string; name: string; status: string; target_url: string }>()
  for (const f of legacy.results) add({ id: `flow:${f.id}`, kind: 'delivery', label: f.name, state: f.status, recipients: [recipient(f.target_url)], purpose: 'Owner-approved immutable HTTP delivery',
    fields: ['approved event input JSON', 'stable idempotency key'], credentials: env.CRANK_TARGET_TOKEN ? 'Installation CRANK_TARGET_TOKEN' : 'No destination token configured' })
  if (env.CRANK_TARGET_ORIGIN) add({ id: 'receiver', kind: 'receiver', label: 'Permitted legacy HTTP origin', state: 'configured', recipients: [recipient(env.CRANK_TARGET_ORIGIN)],
    purpose: 'Exact origin allowed for owner-approved HTTP deliveries', fields: ['approved event input JSON', 'stable idempotency key'], credentials: env.CRANK_TARGET_TOKEN ? 'Installation CRANK_TARGET_TOKEN' : 'No destination token configured' })
  const historical = await stmt(env, 'SELECT id,source_json FROM crank_historical_batches ORDER BY id').all<{ id: string; source_json: string }>()
  for (const h of historical.results) {
    const source = JSON.parse(h.source_json)
    add({ id: `historical:${h.id}`, kind: 'historical', label: 'Historical source preview', state: 'retained preview; no automatic refetch', recipients: [recipient(source.url)],
      purpose: 'Owner-requested historical read before preview; release runs the saved records without refetching', fields: [...queryFields(source.url), 'pagination cursor/page'], credentials: credential(source.connection_id) })
  }
  const digests=await stmt(env,'SELECT id,name,active,retention_days FROM crank_digests ORDER BY id').all<{id:string;name:string;active:number;retention_days:number}>()
  for(const d of digests.results) flows.push({id:`digest:${d.id}`,kind:'digest',label:d.name,state:d.active?'active':'inactive receiving state',recipients:[],purpose:'Local cross-run digest entries and durable release receipts; downstream destinations are disclosed by their workflow steps',fields:['templated entry values','source run references','release occurrence and run references'],credentials:'Current native-owner publication; no external credential for local storage',region:'Owner-operated installation',retention:`${d.retention_days} days for local entries and release values; legal holds preserve values; erased-name digests prevent recreation without retaining entry values`})
  flows.push(...await graphDataFlows(env, credential))
  return { flows, local_retention: await retentionPolicy(env), notes: [
    'This is configuration disclosure, not evidence a request was sent, a provider was verified, or an agreement was checked.',
    'Mapped URLs, redirect destinations and pagination are resolved at runtime under current connection/egress rules. Origins only are shown here; URL paths, query values, graph values and credentials are omitted.',
    'Native source, data and archives remain on this installation. Source updates/package installation are explicit operator commands; core automation requires no author telemetry, license check or kill switch.',
    'Native text classification discloses only mapped text and the declared category enum to the pinned OpenAI model using an installation-owned connection. Provider region and retention remain unverified. Local development AI is listed separately.',
    'Owner-initiated connection tests and historical previews send the supplied URL/query and selected connection credential before a workflow executes. Review that request before submitting it.',
    'Provider deletion and retention are separate from local DATA-003 retention. Unknown provider terms are not a compliance certification.',
  ] }
}
