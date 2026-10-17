import { storeFile, MAX_FILE_BYTES } from '../connectors/files'
import { StepError } from '../engine/errors'
import { canonical, digest, type CrankEnv } from '../model'
import { parseXml, toJson } from './xml'

export const MAX_INBOUND_BYTES = 2 * 1024 * 1024
const HIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cf-connecting-ip', 'x-forwarded-for', 'true-client-ip'])

export async function rawBody(request: Request, limit = MAX_INBOUND_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []; let length = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > limit) { await reader.cancel(); throw new StepError('validation', 'The request body is too large') }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
function formObject(params: URLSearchParams) {
  const out: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) { const values = params.getAll(key); out[key] = values.length > 1 ? values : values[0] }
  return out
}

export interface Inbound { method: string; headers: Record<string, string>; query: Record<string, unknown>; body: unknown; files: Record<string, unknown>; raw?: string; form: URLSearchParams | null; normalized: string }
/** Parses JSON, form-encoded, multipart (files become stored file references), XML and raw bodies. */
export async function parseInbound(env: CrankEnv, workflowId: string, request: Request, bytes: Uint8Array<ArrayBuffer>, raw: boolean): Promise<Inbound> {
  const url = new URL(request.url), type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  const text = new TextDecoder().decode(bytes)
  const headers = Object.fromEntries([...request.headers.entries()].filter(([name]) => !HIDDEN_HEADERS.has(name)))
  let body: unknown = null, form: URLSearchParams | null = null
  const files: Record<string, unknown> = {}
  if (bytes.length) {
    if (type.includes('json')) { try { body = JSON.parse(text) } catch { throw new StepError('validation', 'The body is not valid JSON') } }
    else if (type === 'application/x-www-form-urlencoded') { form = new URLSearchParams(text); body = formObject(form) }
    else if (type === 'multipart/form-data') {
      const data = await new Request(url.href, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body: bytes }).formData()
      const fields: Record<string, unknown> = {}
      for (const [name, value] of data.entries()) {
        if (typeof value === 'string') { fields[name] = name in fields ? [...[fields[name]].flat(), value] : value; continue }
        const file = value as File
        if (file.size > MAX_FILE_BYTES) throw new StepError('validation', `File ${file.name} exceeds ${MAX_FILE_BYTES} bytes`)
        files[name] = await storeFile(env, workflowId, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), source: 'webhook upload' })
      }
      body = fields
    } else if (type.includes('xml')) { const root = parseXml(text); const element = root.children.find(c => c.type === 'element') as any; body = element ? { [element.name]: toJson(element) } : null }
    else body = text
  }
  const normalized = typeof body === 'string' ? body : canonical({ body, files: Object.fromEntries(Object.entries(files).map(([k, f]: any) => [k, f.sha256])) })
  return { method: request.method, headers, query: formObject(url.searchParams), body, files, ...(raw ? { raw: text } : {}), form, normalized }
}

export const bodyDigest = async (inbound: Inbound) => digest(inbound.normalized)
