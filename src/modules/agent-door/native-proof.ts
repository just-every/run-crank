import type { Principal, Runtime, ToolDefinition } from './types.ts'
import { ToolRefusal } from './errors.ts'

/** Only the seed can verify its recent human authentication. No credential
 * reaches Base; the opaque reference remains bound to the original principal. */
export async function nativeProof(rt: Runtime, tool: ToolDefinition, args: Record<string, unknown>, principal: Principal, reference: unknown): Promise<Principal> {
  if (!tool.proof) return principal
  const kind = tool.proofKind!, hook = rt.options.nativeProof!
  if (typeof reference === 'string' && reference.length > 0 && reference.length <= 512
    && await hook.verify({ kind, tool: tool.name, args, principal, reference }) === true) return { ...principal, nativeProof: { kind, reference } }
  const handoff = new URL(await hook.handoff({ kind, tool: tool.name, principal }), rt.options.origin)
  if (handoff.origin !== rt.options.origin || handoff.username || handoff.password) throw new Error('Invalid native proof handoff')
  throw new ToolRefusal('native_proof_required', 'Recent native authentication is required.', { kind, handoff: handoff.href })
}
