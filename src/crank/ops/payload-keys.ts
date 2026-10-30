import { guardedBatch, requireOwner } from '../access'
import { open as openVault, seal as sealVault } from '../connections/vault'
import { CrankError, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement, auditStatementWhen } from './audit'

/** DATA-003 key custody (ct 19 Oct 17:42Z). Each installation holds one active AES-256-GCM
 * key per sealed data class; its raw material is sealed under the installation secret, the
 * same custody as connection credentials, and never travels in an archive. The blind-index
 * HMAC-SHA-256 key is derived from the same material, so it rotates with it. */
export const SEALED_CLASSES = ['customer', 'financial', 'health']
export const SYSTEM_KEYS = 'system:payload-keys'
export interface PayloadKey { id: string; data_class: string; aes: CryptoKey; hmac: CryptoKey }
interface KeyRow { id: string; data_class: string; status: string; origin: string; sealed_iv: string | null; sealed_key: string | null; created_at: string; retired_at: string | null; destroyed_at: string | null }

const enc = (value: string) => new TextEncoder().encode(value)
export const b64 = (bytes: ArrayBuffer | Uint8Array) => { const view = new Uint8Array(bytes); let out = ''; for (let i = 0; i < view.length; i += 8192) out += String.fromCharCode(...view.subarray(i, i + 8192)); return btoa(out) }
export const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
const binding = (keyId: string) => `crank-payload-key:${keyId}`

