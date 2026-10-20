import { isObject } from './engine/values'

const PROVIDER_CONTROLLED = 'Provider-controlled; not verified by Crank. Consult your provider agreement.'
export interface DataFlow {
  id: string; kind: string; label: string; state: string; recipients: string[]
  purpose: string; fields: string[]; credentials: string; region: string; retention: string
}
// Never disclose URL credentials, paths, query values, graph literals or sealed values.
export function recipient(value: unknown): string {
  if (typeof value !== 'string' || value.includes('{{')) return 'Public URL mapped at runtime; inspect the workflow and run for the resolved destination'
  try { return new URL(value).origin } catch { return 'No external destination' }
}
export function fields(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([key, value]) => isObject(value) ? Object.keys(value).map(field => `${key}.${field}`) : [key])
}

export function queryFields(value: unknown): string[] {
  if (typeof value !== 'string' || value.includes('{{')) return []
  try { return [...new Set(new URL(value).searchParams.keys())].map(name => `URL query.${name}`) } catch { return [] }
}

export function providerFlow(flow: Omit<DataFlow, 'region' | 'retention'> & Partial<Pick<DataFlow, 'region' | 'retention'>>): DataFlow {
  return { region: PROVIDER_CONTROLLED, retention: PROVIDER_CONTROLLED, ...flow }
}
