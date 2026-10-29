import { MAX_FILE_BYTES } from '../connectors/files'
import { StepError } from '../engine/errors'
import { id } from '../model'
import type { InboundUpload } from './inbound'

export const MAX_EMAIL_BYTES = 25 * 1024 * 1024
const mime = (major: string, minor: string) => [major, minor].join('/')
const invalid = (reason: string): never => { throw new StepError('validation', `Email MIME: ${reason}`) }
const binary = (bytes: Uint8Array) => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return text }
const octets = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text, c => c.charCodeAt(0))

/** Bound the stream itself, including MIME framing. A claimed rawSize is advisory. */
export async function readEmail(raw: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = raw.getReader(), chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_EMAIL_BYTES) { await reader.cancel(); invalid('message exceeds 25 MiB including attachments') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function decoded(bytes: Uint8Array, charset = 'utf-8') {
  if (!['utf-8', 'us-ascii', 'iso-8859-1', 'windows-1252'].includes(charset.toLowerCase())) invalid('unsupported character set')
  try { return new TextDecoder(charset === 'us-ascii' ? 'utf-8' : charset, { fatal: true }).decode(bytes) }
  catch { return invalid('invalid text encoding') }
}
function transfer(text: string, encoding: string) {
  if (encoding === 'base64') {
    const compact = text.replace(/[\r\n\t ]/g, '')
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+\/]*={0,2}$/.test(compact)) invalid('invalid base64')
    try { return octets(atob(compact)) } catch { return invalid('invalid base64') }
  }
  if (encoding === 'quoted-printable') {
    const joined = text.replace(/=\r?\n/g, '')
    if (/=(?![a-fA-F0-9]{2})/.test(joined)) invalid('invalid quoted printable')
    return octets(joined.replace(/=([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
  }
  if (!['7bit', '8bit', 'binary', ''].includes(encoding)) invalid('unsupported transfer encoding')
  return octets(text)
}
function words(text: string) {
  return text.replace(/(\?=)[\t ]+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_, charset, mode, data) => decoded(transfer(mode.toLowerCase() === 'q' ? data.replace(/_/g, ' ') : data, mode.toLowerCase() === 'q' ? 'quoted-printable' : 'base64'), charset))
}
function headers(text: string) {
  if (text.length > 65536 || text.includes('\0')) invalid('headers exceed bounds')
  const result: Record<string, string> = Object.create(null)
  const lines = text.replace(/\r?\n[\t ]+/g, ' ').split(/\r?\n/)
  if (lines.length > 200) invalid('too many headers')
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]{1,80}):[\t ]*(.*)$/.exec(line)
    if (!match) return invalid('malformed header')
    const name = match[1].toLowerCase()
    if (['content-type', 'content-transfer-encoding', 'content-disposition', 'message-id'].includes(name) && name in result) invalid('ambiguous header')
    result[name] = name in result ? result[name] + ', ' + words(match[2]) : words(match[2])
  }
  return result
}
function parameter(value: string, name: string) {
  const match = new RegExp('(?:^|;)\\s*' + name + '=(?:"([^"\\r\\n]*)"|([^;\\s]+))', 'i').exec(value)
  return match?.[1] ?? match?.[2]
}
export interface ParsedEmail {
  sender: string; recipients: string; cc: string; subject: string; message_id: string
  text: string; html: string; headers: Record<string, string>
  forwarded: { sender: string; recipients: string; subject: string; date: string; text: string; html: string }[]
  files: Record<string, unknown>; uploads: InboundUpload[]
}

/** Data only MIME, with bounded headers, depth, part count and existing file custody limits.
 * HTML stays literal data; rendering it as markup is never part of admission. */
