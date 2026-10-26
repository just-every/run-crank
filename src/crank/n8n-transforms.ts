import type { Step } from './engine/types'
import { n8nStreamField } from './engine/transforms/n8n-stream'

type Obj = Record<string, any>
export interface N8nTransformContext {
  node: Obj
  id: string
  previous: string
  at: string
  maxItems?: number
  fields(value: Obj, allowed: string[], at: string): void
  mapped(value: unknown, previous: string, at: string): unknown
}
export interface N8nTransformResult { steps: Step[]; output: string; stream: true }
export const n8nStreamNodeTypes = new Set(['n8n-nodes-base.limit', 'n8n-nodes-base.sort', 'n8n-nodes-base.removeDuplicates', 'n8n-nodes-base.aggregate'])
const object = (value: unknown): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('n8n transform settings require an object')
  return value as Obj
}
const boolean = (value: unknown, fallback = false) => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw Error('n8n transform option must be boolean')
  return value
}
function fieldList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) throw Error('n8n duplicate comparison requires a literal field list')
  return value.split(',').map(field => n8nStreamField(field.trim()))
}

/** Whole-stream mappings: call with a path to retained JSON items, never a single item.
 * The result must bypass per-item loops and consume only source output zero.
 * Other source types return undefined without consuming settings or coverage.
 * Official formats: https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/Transform */
export function n8nTransform(context: N8nTransformContext): N8nTransformResult | undefined {
  const { node, id, previous, at, fields } = context
  if (!n8nStreamNodeTypes.has(node.type)) return undefined
  const p = object(node.parameters ?? {}), path = at + '.parameters'
  let operation: string, settings: Obj
  switch (node.type) {
    case 'n8n-nodes-base.limit':
      fields(p, ['maxItems', 'keep'], path)
      if (node.typeVersion !== 1 || !Number.isSafeInteger(p.maxItems ?? 1) || (p.maxItems ?? 1) < 1 || (p.maxItems ?? 1) > 1000
        || !['firstItems', 'lastItems'].includes(p.keep ?? 'firstItems')) throw Error('Limit requires version 1, a literal count from 1 to 1000 and a supported keep policy')
      operation = 'limit'; settings = { count: p.maxItems ?? 1, keep: p.keep ?? 'firstItems' }
      break
    case 'n8n-nodes-base.sort': {
      fields(p, ['type', 'sortFieldsUi', 'options'], path)
      const options = object(p.options ?? {}); fields(options, ['disableDotNotation'], path + '.options')
      const ui = object(p.sortFieldsUi ?? {}); fields(ui, ['sortField'], path + '.sortFieldsUi')
      if (node.typeVersion !== 1 || (p.type ?? 'simple') !== 'simple' || !Array.isArray(ui.sortField) || !ui.sortField.length || ui.sortField.length > 25)
        throw Error('Sort requires version 1 and 1 to 25 declarative sort fields')
      const sortFields = ui.sortField.map((raw: unknown, index: number) => {
        const field = object(raw); fields(field, ['fieldName', 'order'], path + '.sortFieldsUi.sortField.' + index)
        if (!['ascending', 'descending'].includes(field.order ?? 'ascending')) throw Error('Sort direction has no native mapping')
        return { field: n8nStreamField(field.fieldName), direction: (field.order ?? 'ascending') === 'ascending' ? 1 : -1 }
      })
      operation = 'sort'; settings = { fields: sortFields, literal: boolean(options.disableDotNotation) }
      break
    }
    case 'n8n-nodes-base.removeDuplicates': {
      fields(p, ['operation', 'compare', 'fieldsToCompare', 'fieldsToExclude', 'options'], path)
      const options = object(p.options ?? {}); fields(options, ['disableDotNotation', 'removeOtherFields'], path + '.options')
      const compare = p.compare ?? 'allFields'
      if (![1, 1.1, 2].includes(node.typeVersion) || (node.typeVersion < 2 && p.operation !== undefined)
        || (p.operation ?? 'removeDuplicateInputItems') !== 'removeDuplicateInputItems'
        || !['allFields', 'selectedFields', 'allFieldsExcept'].includes(compare) || boolean(options.removeOtherFields))
        throw Error('Remove Duplicates supports current-input comparisons retaining the first item; history and field removal require manual conversion')
      if ((compare !== 'selectedFields' && p.fieldsToCompare !== undefined && p.fieldsToCompare !== '')
        || (compare !== 'allFieldsExcept' && p.fieldsToExclude !== undefined && p.fieldsToExclude !== '')) throw Error('Inactive duplicate comparison settings require manual conversion')
      operation = 'dedupe'; settings = { compare, version: node.typeVersion, literal: boolean(options.disableDotNotation),
        ...(compare === 'allFields' ? {} : { fields: fieldList(compare === 'selectedFields' ? p.fieldsToCompare : p.fieldsToExclude) }) }
      break
    }
    case 'n8n-nodes-base.aggregate': {
      fields(p, ['aggregate', 'destinationFieldName', 'include', 'options'], path)
      const options = object(p.options ?? {}); fields(options, ['includeBinaries'], path + '.options')
      const field = n8nStreamField(p.destinationFieldName ?? 'data')
      if (node.typeVersion !== 1 || p.aggregate !== 'aggregateAllItemData' || (p.include ?? 'allFields') !== 'allFields'
        || boolean(options.includeBinaries) || field.includes('.') || field.includes('['))
        throw Error('Aggregate supports version 1, all JSON item data and a simple output field without binaries')
      operation = 'aggregate'; settings = { field }
      break
    }
    default: return undefined
  }
  const max = context.maxItems ?? 1000
  if (!Number.isSafeInteger(max) || max < 1 || max > 1000) throw Error('n8n stream mapping requires an item bound from 1 to 1000')
  return { steps: [{ id, name: node.name, type: 'transform', fn: 'n8n.stream', input: { items: { $ref: previous }, operation, settings: { $literal: settings }, max_items: max } }],
    output: 'steps.' + id, stream: true }
}
