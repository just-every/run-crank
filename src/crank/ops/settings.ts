import { guardedBatch, requireOwner } from '../access'
import { parseDecimal } from '../engine/decimal'
import { requireZone } from '../engine/dates'
import { isObject } from '../engine/values'
import { now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'

/** Workspace defaults: timezone, opt-in USD caps by step category and the auto-pause policy. */
export interface WorkspaceSettings {
  timezone: string
  caps: { category: string; max_usd?: string; max_recipients?: number }[]
  auto_pause: { enabled: boolean; min_runs: number; failure_rate: number; window_hours: number }
}
export const DEFAULT_SETTINGS: WorkspaceSettings = { timezone: 'America/New_York', caps: [], auto_pause: { enabled: true, min_runs: 20, failure_rate: 0.95, window_hours: 24 } }

export async function workspaceSettings(env: CrankEnv): Promise<WorkspaceSettings> {
  const row = await stmt(env, 'SELECT settings_json FROM crank_settings WHERE singleton=1').first<{ settings_json: string }>()
  const stored = row ? JSON.parse(row.settings_json) : {}
  return { ...DEFAULT_SETTINGS, ...stored, auto_pause: { ...DEFAULT_SETTINGS.auto_pause, ...(stored.auto_pause ?? {}) } }
}
export async function updateSettings(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const current = await workspaceSettings(env), next: WorkspaceSettings = { ...current }
  if (input.timezone !== undefined) next.timezone = requireZone(input.timezone)
  if (input.caps !== undefined) {
    requireValue(Array.isArray(input.caps) && input.caps.length <= 50, 'caps must be a list')
    next.caps = (input.caps as unknown[]).map(cap => {
      requireValue(isObject(cap) && typeof cap.category === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(cap.category), 'Each cap names a step category')
      requireValue(cap.max_usd !== undefined || cap.max_recipients !== undefined, 'Each cap has max_usd or max_recipients')
      if (cap.max_usd !== undefined) requireValue(parseDecimal(cap.max_usd) !== null, 'max_usd must be an amount')
      if (cap.max_recipients !== undefined) requireValue(Number.isSafeInteger(cap.max_recipients) && (cap.max_recipients as number) >= 0, 'max_recipients must be a nonnegative whole number')
      return { category: cap.category as string, ...(cap.max_usd !== undefined ? {max_usd: String(cap.max_usd)} : {}), ...(cap.max_recipients !== undefined ? {max_recipients: cap.max_recipients as number} : {}) }
    })
  }
  if (input.auto_pause !== undefined) {
    requireValue(isObject(input.auto_pause), 'auto_pause must be an object')
    const policy = { ...current.auto_pause, ...(input.auto_pause as object) }
    requireValue(typeof policy.enabled === 'boolean' && Number.isInteger(policy.min_runs) && policy.min_runs >= 1 && typeof policy.failure_rate === 'number' && policy.failure_rate > 0 && policy.failure_rate <= 1 && Number.isInteger(policy.window_hours) && policy.window_hours >= 1 && policy.window_hours <= 720, 'auto_pause needs enabled, min_runs, failure_rate (0-1] and window_hours')
    next.auto_pause = policy
  }
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_settings(singleton,settings_json,updated_by,updated_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at', JSON.stringify(next), actor.id, now()),
    auditStatement(env, actor.id, 'settings.update', 'workspace', 'settings', { caps: next.caps, auto_pause: next.auto_pause, timezone: next.timezone }),
  ])
  return next
}