const derived = new Map<string, Promise<PayloadKey>>()
async function derive(row: { id: string; data_class: string }, raw: Uint8Array): Promise<PayloadKey> {
  const base = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey'])
  const params = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc(row.id), info: enc(info) })
  const [aes, hmac] = await Promise.all([
    crypto.subtle.deriveKey(params('crank-payload-aes-v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveKey(params('crank-blind-index-v1'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  ])
  return { id: row.id, data_class: row.data_class, aes, hmac }
}
async function material(env: CrankEnv, row: KeyRow) {
  return unb64(await openVault<string>(env, binding(row.id), row.sealed_iv, row.sealed_key).catch(() => { throw new CrankError(409, 'This data-class key cannot be read with this installation secret') }))
}

/** The key with this id, or null when this installation does not hold its material. */
export async function loadKey(env: CrankEnv, keyId: string): Promise<PayloadKey | null> {
  const cached = derived.get(keyId)
  if (cached) return cached
  const row = await stmt(env, 'SELECT * FROM crank_payload_keys WHERE id=? AND sealed_key IS NOT NULL', keyId).first<KeyRow>()
  if (!row) return null
  const value = material(env, row).then(raw => derive(row, raw))
  derived.set(keyId, value)
  value.catch(() => derived.delete(keyId))
  return value
}
export const forgetKey = (keyId: string) => derived.delete(keyId)

async function keyInsert(env: CrankEnv, dataClass: string, status: 'active' | 'retiring', origin: 'created' | 'imported', createdBy: string, raw: Uint8Array, keyId: string = id()) {
  const sealed = await sealVault(env, binding(keyId), b64(raw))
  // An imported key whose material this installation already destroyed is restored for reading.
  return { keyId, statement: stmt(env, `INSERT INTO crank_payload_keys(id,data_class,status,origin,sealed_iv,sealed_key,created_by,created_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status='retiring',sealed_iv=excluded.sealed_iv,sealed_key=excluded.sealed_key,retired_at=excluded.retired_at,destroyed_at=NULL
    WHERE excluded.status='retiring' AND crank_payload_keys.sealed_key IS NULL AND crank_payload_keys.data_class=excluded.data_class ON CONFLICT DO NOTHING`,
    keyId, dataClass, status, origin, sealed.iv, sealed.ciphertext, createdBy, now(), status === 'retiring' ? now() : null) }
}

/** The class's active key, created on first use. */
export async function activeKey(env: CrankEnv, dataClass: string): Promise<PayloadKey> {
  requireValue(SEALED_CLASSES.includes(dataClass), 'Only customer, financial and health data are sealed', 500)
  let row = await stmt(env, "SELECT id FROM crank_payload_keys WHERE data_class=? AND status='active'", dataClass).first<{ id: string }>()
  if (!row) {
    const created = await keyInsert(env, dataClass, 'active', 'created', SYSTEM_KEYS, crypto.getRandomValues(new Uint8Array(32)))
    await env.DB.batch([created.statement, auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_payload_keys WHERE id=?)', [created.keyId], SYSTEM_KEYS, 'data.key_create', 'data_key', created.keyId, { data_class: dataClass })])
    row = await stmt(env, "SELECT id FROM crank_payload_keys WHERE data_class=? AND status='active'", dataClass).first<{ id: string }>()
  }
  const key = await loadKey(env, row!.id)
  if (!key) throw new CrankError(503, 'The active data-class key has no material on this installation')
  return key
}

/** Rotation makes a new active key at once; the maintenance pass re-seals every value and
 * rebuilds every blind index under it in batches, then destroys the old key once nothing uses it. */
export async function rotateKey(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const dataClass = String(input.data_class ?? '')
  requireValue(SEALED_CLASSES.includes(dataClass), 'Rotate the customer, financial or health key')
  requireValue(input.confirm === 'ROTATE', 'Type ROTATE to replace this key')
  const current = await stmt(env, "SELECT id FROM crank_payload_keys WHERE data_class=? AND status='active'", dataClass).first<{ id: string }>()
  const created = await keyInsert(env, dataClass, 'active', 'created', actor.id, crypto.getRandomValues(new Uint8Array(32)))
  await guardedBatch(env, actor, 'owner', [
    stmt(env, "UPDATE crank_payload_keys SET status='retiring',retired_at=? WHERE data_class=? AND status='active'", now(), dataClass),
    created.statement,
    auditStatement(env, actor.id, 'data.key_rotate', 'data_key', created.keyId, { data_class: dataClass, replaces: current?.id ?? null }),
  ])
  return { data_class: dataClass, key_id: created.keyId, replaces: current?.id ?? null }
}

/** Each key's state and how many runs it still seals; runs sealed under keys this
 * installation does not hold stay sealed and labelled until their key file is imported. */
export async function keyState(env: CrankEnv) {
  const [keys, sealed, pending] = await Promise.all([
    stmt(env, 'SELECT id,data_class,status,origin,created_at,retired_at,destroyed_at FROM crank_payload_keys ORDER BY created_at,id').all<Omit<KeyRow, 'sealed_iv' | 'sealed_key'>>(),
    stmt(env, `SELECT r.payload_key AS key_id,COUNT(*) AS runs,MAX(CASE WHEN k.sealed_key IS NULL THEN 1 ELSE 0 END) AS unavailable FROM crank_wf_runs r
      LEFT JOIN crank_payload_keys k ON k.id=r.payload_key WHERE r.payload_key IS NOT NULL GROUP BY r.payload_key`).all<{ key_id: string; runs: number; unavailable: number }>(),
    pendingRuns(env),
  ])
  const counts = new Map(sealed.results.map(row => [row.key_id, row]))
  return {
    keys: keys.results.map(k => ({ ...k, runs: counts.get(k.id)?.runs ?? 0 })),
    unavailable: sealed.results.filter(row => row.unavailable).map(row => ({ key_id: row.key_id, runs: row.runs })),
    pending_runs: pending,
  }
}

/** SQL over runs `r` joined to their workflow `w`: the run's stored form differs from its target
 * (sealed under the class's active key with the declared fields indexed, or plaintext). */
export const NEEDS_RESEAL = `r.payload_expired_at IS NULL AND CASE WHEN w.data_class IN ('customer','financial','health')
  THEN r.payload_key IS NULL OR r.payload_key IS NOT (SELECT id FROM crank_payload_keys k WHERE k.data_class=w.data_class AND k.status='active') OR r.payload_index IS NOT w.identifier_fields_json
    OR EXISTS(SELECT 1 FROM crank_request_checkpoint_chunks p WHERE p.run_id=r.id AND NOT EXISTS(
      SELECT 1 FROM crank_payload_keys k WHERE k.data_class=w.data_class AND k.status='active' AND instr(p.content_base64,'"k":"'||k.id||'"')>0))
  ELSE r.payload_key IS NOT NULL OR EXISTS(SELECT 1 FROM crank_request_checkpoint_chunks p WHERE p.run_id=r.id AND instr(p.content_base64,'{"sealed":"crank-payload-v1"')=1) END`
export const RESEAL_POSSIBLE = `(r.payload_key IS NULL OR EXISTS(SELECT 1 FROM crank_payload_keys x WHERE x.id=r.payload_key AND x.sealed_key IS NOT NULL))`
export async function pendingRuns(env: CrankEnv) {
  return (await stmt(env, `SELECT COUNT(*) AS n FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id WHERE ${NEEDS_RESEAL} AND ${RESEAL_POSSIBLE}`).first<{ n: number }>())?.n ?? 0
}

const KEY_FILE = 'crank-payload-key-file-v1', ITERATIONS = 100000
async function wrapping(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', enc(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
function passphraseOf(input: Record<string, unknown>) {
  const value = input.passphrase
  requireValue(typeof value === 'string' && value.length >= 12 && value.length <= 500, 'Use a passphrase of 12 to 500 characters')
  return value
}

/** The owner's passphrase-wrapped copy of every key this installation still holds, for restoring
 * an archive on another installation. The file is the only way key material leaves. */
export async function exportKeyFile(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(input.confirm === 'EXPORT KEYS', 'Type EXPORT KEYS to download the key file')
  const passphrase = passphraseOf(input)
  const rows = (await stmt(env, "SELECT * FROM crank_payload_keys WHERE status!='destroyed' ORDER BY created_at,id").all<KeyRow>()).results
  requireValue(rows.length, 'No data-class key exists yet', 404)
  const keys = await Promise.all(rows.map(async row => ({ id: row.id, data_class: row.data_class, created_at: row.created_at, raw: b64(await material(env, row)) })))
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(KEY_FILE) }, await wrapping(passphrase, salt), enc(JSON.stringify(keys)))
  await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'data.key_export', 'data_key', 'file', { keys: rows.map(r => r.id) })])
  return { format: KEY_FILE, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) }, iv: b64(iv), ciphertext: b64(ciphertext),
    keys: rows.map(r => ({ id: r.id, data_class: r.data_class })), exported_at: now() }
}

