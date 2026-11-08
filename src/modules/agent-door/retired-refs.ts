import type { PolicyDocument } from './policy/document.ts'

/** Stable across archive restore; no raw reference is stored in suppression custody. */
export async function retiredDigest(ref: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rer-agent-retired-ref/1\n' + ref))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
const references = (document: PolicyDocument | null) => [...new Set([
  ...document?.rules.flatMap(rule => rule.approver ?? []) ?? [], ...document?.reviewers ?? [],
].filter(ref => ref.startsWith('person:')))]
export async function retiredMarker(db: D1Database, ref: string) {
  return db.prepare('SELECT marker FROM agent_door_retired_refs WHERE digest=?').bind(await retiredDigest(ref)).first<string>('marker')
}
/** Embed sql and bind value in the protected write: suppression is read in that statement. */
export async function retire(db: D1Database, value: unknown): Promise<{ sql: string; value: string }> {
  const text = JSON.stringify(value)
  // Most writes contain no policy principals; avoid work on the admission lease's hot path.
  if (!text.includes('"person:')) return { sql: '?', value: text }
  const markers = new Map<string, string>()
  const digests = new Map<string, string>()
  JSON.parse(text, (_key, item) => { if (typeof item === 'string' && /^person:[^\s:]{1,200}$/.test(item)) digests.set(item, ''); return item })
  await Promise.all([...digests.keys()].map(async ref => {
    const digest = await retiredDigest(ref)
    digests.set(ref, digest)
    const marker = await db.prepare('SELECT marker FROM agent_door_retired_refs WHERE digest=?').bind(digest).first<string>('marker')
    if (marker) markers.set(ref, marker)
  }))
  // Eagerly resolve existing markers to keep subsequent writes cheap. A missing
  // marker here is only a hint: unresolved tokens are checked again by the write.
  const json = JSON.stringify(JSON.parse(text), (_key, item) => typeof item === 'string' ? markers.get(item) ?? item : item)
  const fragments: Array<[string, string | null]> = []
  let start = 0
  for (const token of json.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (json[token.index! + token[0].length] === ':') continue // Object keys are not reference values.
    const digest = digests.get(JSON.parse(token[0]))
    if (!digest) continue
    fragments.push([json.slice(start, token.index), null], [token[0], digest])
    start = token.index! + token[0].length
  }
  if (!fragments.length) return { sql: '?', value: json }
  fragments.push([json.slice(start), null])
  return { sql: `(SELECT group_concat(piece,'') FROM (
    SELECT coalesce((SELECT json_quote(marker) FROM agent_door_retired_refs WHERE digest=json_extract(fragment.value,'$[1]')),json_extract(fragment.value,'$[0]')) AS piece
    FROM json_each(?) AS fragment ORDER BY CAST(fragment.key AS INTEGER)
  ))`, value: JSON.stringify(fragments) }
}
export async function pendingRetirement(db: D1Database, document: PolicyDocument | null) {
  const pending = await Promise.all(references(document).map(async ref => ref.startsWith('person:erased:') || !!await retiredMarker(db, ref)))
  return pending.filter(Boolean).length
}
