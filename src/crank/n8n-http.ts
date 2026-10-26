import type { Step } from './engine/types'
import { validateImportTargetUrl, type ImportTargetEnv } from './import-target'

type Obj = Record<string, any>
type Fields = (value: Obj, allowed: string[], at: string) => void
const object = (value: any): Obj => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('HTTP settings require an object'); return value }
const privateName = /authorization|cookie|api[-_]?key|token|secret|password|signature/i

/** Source references identify what needs rebinding; they never authorize a request. */
export function reviewedHttpBinding(node: Obj, choice: Obj | undefined): string | undefined {
  if (!choice) return undefined
  if (choice.kind !== 'http-connection' || choice.reviewed !== true || Object.keys(choice).some(key => !['kind', 'reviewed', 'connection_id'].includes(key))
    || typeof choice.connection_id !== 'string' || !choice.connection_id || choice.connection_id.length > 160 || /[\u0000-\u001f]/.test(choice.connection_id))
    throw Error('HTTP conversion requires an explicit reviewed fresh native connection')
  if (node.type !== 'n8n-nodes-base.httpRequest') throw Error('HTTP connection conversion requires an HTTP Request node')
  return choice.connection_id
}

export function n8nHttp(node: Obj, id: string, previous: string, at: string, env: ImportTargetEnv, choice: Obj | undefined, fields: Fields, mapped: (value: any, previous: string, at: string) => any): Step {
  const p = object(node.parameters ?? {}), options = object(p.options ?? {})
  fields(p, ['method','url','authentication','genericAuthType','nodeCredentialType','sendBody','contentType','specifyBody','jsonBody','sendHeaders','specifyHeaders','headerParameters','sendQuery','specifyQuery','queryParameters','options'], at + '.parameters')
  fields(options, [], at + '.parameters.options')
  const method = p.method ?? 'GET'
  if (![4,4.1,4.2,4.3].includes(node.typeVersion) || !['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method) || Object.keys(options).length)
    throw Error('HTTP method, version or options have no committed mapping')
  for (const name of ['sendBody','sendHeaders','sendQuery']) if (p[name] !== undefined && typeof p[name] !== 'boolean') throw Error('HTTP send settings must be literal booleans')
  const connection = reviewedHttpBinding(node, choice), auth = p.authentication ?? 'none'
  if (!['none','genericCredentialType','predefinedCredentialType'].includes(auth) || (auth !== 'none' && !connection)) throw Error('HTTP authentication needs a reviewed fresh native connection')
  if (auth === 'none' && (p.genericAuthType !== undefined || p.nodeCredentialType !== undefined)) throw Error('Inactive source authentication settings need manual conversion')
  if (auth === 'genericCredentialType' && (typeof p.genericAuthType !== 'string' || !p.genericAuthType || p.nodeCredentialType !== undefined)) throw Error('HTTP generic credential type must be named')
  if (auth === 'predefinedCredentialType' && (typeof p.nodeCredentialType !== 'string' || !p.nodeCredentialType || p.genericAuthType !== undefined)) throw Error('HTTP predefined credential type must be named')
  const parameters = (name: 'Headers' | 'Query'): Obj => {
    const send = p['send' + name], spec = p['specify' + name], raw = p[name === 'Headers' ? 'headerParameters' : 'queryParameters']
    if (send !== true) { if (raw !== undefined || spec !== undefined) throw Error('Inactive HTTP parameters need manual conversion'); return {} }
    if ((spec ?? 'keypair') !== 'keypair') throw Error('HTTP parameters require explicit named fields')
    const value = object(raw); fields(value, ['parameters'], at + '.parameters.' + name)
    if (!Array.isArray(value.parameters) || value.parameters.length > 50) throw Error('HTTP parameter list must be bounded')
    const result: Obj = {},names=new Set<string>()
    for (const [index, item] of value.parameters.entries()) {
      const field = object(item); fields(field, ['name','value'], at + '.parameters.' + name + '.' + index)
      if (typeof field.name !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(field.name) || privateName.test(field.name) || ['__proto__','constructor','prototype'].includes(field.name) || Object.hasOwn(result,field.name))
        throw Error('HTTP parameter names must be unique literals; credentials belong in a fresh connection')
      const identity=name==='Headers'?field.name.toLowerCase():field.name;if(names.has(identity))throw Error('HTTP parameter names must be unique');names.add(identity)
      result[field.name] = mapped(field.value, previous, at + '.parameters.' + name + '.' + index + '.value')
    }
    return result
  }
  const input: Obj = { method, url: { $literal: validateImportTargetUrl(env, p.url) }, headers: parameters('Headers'), query: parameters('Query') }
  if (p.sendBody === true) {
    if (['GET','HEAD'].includes(method) || (p.contentType ?? 'json') !== 'json' || p.specifyBody !== 'json') throw Error('HTTP body requires JSON on a body-capable method')
    const value=typeof p.jsonBody==='string'&&!p.jsonBody.startsWith('=')?JSON.parse(p.jsonBody):p.jsonBody
    if(!(typeof value==='string'&&value.startsWith('='))&&(!value||typeof value!=='object'))throw Error('JSON scalar and null request bodies need explicit conversion')
    input.body={$fn:'n8n.json_body',args:{value:mapped(value,previous,at+'.parameters.jsonBody')}}
  } else if (p.jsonBody !== undefined || p.specifyBody !== undefined || p.contentType !== undefined) throw Error('Inactive HTTP body settings need manual conversion')
  return { id, name: node.name, type: 'http', body_kind: 'json', ...(connection ? { connection_id: connection } : {}), input }
}
