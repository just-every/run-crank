import { rejectedResponse } from './rejected-response'
// Small structural boundary: adopters supply their real native session service.
// This file is copied unchanged to src/base by both maintained exporters.
import { fontHead } from './font-head'
import { themeFrame, type FrameTheme } from './theme-frame'
interface Session { operator: { id: string; role: string; displayName: string; email: string } }
// changeDisplayName is optional: without it the owner's name is shown, not edited.
interface OperatorAuth { getSession(request: Request): Promise<Session | null>; changeDisplayName?(request: Request, input: { displayName: string }): Promise<unknown> }
const securityHeaders = () => ({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
const failure = (error: string, status: number) => Response.json({ error }, { status, headers: securityHeaders() })

interface SetupBindings { DB: D1Database; AUTH_ORIGIN: string }

export async function needsFirstRun(bindings: SetupBindings, session: Session): Promise<boolean> {
  return session.operator.role === 'owner' && !await bindings.DB.prepare('SELECT singleton FROM oa_first_run WHERE singleton = 1').first()
}

const redirect = (location: string) => new Response(null, { status: 303, headers: { ...securityHeaders(), location } })
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

// This HTTP form works without JavaScript. Authentication is checked at the
// mutation itself, independently of document or client-side route guards.
export async function firstRunResponse(request: Request, bindings: SetupBindings, auth: OperatorAuth, options: { theme?: FrameTheme } = {}): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname
  if (path !== '/setup' && path !== '/app' && !path.startsWith('/app/')) return null
  // Admit the configured origin and Host before returning any owner document.
  if (url.origin !== bindings.AUTH_ORIGIN || (request.headers.has('host') && request.headers.get('host')?.toLowerCase() !== url.host.toLowerCase())) return rejectedResponse(request, failure('invalid_host', 403))
  try {
    const session = await auth.getSession(request)
    if (path !== '/setup') return session && await needsFirstRun(bindings, session) ? rejectedResponse(request, redirect('/setup')) : null
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return rejectedResponse(request, new Response(null, { status: 405, headers: { ...securityHeaders(), allow: 'GET, HEAD, POST' } }))
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== bindings.AUTH_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site') return rejectedResponse(request, failure('invalid_origin', 403))
      if (!session) return rejectedResponse(request, failure('authentication_required', 401))
      if (session.operator.role !== 'owner') return rejectedResponse(request, failure('owner_required', 403))
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return rejectedResponse(request, failure('invalid_form', 400))
      const form = await request.formData()
      if (form.get('confirm') !== 'yes') return failure('confirmation_required', 400)
      const name = form.get('displayName')
      if (typeof name === 'string' && auth.changeDisplayName && name.trim() !== session.operator.displayName) {
        try { await auth.changeDisplayName(request, { displayName: name }) }
        catch (error) { const { code, status } = error as { code?: unknown; status?: unknown }; if (typeof code === 'string' && typeof status === 'number' && status < 500) return failure(code, status); throw error }
      }
      await bindings.DB.prepare('INSERT INTO oa_first_run (singleton, completed_by, completed_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO NOTHING').bind(session.operator.id, Date.now()).run()
      return redirect('/app')
    }
    if (!session) return redirect('/signin?returnTo=%2Fsetup')
    if (!await needsFirstRun(bindings, session)) return redirect('/app')
    const frame = await themeFrame(options.theme)
    const body = `<!doctype html><html lang="en"${frame.htmlClass}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Finish setup</title>${fontHead}${frame.head}</head><body><main>${frame.brand}<h1>Finish setup</h1><p>Review the owner of this installation before opening the app.${auth.changeDisplayName ? ' You can correct your name here now, or later in settings.' : ''}</p>${auth.changeDisplayName ? '' : `<dl><dt>Name</dt><dd>${escape(session.operator.displayName)}</dd></dl>`}<dl><dt>Email</dt><dd>${escape(session.operator.email)}</dd></dl><form method="post" action="/setup">${auth.changeDisplayName ? `<label>Your name <input name="displayName" required maxlength="120" autocomplete="name" value="${escape(session.operator.displayName)}"></label>` : ''}<p><label><input type="checkbox" name="confirm" value="yes" required> I confirm this owner account is ready to use.</label></p><button type="submit">Finish setup</button></form></main></body></html>`
    // Native form POSTs need their origin for the unchanged CSRF check above.
    // no-referrer would serialize that navigation's Origin header as null.
    return new Response(request.method === 'HEAD' ? null : body, { headers: { ...securityHeaders(), 'content-security-policy': securityHeaders()['content-security-policy'] + '; ' + frame.policy, 'referrer-policy': 'strict-origin', 'content-type': 'text/html; charset=utf-8' } })
  } catch {
    return rejectedResponse(request, failure('setup_unavailable', 503))
  }
}
