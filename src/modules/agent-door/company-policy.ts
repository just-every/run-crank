import type { CompanyPolicyDecision, NativeTarget, Runtime, ToolContext, ClassAndFacts } from './types.ts'
import type { Decision } from './policy/decide.ts'
import { approverRefs, durationSeconds } from './policy/document.ts'
import { ToolRefusal } from './errors.ts'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const identifier = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[\x00-\x1f]/.test(value)

/** Native decisions narrow the shared decision; they never supply a policy. */
export function restrictDecision(policy: Decision, native?: CompanyPolicyDecision): Decision {
  if (!native || policy.result === 'unset' || policy.result === 'blocked' || native.decision === 'allow') return policy
  if (native.decision === 'deny') return { ...policy, result: 'blocked' }
  const approval = policy.result === 'approval'
  return { ...policy, result: 'approval', approvers: [...new Set([...(approval ? policy.approvers! : []), ...native.approvers])],
    wait: approval && durationSeconds(policy.wait)! < durationSeconds(native.wait)! ? policy.wait : native.wait }
}

export async function companyDecision(rt: Runtime, tool: string, args: Record<string, unknown>, classes: ClassAndFacts[], target: NativeTarget | null, policy: Decision, ctx: ToolContext): Promise<CompanyPolicyDecision | undefined> {
  if (!rt.options.companyPolicy) return undefined
  let answer: unknown
  try {
    const { emit: _emit, approvers: _approvers, ...identity } = ctx
    answer = await rt.options.companyPolicy.decide(freeze(structuredClone({ tool, args, classes, target, policy })), Object.freeze(identity))
  } catch {
    throw new ToolRefusal('company_policy_unavailable')
  }
  try {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error()
    const item = answer as Record<string, unknown>, hold = item.decision === 'hold'
    const keys = hold ? ['decision', 'rule', 'revision', 'approvers', 'wait'] : ['decision', 'rule', 'revision']
    if (typeof item.decision !== 'string' || !['allow', 'hold', 'deny'].includes(item.decision) || !keys.every(key => Object.hasOwn(item, key)) || Object.keys(item).some(key => !keys.includes(key)) || !identifier(item.rule) || !identifier(item.revision)) throw new Error()
    if (hold) {
      approverRefs(item.approvers, '$.approvers', {})
      if (!durationSeconds(item.wait)) throw new Error()
    }
    return freeze(structuredClone(answer)) as CompanyPolicyDecision
  } catch {
    throw new ToolRefusal('company_policy_invalid')
  }
}
