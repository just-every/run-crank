import { requireValue } from '../model'

export type CustomInput = { type: 'string' | 'number' | 'integer' | 'boolean'; required: boolean; location?: 'path' | 'query' | 'body'; encoding?: 'odata-string' }
export type CustomOperation = {
  id: string; name: string; kind: 'action' | 'search' | 'trigger'
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  path: string; scopes: string[]; inputs: Record<string, CustomInput>
  pagination?: { items_path: string; cursor_path: string; cursor_param: string; max_pages: number; max_items: number }
  gateway?: { destination: string; operation: string }
}
export type CustomDefinition = {
  id: string; name: string; version: number; operations: CustomOperation[]
  auth: { kind: 'none' | 'api_key' | 'oauth2'; scopes: string[] }
  disclosure: { recipient: string; purpose: string; fields: string[]; region: string; retention: string }
}

/** Only JSON data is accepted; bound the walk before interpreting untrusted declarations. */
export function boundedJson(value: unknown): void {
  let nodes = 0, size = 0
  const encoder = new TextEncoder()
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number) => {
    requireValue(++nodes <= 20000 && depth <= 24, 'Connector document exceeds its size or nesting limit')
    if (typeof item === 'string') size += encoder.encode(item).length
    else if (item && typeof item === 'object') {
      requireValue(!ancestors.has(item), 'Connector document must not contain cycles')
      requireValue(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'Connector document must contain plain JSON objects')
      requireValue(Object.getOwnPropertySymbols(item).length === 0, 'Connector document must contain JSON keys')
      if (Array.isArray(item)) requireValue(Object.keys(item).length === item.length && Object.keys(item).every((key, index) => key === String(index)), 'Connector arrays must not have holes or extra fields')
      ancestors.add(item)
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        requireValue('value' in descriptor, 'Connector document must not contain getters')
        if (Array.isArray(item) && key === 'length') continue
        requireValue(!['__proto__', 'prototype', 'constructor'].includes(key), 'Connector document contains an unsafe key')
        size += encoder.encode(key).length
        visit(descriptor.value, depth + 1)
      }
      ancestors.delete(item)
    } else requireValue(item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item), 'Connector document must contain JSON values')
    requireValue(size <= 524288, 'Connector document exceeds 512 KiB')
  }
  visit(value, 0)
}

