import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'

interface OutputSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, OutputSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: OutputSchema
}

const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`

/** A bounded structural JSON schema subset. Unsupported keywords fail authoring,
 * rather than suggesting that a constraint was enforced when it was ignored. */
export function validateOutputSchema(value: unknown, stepId: string): asserts value is OutputSchema {
  const invalid = (reason: string): never => { throw new StepError('validation', `Code ${stepId}: output_schema ${reason}`) }
  if (JSON.stringify(value).length > 16384) invalid('must fit in 16384 characters')
  let nodes = 0
  const walk = (schema: unknown, depth: number) => {
    if (++nodes > 128 || depth > 8) invalid('exceeds its structural limit (128 nodes, 8 levels)')
    if (!isObject(schema)) return invalid('must be a typed schema object')
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))) invalid('needs one supported type')
    const allowed = schema.type === 'object' ? ['type', 'properties', 'required', 'additionalProperties'] : schema.type === 'array' ? ['type', 'items'] : ['type']
    if (Object.keys(schema).some(key => !allowed.includes(key))) invalid('contains an unsupported keyword for its type')
    if (schema.type === 'object') {
      if (schema.properties !== undefined && !isObject(schema.properties)) return invalid('properties must be an object')
      const properties = (schema.properties ?? {}) as Record<string, unknown>
      if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key)) || new Set(schema.required).size !== schema.required.length)) invalid('required must list distinct declared properties')
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') invalid('additionalProperties must be boolean')
      for (const child of Object.values(properties)) walk(child, depth + 1)
    }
    if (schema.type === 'array') {
      if (schema.items === undefined) invalid('arrays need an items schema')
      walk(schema.items, depth + 1)
    }
  }
  walk(value, 1)
}

/** Validate the remote result, never the task envelope. Diagnostics retain only
 * declared paths and fixed reasons; values and undeclared field names stay out. */
export function assertExecutorOutput(value: unknown, declaration: unknown, stepId: string, taskId: string) {
  validateOutputSchema(declaration, stepId)
  let nodes = 0
  const mismatch = (path: string, reason: string): never => {
    throw new StepError('validation', `Code ${stepId}: output schema mismatch at ${path || '/'} (${reason})`, { task_id: taskId, output_path: path, reason: 'output_schema_mismatch' })
  }
  const walk = (output: unknown, schema: OutputSchema, path: string) => {
    if (++nodes > 10000) mismatch(path, 'validation exceeds 10000 values')
    const matches = schema.type === 'null' ? output === null
      : schema.type === 'object' ? isObject(output)
      : schema.type === 'array' ? Array.isArray(output)
      : schema.type === 'integer' ? Number.isSafeInteger(output)
      : schema.type === 'number' ? typeof output === 'number' && Number.isFinite(output)
      : typeof output === schema.type
    if (!matches) mismatch(path, `expected ${schema.type}`)
    if (schema.type === 'object') {
      const object = output as Record<string, unknown>, properties = schema.properties ?? {}
      for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) mismatch(pointer(path, key), 'required field missing')
      for (const [key, child] of Object.entries(object)) {
        if (Object.hasOwn(properties, key)) walk(child, properties[key], pointer(path, key))
        else if (schema.additionalProperties === false) mismatch(path, 'undeclared field')
      }
    } else if (schema.type === 'array') {
      for (const [index, child] of (output as unknown[]).entries()) walk(child, schema.items!, pointer(path, index))
    }
  }
  walk(value, declaration, '')
}
