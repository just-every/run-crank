import { compare, parseDecimal } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { branchesOf, type Graph } from '../engine/graph'
import type { Step } from '../engine/types'
import { isObject } from '../engine/values'
import { requireValue, stmt, type CrankEnv } from '../model'
import { assertGrantAuthority, grantFence, type GrantRow } from './authority'

export interface GrantRule {
  step_id: string; type: string; connection_id: string | null; app: string; fields: string[]; recipients: string[]
  recipient_field?: string; amount_field?: string; max_usd?: string; max_per_minute: number
}
export interface GrantPolicy {
  rules: GrantRule[]
  approval: { timeout_seconds: number; delegate_ids: string[]; escalate_to: string[] }
}
const strings = (value: unknown, label: string): string[] => {
  requireValue(Array.isArray(value) && value.length <= 1000 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)), `${label} must be an array of exact nonempty strings`)
  requireValue(new Set(value).size === value.length, `${label} cannot contain duplicates`)
  return value as string[]
}
function knownKeys(value: Record<string, unknown>, keys: string[], label: string) {
  requireValue(Object.keys(value).every(k => keys.includes(k)), `${label} contains an unknown field`)
}
function validFieldPath(value: unknown, fields: string[]): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[a-zA-Z_][a-zA-Z0-9_-]*(\.[a-zA-Z_][a-zA-Z0-9_-]*)*$/.test(value)
    && value.split('.').every(key => !['__proto__', 'constructor', 'prototype'].includes(key)) && fields.includes(value.split('.')[0])
}
/** Only exact own JSON properties are traversed; missing paths exceed the grant. */
function inputAt(input: Record<string, unknown>, path: string): unknown {
  let value: unknown = input
  for (const key of path.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}
export function grantLeaves(graph: Graph): Step[] {
  const walk = (steps: Step[]): Step[] => steps.flatMap(step => step.type === 'loop' ? walk(step.steps as Step[]) : step.type === 'paths' ? branchesOf(step).flatMap(branch => walk(branch.steps)) : [step])
  return walk(graph.steps)
}

/** An owner explicitly covers every template leaf; unknown policy fields refuse. */
export async function validateGrantPolicy(env: CrankEnv, graph: Graph, value: unknown): Promise<GrantPolicy> {
  requireValue(isObject(value) && Array.isArray(value.rules) && isObject(value.approval), 'policy needs rules and approval')
  knownKeys(value, ['rules', 'approval'], 'policy')
  const leaves = grantLeaves(graph), rules: GrantRule[] = [], seen = new Set<string>()
  requireValue(value.rules.length === leaves.length, 'Every workflow leaf needs exactly one grant rule')
  for (const raw of value.rules) {
    requireValue(isObject(raw), 'Each grant rule must be an object')
    knownKeys(raw, ['step_id', 'type', 'connection_id', 'app', 'fields', 'recipients', 'recipient_field', 'amount_field', 'max_usd', 'max_per_minute'], 'rule')
    const step = leaves.find(s => s.id === raw.step_id)
    requireValue(step && !seen.has(step.id), 'Each grant rule must identify a distinct workflow leaf')
    seen.add(step.id)
    const connection = typeof step.connection_id === 'string' ? step.connection_id : null
    requireValue(raw.type === step.type && raw.connection_id === connection, `Rule ${step.id} must match its step type and connection`)
    const account = connection ? await stmt(env, 'SELECT app FROM crank_connections WHERE id=? AND status=\'active\'', connection).first<{ app: string }>() : null
    requireValue(!connection || account, `Rule ${step.id} needs an active connection`)
    requireValue(raw.app === (account?.app ?? 'none'), `Rule ${step.id} must name the bound app`)
    const fields = strings(raw.fields, 'fields'), recipients = strings(raw.recipients, 'recipients')
    for (const key of ['recipient_field', 'amount_field'] as const) if (raw[key] !== undefined)
      requireValue(validFieldPath(raw[key], fields), `${key} must be an exact dotted path rooted in an allowed input field`)
    requireValue(!recipients.length || raw.recipient_field !== undefined, 'Allowed recipients need recipient_field')
    requireValue((raw.max_usd === undefined) === (raw.amount_field === undefined), 'A USD limit needs both max_usd and amount_field')
    if (raw.max_usd !== undefined) {
      const amount = parseDecimal(raw.max_usd)
      requireValue(typeof raw.max_usd === 'string' && amount && amount.units >= 0n, 'max_usd must be a nonnegative decimal string')
    }
    requireValue(Number.isSafeInteger(raw.max_per_minute) && Number(raw.max_per_minute) > 0, 'max_per_minute must be a positive whole number')
    rules.push({ step_id: step.id, type: step.type, connection_id: connection, app: String(raw.app), fields, recipients,
      max_per_minute: Number(raw.max_per_minute), ...(raw.recipient_field === undefined ? {} : { recipient_field: raw.recipient_field as string }),
      ...(raw.amount_field === undefined ? {} : { amount_field: raw.amount_field as string, max_usd: raw.max_usd as string }) })
  }
  const approval = value.approval
  knownKeys(approval, ['timeout_seconds', 'delegate_ids', 'escalate_to'], 'approval')
  requireValue(Number.isSafeInteger(approval.timeout_seconds) && Number(approval.timeout_seconds) > 0, 'approval.timeout_seconds must be a positive whole number')
  requireValue(Number.isFinite(new Date(Date.now() + Number(approval.timeout_seconds) * 1000).getTime()), 'approval.timeout_seconds exceeds the supported timestamp range')
  const delegates = strings(approval.delegate_ids, 'delegate_ids'), escalation = strings(approval.escalate_to, 'escalate_to')
  for (const operator of new Set([...delegates, ...escalation]))
    requireValue(await stmt(env, "SELECT id FROM oa_operators WHERE id=? AND status='active'", operator).first(), 'Approval delegates and escalation recipients must be active native operators')
  return { rules, approval: { timeout_seconds: Number(approval.timeout_seconds), delegate_ids: delegates, escalate_to: escalation } }
}

/** Checks every leaf, including pure/read steps. Approval overrides only effect limits. */
export async function grantProposal(env: CrankEnv, run: { id: string; workflow_id: string; version_id: string; grant_id?: string | null }, step: Step, path: string, input: Record<string, unknown>, approved = false) {
  if (!run.grant_id) return null
  await assertGrantAuthority(env, run.id)
  const grant = await stmt(env, 'SELECT * FROM crank_grants WHERE id=?', run.grant_id).first<GrantRow>()
  if (!grant) throw new StepError('authority', 'The execution grant no longer exists')
  const policy = JSON.parse(grant.policy_json) as GrantPolicy, rule = policy.rules.find(r => r.step_id === step.id)
  const connection = typeof step.connection_id === 'string' ? step.connection_id : null
  const account = connection ? await stmt(env, 'SELECT app FROM crank_connections WHERE id=? AND status=\'active\'', connection).first<{ app: string }>() : null
  if (!rule || rule.type !== step.type || rule.connection_id !== connection || rule.app !== (account?.app ?? 'none') || connection && !account)
    throw new StepError('authority', 'This step, app or connection is outside the execution grant', { grant_id: grant.id })
  const reasons: string[] = []
  if (Object.keys(input).some(field => !rule.fields.includes(field))) reasons.push('Input fields exceed the grant')
  if (rule.recipient_field) {
    const value = inputAt(input, rule.recipient_field), values = Array.isArray(value) ? value : [value]
    if (!values.length || values.some(v => typeof v !== 'string' || !rule.recipients.includes(v))) reasons.push('Recipients exceed the grant')
  }
  if (rule.amount_field) {
    const amount = parseDecimal(inputAt(input, rule.amount_field)), maximum = parseDecimal(rule.max_usd)
    if (!amount || amount.units < 0n || !maximum || compare(amount, maximum) > 0) reasons.push('Amount exceeds the grant')
  }
  const proposal = { step: step.id, type: step.type, input, grant_id: grant.id, rule, approval: policy.approval }
  if (!approved && reasons.length) return { proposal, reason: reasons.join('; ') }
  const at = new Date().toISOString(), since = new Date(Date.now() - 60000).toISOString(), fence = grantFence(env, grant.id, run.workflow_id, run.version_id)
  const admission = await stmt(env, `INSERT INTO crank_grant_admissions(grant_id,run_id,path,admitted_at)
    SELECT ?,?,?,? WHERE ${fence.sql}
    AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND grant_id=? AND workflow_id=? AND version_id=? AND status='running')
    AND (?=1 OR (SELECT COUNT(*) FROM crank_grant_admissions a WHERE a.grant_id=? AND a.admitted_at>? AND (a.path=? OR substr(a.path,-length(?)-1)='/'||?))<?)
    ON CONFLICT(grant_id,run_id,path) DO NOTHING RETURNING run_id`,
    grant.id, run.id, path, at, ...fence.args, run.id, grant.id, run.workflow_id, run.version_id,
    approved ? 1 : 0, grant.id, since, step.id, step.id, step.id, rule.max_per_minute).first()
  if (!admission) {
    await assertGrantAuthority(env, run.id)
    if (!await stmt(env, "SELECT 1 FROM crank_wf_runs WHERE id=? AND grant_id=? AND status='running'", run.id, grant.id).first())
      throw new StepError('authority', 'This run no longer has dispatch authority')
    if (!await stmt(env, 'SELECT 1 FROM crank_grant_admissions WHERE grant_id=? AND run_id=? AND path=?', grant.id, run.id, path).first())
      return { proposal, reason: 'Rate exceeds the grant' }
  }
  return null
}
