/** The move-in screen drives the shared import door with the owner's own
 * session: upload original bytes, plan, apply the reviewed fingerprint in
 * bounded calls, reconcile, and undo. It never mints an import grant. */
type Call = (path: string, input: unknown) => Promise<Response>
const CHUNK = 65536
const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('')
const base64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text) }

export class DoorRefusal extends Error {
  constructor(readonly status: number, readonly body: any) { super(body?.details?.reason ?? body?.error ?? 'Import refused') }
}
async function door(call: Call, action: string, input: unknown) {
  const response = await call('/api/operator/import/' + action, input), body: any = await response.json()
  if (!response.ok) throw new DoorRefusal(response.status, body)
  return body
}

/** A source already imported plans as a reviewed catch-up of that history. */
export async function uploadAndPlan(call: Call, source: string) {
  try { return await upload(call, source, false) }
  catch (error) { if (error instanceof DoorRefusal && error.body?.error === 'catchup_required') return upload(call, source, true); throw error }
}
async function upload(call: Call, source: string, catchup: boolean) {
  const bytes = new TextEncoder().encode(source), totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK)), bundleSha256 = await hex(bytes)
  let uploadId: string | undefined
  for (let index = 0; index < totalChunks; index++) {
    const chunk = bytes.subarray(index * CHUNK, (index + 1) * CHUNK)
    uploadId = (await door(call, 'uploads', { ...(uploadId ? { uploadId } : {}), name: 'n8n-workflows.json', bundleSha256, totalBytes: bytes.length, totalChunks, index, chunkSha256: await hex(chunk), base64: base64(chunk) })).uploadId
  }
  return door(call, 'plan', { uploadId, ...(catchup ? { catchup } : {}) })
}

/** Repeat bounded calls until the job reaches `state`. */
async function until(call: Call, action: string, input: unknown, state: string) {
  for (let batch = 0; batch < 100; batch++) {
    const result = await door(call, action, input)
    if (action === 'undo' && result.state === 'cancelled') return result
    if (result.job?.state === state) return result.job
  }
  throw new DoorRefusal(409, { error: `${action} did not finish; open Move in to continue` })
}

export async function applyReviewed(call: Call, planId: string, reviewedFingerprint: string) {
  const job = await until(call, 'apply', { planId, reviewedFingerprint }, 'completed')
  return { job, report: await door(call, 'reconcile', { planId }) }
}
export const undoPlan = (call: Call, planId: string) => until(call, 'undo', { planId }, 'undone')
