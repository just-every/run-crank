import * as D from '../decimal'
import { StepError } from '../errors'
import { integer, list, text, type Args, type Transform } from './args'

const rounding = (args: Args): D.Rounding => {
  const mode = args.rounding ?? 'half_up'
  if (!['half_up', 'half_even', 'up', 'down'].includes(mode as string)) throw new StepError('validation', 'rounding must be half_up, half_even, up or down')
  return mode as D.Rounding
}
/** Results honour a declared `scale` (decimal places) and rounding mode. */
function finish(args: Args, value: D.Decimal) {
  return D.toJson(args.scale === undefined ? value : D.round(value, integer(args, 'scale'), rounding(args)))
}
const operands = (args: Args) => args.values !== undefined ? list(args, 'values').map((v, i) => D.requireDecimal(v, `value ${i + 1}`)) : [D.requireDecimal(args.a, 'a'), D.requireDecimal(args.b, 'b')]

type Token = { kind: 'number' | 'name' | 'op' | 'paren' | 'comma'; text: string }
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const pattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][\w.]*)|(<=|>=|<>|[-+*/<>=])|([()])|(,))/y
  let index = 0
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break
    pattern.lastIndex = index
    const m = pattern.exec(source)
    if (!m) throw new StepError('validation', `Formula has an unexpected character at ${index + 1}`)
    index = pattern.lastIndex
    tokens.push(m[1] ? { kind: 'number', text: m[1] } : m[2] ? { kind: 'name', text: m[2] } : m[3] ? { kind: 'op', text: m[3] } : m[4] ? { kind: 'paren', text: m[4] } : { kind: 'comma', text: ',' })
  }
  return tokens
}
type Value = D.Decimal | boolean
/** Spreadsheet-style formulas: + - * /, comparisons, SUM ROUND ROUNDUP ROUNDDOWN MIN MAX ABS IF. */
export function formula(source: string, vars: Record<string, unknown>, mode: D.Rounding): D.Decimal {
  const tokens = tokenize(source)
  let at = 0
  const peek = () => tokens[at], take = () => tokens[at++]
  const expect = (text: string) => { if (take()?.text !== text) throw new StepError('validation', `Formula expected "${text}"`) }
  const num = (value: Value): D.Decimal => { if (typeof value === 'boolean') throw new StepError('validation', 'Formula used a comparison as a number'); return value }
  const comparison = (): Value => {
    const left = additive()
    const op = peek()
    if (op?.kind === 'op' && ['<', '>', '<=', '>=', '=', '<>'].includes(op.text)) {
      take()
      const order = D.compare(num(left), num(additive()))
      return op.text === '<' ? order < 0 : op.text === '>' ? order > 0 : op.text === '<=' ? order <= 0 : op.text === '>=' ? order >= 0 : op.text === '=' ? order === 0 : order !== 0
    }
    return left
  }
  const additive = (): Value => {
    let value = term()
    while (peek()?.kind === 'op' && ['+', '-'].includes(peek().text)) {
      const op = take().text, right = num(term())
      value = op === '+' ? D.add(num(value), right) : D.subtract(num(value), right)
    }
    return value
  }
  const term = (): Value => {
    let value = unary()
    while (peek()?.kind === 'op' && ['*', '/'].includes(peek().text)) {
      const op = take().text, right = num(unary())
      value = op === '*' ? D.multiply(num(value), right) : D.divide(num(value), right, 12, mode)
    }
    return value
  }
  const unary = (): Value => {
    if (peek()?.text === '-') { take(); return D.negate(num(unary())) }
    if (peek()?.text === '+') { take(); return unary() }
    return primary()
  }
  const call = (name: string): Value => {
    expect('(')
    const args: Value[] = []
    if (peek()?.text !== ')') { do { args.push(comparison()) } while (peek()?.kind === 'comma' && take()) }
    expect(')')
    const n = args.map(num), places = () => args[1] === undefined ? 0 : Number(D.toText(num(args[1])))
    switch (name) {
      case 'SUM': return n.reduce(D.add, D.fromInt(0))
      case 'MIN': if (!n.length) break; return n.reduce((a, b) => D.compare(a, b) <= 0 ? a : b)
      case 'MAX': if (!n.length) break; return n.reduce((a, b) => D.compare(a, b) >= 0 ? a : b)
      case 'ABS': return D.abs(n[0])
      case 'ROUND': return D.round(n[0], places(), mode)
      case 'ROUNDUP': return D.round(n[0], places(), 'up')
      case 'ROUNDDOWN': return D.round(n[0], places(), 'down')
      case 'IF': if (args.length !== 3 || typeof args[0] !== 'boolean') break; return args[0] ? args[1] : args[2]
      default: throw new StepError('validation', `Unknown formula function ${name}`)
    }
    throw new StepError('validation', `${name} has the wrong arguments`)
  }
  const primary = (): Value => {
    const token = take()
    if (!token) throw new StepError('validation', 'Formula ended early')
    if (token.kind === 'number') return D.parseDecimal(token.text)!
    if (token.text === '(') { const value = comparison(); expect(')'); return value }
    if (token.kind === 'name') {
      if (peek()?.text === '(') return call(token.text.toUpperCase())
      if (!Object.prototype.hasOwnProperty.call(vars, token.text)) throw new StepError('validation', `Formula variable "${token.text}" is not mapped`)
      return D.requireDecimal(vars[token.text], `Formula variable "${token.text}"`)
    }
    throw new StepError('validation', `Formula has an unexpected "${token.text}"`)
  }
  const result = num(comparison())
  if (at < tokens.length) throw new StepError('validation', `Formula has extra input at "${tokens[at].text}"`)
  return result
}

export const numberTransforms: Record<string, Transform> = {
  'number.add': args => finish(args, operands(args).reduce(D.add)),
  'number.subtract': args => finish(args, operands(args).reduce(D.subtract)),
  'number.multiply': args => finish(args, operands(args).reduce(D.multiply)),
  'number.divide': args => { const [a, b] = operands(args); return finish(args, D.divide(a, b, args.scale === undefined ? 10 : integer(args, 'scale'), rounding(args))) },
  'number.negate': args => finish(args, D.negate(D.requireDecimal(args.value, 'value'))),
  'number.formula': args => finish(args, formula(text(args, 'formula'), (args.vars ?? {}) as Record<string, unknown>, rounding(args))),
  'number.parse': args => D.toJson(D.requireDecimal(args.value, 'value')),
  'number.format': args => {
    const value = D.requireDecimal(args.value, 'value'), decimals = integer(args, 'decimals', 2)
    const fixed = D.toText(D.round(value, decimals, rounding(args)))
    if (args.separators === false) return fixed
    const [whole, fraction] = fixed.replace('-', '').split('.')
    return (fixed.startsWith('-') ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '')
  },
  'number.currency': args => {
    const currency = typeof args.currency === 'string' ? args.currency.toUpperCase() : 'USD'
    if (!/^[A-Z]{3}$/.test(currency)) throw new StepError('validation', 'currency must be an ISO 4217 code')
    let format: Intl.NumberFormat
    try { format = new Intl.NumberFormat(typeof args.locale === 'string' ? args.locale : 'en-US', { style: 'currency', currency }) } catch { throw new StepError('validation', `Unknown currency ${currency}`) }
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2
    return format.format(Number(D.toText(D.round(D.requireDecimal(args.value, 'value'), digits, rounding(args)))))
  },
}
