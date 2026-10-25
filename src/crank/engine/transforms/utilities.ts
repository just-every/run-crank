import { canonical } from '../../model'
import * as D from '../decimal'
import { StepError } from '../errors'
import { isObject, textOf } from '../values'
import { choice, integer, list, text, type Args, type Transform } from './args'

const LINE_FIELDS = ['description', 'item', 'quantity', 'unit_price', 'amount', 'discount', 'tax_code', 'taxable', 'class', 'location'] as const

/** Builds line items by zipping parallel lists or splitting delimited text into columns. */
function lineItemizer(args: Args) {
  const fields = args.fields
  if (!isObject(fields) || !Object.keys(fields).length) throw new StepError('validation', 'line items: map at least one field')
  const separator = typeof args.separator === 'string' ? args.separator : ','
  const columns = Object.entries(fields).map(([name, value]) => {
    if (!LINE_FIELDS.includes(name as typeof LINE_FIELDS[number])) throw new StepError('validation', `line items: unknown field ${name}`)
    const values = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : String(textOf(value) ?? '').split(separator).map(v => v.trim())
    return [name, values] as const
  })
  const lengths = columns.map(([name, values]) => `${name} ${values.length}`), count = columns[0][1].length
  if (columns.some(([, values]) => values.length !== count)) throw new StepError('validation', `line items: lists have unequal lengths (${lengths.join(', ')})`, { code: 'unequal_lists' })
  if (count === 0) throw new StepError('validation', 'line items: the source has no lines', { code: 'zero_lines' })
  return Array.from({ length: count }, (_, i) => {
    const line: Record<string, unknown> = Object.fromEntries(columns.map(([name, values]) => [name, values[i]]))
    for (const name of ['quantity', 'unit_price', 'amount', 'discount'] as const) if (line[name] !== undefined) line[name] = D.toJson(D.requireDecimal(line[name], `line ${i + 1} ${name}`))
    if (line.amount === undefined && line.quantity !== undefined && line.unit_price !== undefined) {
      const gross = D.round(D.multiply(D.requireDecimal(line.quantity, 'quantity'), D.requireDecimal(line.unit_price, 'unit_price')), 2, 'half_up')
      line.amount = D.toJson(line.discount === undefined ? gross : D.subtract(gross, D.requireDecimal(line.discount, 'discount')))
    }
    return line
  })
}

/** Lines, discounts, tax and shipping must reconcile to the source total to the cent. */
function reconcile(args: Args) {
  const lines = list(args, 'lines')
  if (!lines.length) throw new StepError('validation', 'line items: the source has no lines', { code: 'zero_lines' })
  const required = Array.isArray(args.required) ? args.required.map(String) : ['amount']
  const cents = (value: unknown, label: string) => D.round(D.requireDecimal(value, label), 2, 'half_up')
  let subtotal = D.fromInt(0)
  lines.forEach((line, i) => {
    if (!isObject(line)) throw new StepError('validation', `line ${i + 1} is not an object`)
    for (const field of required) if (line[field] === undefined || line[field] === null || line[field] === '') throw new StepError('validation', `line ${i + 1} is missing ${field}`, { code: 'line_missing_field', line: i + 1, field })
    subtotal = D.add(subtotal, cents(line.amount, `line ${i + 1} amount`))
  })
  const extra = (name: string) => args[name] === undefined || args[name] === null ? D.fromInt(0) : cents(args[name], name)
  const computed = D.add(D.add(D.subtract(subtotal, extra('discount')), extra('tax')), extra('shipping'))
  const total = cents(args.total, 'total')
  if (D.compare(computed, total) !== 0) throw new StepError('validation', `line items do not reconcile: lines give ${D.toText(computed)}, source total is ${D.toText(total)}`, { code: 'lines_unreconciled' })
  return { lines, line_count: lines.length, subtotal: D.toText(D.round(subtotal, 2)), total: D.toText(total) }
}

export const utilityTransforms: Record<string, Transform> = {
  'utility.assert_type': args => {
    const type = choice(args, 'type', ['string', 'number', 'boolean', 'object', 'array'] as const), value = args.value
    const valid = type === 'array' ? Array.isArray(value) : type === 'object' ? isObject(value) : typeof value === type && (type !== 'number' || Number.isFinite(value))
    if (!valid) throw new StepError('type_mismatch', `Expected a ${type} value; no source coercion was applied`)
    return value
  },
  'utility.lookup': args => {
    const table = args.table
    if (!isObject(table)) throw new StepError('validation', 'lookup table must map keys to values')
    const key = text(args), insensitive = args.case_sensitive !== true
    const match = Object.keys(table).find(candidate => insensitive ? candidate.trim().toLowerCase() === key.trim().toLowerCase() : candidate === key)
    if (match !== undefined) return table[match]
    if (args.default !== undefined) return args.default
    throw new StepError('validation', `lookup table has no entry for ${JSON.stringify(key)} and no default`)
  },
  'utility.pick': args => {
    const items = list(args), mode = choice(args, 'mode', ['first', 'last', 'index', 'random'] as const, 'first')
    if (!items.length) throw new StepError('validation', 'The list is empty')
    if (mode === 'first') return items[0]
    if (mode === 'last') return items.at(-1)
    if (mode === 'random') return items[crypto.getRandomValues(new Uint32Array(1))[0] % items.length]
    const index = integer(args, 'index')
    if (index < 0 || index >= items.length) throw new StepError('validation', `Index ${index} is outside the list (${items.length} items)`)
    return items[index]
  },
  'utility.text_to_list': args => text(args).split(typeof args.separator === 'string' ? args.separator : ',').map(item => args.trim === false ? item : item.trim()).filter(item => args.keep_empty === true || item !== ''),
  'utility.list_to_text': args => list(args).map(item => textOf(item) ?? JSON.stringify(item)).join(typeof args.separator === 'string' ? args.separator : ', '),
  'utility.count': args => list(args).length,
  'utility.dedupe': args => { const seen = new Set<string>(); return list(args).filter(item => { const key = canonical(item); if (seen.has(key)) return false; seen.add(key); return true }) },
  'utility.line_itemizer': lineItemizer,
  'utility.reconcile_lines': reconcile,
}
