import { add, compare, multiply, negate, parseDecimal, type Decimal } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { inputLiteral } from '../engine/input-schema'

/** A known line must agree with its explicit quantity and price even without a total.
 * Absent provider defaults and unresolved mappings are left intact. */
export function requireInvoiceLines(payload: unknown, mapped = false) {
  const node = (value: unknown, mappings: boolean) => mappings && isObject(value) && '$literal' in value
    ? { value: value.$literal, mapped: false } : { value, mapped: mappings }
  const literal = (value: unknown, mappings: boolean) => mappings ? inputLiteral(value) : { known: true, value }
  const source = node(payload, mapped)
  if (!isObject(source.value)) return
  const lines = node(source.value.Line, source.mapped)
  if (!Array.isArray(lines.value)) return
  for (const [index, raw] of lines.value.entries()) {
    const line = node(raw, lines.mapped)
    if (!isObject(line.value) || literal(line.value.DetailType, line.mapped).value !== 'SalesItemLineDetail') continue
    const detail = node(line.value.SalesItemLineDetail, line.mapped)
    if (!isObject(detail.value)) continue
    const price = literal(detail.value.UnitPrice, detail.mapped), quantity = literal(detail.value.Qty, detail.mapped), amount = literal(line.value.Amount, line.mapped)
    if (![price, quantity, amount].every(part => part.known) || price.value === undefined || quantity.value === undefined) continue
    const p = parseDecimal(price.value), q = parseDecimal(quantity.value), a = parseDecimal(amount.value)
    if (p && q && a && compare(multiply(p, q), a) !== 0) {
      const field = `input.payload.Line[${index}].Amount`
      throw new StepError('validation', `Field "${field}": amount must equal its exact quantity and unit price product`, { field, input_schema: true })
    }
  }
}

/** A declared grant amount covers the actual invoice total, never a parallel label. */
export function invoiceAmountMatches(payload: unknown, expected: unknown) {
  const amount = parseDecimal(expected)
  if (!isObject(payload) || !Array.isArray(payload.Line) || !payload.Line.length || !amount || amount.units < 0n) return false
  let total: Decimal = { units: 0n, scale: 0 }
  for (const line of payload.Line) {
    if (!isObject(line)) return false
    if (line.DetailType === 'SubTotalLineDetail' || line.DetailType === 'DescriptionOnly') continue
    const value = parseDecimal(line.Amount)
    if (!value || value.units < 0n || !['SalesItemLineDetail','DiscountLineDetail'].includes(String(line.DetailType))) return false
    const detail = line.DetailType === 'SalesItemLineDetail' ? line.SalesItemLineDetail : line.DiscountLineDetail
    if (isObject(detail) && (detail.UnitPrice !== undefined || detail.Qty !== undefined)) {
      const price = parseDecimal(detail.UnitPrice), quantity = parseDecimal(detail.Qty)
      if (!price || !quantity || price.units < 0n || quantity.units < 0n || compare(multiply(price,quantity),value) !== 0) return false
    }
    if (isObject(detail) && (detail.PercentBased === true || detail.DiscountPercent !== undefined)) return false
    total = add(total, line.DetailType === 'DiscountLineDetail' ? negate(value) : value)
  }
  if (isObject(payload.TxnTaxDetail) && payload.TxnTaxDetail.TotalTax !== undefined) {
    const tax = parseDecimal(payload.TxnTaxDetail.TotalTax)
    if (!tax || tax.units < 0n) return false
    total = add(total,tax)
  }
  return total.units >= 0n && compare(total,amount) === 0
}
export function requireInvoiceAmount(payload: unknown, expected: unknown) {
  if (!invoiceAmountMatches(payload,expected)) throw new StepError('validation','Field "input.amount_usd": declared invoice USD amount must equal its exact line, discount and tax total before dispatch', { field: 'input.amount_usd', input_schema: true })
}
