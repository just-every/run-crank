// A hosted deploy runs this Worker before its static assets (rer deploy sets
// assets.run_worker_first), so built files reach the browser only when the
// Worker hands them to env.ASSETS. Call this first in the entry's fetch.
type AssetBindings = { ASSETS?: { fetch(request: Request): Promise<Response> } }

/**
 * Answer a GET or HEAD for a built file (a path whose last segment has an
 * extension, `.html` included) from env.ASSETS. Returns null on a miss and for every other
 * request, so app routes and documents keep their own handling. Private paths
 * are never looked up: dot segments (.rer, .seed, .well-known, .dev.vars,
 * .assetsignore), /exports/, /__dev/ and *.rer archives.
 */
export async function staticAssetResponse(request: Request, env: AssetBindings): Promise<Response | null> {
  if (!env.ASSETS || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  let path: string
  try { path = decodeURIComponent(new URL(request.url).pathname) } catch { return null }
  const segments = path.split('/').slice(1)
  const name = segments.at(-1) ?? ''
  if (!/.\.[A-Za-z0-9]+$/.test(name) || path.includes('\\') || path.includes('\0')) return null
  if (segments.some(segment => segment.startsWith('.')) || ['exports', '__dev'].includes(segments[0]) || name.endsWith('.rer')) return null
  let response = await env.ASSETS.fetch(request)
  // Assets' html_handling answers a built `.html` path with a redirect to its
  // pretty path (/guide.html to /guide), which this function never serves; a
  // link to the file itself gets the file, by following that redirect once here.
  const location = response.headers.get('location')
  if (name.endsWith('.html') && response.status >= 300 && response.status < 400 && location) {
    await response.body?.cancel()
    const target = new URL(location, request.url)
    if (target.origin !== new URL(request.url).origin) return null
    response = await env.ASSETS.fetch(new Request(target, { method: request.method, headers: request.headers }))
    // A revalidation (If-None-Match) of the file answers 304, which is as much a hit as 200.
    if (response.status !== 200 && response.status !== 304) { await response.body?.cancel(); return null }
  }
  if (response.status === 404) { await response.body?.cancel(); return null }
  return response
}
