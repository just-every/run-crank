import { ToolRefusal } from '../../modules/agent-door/errors.ts'
import type { ClassAndFacts, JsonSchema, JsonSchemaObject, ToolContext } from '../../modules/agent-door/types.ts'
import { CrankError, type CrankEnv } from '../model.ts'
import { productApi } from '../ui/handler.ts'
import { attributionEnv, bindNativeRequest, resolveActor } from './native.ts'

export const textSchema = { type: 'string', minLength: 1, maxLength: 200 }
export const nullableText = { type: ['string', 'null'] }
export const strings = { type: 'array', items: { type: 'string' } }
export const objectSchema = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchemaObject => ({ type: 'object', properties, required, additionalProperties: false })
export const arraySchema = (items: JsonSchema): JsonSchema => ({ type: 'array', items })
export const standard = (measure = 1): ClassAndFacts[] => [{ class: 'standard', facts: { measure } }]
export const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>
export const pathPart = (args: Record<string, unknown>, key: string) => encodeURIComponent(String(args[key]))
export const query = (args: Record<string, unknown>, keys: string[]) => {
  const params = new URLSearchParams()
  for (const key of keys) if (args[key] !== undefined) params.set(key, String(args[key]))
  return params.toString()
}

/** No token or browser session is fabricated: native authorization rechecks the bound actor. */
export async function nativeCall(env: CrankEnv, ctx: ToolContext, path: string, input?: Record<string, unknown>) {
  const actor = await resolveActor(env, ctx)
  const headers = new Headers({ origin: ctx.origin, 'content-type': 'application/json' })
  if (input !== undefined && ctx.idempotencyKey) headers.set('Idempotency-Key', ctx.idempotencyKey)
  const request = bindNativeRequest(new Request(ctx.origin + '/api/crank' + path, {
    method: input === undefined ? 'GET' : 'POST', headers,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }), actor)
  const response = await productApi(request, attributionEnv(env, ctx))
  if (!response) throw new ToolRefusal('native_operation_unavailable')
  if (!response.ok) {
    await response.body?.cancel()
    // Native validation messages may interpolate private graph/payload values.
    throw new ToolRefusal(response.status === 401 || response.status === 403 ? 'native_authority_refused'
      : response.status === 404 ? 'resource_unavailable'
      : response.status === 409 ? 'revision_conflict' : 'native_operation_refused',
    'The native operation was refused', { status: response.status })
  }
  return await response.json() as unknown
}

export async function nativeGuard<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    if (error instanceof CrankError) throw new ToolRefusal(error.status === 403 ? 'native_authority_refused' : error.status === 404 ? 'resource_unavailable' : 'native_operation_refused')
    throw error
  }
}

/** Metadata has a closed projection; arbitrary graph settings, payloads and hook URLs never escape. */
export function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
