import { hostAllowed } from '../connections/apps'
import { getConnection } from '../connections/store'
import { checkEgress } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'
import { requireCustomBinding } from './bindings'
import type { CustomDefinition, CustomOperation } from './definition'
import { customVersion } from './store'

export interface CustomPollBinding {
  id: string; version: number; operation: string; sandbox: false; url: string
  /** Count every returned row across pages, including duplicate identities. */
  maxItems: number
  /** Append this predicate and its positional parameters to the same transaction
   * that retains an event or comparison state. A fresh read alone is not a fence. */
  guard: { sql: string; params: (string | number | null)[] }
}

function invalid(message: string): never { throw new StepError('validation', message) }
function denied(message: string): never { throw new StepError('authority', message, { custom_scope: true }) }

/** No mappings, source evaluation, inferred inputs or workflow-owned pagination. */
function operationUrl(op: CustomOperation, raw: unknown): string {
  if (!isObject(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid('Declare literal custom_inputs for the custom poll')
  if (Object.keys(raw).some(name => !Object.hasOwn(op.inputs, name))) invalid('Custom poll received an undeclared input')
  let path = op.path
  const query = new URLSearchParams()
  for (const [name, spec] of Object.entries(op.inputs)) {
    if (!['path', 'query'].includes(spec.location ?? 'query')) invalid('Custom polls support only path and query inputs')
    const value = raw[name]
    if (op.pagination?.cursor_param === name && Object.hasOwn(raw, name)) invalid('Custom poll cursors are owned by the complete source read')
    if (value === undefined) { if (spec.required) invalid(`Custom poll input ${name} is required`); continue }
    if (spec.type === 'integer' ? !Number.isSafeInteger(value) : spec.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== spec.type) invalid(`Custom poll input ${name} must be ${spec.type}`)
    const text = String(value)
    if (typeof value === 'string' && (value.length > 8192 || spec.required && !value.trim() || /[\u0000-\u001f\u007f]|\{\{|\}\}/.test(value))) invalid(`Custom poll input ${name} must be bounded literal text`)
    if (spec.location === 'path') {
      if (['.', '..'].includes(text) || /[\\/\u0000-\u001f\u007f]/.test(text)) invalid(`Custom poll input ${name} must be a path segment`)
      const segment = spec.encoding === 'odata-string' ? text.replaceAll("'", "''") : text
      let encoded: string
      try { encoded = encodeURIComponent(segment).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()) }
      catch { return invalid(`Custom poll input ${name} is not valid Unicode`) }
      path = path.replaceAll('{' + name + '}', encoded)
    } else query.set(name, text)
  }
  if (!path.startsWith('https://') || /[{}\s\\]/.test(path)) invalid('Custom polls require a literal public HTTPS operation URL')
  const url = checkEgress(path)
  if (url.protocol !== 'https:' || url.search || url.hash) invalid('Custom poll operation URLs cannot contain a query or fragment')
  url.search = query.toString()
  url.searchParams.sort()
  return url.href
}

function paginationMatches(trigger: Record<string, unknown>, op: CustomOperation) {
  if (!op.pagination) {
    if (trigger.pagination !== undefined) invalid('Custom poll pagination must be declared by the reviewed operation')
    return
  }
  const page = op.pagination, configured = trigger.pagination
  if (page.max_pages > 10) invalid('Custom poll pagination supports at most ten reviewed pages')
  if (!isObject(configured) || Object.keys(configured).some(key => !['cursor_path', 'param', 'max_pages'].includes(key)) || configured.cursor_path !== page.cursor_path || configured.param !== page.cursor_param || configured.max_pages !== page.max_pages || trigger.items_path !== page.items_path) invalid('Custom poll pagination must exactly match the reviewed operation')
}

/** Publication and runtime share the same pinned production authority. At runtime
 * pass the immutable workflow version, before and after each provider page. Keep
 * the initial guard for every admission and state commit in that poll attempt. */
export async function customPollBinding(env: CrankEnv, trigger: Record<string, unknown>, versionId?: string): Promise<CustomPollBinding | null> {
  if (trigger.custom_connector_id === undefined) return null
  if (trigger.type !== 'app_poll' || trigger.provider !== 'http_json' || typeof trigger.custom_connector_id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(trigger.custom_connector_id) || !Number.isSafeInteger(trigger.custom_connector_version) || Number(trigger.custom_connector_version) < 1 || typeof trigger.custom_operation !== 'string') invalid('Pin a custom JSON polling connector, version and trigger operation')
  if (trigger.custom_sandbox === true) invalid('Custom polling requires a ready production version; sandbox mode cannot bypass its review')
  if (['gateway_id', 'headers', 'query', 'body', 'method'].some(key => trigger[key] !== undefined)) invalid('Custom polling request options belong to its reviewed operation and stored connection')
  const row = await customVersion(env, trigger.custom_connector_id, Number(trigger.custom_connector_version))
  if (row.status !== 'ready') denied('The custom polling version has no current production authority')
  if (versionId !== undefined) await requireCustomBinding(env, versionId, row)
  const definition = JSON.parse(row.definition_json) as CustomDefinition
  const op = definition.operations.find(value => value.id === trigger.custom_operation)
  const scopes = JSON.parse(row.scopes_json) as string[]
  if (!op || !op.scopes.every(scope => scopes.includes(scope))) denied('The custom polling operation or its scope was refused or revoked')
  if (op.kind !== 'trigger' || op.method !== 'GET' || op.gateway) invalid('Custom polling supports only public GET trigger operations')
  const url = operationUrl(op, trigger.custom_inputs)
  if (typeof trigger.url !== 'string') invalid('Custom poll URL must exactly match its reviewed operation and typed literal inputs')
  const configuredUrl = checkEgress(trigger.url); configuredUrl.searchParams.sort()
  if (configuredUrl.href !== url) invalid('Custom poll URL must exactly match its reviewed operation and typed literal inputs')
  paginationMatches(trigger, op)
  if (typeof trigger.connection_id !== 'string') invalid('Choose a stored HTTP connection for the custom poll')
  const connection = await getConnection(env, trigger.connection_id)
  if (connection.app !== 'http' || connection.status !== 'active') denied('Choose an active HTTP connection for the custom poll')
  if (!op.scopes.every(scope => (JSON.parse(connection.scopes_json) as string[]).includes(scope))) denied('The selected account no longer grants the required custom polling scope')
  if (!hostAllowed(new URL(url).hostname, JSON.parse(connection.domains_json))) throw new StepError('egress', 'The custom polling recipient is outside the selected connection domains')
  return {
    id: row.id, version: row.version, operation: op.id, sandbox: false, url, maxItems: op.pagination?.max_items ?? 1000,
    guard: {
      sql: `EXISTS(SELECT 1 FROM crank_custom_versions WHERE id=? AND version=? AND status='ready' AND definition_digest=? AND consent_generation=? AND scopes_json=?)
        AND EXISTS(SELECT 1 FROM crank_connections WHERE id=? AND app='http' AND status='active' AND scopes_json=? AND domains_json=? AND consented_at IS ?)`,
      params: [row.id, row.version, row.definition_digest, row.consent_generation, row.scopes_json, connection.id, connection.scopes_json, connection.domains_json, connection.consented_at],
    },
  }
}