/** Imported keys only read: they are retiring here, so the pass re-seals their values under this
 * installation's own key and then destroys them. */
export async function importKeyFile(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const passphrase = passphraseOf(input)
  let file: { format?: string; kdf?: { salt?: string; iterations?: number }; iv?: string; ciphertext?: string }
  try { file = typeof input.file === 'string' ? JSON.parse(input.file) : input.file as typeof file } catch { throw new CrankError(400, 'This is not a Crank key file') }
  requireValue(file?.format === KEY_FILE && file.kdf?.iterations === ITERATIONS && typeof file.kdf.salt === 'string' && typeof file.iv === 'string' && typeof file.ciphertext === 'string', 'This is not a Crank key file')
  let keys: { id: string; data_class: string; raw: string }[]
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv!), additionalData: enc(KEY_FILE) }, await wrapping(passphrase, unb64(file.kdf!.salt!)), unb64(file.ciphertext!))
    keys = JSON.parse(new TextDecoder().decode(plain))
  } catch { throw new CrankError(400, 'The passphrase does not open this key file') }
  requireValue(Array.isArray(keys) && keys.every(k => typeof k.id === 'string' && SEALED_CLASSES.includes(k.data_class) && typeof k.raw === 'string'), 'This is not a Crank key file')
  const held = new Set((await stmt(env, 'SELECT id FROM crank_payload_keys WHERE sealed_key IS NOT NULL').all<{ id: string }>()).results.map(r => r.id))
  const fresh = keys.filter(k => !held.has(k.id))
  const inserts = await Promise.all(fresh.map(k => keyInsert(env, k.data_class, 'retiring', 'imported', actor.id, unb64(k.raw), k.id)))
  await guardedBatch(env, actor, 'owner', [...inserts.map(i => i.statement), auditStatement(env, actor.id, 'data.key_import', 'data_key', 'file', { keys: fresh.map(k => k.id) })])
  return { imported: fresh.map(k => ({ id: k.id, data_class: k.data_class })), already_held: keys.length - fresh.length }
}

