import { rejectedResponse } from './base/rejected-response'
import { createDependencies } from './modules/dependencies/index.mjs'
import { createIdpOwnerClaimHandler, createOwnerClaimHandler } from './modules/owner-claim/index.mjs'
import { firstRunResponse } from './base/setup'
import { fontDocumentResponse } from './base/font-response'
import { createOperatorAuth, createAuthHandler, createSignInHandler, defaultRolePolicy, devGate, devNotFound, normalizeEmail, type AuthConfig, type RolePolicy } from './modules/operator-auth/index.mjs'
import { auditStatement } from './crank/ops/audit'
import type { CrankEnv } from './crank/model'
import { operatorMail } from './mail.server.mjs'
import branding from './branding.json'

// The edition's declared theme (public/rer-theme.css), as Base frames link it.
const theme = { href: '/rer-theme.css', productName: branding.name, accentColor: branding.primaryColor }

export interface Bindings {
 DB: D1Database
 /** Built browser files; hosted deploys run the Worker first (staticAssetResponse). */
 ASSETS?: Fetcher
 RER_DEPLOY_SOURCE?: string
 RER_DEPLOY_FINGERPRINT?: string
 RER_VERSION?: { id: string }
 IDENTITY_PROVIDER?: string
 AUTH_ORIGIN: string
 AUTH_LOCAL?: string
 RER_DEV_ORIGIN?: string
 /** Local runtimes only: the checkout's key gate and dev identity switch. Deploy refuses both. */
 RER_MODELS_SERVICE?: string
 RER_MODELS_KEY?: string
 RER_DEV_KEY?: string
 RER_DEV_IDENTITY?: string
 RER_INSTALLATION_ID?: string
 RER_MANAGEMENT_ORIGIN?: string
 RER_DEMO?: string
 RER_OWNER_CLAIM_PUBLIC_KEYS?: string
 RER_OWNER_CLAIM_ISSUER?: string
 RER_OWNER_CLAIM_INSTALLATION_ID?: string
 OWNER_EMAIL: string
 SESSION_SECRET: string
 INSTALLATION_KEY?: string
 INSTALLATION_KEY_PREVIOUS?: string
 SETUP_TOKEN?: string
 MAIL_PROVIDER?: 'development' | 'resend' | 'sendgrid' | 'cloudflare'
 MAIL_FROM?: string
 MAIL_API_KEY?: string
 MAIL_ACCOUNT_ID?: string
}

