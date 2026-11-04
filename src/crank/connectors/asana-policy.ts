import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'

export const ASANA_FIELDS = 'gid,resource_type,name,completed,due_on,due_at,permalink_url'
export const ASANA_COMPLETED_SINCE = '1970-01-01T00:00:00.000Z'
export const ASANA_CHECKPOINT_URL = 'https://app.asana.com/api/1.0/tasks'
const gid = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value)
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x20\x7f]/.test(value)
const invalid = (message: string): never => { throw new StepError('validation', `Asana search: ${message}`) }
export const malformedAsana = (): never => { throw new StepError('provider', 'Asana search returned malformed or inconsistent task data') }

export function asanaInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['project_id', 'name'].includes(key))) invalid('unsupported search field')
  if (!gid(input.project_id)) invalid('choose one exact numeric project identifier')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 8192 || /[\x00-\x1f\x7f]/.test(input.name)) invalid('name must be exact nonempty task text of at most 8192 characters')
  return { project_id: input.project_id as string, name: input.name as string }
}

export function asanaPageUrl(project: string, offset = '') {
  const url = new URL(`https://app.asana.com/api/1.0/projects/${project}/tasks`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('opt_fields', ASANA_FIELDS)
  url.searchParams.set('completed_since', ASANA_COMPLETED_SINCE)
  if (offset) url.searchParams.set('offset', offset)
  return url
}

/** A broad personal token never makes the native read credential a write door. */
export function assertAsanaDestination(url: URL, method: string, body: unknown, scopes: string[]) {
  if (!scopes.includes('tasks:read')) throw new StepError('authority', 'Asana task reads require explicit current tasks:read consent')
  const match = /^\/api\/1\.0\/projects\/([1-9][0-9]{0,39})\/tasks$/.exec(url.pathname)
  const expected = match && asanaPageUrl(match[1], url.searchParams.get('offset') ?? '')
  if (method !== 'GET' || body !== null || url.origin !== 'https://app.asana.com' || url.username || url.password || url.hash || !expected ||
      url.searchParams.size !== expected.searchParams.size || [...expected.searchParams].some(([key, value]) => url.searchParams.get(key) !== value) ||
      url.searchParams.has('offset') && !token(url.searchParams.get('offset'))) {
    throw new StepError('egress', 'Asana credentials authorize only the fixed projected project task-list read')
  }
}

/** Link metadata is checked against the immutable request; it is never followed. */
export function asanaNextPage(value: unknown, project: string, seen: Set<string>) {
  if (value === null) return ''
  if (!isObject(value) || !token(value.offset) || seen.has(value.offset)) return malformedAsana()
  const expected = asanaPageUrl(project, value.offset)
  for (const field of ['path', 'uri'] as const) {
    if (value[field] === undefined) continue
    if (typeof value[field] !== 'string' || value[field].length > 8192 || /[\x00-\x20\x7f\\]/.test(value[field])) return malformedAsana()
    if (field === 'path' && !value[field].startsWith('/')) return malformedAsana()
    let supplied: URL
    // Asana paths are relative to the API root; retain full API paths too.
    const link = field === 'path' && !value[field].startsWith('/api/1.0/') ? '/api/1.0' + value[field] : value[field]
    try { supplied = new URL(link, 'https://app.asana.com') } catch { return malformedAsana() }
    if (supplied.origin !== expected.origin || supplied.pathname !== expected.pathname || supplied.username || supplied.password || supplied.hash ||
        supplied.searchParams.size !== expected.searchParams.size || [...expected.searchParams].some(([key, text]) => supplied.searchParams.get(key) !== text)) return malformedAsana()
  }
  return value.offset
}

function dueDate(value: unknown, timestamp: boolean): boolean {
  if (value === null) return true
  if (typeof value !== 'string') return false
  if (!timestamp) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  return !!match && dueDate(match[1], false) && Number.isFinite(Date.parse(value))
}

export function asanaTask(value: unknown, project: string) {
  if (!isObject(value) || !gid(value.gid) || value.resource_type !== 'task' || typeof value.name !== 'string' || value.name.length > 8192 || /[\x00-\x1f\x7f]/.test(value.name)) return malformedAsana()
  const result: Record<string, unknown> & { id: string; name: string } = { id: value.gid, gid: value.gid, resource_type: 'task', project_id: project, name: value.name }
  if ('completed' in value) {
    if (typeof value.completed !== 'boolean') return malformedAsana()
    result.completed = value.completed
  }
  for (const field of ['due_on', 'due_at'] as const) if (field in value) {
    if (!dueDate(value[field], field === 'due_at')) return malformedAsana()
    result[field] = value[field]
  }
  if ('permalink_url' in value) {
    if (value.permalink_url !== null) {
      if (typeof value.permalink_url !== 'string' || value.permalink_url.length > 2048 || /[\x00-\x20\x7f\\]/.test(value.permalink_url)) return malformedAsana()
      let link: URL
      try { link = new URL(value.permalink_url) } catch { return malformedAsana() }
      // Both legacy project links and current workspace task links exist.
      if (link.origin !== 'https://app.asana.com' || link.username || link.password || link.search || link.hash ||
          !new RegExp(`^/(?:0/[0-9]+|1/[0-9]+/(?:project/[0-9]+/)?task)/${value.gid}(?:/f)?$`).test(link.pathname)) return malformedAsana()
    }
    result.permalink_url = value.permalink_url
  }
  return result
}
