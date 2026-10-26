import { getConnection } from '../connections/store'
import { stmt, type CrankEnv } from '../model'
import { StepError } from './errors'
import type { Step } from './types'

/** Authoring never turns a test approval into permission to contact production. */
export async function assertAuthoringStep(env: CrankEnv, runId: string, step: Step, input: Record<string, unknown>) {
  const version = await stmt(env, `SELECT v.declared_json,w.settings_json FROM crank_wf_runs r
    JOIN crank_workflow_versions v ON v.id=r.version_id JOIN crank_workflows w ON w.id=r.workflow_id WHERE r.id=?`, runId)
    .first<{ declared_json: string; settings_json: string }>()
  if (!version || !JSON.parse(version.declared_json).authoring && !JSON.parse(version.settings_json).authoring) return
  if (['filter', 'map', 'transform', 'respond'].includes(step.type)) return
  if (!['http', 'quickbooks.create_invoice'].includes(step.type) || typeof step.connection_id !== 'string')
    throw new StepError('authority', 'Authoring permits only the declared CRM read and sandbox invoice; production sends are refused')
  const connection = await getConnection(env, step.connection_id)
  if (connection.status !== 'active' || connection.purpose !== 'test' || connection.environment !== 'sandbox')
    throw new StepError('authority', 'Authoring requires a current sandbox test account; production sends are refused')
  if (step.type === 'http') {
    if (!['http', 'hubspot'].includes(connection.app) || !['GET', 'HEAD'].includes(String(input.method ?? 'GET').toUpperCase()))
      throw new StepError('authority', 'Authoring cannot send to the CRM or use another app')
  } else if (connection.app !== 'quickbooks' || connection.account_name !== input.realm_id)
    throw new StepError('authority', 'Authoring cannot change the approved QuickBooks sandbox company')
}
