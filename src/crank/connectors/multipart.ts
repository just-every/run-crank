import { StepError } from '../engine/errors'
import type { StepContext } from '../engine/types'
import { textOf } from '../engine/values'
import { canonical, digest, stmt } from '../model'
import { fromBase64 } from './files'

const bytes = (value: string) => new TextEncoder().encode(value)
const parameter = (value: string) => value.replace(/[\r\n"]/g, character => ({ '\r': '%0D', '\n': '%0A', '"': '%22' })[character]!)

/** A resumed idempotent upload must send the same bytes, including its MIME
 * boundary. FormData's fresh random boundary would change the retained request. */
export async function multipart(ctx: StepContext, value: Record<string, unknown>) {
  const parts: { header: string; body: Uint8Array }[] = []
  for (const [name, field] of Object.entries(value)) {
    const fileId = field && typeof field === 'object' && 'file_id' in field ? field.file_id : undefined
    if (typeof fileId === 'string') {
      const file = await stmt(ctx.env, 'SELECT name,type,content_base64 FROM crank_files WHERE id=? AND workflow_id=?', fileId, ctx.run.workflow_id).first<{name: string; type: string; content_base64: string}>()
      if (!file) throw new StepError('validation', `File ${fileId} is not available to this workflow`)
      const type = /^[\x20-\x7e]+$/.test(file.type) ? file.type : 'application/octet-stream'
      parts.push({ header: `Content-Disposition: form-data; name="${parameter(name)}"; filename="${parameter(file.name)}"\r\nContent-Type: ${type}\r\n\r\n`, body: fromBase64(file.content_base64) })
    } else parts.push({ header: `Content-Disposition: form-data; name="${parameter(name)}"\r\n\r\n`, body: bytes(String(textOf(field) ?? JSON.stringify(field)).replace(/\r?\n|\r/g, '\r\n')) })
  }
  const base = 'crank-' + await digest(canonical({ key: ctx.operationKey, value }))
  let boundary = base, suffix = 0
  while (parts.some(part => part.header.includes(boundary) || new TextDecoder().decode(part.body).includes(boundary))) boundary = base + '-' + ++suffix
  const chunks = parts.flatMap(part => [bytes('--' + boundary + '\r\n' + part.header), part.body, bytes('\r\n')])
  chunks.push(bytes('--' + boundary + '--\r\n'))
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return { body, type: 'multipart/form-data; boundary=' + boundary }
}
