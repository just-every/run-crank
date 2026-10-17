import { compare as compareDecimal, parseDecimal } from './decimal'
import { addTime, dateKey, parseDate, requireUnit, requireZone, startOfDay, wallTime, fromWallTime } from './dates'
import { StepError } from './errors'
import { resolve, type Scope } from './mapping'
import { isObject, kindOf, lookup, textOf, type ValueKind } from './values'

/** WORK-013: one condition language for filters, paths and outcome routes. */
export const LIMITS = { rulesPerGroup: 50, groups: 20 } as const
const TEXT = ['contains', 'not_contains', 'equals', 'not_equals', 'in', 'not_in', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with', 'matches', 'not_matches']
const NUMBER = ['gt', 'lt', 'eq', 'ne', 'gte', 'lte']
const DATE = ['after', 'before', 'equals', 'on_or_after', 'on_or_before']
export const OPERATORS = [
  ...TEXT.map(op => 'text.' + op), ...NUMBER.map(op => 'number.' + op), ...DATE.map(op => 'date.' + op),
  'boolean.is_true', 'boolean.is_false', 'exists', 'not_exists', 'is_empty', 'not_empty', 'list.any', 'list.every', 'list.length',
]
export interface Rule {
  field: string; op: string; value?: unknown; case_sensitive?: boolean; keep_whitespace?: boolean
  precision?: 'instant' | 'day'; timezone?: string; calendar?: unknown; inner?: Rule; compare?: string
}
export type Groups = Rule[][]
export interface RuleTrace { field: string; op: string; kind: ValueKind; left: unknown; right?: unknown; result: boolean | 'type_mismatch'; message?: string }
export interface Evaluation {
  pass: boolean
  mismatch: { group: number; rule: number; field: string; value: unknown; message: string } | null
  groups: { pass: boolean; rules: RuleTrace[] }[]
}

class Mismatch extends Error {}

export function validateGroups(groups: unknown, label: string): Groups {
  if (!Array.isArray(groups) || groups.length === 0) throw new StepError('validation', `${label}: add at least one rule group`)
  if (groups.length > LIMITS.groups) throw new StepError('validation', `${label}: at most ${LIMITS.groups} OR groups`)
  groups.forEach((group, g) => {
    if (!Array.isArray(group) || group.length === 0) throw new StepError('validation', `${label}: group ${g + 1} needs at least one rule`)
    if (group.length > LIMITS.rulesPerGroup) throw new StepError('validation', `${label}: at most ${LIMITS.rulesPerGroup} rules per group`)
    group.forEach((rule, r) => validateRule(rule, `${label} group ${g + 1} rule ${r + 1}`))
  })
  return groups as Groups
}
function validateRule(rule: unknown, label: string) {
  if (!isObject(rule) || typeof rule.field !== 'string' || typeof rule.op !== 'string') throw new StepError('validation', `${label}: name a field and an operator`)
  if (!OPERATORS.includes(rule.op)) throw new StepError('validation', `${label}: unknown operator ${rule.op}`)
  const operandless = ['boolean.is_true', 'boolean.is_false', 'exists', 'not_exists', 'is_empty', 'not_empty', 'list.any', 'list.every']
  if (!operandless.includes(rule.op) && rule.value === undefined) throw new StepError('validation', `${label}: ${rule.op} needs an operand`)
  if (rule.op.endsWith('matches') && typeof rule.value === 'string') {
    try { new RegExp(rule.value) } catch { throw new StepError('validation', `${label}: invalid pattern`) }
  }
  if (rule.op === 'list.length' && !NUMBER.includes(String(rule.compare))) throw new StepError('validation', `${label}: list length needs a number comparison`)
  if (rule.op.startsWith('list.') && rule.op !== 'list.length') {
    if (!isObject(rule.inner)) throw new StepError('validation', `${label}: add the rule each item must match`)
    validateRule(rule.inner, label + ' item rule')
  }
  if (rule.timezone !== undefined) requireZone(rule.timezone)
}

const TRUE = ['true', 'yes', '1'], FALSE = ['false', 'no', '0']
function booleanOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const text = textOf(value)?.trim().toLowerCase()
  if (text !== undefined && TRUE.includes(text)) return true
  if (text !== undefined && FALSE.includes(text)) return false
  throw new Mismatch(`not a boolean: ${JSON.stringify(value)}`)
}

/** Relative operands: `{relative:"now"|"today"|"start_of_week"|"start_of_month", offset:{amount,unit}}`. */
function operandDate(value: unknown, zone: string, now: number, calendar: unknown): number {
  if (isObject(value) && typeof value.relative === 'string') {
    let base: number
    if (value.relative === 'now') base = now
    else if (value.relative === 'today') base = startOfDay(now, zone)
    else if (value.relative === 'start_of_week') { const w = wallTime(now, zone); base = addTime(startOfDay(now, zone), -w.weekday, 'days', zone) }
    else if (value.relative === 'start_of_month') { const w = wallTime(now, zone); base = fromWallTime({ year: w.year, month: w.month, day: 1, hour: 0, minute: 0, second: 0 }, zone) }
    else throw new StepError('validation', `Unknown relative date ${value.relative}`)
    if (isObject(value.offset)) base = addTime(base, Number(value.offset.amount), requireUnit(value.offset.unit), zone, calendar)
    return base
  }
  const parsed = parseDate(value, zone)
  if (!parsed) throw new Mismatch(`not a date: ${JSON.stringify(value)}`)
  return parsed.ms
}

