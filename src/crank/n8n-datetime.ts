import type { Step } from './engine/types'

type Obj = Record<string, any>
type Fields = (value: Obj, allowed: string[], at: string) => void
type Mapped = (value: any, previous: string, at: string) => any

/** Version 2 JSON date operations. Unproved source settings stay manual. */
export function n8nDateTime(node: Obj, id: string, previous: string, at: string, timezone: any, fields: Fields, mapped: Mapped): Step {
  const p = node.parameters ?? {}, options = p.options === undefined ? {} : p.options
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('date options must be an object')
  const field = p.outputFieldName === undefined ? (p.operation === 'formatDate' ? 'formattedDate' : 'newDate') : p.outputFieldName
  if (node.typeVersion !== 2 || !timezone || typeof field !== 'string' || field.length > 160 || !/^[_A-Za-z][_A-Za-z0-9]*$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) throw Error('date conversion requires version 2, an explicit workflow timezone and a simple output field')
  if (p.operation === 'formatDate') {
    fields(p, ['operation', 'date', 'format', 'customFormat', 'outputFieldName', 'options'], at + '.parameters')
    fields(options, ['timezone', 'includeInputFields'], at + '.parameters.options')
    const patterns: Obj = { 'yyyy-MM-dd': 'date', 'MM/dd/yyyy': 'MM/DD/YYYY', 'yyyy/MM/dd': 'YYYY/MM/DD', 'MMMM dd yyyy': 'MMMM DD YYYY', 'MM-dd-yyyy': 'MM-DD-YYYY' }
    const selected = p.format === 'custom' ? p.customFormat : (p.format ?? 'MM/dd/yyyy')
    const pattern = Object.hasOwn(patterns, selected) ? patterns[selected] : undefined
    if (!pattern || options.timezone !== true || (options.includeInputFields !== undefined && typeof options.includeInputFields !== 'boolean')) throw Error('date formatting requires a supported calendar format, explicit workflow zone and boolean input retention')
    if (options.includeInputFields === true) return { id, name: node.name, type: 'transform', fn: 'date.n8n_format', input: {
      value: mapped(p.date, previous, at + '.parameters.date'), input: { $ref: previous },
      pattern: { $literal: pattern }, timezone: { $literal: timezone }, field: { $literal: field },
    } } as Step
    return { id, name: node.name, type: 'map', input: { [field]: { $fn: 'date.format', args: { value: mapped(p.date, previous, at + '.parameters.date'), pattern: { $literal: pattern }, timezone: { $literal: timezone }, nullable: true } } } } as Step
  }
  fields(p, ['operation', 'magnitude', 'timeUnit', 'duration', 'outputFieldName', 'options'], at + '.parameters')
  fields(options, ['includeInputFields'], at + '.parameters.options')
  const amount = p.duration === undefined ? 0 : p.duration, unit = p.timeUnit === undefined ? 'days' : p.timeUnit
  if (!['addToDate', 'subtractFromDate'].includes(p.operation) || !Number.isInteger(amount) || Math.abs(amount) > 10000 || !['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds'].includes(unit) || (options.includeInputFields !== undefined && typeof options.includeInputFields !== 'boolean')) throw Error('date arithmetic requires a literal bounded whole duration, a supported unit and boolean input retention')
  return { id, name: node.name, type: 'transform', fn: 'date.n8n_arithmetic', input: {
    value: mapped(p.magnitude, previous, at + '.parameters.magnitude'), input: { $ref: previous },
    amount: { $literal: amount * (p.operation === 'subtractFromDate' ? -1 : 1) }, unit: { $literal: unit },
    timezone: { $literal: timezone }, field: { $literal: field }, include_input_fields: { $literal: options.includeInputFields ?? false },
  } } as Step
}
