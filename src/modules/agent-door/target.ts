import type { NativeTarget, ToolContext, ToolDefinition } from './types.ts'
import { ToolRefusal } from './errors.ts'

/** The seed returns an audit-safe native identity, after its own redaction. */
export async function nativeTarget(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<NativeTarget | null> {
  const value = await tool.target?.(args, ctx) ?? null
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'id,kind' || ![value.kind, value.id].every(item => typeof item === 'string' && item.trim().length)) throw new ToolRefusal('target_invalid')
  return { kind: value.kind, id: value.id }
}
