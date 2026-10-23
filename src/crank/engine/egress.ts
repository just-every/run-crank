import { isPublicAddress } from '@runeditrun/rer/internal/modules/integrations/core/public-address.ts'
import { StepError } from './errors'

/** Refuses non-HTTP schemes, URL credentials, private/link-local/metadata literals and
 * internal names before any request. Workers resolve DNS inside fetch, so names that
 * resolve privately need the platform's own egress policy (named Base gap). */
export function checkEgress(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new StepError('egress', 'The URL is not valid') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new StepError('egress', 'Only http and https URLs are allowed')
  if (url.username || url.password) throw new StepError('egress', 'URLs may not carry credentials; use a connection')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || /^[0-9a-f:]+$/.test(host) && host.includes(':')
  if (literal) {
    if (!isPublicAddress(host)) throw new StepError('egress', 'Private, loopback, link-local and metadata addresses are refused')
  } else {
    if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host) || host === 'metadata.google.internal') throw new StepError('egress', 'Internal host names are refused')
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new StepError('egress', 'Numeric host aliases are refused')
  }
  return url
}

export interface BoundedResponse { status: number; headers: Headers; bytes: Uint8Array<ArrayBuffer>; url: string; redirects: number }

/** One request with a deadline and a byte bound. Redirects are followed only when
 * `follow` is set, re-checking every hop; otherwise a 3xx is returned as is. A request
 * carrying connection credentials sets `sameOrigin`: its headers are never resent to
 * another origin, including the same host over plain HTTP. */
export async function boundedFetch(raw: string, init: RequestInit & { timeoutMs?: number; maxBytes?: number; follow?: number; sameOrigin?: boolean } = {}): Promise<BoundedResponse> {
  const { timeoutMs = 15000, maxBytes = 1024 * 1024, follow = 0, sameOrigin = false, ...request } = init
  let url = checkEgress(raw).href, redirects = 0
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (;;) {
      let response: Response
      try { response = await fetch(url, { ...request, redirect: 'manual', signal: controller.signal }) }
      catch { throw new StepError('network', controller.signal.aborted ? 'The request timed out' : 'The request could not be completed', { uncertain: true }) }
      if (response.status >= 300 && response.status < 400 && response.headers.get('location') && follow > redirects) {
        await response.body?.cancel()
        const next = new URL(response.headers.get('location')!, url).href
        checkEgress(next)
        if (sameOrigin && new URL(next).origin !== new URL(url).origin) throw new StepError('egress', 'A redirect left the API origin; connection credentials are not sent there')
        url = next; redirects++
        if (request.method && !['GET', 'HEAD'].includes(request.method.toUpperCase())) throw new StepError('egress', 'Redirects are not followed for writes')
        continue
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []
      let length = 0
      if (reader) {
        for (;;) {
          let part
          // A connection lost while the body streams is a lost response: its effect is uncertain.
          try { part = await reader.read() } catch { throw new StepError('network', 'The response was interrupted', { uncertain: true }) }
          if (part.done) break
          length += part.value.byteLength
          if (length > maxBytes) { await reader.cancel(); throw new StepError('provider', `The response exceeded ${maxBytes} bytes`) }
          chunks.push(part.value)
        }
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return { status: response.status, headers: response.headers, bytes, url, redirects }
    }
  } finally { clearTimeout(timer) }
}

export const utf8 = (bytes: Uint8Array<ArrayBuffer>) => new TextDecoder('utf-8').decode(bytes)
