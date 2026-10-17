import { StepError } from '../errors'
import { textOf } from '../values'

export type Args = Record<string, unknown>
export type Transform = (args: Args) => unknown

export function text(args: Args, name = 'value', options: { allowEmpty?: boolean } = { allowEmpty: true }): string {
  const value = args[name]
  if (value === undefined || value === null) {
    if (options.allowEmpty) return ''
    throw new StepError('validation', `${name} is required`)
  }
  const result = textOf(value)
  if (result === null) throw new StepError('validation', `${name} must be text, not ${Array.isArray(value) ? 'a list' : 'an object'}`)
  return result
}
export function integer(args: Args, name: string, fallback?: number): number {
  const value = args[name] ?? fallback
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isInteger(number)) throw new StepError('validation', `${name} must be a whole number`)
  return number
}
export function list(args: Args, name = 'list'): unknown[] {
  const value = args[name]
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) throw new StepError('validation', `${name} is required`)
  throw new StepError('validation', `${name} must be a list`)
}
export function choice<T extends string>(args: Args, name: string, options: readonly T[], fallback?: T): T {
  const value = args[name] ?? fallback
  if (!options.includes(value as T)) throw new StepError('validation', `${name} must be one of ${options.join(', ')}`)
  return value as T
}
