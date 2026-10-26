import { StepError } from '../engine/errors'
import type { Step, StepType } from '../engine/types'
import { isObject, lookup } from '../engine/values'
import { canonical, id, now, stmt, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'

export interface DriftField { source: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array' }
const types = ['string', 'number', 'boolean', 'object', 'array']
export const valueType = (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
export function safeField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && /^[A-Za-z_][\w-]*(?:\[\d+\])*(?:\.[A-Za-z_][\w-]*(?:\[\d+\])*)*$/.test(value)
    && !value.split(/[.\[\]]/).some(part => ['__proto__', 'constructor', 'prototype'].includes(part))
}
export function driftFields(step: Step): Record<string, DriftField> {
  if (!isObject(step.fields) || !Object.keys(step.fields).length || Object.keys(step.fields).length > 40)
    throw new StepError('validation', 'Drift mapping needs 1 to 40 named typed fields')
  for (const [name, field] of Object.entries(step.fields)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || !isObject(field) || !safeField(field.source) || !types.includes(String(field.type))
      || Object.keys(field).some(key => !['source', 'type'].includes(key)))
      throw new StepError('validation', 'Each drift mapping field needs an unchanged business name, source path and declared type')
  }
  return step.fields as unknown as Record<string, DriftField>
}

/** Metadata only: never persist source values or provider response bodies here. */
function schemaOf(value: unknown, prefix = '', depth = 0): Record<string, string> {
  if (!isObject(value) || depth > 5) return {}
  const result: Record<string, string> = {}
  for (const key of Object.keys(value).sort().slice(0, 100)) {
    const path = prefix ? prefix + '.' + key : key
    if (!safeField(path)) continue
    result[path] = valueType(value[key])
    if (isObject(value[key])) Object.assign(result, schemaOf(value[key], path, depth + 1))
    if (Object.keys(result).length >= 200) break
  }
  return Object.fromEntries(Object.entries(result).slice(0, 200))
}
export async function recordDriftIncident(env: CrankEnv, runId: string, path: string, kind: 'schema' | 'permission', field = '', expected = '', schema: Record<string, string> = {}) {
  const incidentId = id(), at = now()
  await env.DB.batch([
    stmt(env, `INSERT OR IGNORE INTO crank_drift_incidents(id,workflow_id,version_id,run_id,path,kind,field,expected_type,schema_json,created_at)
      SELECT ?,workflow_id,version_id,id,?,?,?,?,?,? FROM crank_wf_runs WHERE id=? AND mode='production'`,
    incidentId, path, kind, field, expected, canonical(schema), at, runId),
    auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_drift_incidents WHERE id=?)', [incidentId], 'system:drift', 'drift.detect', 'run', runId, { path, kind, field, expected_type: expected }),
  ])
}

/** Root calls this before settling an auth failure, then pauses the run. */
export async function recordDriftFailure(env: CrankEnv, runId: string, path: string, error: unknown): Promise<boolean> {
  if (!(error instanceof StepError) || error.detail.uncertain) return false
  if (error.category !== 'auth' && ![401, 403].includes(Number(error.detail.status))) return false
  if (!await stmt(env, "SELECT 1 FROM crank_wf_runs WHERE id=? AND mode='production'", runId).first()) return false
  await recordDriftIncident(env, runId, path, 'permission')
  return true
}

/** Call at every production write boundary, including after a request admission wait. */
export async function assertDriftWriteAllowed(env: CrankEnv, runId: string): Promise<void> {
  const held = await stmt(env, `SELECT i.id FROM crank_wf_runs r JOIN crank_drift_incidents i ON i.workflow_id=r.workflow_id
    WHERE r.id=? AND r.mode='production' AND i.state='open' LIMIT 1`, runId).first()
  if (held) throw new StepError('authority', 'Provider drift holds affected writes. Review and test an exact repair before continuing.', { drift: true })
}

export const driftMap: StepType = {
  mutating: false, required: ['record'],
  validate(step) { driftFields(step) },
  async execute(step, ctx) {
    const fields = driftFields(step), output: Record<string, unknown> = {}, mismatches: string[] = []
    if (!isObject(ctx.input.record)) throw new StepError('validation', 'Drift mapping record must be an object')
    const providerSchema = ctx.input.provider_schema, changelog = ctx.input.changelog
    if (providerSchema !== undefined && (!isObject(providerSchema) || Object.keys(providerSchema).length > 200 || Object.entries(providerSchema).some(([key,type])=>!safeField(key)||!types.includes(String(type)))))
      throw new StepError('validation','Provider schema must declare bounded field names and types')
    if (changelog !== undefined && (!Array.isArray(changelog) || changelog.length > 100 || changelog.some(change=>!isObject(change)||!safeField(change.from)||!safeField(change.to)||!types.includes(String(change.type))||Object.keys(change).some(key=>!['from','to','type'].includes(key)))))
      throw new StepError('validation','Provider changelog must contain bounded typed field changes; it cannot grant scopes or meaning')
    for (const [name, field] of Object.entries(fields)) {
      const found = lookup(ctx.input.record, field.source)
      if (!found.found || valueType(found.value) !== field.type || isObject(providerSchema) && providerSchema[field.source] !== field.type) {
        mismatches.push(field.source)
        if (ctx.run.mode !== 'test') await recordDriftIncident(ctx.env, ctx.run.id, ctx.path, 'schema', field.source, field.type, schemaOf(ctx.input.record))
      } else output[name] = found.value
    }
    if (mismatches.length) throw new StepError(ctx.run.mode === 'test' ? 'validation' : 'authority',
      'Provider field no longer exists or changed type: ' + mismatches.join(', '), { drift: true, fields: mismatches })
    return { status: 'succeeded', output, trace: { schema: schemaOf(ctx.input.record), provider_schema: providerSchema ?? null, changelog: changelog ?? [], fields } }
  },
}
