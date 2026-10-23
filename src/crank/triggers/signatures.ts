import { hmac } from '../connections/auth'
import { StepError } from '../engine/errors'

/** Provider webhook signatures over the raw body, per each provider's documentation. */
export const SIGNATURE_PRESETS = ['stripe', 'shopify', 'github', 'calendly', 'typeform', 'twilio', 'hmac']
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
const refuse = (message: string): never => { throw new StepError('auth', message) }
function fresh(timestamp: number, tolerance: number, now: number) {
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > tolerance) refuse('The signature timestamp is outside the replay tolerance')
}
/** `t=…,v1=…` headers (Stripe, Calendly): HMAC-SHA256 of `t.body`, any v1 may match. */
async function timestamped(header: string | null, secret: string, body: Uint8Array<ArrayBuffer>, tolerance: number, now: number) {
  if (!header) refuse('The signature header is missing')
  const parts = header!.split(',').map(p => p.trim().split('=')), t = parts.find(([k]) => k === 't')?.[1]
  const candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  fresh(Number(t), tolerance, now)
  const expected = hex(await hmac('sha256', secret, concat(new TextEncoder().encode(`${t}.`), body)))
  if (!candidates.some(v => same(v, expected))) refuse('The signature does not match')
}
function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out }

export interface SignedRequest { body: Uint8Array<ArrayBuffer>; headers: Headers; url: string; form: URLSearchParams | null }
export async function verifySignature(config: Record<string, unknown>, secret: string, request: SignedRequest, now = Date.now()) {
  const tolerance = Number(config.tolerance_seconds ?? 300), header = (name: string) => request.headers.get(name)
  switch (config.preset) {
    case 'stripe': return timestamped(header('stripe-signature'), secret, request.body, tolerance, now)
    case 'calendly': return timestamped(header('calendly-webhook-signature'), secret, request.body, tolerance, now)
    case 'shopify': {
      const expected = b64(await hmac('sha256', secret, request.body))
      if (!same(header('x-shopify-hmac-sha256') ?? '', expected)) refuse('The Shopify signature does not match')
      return
    }
    case 'github': {
      const expected = 'sha256=' + hex(await hmac('sha256', secret, request.body))
      if (!same(header('x-hub-signature-256') ?? '', expected)) refuse('The GitHub signature does not match')
      return
    }
    case 'typeform': {
      const expected = 'sha256=' + b64(await hmac('sha256', secret, request.body))
      if (!same(header('typeform-signature') ?? '', expected)) refuse('The Typeform signature does not match')
      return
    }
    case 'twilio': {
      // https://www.twilio.com/docs/usage/webhooks/webhooks-security
      const url = new URL(request.url)
      let signed = url.href
      if (url.searchParams.has('bodySHA256')) {
        if (!same(url.searchParams.get('bodySHA256')!, hex(await crypto.subtle.digest('SHA-256', request.body)))) refuse('The Twilio body hash does not match')
      } else if (request.form) {
        signed += [...request.form.keys()].sort().map(key => key + request.form!.getAll(key).join('')).join('')
      } else if (request.body.length) refuse('A Twilio body must be form-encoded or covered by bodySHA256')
      if (!same(header('x-twilio-signature') ?? '', b64(await hmac('sha1', secret, signed)))) refuse('The Twilio signature does not match')
      return
    }
    case 'hmac': {
      const name = String(config.header), algorithm = config.algorithm === 'sha1' ? 'sha1' : 'sha256'
      let message = request.body
      if (typeof config.timestamp_header === 'string') {
        const t = header(config.timestamp_header) ?? ''
        fresh(Number(t), tolerance, now)
        message = concat(new TextEncoder().encode(t + '.'), request.body)
      }
      const signature = await hmac(algorithm, secret, message)
      const expected = String(config.prefix ?? '') + (config.encoding === 'base64' ? b64(signature) : hex(signature))
      if (!same(header(name) ?? '', expected)) refuse('The signature does not match')
      return
    }
    default: refuse('Unknown signature preset')
  }
}
