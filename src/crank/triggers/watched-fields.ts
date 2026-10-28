import { requirePrepare } from '../access'
import { connectionScope, completeGrant, workflowScope } from '../team/policy'
import { canonical, digest, requireValue, type Actor, type CrankEnv } from '../model'
import { appFieldNames } from './app-source'
import { getWorkflow, updateDraft } from '../workflows/store'
import { isTableSource, tableFieldNames } from './table-source'

/** Loading names reads the exact current draft account, without trigger admission. */
export async function watchedFields(env: CrankEnv, actor: Actor, workflowId: string) {
  requirePrepare(actor); workflowScope(actor, workflowId)
  const workflow = await getWorkflow(env, workflowId), graph = JSON.parse(workflow.draft_json)
  requireValue(graph.trigger.type === 'app_poll', 'Choose a native app polling trigger')
  const native = isTableSource(graph.trigger)
  if (!native) connectionScope(actor, graph.trigger.connection_id)
  requireValue(!actor.team || !native && completeGrant(actor, 'prepare', workflowId, [graph.trigger.connection_id]), 'One complete grant must cover the workflow and its account', 403)
  const fields = native ? await tableFieldNames(env, graph.trigger, { workflowId }) : await appFieldNames(env, graph.trigger)
  requireValue((await getWorkflow(env, workflowId)).draft_json === workflow.draft_json, 'The draft changed; load current field names again', 409)
  return { fields, draft_digest: await digest(canonical(graph)), schema_digest: await digest(canonical(fields)) }
}

export async function saveWatchedFields(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  const current = await getWorkflow(env, workflowId), graph = JSON.parse(current.draft_json)
  requireValue(input.draft_digest === await digest(canonical(graph)), 'The draft changed; load current field names again', 409)
  const schema = await watchedFields(env, actor, workflowId)
  requireValue(input.schema_digest === schema.schema_digest, 'The source fields changed; load current field names again', 409)
  const fields = input.watched_fields
  requireValue(Array.isArray(fields) && fields.every(name => typeof name === 'string' && schema.fields.some(field => field.name === name)), 'Select fields from the current account resource')
  requireValue(typeof input.any_field === 'boolean', 'Choose watched fields or any field explicitly')
  graph.trigger = { ...graph.trigger, any_field: input.any_field, watched_fields: input.any_field ? undefined : fields }
  return updateDraft(env, actor, workflowId, { graph }, undefined, current.draft_json, { action: 'trigger.watched_fields', detail: { any_field: input.any_field, fields } })
}