function evaluateRule(rule: Rule, root: unknown, scope: Scope, zone: string, now: number): RuleTrace {
  const found = rule.field === '' ? { found: true, value: root } : lookup(root, rule.field), kind = kindOf(found.found, found.value), left = found.value
  const right = rule.value === undefined ? undefined : isObject(rule.value) && 'relative' in rule.value ? rule.value : resolve(rule.value, scope)
  const trace: RuleTrace = { field: rule.field, op: rule.op, kind, left, right, result: false }
  try {
    trace.result = test(rule, left, kind, right, scope, zone, now)
  } catch (error) {
    if (!(error instanceof Mismatch)) throw error
    trace.result = 'type_mismatch'; trace.message = error.message
  }
  return trace
}

function test(rule: Rule, left: unknown, kind: ValueKind, right: unknown, scope: Scope, defaultZone: string, now: number): boolean {
  const [family, op] = rule.op.includes('.') ? rule.op.split('.') as [string, string] : ['exists', rule.op]
  if (family === 'exists') {
    if (op === 'exists') return kind !== 'missing' && kind !== 'null'
    if (op === 'not_exists') return kind === 'missing' || kind === 'null'
    if (op === 'is_empty') return kind === 'empty'
    return kind === 'value'
  }
  if (family === 'text') {
    const prepare = (value: unknown) => {
      if (value === undefined || value === null) return ''
      const text = textOf(value)
      if (text === null) throw new Mismatch(`not text: ${JSON.stringify(value)}`)
      const trimmed = rule.keep_whitespace ? text : text.trim()
      return rule.case_sensitive ? trimmed : trimmed.toLowerCase()
    }
    const subject = prepare(left), negate = op.startsWith('not_'), base = negate ? op.slice(4) : op
    let result: boolean
    if (base === 'in') {
      const list = Array.isArray(right) ? right : String(right ?? '').split(',')
      result = list.map(prepare).includes(subject)
    } else if (base === 'matches') {
      result = new RegExp(String(right), rule.case_sensitive ? '' : 'i').test(rule.keep_whitespace ? textOf(left) ?? '' : (textOf(left) ?? '').trim())
    } else {
      const operand = prepare(right)
      result = base === 'contains' ? subject.includes(operand) : base === 'equals' ? subject === operand : base === 'starts_with' ? subject.startsWith(operand) : subject.endsWith(operand)
    }
    return negate ? !result : result
  }
  if (family === 'number') {
    if (kind !== 'value') return false
    const a = parseDecimal(left), b = parseDecimal(right)
    if (!a) throw new Mismatch(`not a number: ${JSON.stringify(left)}`)
    if (!b) throw new Mismatch(`operand is not a number: ${JSON.stringify(right)}`)
    return numberCompare(op, compareDecimal(a, b))
  }
  if (family === 'date') {
    if (kind !== 'value') return false
    const zone = requireZone(rule.timezone, defaultZone)
    const a = operandDate(left, zone, now, rule.calendar), b = operandDate(right, zone, now, rule.calendar)
    const order = rule.precision === 'day' ? dateKey(wallTime(a, zone)).localeCompare(dateKey(wallTime(b, zone))) : Math.sign(a - b)
    return op === 'after' ? order > 0 : op === 'before' ? order < 0 : op === 'equals' ? order === 0 : op === 'on_or_after' ? order >= 0 : order <= 0
  }
  if (family === 'boolean') {
    if (kind === 'missing' || kind === 'null') return false
    if (Array.isArray(left) || isObject(left)) throw new Mismatch(`a ${Array.isArray(left) ? 'list' : 'object'} is not a boolean`)
    return booleanOf(left) === (op === 'is_true')
  }
  if (kind === 'missing' || kind === 'null') return false
  if (!Array.isArray(left)) throw new Mismatch(`not a list: ${JSON.stringify(left)}`)
  if (op === 'length') {
    const b = parseDecimal(right)
    if (!b) throw new Mismatch(`operand is not a number: ${JSON.stringify(right)}`)
    return numberCompare(String(rule.compare), compareDecimal({ units: BigInt(left.length), scale: 0 }, b))
  }
  const results = left.map(item => {
    const trace = evaluateRule(rule.inner!, item, scope, defaultZone, now)
    if (trace.result === 'type_mismatch') throw new Mismatch(`item ${JSON.stringify(item)}: ${trace.message}`)
    return trace.result
  })
  return op === 'any' ? results.some(Boolean) : results.length > 0 && results.every(Boolean)
}
function numberCompare(op: string, order: number) {
  return op === 'gt' ? order > 0 : op === 'lt' ? order < 0 : op === 'eq' ? order === 0 : op === 'ne' ? order !== 0 : op === 'gte' ? order >= 0 : order <= 0
}

/** AND inside a group, OR across groups. Every rule is evaluated so the trace is complete;
 * any type mismatch is reported, never a silent pass or fail. */
export function evaluate(groups: Groups, scope: Scope, zone: string, now = Date.now()): Evaluation {
  const evaluation: Evaluation = { pass: false, mismatch: null, groups: [] }
  groups.forEach((group, g) => {
    const rules = group.map(rule => evaluateRule(rule, scope, scope, zone, now))
    rules.forEach((trace, r) => { if (trace.result === 'type_mismatch' && !evaluation.mismatch) evaluation.mismatch = { group: g, rule: r, field: trace.field, value: trace.left, message: trace.message ?? 'type mismatch' } })
    const pass = rules.every(trace => trace.result === true)
    evaluation.groups.push({ pass, rules })
    if (pass) evaluation.pass = true
  })
  if (evaluation.mismatch) evaluation.pass = false
  return evaluation
}
