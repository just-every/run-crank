import { StepError } from '../engine/errors'
import type { Step } from '../engine/types'
import { isObject, lookup } from '../engine/values'
import type { BoundedResponse } from '../engine/egress'

/** Dataset bounds are declared before publishing; a partial dataset never reaches actions. */
export function validatePagination(step: Step) {
  const input = isObject(step.input) ? step.input : {}
  if (step.pagination !== undefined) {
      const p = step.pagination
      if (!isObject(p) || !['cursor', 'page', 'link'].includes(String(p.kind))) throw new StepError('validation', `HTTP ${step.id}: pagination.kind must be cursor, page or link`)
      if (input.method !== undefined && String(input.method).toUpperCase() !== 'GET') throw new StepError('validation', `HTTP ${step.id}: pagination requires GET`)
      if (p.kind === 'cursor' && (typeof p.cursor_path !== 'string' || !p.cursor_path)) throw new StepError('validation', `HTTP ${step.id}: cursor pagination needs cursor_path`)
      if (p.items_path !== undefined && typeof p.items_path !== 'string') throw new StepError('validation', `HTTP ${step.id}: items_path must be a field path`)
      if (p.param !== undefined && (typeof p.param !== 'string' || !p.param || p.param.length > 100)) throw new StepError('validation', `HTTP ${step.id}: pagination param must be a name`)
      for (const [key, max] of [['max_pages', 50], ['max_items', 10000], ['max_bytes', 32 * 1024 * 1024], ['start', 1000000]] as const) if (p[key] !== undefined && (!Number.isInteger(p[key]) || (p[key] as number) < 1 || (p[key] as number) > max)) throw new StepError('validation', `HTTP ${step.id}: pagination ${key} must be 1 to ${max}`)
    }
}

export async function paginate(step: Record<string, unknown>, firstUrl: URL, body: unknown, response: BoundedResponse, sendPage: (url: URL) => Promise<BoundedResponse>, parseResponse: (response: BoundedResponse) => unknown) {
  const spec = step.pagination as Record<string, unknown>, itemsPath = typeof spec.items_path === 'string' ? spec.items_path : ''
  const maxPages = Number(spec.max_pages ?? 10), maxItems = Number(spec.max_items ?? 1000), maxBytes = Number(spec.max_bytes ?? 8 * 1024 * 1024)
  const itemsOf = (value: unknown): unknown[] => {
    const found = itemsPath ? lookup(value, itemsPath) : { found: true, value }
    if (!found.found || !Array.isArray(found.value)) throw new StepError('validation', `HTTP ${step.id}: pagination items_path must resolve to an array`, { outcome: 'invalid pagination items' })
    return found.value
  }
  const items = [...itemsOf(body)], visited = new Set([firstUrl.href])
  let pages = 1, current = body, currentResponse = response, page = Number(spec.start ?? 1), bytes = response.bytes.byteLength
  for (;;) {
    if (items.length > maxItems || bytes > maxBytes) throw new StepError('validation', `HTTP ${step.id}: pagination exceeded its item or byte bound`, { outcome: 'pagination limit', pages, items_seen: items.length })
    const url = new URL(firstUrl)
    if (spec.kind === 'cursor') {
      const cursor = lookup(current, String(spec.cursor_path)).value
      if (cursor === undefined || cursor === null || cursor === '') break
      if (!['string', 'number'].includes(typeof cursor)) throw new StepError('validation', 'A pagination cursor must be text or a number', { outcome: 'invalid pagination cursor' })
      url.searchParams.set(String(spec.param ?? 'cursor'), String(cursor))
    } else if (spec.kind === 'page') {
      if (!itemsOf(current).length) break
      page++; url.searchParams.set(String(spec.param ?? 'page'), String(page))
    } else {
      const next = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(currentResponse.headers.get('link') ?? '')
      if (!next) break
      const target = new URL(next[1], currentResponse.url || firstUrl)
      if (target.origin !== firstUrl.origin) throw new StepError('egress', 'A pagination link left the API origin')
      url.href = target.href
    }
    if (pages >= maxPages) throw new StepError('validation', `HTTP ${step.id}: pagination reached max_pages with more data pending`, { outcome: 'pagination truncated', pages, items_seen: items.length })
    if (visited.has(url.href)) throw new StepError('validation', `HTTP ${step.id}: pagination repeated a page`, { outcome: 'pagination cycle', pages })
    visited.add(url.href)
    currentResponse = await sendPage(url)
    if (currentResponse.status < 200 || currentResponse.status > 299) throw new StepError([401, 403].includes(currentResponse.status) ? 'auth' : currentResponse.status === 429 ? 'rate_limit' : 'provider', `Pagination request failed with status ${currentResponse.status}`, { status: currentResponse.status, next_owner_action: 'Inspect this page’s retained attempts and correct the provider or account issue before starting a new run.' })
    current = parseResponse(currentResponse); pages++; bytes += currentResponse.bytes.byteLength
    items.push(...itemsOf(current))
  }
  return { items, pages, complete: true }
}