/** Destroys a retiring key once no stored value, blind index or run refers to it, and no
 * write that read it before the rotation can still land (15 minutes after it retired). */
export async function destroyUnreferenced(env: CrankEnv, time = Date.now()) {
  const settled = new Date(time - 15 * 60000).toISOString()
  const retiring = (await stmt(env, "SELECT id,data_class FROM crank_payload_keys WHERE status='retiring' AND retired_at<=?", settled).all<{ id: string; data_class: string }>()).results
  let destroyed = 0
  for (const key of retiring) {
    const marker = `"k":"${key.id}"`
    const used = await stmt(env, `SELECT 1 WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE payload_key=?1 OR instr(trigger_json,?2)>0 OR instr(COALESCE(response_json,''),?2)>0 OR instr(COALESCE(error_json,''),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_request_checkpoints WHERE instr(response_json,?2)>0)
      OR EXISTS(SELECT 1 FROM crank_request_checkpoint_chunks WHERE instr(content_base64,?2)>0)
      OR EXISTS(SELECT 1 FROM crank_workflow_samples WHERE instr(payload_json,?2)>0 OR instr(uploads_json,?2)>0)
      OR EXISTS(SELECT 1 FROM crank_gateway_tasks WHERE instr(COALESCE(input_json,''),?2)>0 OR instr(COALESCE(output_json,''),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_wf_steps WHERE instr(COALESCE(input_json,''),?2)>0 OR instr(COALESCE(output_json,''),?2)>0 OR instr(COALESCE(trace_json,''),?2)>0 OR instr(COALESCE(error_json,''),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_wf_step_revisions WHERE instr(COALESCE(input_json,''),?2)>0 OR instr(COALESCE(prior_input_json,''),?2)>0 OR instr(COALESCE(prior_error_json,''),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_waits WHERE instr(COALESCE(proposal_json,''),?2)>0 OR instr(COALESCE(resolution_json,''),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_hold_items WHERE instr(payload_json,?2)>0) OR EXISTS(SELECT 1 FROM crank_historical_items WHERE instr(payload_json,?2)>0)
      OR EXISTS(SELECT 1 FROM crank_app_snapshots WHERE instr(fields_json,?2)>0) OR EXISTS(SELECT 1 FROM crank_files WHERE instr(content_base64,?2)>0) OR EXISTS(SELECT 1 FROM crank_blind_index WHERE key_id=?1)`, key.id, marker).first()
    if (used) continue
    const at = now()
    const [, change] = await env.DB.batch([
      stmt(env, 'DELETE FROM crank_hold_digests WHERE key_id=?', key.id),
      stmt(env, "UPDATE crank_payload_keys SET status='destroyed',sealed_iv=NULL,sealed_key=NULL,destroyed_at=? WHERE id=? AND status='retiring'", at, key.id),
    ])
    if (change.meta.changes) {
      await auditStatement(env, SYSTEM_KEYS, 'data.key_destroy', 'data_key', key.id, { data_class: key.data_class }).run()
      forgetKey(key.id); destroyed++
    }
  }
  return destroyed
}
