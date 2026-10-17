import { boundedFetch } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepType } from '../engine/types'
import { digest, id, now, stmt, type CrankEnv } from '../model'

export const MAX_FILE_BYTES = 1024 * 1024
const b64 = (bytes: Uint8Array<ArrayBuffer>) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text) }
export const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')

/** A stored file reference: name, type, size and SHA-256; bytes stay in workspace data. */
export async function storeFile(env: CrankEnv, workflowId: string, file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer>; source: string }) {
  if (file.bytes.byteLength > MAX_FILE_BYTES) throw new StepError('validation', `The file exceeds ${MAX_FILE_BYTES} bytes`)
  const ref = { file_id: id(), name: file.name.slice(0, 255) || 'file', type: (file.type || 'application/octet-stream').slice(0, 255), size: file.bytes.byteLength, sha256: hex(await crypto.subtle.digest('SHA-256', file.bytes)) }
  await stmt(env, 'INSERT INTO crank_files(id,workflow_id,name,type,size,sha256,source,content_base64,created_at) VALUES(?,?,?,?,?,?,?,?,?)', ref.file_id, workflowId, ref.name, ref.type, ref.size, ref.sha256, file.source.slice(0, 2048), b64(file.bytes), now()).run()
  return ref
}

/** WORK-002: a public file URL mapped into a file input becomes a file reference under the
 * egress rules; any refusal, redirect into a private network, timeout, oversize or non-2xx
 * response is the named error `file fetch failed` with no write. */
export const fileFetch: StepType = {
  mutating: false,
  required: ['url'],
  async execute(_step, ctx) {
    const url = String(ctx.input.url)
    let response
    try { response = await boundedFetch(url, { method: 'GET', timeoutMs: 15000, maxBytes: MAX_FILE_BYTES, follow: 5 }) }
    catch (error) { throw new StepError('validation', `file fetch failed: ${error instanceof StepError ? error.message : 'request refused'}`, { code: 'file_fetch_failed' }) }
    if (response.status < 200 || response.status > 299) throw new StepError('validation', `file fetch failed: status ${response.status}`, { code: 'file_fetch_failed', status: response.status })
    const type = response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream'
    const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('content-disposition') ?? '')?.[1]
    const name = typeof ctx.input.name === 'string' && ctx.input.name ? ctx.input.name : decodeURIComponent(disposition ?? new URL(response.url).pathname.split('/').filter(Boolean).at(-1) ?? 'file')
    const ref = await storeFile(ctx.env, ctx.run.workflow_id, { name, type, bytes: response.bytes, source: response.url })
    return { status: 'succeeded', output: { ...ref, source_url: response.url, source_digest: await digest(response.url) } }
  },
}
