import { add, compare, multiply, negate, parseDecimal, type Decimal } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'

/** A declared grant amount covers the actual invoice total, never a parallel label. */
export function invoiceAmountMatches(payload: unknown, expected: unknown) {
  const amount = parseDecimal(expected)
  if (!isObject(payload) || !Array.isArray(payload.Line) || !amount || amount.units < 0n) return false
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
    const detail = line.DetailType === 'SalesItemLineDetail' ? line.SalesItemLineDetail : line.DiscountLineDetail
    if (isObject(detail) && (detail.UnitPrice !== undefined || detail.Qty !== undefined)) {
      const price = parseDecimal(detail.UnitPrice), quantity = parseDecimal(detail.Qty)
      if (!price || !quantity || price.units < 0n || quantity.units < 0n || compare(multiply(price,quantity),value) !== 0) return false
    }
    if (isObject(detail) && (detail.PercentBased === true || detail.DiscountPercent !== undefined)) return false
    total = add(total,tax)
  }
  return total.units >= 0n && compare(total,amount) === 0
}
export function requireInvoiceAmount(payload: unknown, expected: unknown) {
  if (!invoiceAmountMatches(payload,expected)) throw new StepError('validation','Declared invoice USD amount must equal its exact line, discount and tax total before dispatch')
}