export async function parseEmail(bytes: Uint8Array): Promise<ParsedEmail> {
  let parts = 0, textBytes = 0
  const files: Record<string, unknown> = {}, uploads: InboundUpload[] = []
  const forwarded: ParsedEmail['forwarded'] = []
  async function part(raw: string, depth: number): Promise<{ headers: Record<string, string>; text: string; html: string }> {
    if (++parts > 80 || depth > 8) invalid('part count or nesting exceeds bounds')
    const split = /\r?\n\r?\n/.exec(raw)
    if (!split) return invalid('missing header separator')
    const h = headers(raw.slice(0, split.index)), body = raw.slice(split.index + split[0].length)
    const declaration = h['content-type'] ?? mime('text', 'plain'), type = declaration.split(';')[0].trim().toLowerCase()
    const encoding = (h['content-transfer-encoding'] ?? '').toLowerCase()
    if (type.startsWith('multipart' + '/')) {
      if (encoding && encoding !== '7bit' && encoding !== '8bit') invalid('encoded multipart unsupported')
      const boundary = parameter(declaration, 'boundary')
      if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) return invalid('invalid boundary')
      // Scan delimiter offsets, not an array of every line in a hostile body.
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const delimiters = new RegExp('(?:^|\\r?\\n)--' + escaped + '(--)?[\\t ]*(?:\\r?\\n|$)', 'g'), children: string[] = []
      let start: number | null = null, closed = false, delimiter: RegExpExecArray | null
      while ((delimiter = delimiters.exec(body))) {
        if (start !== null) { children.push(body.slice(start, delimiter.index)); if (children.length > 80) invalid('too many parts') }
        if (delimiter[1]) { closed = true; break }
        start = delimiters.lastIndex
      }
      if (!closed || !children.length) invalid('unclosed multipart')
      const parsed = []
      for (const child of children) parsed.push(await part(child, depth + 1))
      return { headers: h, text: parsed.map(p => p.text).filter(Boolean).join('\n'), html: parsed.map(p => p.html).filter(Boolean).join('\n') }
    }
    if (body.length > 2 * 1024 * 1024) invalid('encoded leaf exceeds bounds')
    const data = transfer(body, encoding)
    if (type === mime('message', 'rfc822')) {
      const original = await part(binary(data), depth + 1)
      forwarded.push({ sender: original.headers.from ?? '', recipients: original.headers.to ?? '', subject: original.headers.subject ?? '', date: original.headers.date ?? '', text: original.text, html: original.html })
      return { headers: h, text: '', html: '' }
    }
    const disposition = h['content-disposition'] ?? ''
    const filename = parameter(disposition, 'filename') ?? parameter(declaration, 'name')
    if (filename || disposition.toLowerCase().startsWith('attachment') || ![mime('text', 'plain'), mime('text', 'html')].includes(type)) {
      if (uploads.length >= 20 || data.length > MAX_FILE_BYTES) invalid('attachment exceeds file custody bounds')
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('')
      const reference = { file_id: id(), name: (filename ?? 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255), type, size: data.length, sha256 }
      files['attachment_' + uploads.length] = reference
      uploads.push({ ...reference, content_base64: btoa(binary(data)) })
      return { headers: h, text: '', html: '' }
    }
    textBytes += data.byteLength
    if (textBytes > 1024 * 1024) invalid('decoded text exceeds bounds')
    const text = decoded(data, parameter(declaration, 'charset'))
    return { headers: h, text: type === mime('text', 'plain') ? text : '', html: type === mime('text', 'html') ? text : '' }
  }
  const root = await part(binary(bytes), 0), h = root.headers
  if (!h['message-id'] || h['message-id'].length > 998 || !/^<[^<>\s]+>$/.test(h['message-id'])) invalid('a single Message-ID is required')
  // Ordinary inline forwarding is provenance, never authentication evidence.
  if (!forwarded.length) {
    const match = /(?:^-{2,}[^\n]*|^Begin forwarded message:)[\r\n]+([\s\S]*)/mi.exec(root.text)
    if (match) {
      const split = /\r?\n\r?\n/.exec(match[1])
      if (split && split.index < 65536) {
        try { const original = headers(match[1].slice(0, split.index)); if (original.from) forwarded.push({ sender: original.from, recipients: original.to ?? '', subject: original.subject ?? '', date: original.date ?? '', text: match[1].slice(split.index + split[0].length), html: '' }) } catch { /* Inline prose is not required to be a MIME header. */ }
      }
    }
  }
  return { sender: h.from ?? '', recipients: h.to ?? '', cc: h.cc ?? '', subject: h.subject ?? '', message_id: h['message-id'], text: root.text, html: root.html, headers: h, forwarded, files, uploads }
}
