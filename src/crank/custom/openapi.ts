import { requireValue } from '../model'
import { boundedJson, keys, object, parseDefinition, string, strings, type CustomDefinition, type CustomInput, type CustomOperation, type CustomResource } from './definition'

type Json = Record<string, unknown>
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
const annotations = ['title', 'description', 'example', 'examples', 'deprecated', 'externalDocs']

/** A bounded proposal converter, deliberately narrower than the entire OpenAPI language. */
export function proposeOpenApi(value: unknown): CustomDefinition {
  boundedJson(value)
  const doc = object(value, 'OpenAPI document')
  requireValue(typeof doc.openapi === 'string' && /^3\.(0|1)\.\d+$/.test(doc.openapi), 'Only OpenAPI 3.0 and 3.1 documents are supported')
  const info = object(doc.info, 'OpenAPI info'), name = string(info.title, 'API title')
  const referenceTarget = (ref: string): unknown => {
    let target: unknown = doc
    for (const part of ref.slice(2).split('/')) target = object(target, 'Reference parent')[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    requireValue(target !== undefined, 'Local component reference does not exist')
    return target
  }
  const activeRefs = new Set<string>(), checkedRefs = new Set<string>()
  const inspectRefs = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      if (key !== '$ref') { inspectRefs(child); continue }
      requireValue(typeof child === 'string' && /^#\/components\/(schemas|parameters|requestBodies|securitySchemes|responses|headers)\/[^/]+$/.test(child), 'Only local component references are supported')
      requireValue(!activeRefs.has(child) && activeRefs.size < 12, 'Recursive or deeply nested component references are unsupported')
      if (!checkedRefs.has(child)) {
        activeRefs.add(child); inspectRefs(referenceTarget(child)); activeRefs.delete(child); checkedRefs.add(child)
      }
    }
  }
  inspectRefs(doc)
  const resolve = (value: unknown, label: string, trail: string[] = []): Json => {
    const raw = object(value, label)
    if (raw.$ref === undefined) return raw
    keys(raw, ['$ref'], `${label} reference`)
    const ref = string(raw.$ref, 'Component reference', 300)
    requireValue(trail.length < 12 && !trail.includes(ref), 'Recursive or deeply nested component references are unsupported')
    return resolve(referenceTarget(ref), label, [...trail, ref])
  }
  const serverUrl = (value: unknown, label: string): string => {
    const text = string(value, label, 2000)
    let url: URL
    try { url = new URL(text) } catch { requireValue(false, `${label} must be an absolute HTTPS URL`) }
    requireValue(url!.protocol === 'https:' && !url!.username && !url!.password && !url!.search && !url!.hash && !/[{}\\\s]/.test(text), `${label} must be HTTPS without credentials, variables, query or fragment`)
    return text.replace(/\/$/, '')
  }
  requireValue(Array.isArray(doc.servers) && doc.servers.length === 1, 'Declare exactly one HTTPS API server')
  const server = object(doc.servers[0], 'API server')
  requireValue(server.variables === undefined, 'Server variables are unsupported')
  const base = serverUrl(server.url, 'API server URL')
  requireValue(doc.webhooks === undefined, 'OpenAPI webhook verification must be declared manually')

  const primitive = (value: unknown): CustomInput['type'] => {
    const schema = resolve(value, 'Input schema')
    keys(schema, ['type', ...annotations], 'Input schema (constraints, formats and structured inputs require a reviewed manual declaration)')
    requireValue(['string', 'number', 'integer', 'boolean'].includes(String(schema.type)), 'Inputs must use a primitive string, number, integer or boolean schema')
    return schema.type as CustomInput['type']
  }
  const readParameters = (value: unknown): Json[] => {
    if (value === undefined) return []
    requireValue(Array.isArray(value) && value.length <= 100, 'Declare at most 100 parameters')
    const result = value.map(item => resolve(item, 'Parameter'))
    const identities = result.map(item => `${item.in}:${item.name}`)
    requireValue(new Set(identities).size === identities.length, 'Parameters must be unique within their declaration')
    return result
  }
  const inputsFor = (pathItem: Json, op: Json): Record<string, CustomInput> => {
    const parameters = new Map<string, Json>()
    for (const parameter of [...readParameters(pathItem.parameters), ...readParameters(op.parameters)]) parameters.set(`${parameter.in}:${parameter.name}`, parameter)
    const inputs: Record<string, CustomInput> = {}
    for (const parameter of parameters.values()) {
      keys(parameter, ['name', 'in', 'required', 'schema', 'style', 'explode', 'allowReserved', 'x-crank-resource', ...annotations], 'Parameter')
      const name = string(parameter.name, 'Parameter name', 100)
      requireValue(parameter.in === 'path' || parameter.in === 'query', 'Header and cookie parameters require a reviewed manual declaration')
      requireValue(parameter.required === undefined || typeof parameter.required === 'boolean', 'Parameter required must be boolean')
      requireValue(parameter.in !== 'path' || parameter.required === true, 'Path parameters must be required')
      requireValue(parameter.style === undefined || parameter.style === (parameter.in === 'path' ? 'simple' : 'form'), 'Unsupported parameter serialization')
      requireValue(parameter.explode === undefined || typeof parameter.explode === 'boolean', 'Parameter explode must be boolean')
      requireValue(parameter.allowReserved === undefined || parameter.allowReserved === false, 'Reserved query serialization is unsupported')
      requireValue(!Object.hasOwn(inputs, name), 'Inputs with the same name in different locations are unsupported')
      inputs[name] = { type: primitive(parameter.schema), required: parameter.required === true, location: parameter.in, ...(parameter['x-crank-resource']===undefined?{}:{resource:parameter['x-crank-resource'] as CustomResource}) }
    }
    if (op.requestBody !== undefined) {
      const body = resolve(op.requestBody, 'Request body')
      keys(body, ['content', 'required', 'description'], 'Request body')
      requireValue(body.required === true, 'Optional request bodies require a reviewed manual declaration')
      const content = object(body.content, 'Request content')
      keys(content, ['application/json'], 'Request content')
      const media = object(content['application/json'], 'JSON request content')
      keys(media, ['schema', 'example', 'examples'], 'JSON request content')
      const schema = resolve(media.schema, 'Request object schema')
      keys(schema, ['type', 'properties', 'required', 'additionalProperties', ...annotations], 'Request object schema')
      requireValue(schema.type === 'object', 'JSON bodies must have an object schema')
      requireValue(schema.additionalProperties === undefined || schema.additionalProperties === false, 'Dynamic request object fields are unsupported')
      const properties = object(schema.properties, 'Request properties')
      const required = schema.required === undefined ? [] : strings(schema.required, 'Required body fields')
      requireValue(required.every(key => Object.hasOwn(properties, key)), 'Required body fields must name declared properties')
      for (const [name, property] of Object.entries(properties)) {
        requireValue(!Object.hasOwn(inputs, name), 'Body and parameter inputs must have distinct names')
        inputs[name] = { type: primitive(property), required: required.includes(name), location: 'body' }
      }
    }
    return inputs
  }
  const authKinds = new Set<string>(), schemeNames = new Set<string>(), requestedScopes = new Set<string>()
  const securityFor = (value: unknown): string[] => {
    if (value === undefined) value = []
    requireValue(Array.isArray(value) && value.length <= 1, 'Alternative security requirements require a reviewed manual declaration')
    if (value.length === 0) { authKinds.add('none'); return [] }
    const requirement = object(value[0], 'Security requirement')
    const names = Object.keys(requirement)
    if (names.length === 0) { authKinds.add('none'); return [] }
    requireValue(names.length === 1, 'Combined authentication schemes require a reviewed manual declaration')
    const name = names[0], scopes = strings(requirement[name], 'Operation OAuth scopes')
    const components = object(doc.components, 'Components'), schemes = object(components.securitySchemes, 'Security schemes')
    const scheme = resolve(schemes[name], 'Security scheme')
    schemeNames.add(name)
    requireValue(scheme.type === 'apiKey' || scheme.type === 'oauth2', 'Only API key and OAuth2 security declarations are supported')
    if (scheme.type === 'apiKey') {
      keys(scheme, ['type', 'in', 'name', 'description'], 'API key security scheme')
      string(scheme.name, 'API key field name', 100)
      requireValue(['header', 'query'].includes(String(scheme.in)) && scopes.length === 0, 'API keys require a header or query location and no scopes')
      authKinds.add('api_key')
    } else {
      keys(scheme, ['type', 'flows', 'description'], 'OAuth security scheme')
      const flows = object(scheme.flows, 'OAuth flows'), available = new Set<string>()
      requireValue(Object.keys(flows).length > 0, 'Declare at least one OAuth flow')
      keys(flows, ['authorizationCode', 'clientCredentials', 'implicit', 'password'], 'OAuth flows')
      for (const [kind, value] of Object.entries(flows)) {
        const flow = object(value, 'OAuth flow')
        keys(flow, ['authorizationUrl', 'tokenUrl', 'refreshUrl', 'scopes'], 'OAuth flow')
        if (kind === 'authorizationCode' || kind === 'implicit') serverUrl(flow.authorizationUrl, 'OAuth authorization URL')
        if (kind !== 'implicit') serverUrl(flow.tokenUrl, 'OAuth token URL')
        if (flow.refreshUrl !== undefined) serverUrl(flow.refreshUrl, 'OAuth refresh URL')
        for (const [scope, description] of Object.entries(object(flow.scopes, 'OAuth scope declarations'))) {
          string(scope, 'OAuth scope'); requireValue(typeof description === 'string', 'OAuth scope descriptions must be text'); available.add(scope)
        }
      }
      requireValue(scopes.every(scope => available.has(scope)), 'Operation requests an undeclared OAuth scope')
      scopes.forEach(scope => requestedScopes.add(scope)); authKinds.add('oauth2')
    }
    return scopes
  }
  const paths = object(doc.paths, 'OpenAPI paths'), operations: CustomOperation[] = []
  requireValue(Object.keys(paths).length <= 100, 'Declare at most 100 API paths')
  for (const [path, value] of Object.entries(paths).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    requireValue(path.startsWith('/') && !path.startsWith('//') && !/[?#\\\s]/.test(path), 'API paths must be absolute paths without query or fragment')
    const item = resolve(value, 'Path item')
    keys(item, [...methods, 'parameters', 'summary', 'description'], 'Path item (server overrides and TRACE are unsupported)')
    for (const method of methods) {
      if (item[method] === undefined) continue
      const op = object(item[method], 'OpenAPI operation')
      keys(op, ['operationId', 'summary', 'description', 'tags', 'parameters', 'requestBody', 'responses', 'security', 'deprecated', 'externalDocs', 'x-crank-kind', 'x-crank-pagination'], 'OpenAPI operation (callbacks and server overrides are unsupported)')
      const scopes = securityFor(op.security === undefined ? doc.security : op.security)
      const id = op.operationId === undefined ? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}` : string(op.operationId, 'Operation id', 100)
      operations.push({ id, name: op.summary === undefined ? id : string(op.summary, 'Operation summary'), kind: (op['x-crank-kind'] ?? (method === 'get' || method === 'head' ? 'search' : 'action')) as CustomOperation['kind'], method: method.toUpperCase() as CustomOperation['method'], path: base + path, scopes, inputs: inputsFor(item, op), ...(op['x-crank-pagination'] === undefined ? {} : { pagination: op['x-crank-pagination'] as CustomOperation['pagination'] }) })
    }
  }
  requireValue(authKinds.size === 1 && schemeNames.size <= 1, 'Mixed authentication schemes require separate reviewed connector declarations')
  const id = doc['x-crank-id'] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return parseDefinition({ id, name, version: doc['x-crank-version'] ?? 1, operations, auth: { kind: [...authKinds][0], scopes: [...requestedScopes].sort() }, disclosure: doc['x-crank-disclosure'] ?? { recipient: name, purpose: 'Owner review required: API operation purpose', fields: [...new Set(operations.flatMap(op => Object.keys(op.inputs)))].sort(), region: 'Owner review required', retention: 'Owner review required' } })
}
