import { CrankError, stmt, type CrankEnv } from '../model'
import { activeKey, b64, loadKey, SEALED_CLASSES, unb64, type PayloadKey } from './payload-keys'

/** DATA-003 sealed payload values. A customer, financial or health workflow's trigger data, webhook
 * response, step input, output, trace and failure detail, replay inputs, approval proposals and
 * decisions, held and historical event copies and run files are stored as this envelope: AES-256-GCM
 * ciphertext bound to the workflow and key, plus the value-free facts Crank's own SQL and routing read
 * (file ids the value names, and the top-level fields in KEPT). */
export const SEALED_PREFIX = '{"sealed":"crank-payload-v1"'
export const SEALED_LABEL = 'Sealed: this value is encrypted under a data-class key this installation does not hold. Import the owner\'s key file on the Data screen to read it.'
/** SQL: the column holds plaintext (so text matching may look inside it). */
export const plain = (column: string) => `substr(COALESCE(${column},''),1,${SEALED_PREFIX.length})!='${SEALED_PREFIX}'`
export const isSealed = (value: unknown): value is string => typeof value === 'string' && value.startsWith(SEALED_PREFIX)

export interface Target { workflowId: string; dataClass: string; key: PayloadKey | null; fields: string[]; fieldsJson: string }
/** How this workflow's values are stored now: sealed under its class's active key, or plaintext. */
export async function targetFor(env: CrankEnv, workflowId: string): Promise<Target> {
  const row = await stmt(env, 'SELECT data_class,identifier_fields_json FROM crank_workflows WHERE id=?', workflowId).first<{ data_class: string; identifier_fields_json: string }>()
  const dataClass = row?.data_class ?? 'none', sealed = SEALED_CLASSES.includes(dataClass)
  return { workflowId, dataClass, key: sealed ? await activeKey(env, dataClass) : null, fields: sealed ? JSON.parse(row!.identifier_fields_json) : [], fieldsJson: row?.identifier_fields_json ?? '[]' }
}
/** Value-free routing fields kept readable beside the ciphertext: an HTTP step's method, a failure's
 * category, code, HTTP status and uncertainty, retry bookkeeping and restore/reconnect markers. */
export const KEPT = ['method', 'category', 'code', 'status', 'uncertain', 'exhausted', 'retry_attempt_id', 'retry_at', 'previous_status', 'connection_id', 'reconnect']
const aad = (workflowId: string, keyId: string) => new TextEncoder().encode(`crank-payload-v1|${workflowId}|${keyId}`)

function fileIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 64 || value === null || typeof value !== 'object') return out
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (name === 'file_id' && typeof item === 'string') out.add(item)
    else fileIds(item, out, depth + 1)
  }
  return out
}

/** Stores a JSON text under the target: plaintext unchanged, or the sealed envelope. */
export async function sealText(target: Target, text: string | null): Promise<string | null> {
  if (text === null || !target.key || isSealed(text)) return text
  const value = JSON.parse(text), iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(target.workflowId, target.key.id) }, target.key.aes, new TextEncoder().encode(text))
  const files = [...fileIds(value)]
  const kept = value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(KEPT.filter(k => ['string', 'number', 'boolean'].includes(typeof value[k])).map(k => [k, value[k]])) : {}
  return JSON.stringify({ sealed: 'crank-payload-v1', k: target.key.id, c: target.key.data_class, iv: b64(iv), ct: b64(ciphertext), ...(files.length ? { files } : {}), ...kept })
}
export const sealJson = (target: Target, value: unknown) => sealText(target, value === undefined ? null : JSON.stringify(value))

/** The plaintext JSON text of a stored value. `strict` (execution) refuses a value whose key this
 * installation does not hold; `display` shows it as a labelled sealed placeholder. */
export async function openText(env: CrankEnv, workflowId: string, text: string | null, mode: 'strict' | 'display' = 'strict'): Promise<string | null> {
  if (!isSealed(text)) return text
  const envelope = JSON.parse(text) as { k: string; c: string; iv: string; ct: string }
  const key = await loadKey(env, envelope.k)
  try {
    if (!key) throw new Error('missing key')
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: aad(workflowId, envelope.k) }, key.aes, unb64(envelope.ct)))
  } catch {
    if (mode === 'strict') throw new CrankError(409, `This ${envelope.c} payload is sealed under a key this installation does not hold. Import the owner's key file on the Data screen first.`)
    return JSON.stringify({ sealed: true, data_class: envelope.c, key_id: envelope.k, label: SEALED_LABEL })
  }
}
/** The same row with the named columns opened. */
export async function openRow<T extends Record<string, any>>(env: CrankEnv, workflowId: string, row: T, columns: (keyof T)[], mode: 'strict' | 'display' = 'strict'): Promise<T> {
  const copy: Record<string, unknown> = { ...row }
  for (const column of columns) copy[column as string] = await openText(env, workflowId, row[column] ?? null, mode)
  return copy as T
}
/** A run file's base64 bytes (stored plain, or as a sealed JSON string). */
export async function fileBase64(env: CrankEnv, workflowId: string, content: string, mode: 'strict' | 'display' = 'strict') {
  return isSealed(content) ? JSON.parse((await openText(env, workflowId, content, mode))!) : content
}
export const sealFileBase64 = (target: Target, content: string) => target.key ? sealJson(target, content) as Promise<string> : Promise.resolve(content)

/** Blind index: lower-cased, trimmed text or number values of the declared identifier fields,
 * found at any depth by property name, as hex HMAC-SHA-256 under the key. */
export function identifierValues(value: unknown, fields: string[], out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 64 || value === null || typeof value !== 'object') return out
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (fields.includes(name.toLowerCase()) && (typeof item === 'string' || typeof item === 'number')) { const v = String(item).trim().toLowerCase(); if (v) out.add(v) }
    else identifierValues(item, fields, out, depth + 1)
  }
  return out
}
export async function blindDigest(key: PayloadKey, value: string) {
  const signature = await crypto.subtle.sign('HMAC', key.hmac, new TextEncoder().encode(value.trim().toLowerCase()))
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')
}
export async function blindDigests(target: Target, texts: (string | null | undefined)[]) {
  if (!target.key || !target.fields.length) return []
  const values = new Set<string>()
  for (const text of texts) if (text) identifierValues(JSON.parse(text), target.fields, values)
  return Promise.all([...values].map(v => blindDigest(target.key!, v)))
}
/** Adds the run's digests for these plaintext values; `guard` is extra SQL that must hold. */
export async function indexStatement(env: CrankEnv, target: Target, runId: string, texts: (string | null | undefined)[], guard = '1', guardArgs: unknown[] = []) {
  const digests = await blindDigests(target, texts)
  return digests.length ? stmt(env, `INSERT OR IGNORE INTO crank_blind_index(run_id,key_id,digest) SELECT ?,?,value FROM json_each(?) WHERE ${guard}`, runId, target.key!.id, JSON.stringify(digests), ...guardArgs) : null
}
/** An identifier's digest under every key this installation holds, for DATA-002 matching and holds. */
export async function subjectDigests(env: CrankEnv, subject: string) {
  const keys = (await stmt(env, 'SELECT id FROM crank_payload_keys WHERE sealed_key IS NOT NULL').all<{ id: string }>()).results
  const out: { key_id: string; digest: string }[] = []
  for (const row of keys) { const key = await loadKey(env, row.id); if (key) out.push({ key_id: key.id, digest: await blindDigest(key, subject) }) }
  return out
}
