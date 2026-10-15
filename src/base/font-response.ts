import { fontHead } from './font-head'

// Native auth documents bypass the route renderer. Append after their own
// styles so the shared body font also applies, preserving the auth module's
// hashed styles, private headers and form/Origin behavior.
export async function fontDocumentResponse(response: Response | null): Promise<Response | null> {
  if (!response?.headers.get('content-type')?.startsWith('text/html')) return response
  const headers = new Headers(response.headers)
  const policy = headers.get('content-security-policy')
  if (policy) {
    const directives = policy.split(';').map(value => value.trim()).filter(Boolean)
    for (const name of ['style-src', 'font-src']) {
      const index = directives.findIndex(value => value.split(/\s+/)[0] === name)
      if (index < 0) directives.push(`${name} 'self'`)
      else if (!directives[index].split(/\s+/).includes("'self'")) directives[index] += " 'self'"
    }
    headers.set('content-security-policy', directives.join('; '))
  }
  // These are bounded native auth documents, not streaming route renders.
  const html = await response.text()
  headers.delete('content-length')
  return new Response(html.replace(/<\/head\s*>/i, `${fontHead}</head>`), {
    status: response.status, statusText: response.statusText, headers,
  })
}
