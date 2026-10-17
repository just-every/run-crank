/** Field paths such as `body.lines[2].amount` or `headers.x-request-id`. */
export function pathParts(path: string): (string | number)[] {
  const parts: (string | number)[] = []
  for (const piece of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(piece)
    if (!match) { parts.push(piece); continue }
    if (match[1] !== '') parts.push(match[1])
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]))
  }
  return parts
}

/** Missing (`found:false`), null and empty values stay distinct. */
export function lookup(root: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = root
  for (const part of pathParts(path)) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined }
    if (Array.isArray(current) && typeof part === 'number') {
      if (part >= current.length) return { found: false, value: undefined }
      current = current[part]
    } else if (!Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = (current as Record<string, unknown>)[part as string]
    } else return { found: false, value: undefined }
  }
  return { found: true, value: current }
}

export type ValueKind = 'missing' | 'null' | 'empty' | 'value'
export function kindOf(found: boolean, value: unknown): ValueKind {
  if (!found || value === undefined) return 'missing'
  if (value === null) return 'null'
  if ((typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)) return 'empty'
  return 'value'
}

export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return null
}