export const runtimeBindings = (env: Bindings): Bindings => env.RER_DEV_ORIGIN && env.AUTH_LOCAL === 'true' ? { ...env, AUTH_ORIGIN: env.RER_DEV_ORIGIN } : env
export const authConfig = (env: Bindings): AuthConfig => ({ dependencies: true, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true', OWNER_EMAIL: env.OWNER_EMAIL, SESSION_SECRET: env.SESSION_SECRET, INSTALLATION_KEY: env.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: env.INSTALLATION_KEY_PREVIOUS, SETUP_TOKEN: env.SETUP_TOKEN, MAIL_FROM: env.MAIL_FROM, branding: { productName: branding.name, accentColor: branding.primaryColor, signInPath: '/signin', theme: theme.href } })
// Access decisions (invite, deactivate, reactivate, change role, end someone's sessions) are
// the owner's alone. Admins may still read the people list; everyone manages their own sessions.
const rolePolicy: RolePolicy = input => defaultRolePolicy(input) && (input.actor.role === 'owner' || input.action === 'operators:list'
 || (input.action === 'sessions:list' || input.action === 'sessions:revoke') && input.target?.id === input.actor.id)
// SEC-003: each accepted access decision enters Crank's audit with the deciding owner and
// the person's operator id, never their email address.
const ACCESS_ACTIONS: Record<string, string> = { '/auth/invite': 'access.invite', '/auth/operator/status': 'access.status', '/auth/operator/role': 'access.role' }
async function auditedAuth(request: Request, env: Bindings): Promise<Response | null> {
 const action = request.method === 'POST' && request.headers.get('content-type')?.startsWith('application/json') ? ACCESS_ACTIONS[new URL(request.url).pathname] : undefined
 const copy = action ? request.clone() : null
 const response = await createAuthHandler(operatorAuth(env))(request)
 if (!copy || !response || response.status >= 300) return response
 const [session, input] = await Promise.all([operatorAuth(env).getSession(copy.clone() as Request), copy.json() as Promise<Record<string, string>>])
 const subject = action === 'access.invite'
  ? (await env.DB.prepare('SELECT id FROM oa_operators WHERE email=?').bind(normalizeEmail(input.email)).first<{ id: string }>())?.id
  : input.operatorId
 if (session && subject) await auditStatement(env as CrankEnv, session.operator.id, action!, 'operator', subject, action === 'access.status' ? { status: input.status } : { role: input.role ?? 'member' }).run()
 return response
}
export function operatorAuth(env: Bindings) {
 return createOperatorAuth({ db: env.DB, config: authConfig(env), mailSender: operatorMail(env), rolePolicy, clientIp: request => request.headers.get('CF-Connecting-IP') ?? '' })
}

async function handleAuthResponse(request: Request, original: Bindings): Promise<Response | null> {
 const env = runtimeBindings(original), url = new URL(request.url)
 if (url.pathname.startsWith('/.well-known/rer-') || url.pathname.startsWith('/auth/dependencies/')) {
  const linked = await createDependencies({ db: env.DB, INSTALLATION_KEY: env.INSTALLATION_KEY, INSTALLATION_KEY_PREVIOUS: env.INSTALLATION_KEY_PREVIOUS, origin: env.AUTH_ORIGIN, name: branding.name, provider: env.IDENTITY_PROVIDER, local: env.AUTH_LOCAL === 'true', auth: operatorAuth(env), claimOwner: token => createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:()=>request.headers.get('CF-Connecting-IP')??''})(new Request(env.AUTH_ORIGIN+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(env.AUTH_ORIGIN).host,Origin:env.AUTH_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({token})})) }).handle(request)
  if (linked) return linked
 }
 if (url.pathname === '/auth/owner-claim' && env.RER_OWNER_CLAIM_PUBLIC_KEYS) return createOwnerClaimHandler({ db: env.DB, authConfig: authConfig(env), clientIp: req => req.headers.get('CF-Connecting-IP') ?? '', issuer: env.RER_OWNER_CLAIM_ISSUER ?? '', installationId: env.RER_OWNER_CLAIM_INSTALLATION_ID ?? '', appOrigin: env.AUTH_ORIGIN, expectedEmail: env.OWNER_EMAIL, publicKeys: JSON.parse(env.RER_OWNER_CLAIM_PUBLIC_KEYS) })(request)
 if (url.pathname === '/auth/owner-claim') return createIdpOwnerClaimHandler({db:env.DB,authConfig:authConfig(env),clientIp:req=>req.headers.get('CF-Connecting-IP')??''})(request)
 // The outbox and key exchange answer only a local runtime holding RER_DEV_KEY;
 // the outbox also needs the key gate's cookie (or the rer harness's header).
 if (url.pathname === '/__dev/key') {
  const gate = env.MAIL_PROVIDER === 'development' ? devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true' }) : null
  if (!gate) return devNotFound()
  if (url.pathname === '/__dev/key') return await gate.exchange(request) ?? devNotFound()
  return devNotFound()
 }
 // The shared server-rendered sign-in page: plain forms that work before any script.
 if (url.pathname === '/signin') {
  const page = await createSignInHandler(operatorAuth(env), {
   defaultReturnTo: '/setup',
  })(request)
  if (page) return fontDocumentResponse(page)
 }
 if (url.pathname.startsWith('/auth/')) return fontDocumentResponse(await auditedAuth(request, env))
 if (url.pathname === '/setup' || url.pathname === '/app' || url.pathname.startsWith('/app/')) {
  const setup = await firstRunResponse(request, env, operatorAuth(env), { theme })
  if (setup) return setup
 }

 return null
}

export async function authResponse(request: Request, original: Bindings): Promise<Response | null> {
 const response = await handleAuthResponse(request, original)
 return response ? rejectedResponse(request, response) : null
}
