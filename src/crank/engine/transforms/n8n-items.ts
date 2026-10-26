import { StepError } from '../errors'
import { isObject } from '../values'
import type { Transform } from './args'

/** Matches HTTP V3 JSON response item expansion and its null-to-object rule.
 * https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/HttpRequest/V3/HttpRequestV3.node.ts
 * A source stream is a list of records, never one record containing the list. */
export const n8nItems: Transform = args => {
  const kind = args.kind, value = args.value
  const maxItems = args.max_items ?? 1000
  if (!Number.isSafeInteger(maxItems) || Number(maxItems) < 1 || Number(maxItems) > 1000)
    throw new StepError('validation', 'n8n item conversion requires a reviewed item bound from 1 to 1000')
  const responseItems = (response: unknown): unknown[] => {
    if (!isObject(response) || !isObject(response.headers)) throw new StepError('validation', 'n8n HTTP item conversion needs a native response checkpoint')
    const type = String(response.headers['content-type'] ?? '').toLowerCase()
    if (type.includes('json')) return Array.isArray(response.body) ? response.body.map(item => item === null ? {} : item) : [response.body === null ? {} : response.body]
    if (!type || type.startsWith('text/')) return [response.body === null || response.body === undefined ? {} : { data: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) }]
    throw new StepError('validation', 'n8n file or binary response items require an explicit file conversion')
  }
  let items: unknown[]
  if (kind === 'batches' || kind === 'split') {
    const field = args.field, size = args.batch_size
    if (typeof field !== 'string' || !/^[_A-Za-z][_A-Za-z0-9]*$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)
      || !Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 1000 || !Array.isArray(value))
      throw new StepError('validation', 'n8n batches require an explicit field, array and literal batch size')
    if (value.length > Number(maxItems) || new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024)
      throw new StepError('validation', 'n8n source items exceed the reviewed item or byte bound')
    if(kind==='split')return value.map(item=>({[field]:item}))
    const batches = []
    for (let index = 0; index < value.length; index += Number(size)) batches.push(value.slice(index, index + Number(size)).map(item => ({ [field]: item })))
    return batches
  } else if (kind === 'flatten') {
    if (!Array.isArray(value) || value.some(group => !Array.isArray(group))) throw new StepError('validation', 'n8n processed results must be retained item lists')
    items = value.flat(1)
  } else if (kind === 'item') items = [value]
  else if (kind === 'http') items = responseItems(value)
  else if (kind === 'responses') {
    if (!Array.isArray(value)) throw new StepError('validation', 'n8n response collection needs a retained response list')
    items = value.flatMap(responseItems)
  } else throw new StepError('validation', 'Choose an explicit n8n item conversion kind')
  if (items.length > Number(maxItems) || new TextEncoder().encode(JSON.stringify(items)).length > 1024 * 1024)
    throw new StepError('validation', 'n8n processed items exceed the retained item or byte bound')
  if (items.some(item => !isObject(item))) throw new StepError('validation', 'Each n8n processed item must be a JSON object')
  return items
}
