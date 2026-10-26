import type { Groups } from './engine/conditions'
import type { Step } from './engine/types'
import { n8nDateValue } from './engine/transforms/n8n-date-value'

type Obj = Record<string, any>
type Mapper = (value: any, previous: string, at: string) => any
type Fields = (value: Obj, allowed: string[], at: string) => void
export interface N8nCondition { type: string; operation: string; rightType: string; singleValue: boolean }
export interface N8nConditionSet { combinator: 'and' | 'or'; caseSensitive: boolean; version: number; strict: boolean; conditions: N8nCondition[] }

export const N8N_CONDITION_OPERATIONS: Record<string, readonly string[]> = {
  string: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith', 'regex', 'notRegex'],
  number: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'],
  dateTime: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals', 'after', 'before', 'afterOrEquals', 'beforeOrEquals'],
  boolean: ['exists', 'notExists', 'empty', 'notEmpty', 'true', 'false', 'equals', 'notEquals'],
  array: ['exists', 'notExists', 'empty', 'notEmpty', 'contains', 'notContains', 'lengthEquals', 'lengthNotEquals', 'lengthGt', 'lengthGte', 'lengthLt', 'lengthLte'],
  object: ['exists', 'notExists', 'empty', 'notEmpty'],
  any: ['exists', 'notExists'],
}
const object = (value: any): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('condition object required')
  return value
}
const unary = (operation: string) => ['exists', 'notExists', 'empty', 'notEmpty', 'true', 'false'].includes(operation)

/** Preserve source evaluation order before native boolean routing. */
export function compileN8nConditionSets(values: unknown[], previous: string, at: string, id: string, mapped: Mapper, fields: Fields, allMatching = false): { step: Step; when: Groups[] } {
  if (!values.length || values.length > 25) throw Error('conditions require 1 to 25 output groups')
  const inputs: Obj = {}, sets: N8nConditionSet[] = values.map((value, group) => {
    const path = at + '.' + group, source = object(value)
    fields(source, ['options', 'conditions', 'combinator'], path)
    const options = object(source.options ?? {})
    fields(options, ['caseSensitive', 'leftValue', 'typeValidation', 'version'], path + '.options')
    if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') throw Error('condition case sensitivity must be boolean')
    if (options.typeValidation !== undefined && !['strict', 'loose'].includes(options.typeValidation)) throw Error('unsupported condition type validation')
    if (options.leftValue !== undefined && typeof options.leftValue !== 'string') throw Error('condition option leftValue must be text metadata')
    if (options.version !== undefined && ![1, 2, 3, 4].includes(options.version)) throw Error('unsupported condition version')
    if (!Array.isArray(source.conditions) || source.conditions.length > 50 || !['and', 'or'].includes(source.combinator)) throw Error('unsupported condition group')
    const operands: Obj = {}
    inputs['g' + group] = operands
    const conditions = source.conditions.map((raw: unknown, index: number): N8nCondition => {
      const condition = object(raw), conditionPath = path + '.conditions.' + index
      fields(condition, ['id', 'leftValue', 'rightValue', 'operator'], conditionPath)
      const operator = object(condition.operator)
      fields(operator, ['type', 'operation', 'singleValue', 'rightType'], conditionPath + '.operator')
      const { type, operation } = operator
      if (!Object.hasOwn(N8N_CONDITION_OPERATIONS, type) || !N8N_CONDITION_OPERATIONS[type].includes(operation)) throw Error('unsupported condition operator')
      if (operator.singleValue !== undefined && typeof operator.singleValue !== 'boolean') throw Error('condition singleValue must be boolean')
      const rightType = operator.rightType ?? type
      if (!['string', 'number', 'boolean', 'array', 'object', 'any', 'dateTime'].includes(rightType)) throw Error('unsupported condition operand type override')
      if(options.typeValidation!=='strict'&&(type==='object'||rightType==='object'))throw Error('loose object parsing requires manual conversion')
      if (operator.singleValue === true && !unary(operation)) throw Error('binary conditions cannot skip operand validation')
      if(type==='dateTime') {
        if(rightType!=='dateTime')throw Error('DateTime comparisons require timestamp operands')
        for(const [key,value]of [['leftValue',condition.leftValue],['rightValue',condition.rightValue]]) {
          if(key==='rightValue'&&operator.singleValue===true)continue
          if(typeof value==='string'&&(value.startsWith('=')||value.includes('{{')))continue
          n8nDateValue(value)
        }
      }
      operands['c' + index] = {
        ...(Object.hasOwn(condition, 'leftValue') ? { left: mapped(condition.leftValue, previous, conditionPath + '.leftValue') } : {}),
        ...(Object.hasOwn(condition, 'rightValue') ? { right: mapped(condition.rightValue, previous, conditionPath + '.rightValue') } : {}),
      }
      return { type, operation, rightType, singleValue: operator.singleValue === true }
    })
    return { combinator: source.combinator, caseSensitive: options.caseSensitive ?? false, version: options.version ?? 1, strict: options.typeValidation==='strict', conditions }
  })
  const stepId = id + '_conditions'
  return {
    step: { id: stepId, name: 'Source conditions', type: 'transform', fn: 'n8n.conditions', input: { sets: { $literal: sets }, inputs, all_matching: allMatching } } as Step,
    when: sets.map((_, index) => [[{ field: 'steps.' + stepId + '[' + index + ']', op: 'boolean.is_true', value_type: 'boolean' }]]),
  }
}