export function object(value: unknown, label: string): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  requireValue(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported fields`)
}
export function string(value: unknown, label: string, max = 200): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), `${label} must be nonempty text of at most ${max} characters`)
  return value
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label, 100)
  requireValue(/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(result), `${label} must be an identifier`)
  return result
}
export function strings(value: unknown, label: string, max = 100): string[] {
  requireValue(Array.isArray(value) && value.length <= max, `${label} must be a bounded list`)
  const result = value.map(item => string(item, label, 200))
  requireValue(new Set(result).size === result.length, `${label} must not contain duplicates`)
  return result
}
function bound(value: unknown, label: string, max: number): number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max, `${label} must be an integer from 1 to ${max}`)
  return value
}
function dataPath(value: unknown, label: string): string {
  const result = string(value, label)
  requireValue(/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/.test(result), `${label} must be a dotted object path`)
  requireValue(!result.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key)), `${label} contains an unsafe key`)
  return result
}
function endpoint(value: unknown): string {
  const result = string(value, 'Operation path', 2000)
  requireValue(!/[\s\\?#]/.test(result) && !/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(result), 'Operation path must not contain credentials, whitespace, query or fragment')
  if (result.startsWith('https://')) {
    let url: URL
    try { url = new URL(result) } catch { requireValue(false, 'Operation path must be a valid HTTPS URL') }
    requireValue(!url!.username && !url!.password && !!url!.hostname && !result.slice(0,result.indexOf('/',8)).includes('{'), 'Operation URL must have a literal recipient and no credentials')
    requireValue(!/[{}]/.test(url!.origin), 'Operation URL placeholders must be in its path')
  } else requireValue(result.startsWith('/') && !result.startsWith('//'), 'Operation path must be an HTTPS URL or absolute path')
  return result
}
function operation(value: unknown): CustomOperation {
  const raw = object(value, 'Operation')
  keys(raw, ['id', 'name', 'kind', 'method', 'path', 'scopes', 'inputs', 'pagination', 'gateway'], 'Operation')
  requireValue(['action', 'search', 'trigger'].includes(String(raw.kind)), 'Unsupported operation kind')
  requireValue(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(String(raw.method)), 'Unsupported operation method')
  const inputs = object(raw.inputs, 'Operation inputs'), parsed: Record<string, CustomInput> = {}
  requireValue(Object.keys(inputs).length <= 100, 'Declare at most 100 inputs per operation')
  for (const [name, value] of Object.entries(inputs)) {
    identifier(name, 'Input name')
    const input = object(value, 'Input')
    keys(input, ['type', 'required', 'location', 'encoding'], 'Input')
    requireValue(['string', 'number', 'integer', 'boolean'].includes(String(input.type)), 'Unsupported input type')
    requireValue(typeof input.required === 'boolean', 'Input required must be boolean')
    requireValue(input.location === undefined || ['path', 'query', 'body'].includes(String(input.location)), 'Unsupported input location')
    requireValue(input.encoding === undefined || input.encoding === 'odata-string' && input.type === 'string' && input.location === 'path', 'OData string encoding requires a string path input')
    parsed[name] = { type: input.type as CustomInput['type'], required: input.required, location: input.location as CustomInput['location'] ?? 'query', ...(input.encoding ? {encoding:input.encoding as 'odata-string'} : {}) }
  }
  const path = endpoint(raw.path), placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1])
  requireValue(!/[{}]/.test(path.replace(/\{[^{}]+\}/g, '')), 'Operation path has malformed placeholders')
  for (const name of placeholders) requireValue(parsed[name]?.location === 'path' && parsed[name]?.required, 'Every path placeholder needs a required path input')
  for (const [name, input] of Object.entries(parsed)) requireValue(input.location !== 'path' || placeholders.includes(name), 'Every path input needs a path placeholder')
  requireValue(!['GET', 'HEAD'].includes(String(raw.method)) || !Object.values(parsed).some(input => input.location === 'body'), 'GET and HEAD cannot declare body inputs')
  const result: CustomOperation = { id: identifier(raw.id, 'Operation id'), name: string(raw.name, 'Operation name'), kind: raw.kind as CustomOperation['kind'], method: raw.method as CustomOperation['method'], path, scopes: strings(raw.scopes, 'Operation scopes'), inputs: parsed }
  if (raw.pagination !== undefined) {
    const page = object(raw.pagination, 'Pagination')
    keys(page, ['items_path', 'cursor_path', 'cursor_param', 'max_pages', 'max_items'], 'Pagination')
    const param = identifier(page.cursor_param, 'Cursor parameter')
    requireValue(parsed[param]?.type === 'string' && parsed[param]?.location === 'query' && !parsed[param]?.required, 'Pagination needs an optional string query input for the cursor')
    requireValue(result.method === 'GET', 'Cursor pagination requires GET')
    result.pagination = { items_path: dataPath(page.items_path, 'Items path'), cursor_path: dataPath(page.cursor_path, 'Cursor path'), cursor_param: param, max_pages: bound(page.max_pages, 'max_pages', 50), max_items: bound(page.max_items, 'max_items', 10000) }
  }
  if (raw.gateway !== undefined) {
    const gateway = object(raw.gateway, 'Gateway')
    keys(gateway, ['destination', 'operation'], 'Gateway')
    result.gateway = { destination: identifier(gateway.destination, 'Gateway destination'), operation: identifier(gateway.operation, 'Gateway operation') }
  }
  requireValue(result.gateway || result.kind==='trigger' || result.path.startsWith('https://'),'Public actions and searches require a literal HTTPS API URL')
  return result
}

/** Parse declarations only. Installation, scope consent and runtime gates belong to their routes. */
export function parseDefinition(value: unknown): CustomDefinition {
  boundedJson(value)
  const raw = object(value, 'Connector definition')
  keys(raw, ['id', 'name', 'version', 'operations', 'auth', 'disclosure'], 'Connector definition')
  requireValue(Array.isArray(raw.operations) && raw.operations.length > 0 && raw.operations.length <= 100, 'Declare from 1 to 100 operations')
  const operations = raw.operations.map(operation)
  requireValue(new Set(operations.map(op => op.id)).size === operations.length, 'Operation ids must be unique')
  const auth = object(raw.auth, 'Auth declaration')
  keys(auth, ['kind', 'scopes'], 'Auth declaration')
  requireValue(['none', 'api_key', 'oauth2'].includes(String(auth.kind)), 'Unsupported auth kind')
  const scopes = strings(auth.scopes, 'Auth scopes')
  requireValue(auth.kind === 'oauth2' || scopes.length === 0, 'Only OAuth declarations can require scopes')
  requireValue(operations.every(op => op.scopes.every(scope => scopes.includes(scope))), 'Every operation scope must be declared by auth')
  const disclosure = object(raw.disclosure, 'Disclosure')
  keys(disclosure, ['recipient', 'purpose', 'fields', 'region', 'retention'], 'Disclosure')
  return { id: identifier(raw.id, 'Connector id'), name: string(raw.name, 'Connector name'), version: bound(raw.version, 'Connector version', 1000000), operations, auth: { kind: auth.kind as CustomDefinition['auth']['kind'], scopes }, disclosure: { recipient: string(disclosure.recipient, 'Recipient'), purpose: string(disclosure.purpose, 'Purpose', 2000), fields: strings(disclosure.fields, 'Disclosed fields'), region: string(disclosure.region, 'Region'), retention: string(disclosure.retention, 'Retention') } }
}
