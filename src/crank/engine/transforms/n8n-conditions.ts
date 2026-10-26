import { N8N_CONDITION_OPERATIONS, type N8nCondition, type N8nConditionSet } from '../../n8n-conditions'
import { StepError } from '../errors'
import { isObject } from '../values'
import type { Args } from './args'

function strict(value: unknown, type: string): unknown {
  if (value === undefined || value === null || type === 'any') return value
  const valid = type === 'array' ? Array.isArray(value) : type === 'object' ? isObject(value) : typeof value === type
  if (!valid) throw new StepError('type_mismatch', 'Condition requires ' + type + ' operands without coercion')
  return value
}

function regex(pattern: string, subject: string, ignoreCase: boolean): boolean {
  const literal = /^\/(.*?)\/([gimusy]*)$/.exec(pattern)
  let flags = literal?.[2] ?? ''
  if (ignoreCase && !flags.includes('i')) flags += 'i'
  try { return new RegExp(literal?.[1] ?? pattern, flags).test(subject) }
  catch { throw new StepError('validation', 'Invalid condition pattern') }
}

function test(condition: N8nCondition, input: unknown, set: N8nConditionSet): boolean {
  const operands = isObject(input) ? input : {}, left = strict(operands.left, condition.type)
  const right = condition.singleValue ? undefined : strict(operands.right, condition.rightType)
  const { type, operation } = condition, exists = left !== undefined && left !== null && !Number.isNaN(left)
  if (operation === 'exists') return exists
  if (operation === 'notExists') return !exists
  if (type === 'string') {
    const isRegex = operation === 'regex' || operation === 'notRegex'
    const ignoreCase = !set.caseSensitive, flag = ignoreCase && set.version >= 4 && isRegex
    const a = ignoreCase && !flag ? String(left ?? '').toLocaleLowerCase() : String(left ?? '')
    const b = ignoreCase && !isRegex ? String(right ?? '').toLocaleLowerCase() : String(right ?? '')
    switch (operation) {
      case 'empty': return a.length === 0
      case 'notEmpty': return a.length !== 0
      case 'equals': return a === b
      case 'notEquals': return a !== b
      case 'contains': return a.includes(b)
      case 'notContains': return !a.includes(b)
      case 'startsWith': return a.startsWith(b)
      case 'notStartsWith': return !a.startsWith(b)
      case 'endsWith': return a.endsWith(b)
      case 'notEndsWith': return !a.endsWith(b)
      case 'regex': return regex(b, a, flag)
      case 'notRegex': return !regex(b, a, flag)
    }
  }
  if (type === 'number') {
    const a = left as number, b = right as number
    switch (operation) {
      case 'empty': return !exists
      case 'notEmpty': return exists
      case 'equals': return a === b
      case 'notEquals': return a !== b
      case 'gt': return a > b
      case 'gte': return a >= b
      case 'lt': return a < b
      case 'lte': return a <= b
    }
  }
  if (type === 'boolean') {
    switch (operation) {
      case 'empty': return !exists
      case 'notEmpty': return exists
      case 'true': return Boolean(left)
      case 'false': return !left
      case 'equals': return left === right
      case 'notEquals': return left !== right
    }
  }
  if (type === 'array') {
    const a = (left ?? []) as unknown[], b = right as number
    const contains = () => !set.caseSensitive && typeof right === 'string'
      ? a.some(item => typeof item === 'string' && item.toLocaleLowerCase() === right.toLocaleLowerCase())
      : a.includes(right)
    switch (operation) {
      case 'empty': return a.length === 0
      case 'notEmpty': return a.length !== 0
      case 'contains': return contains()
      case 'notContains': return !contains()
      case 'lengthEquals': return a.length === b
      case 'lengthNotEquals': return a.length !== b
      case 'lengthGt': return a.length > b
      case 'lengthGte': return a.length >= b
      case 'lengthLt': return a.length < b
      case 'lengthLte': return a.length <= b
    }
  }
  if (type === 'object') {
    if (operation === 'empty') return !left || Object.keys(left).length === 0
    if (operation === 'notEmpty') return !!left && Object.keys(left).length !== 0
  }
  throw new StepError('validation', 'Unsupported condition operator')
}

/** Strict source conditions short circuit within groups and across exclusive outputs. */
export function n8nConditions(args: Args): boolean[] {
  if (!Array.isArray(args.sets) || !args.sets.length || args.sets.length > 25 || !isObject(args.inputs) || typeof args.all_matching !== 'boolean') throw new StepError('validation', 'Invalid condition groups')
  const inputs = args.inputs, sets = args.sets as N8nConditionSet[]
  for (const set of sets) {
    if (!isObject(set) || !['and', 'or'].includes(set.combinator) || typeof set.caseSensitive !== 'boolean' || ![1, 2, 3, 4].includes(set.version) || !Array.isArray(set.conditions) || set.conditions.length > 50) throw new StepError('validation', 'Invalid condition group')
    for (const condition of set.conditions) {
      if (!isObject(condition) || !Object.hasOwn(N8N_CONDITION_OPERATIONS, condition.type) || !N8N_CONDITION_OPERATIONS[condition.type].includes(condition.operation) || typeof condition.singleValue !== 'boolean') throw new StepError('validation', 'Unsupported condition operator')
    }
  }
  const results = sets.map(() => false)
  for (const [group, set] of sets.entries()) {
    const operands = isObject(inputs['g' + group]) ? inputs['g' + group] as Record<string, unknown> : {}
    const conditionPass = (condition: N8nCondition, index: number) => test(condition, operands['c' + index], set)
    results[group] = set.combinator === 'and' ? set.conditions.every(conditionPass) : set.conditions.some(conditionPass)
    if (results[group] && !args.all_matching) break
  }
  return results
}
