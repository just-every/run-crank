import { APPS } from '../connections/apps'
import { getConnection, present } from '../connections/store'
import { STEP_TYPES } from '../engine/steps'
import { aiConfig, createAiClient, AiError } from '../../modules/ai/index.mjs'
import { CrankError, now, requireValue, text, type CrankEnv } from '../model'
import { exact, proposalSchema, scopedGraph, type AuthoringScope, type Question } from './authoring-schema'

export async function generateProposal(env: CrankEnv, prompt: string, scope: AuthoringScope, samples: Record<string, unknown>[]) {
  const config = aiConfig(env as unknown as Record<string, unknown>)
  requireValue(config.enabled && config.model, 'Configure and enable an authoring model before generating a workflow', 409)
  const connections = await Promise.all([getConnection(env, scope.crm_connection_id), getConnection(env, scope.quickbooks_connection_id)])
  const schemas = scope.tools.map(type => ({ type, connection: STEP_TYPES[type].connection ?? null, required: STEP_TYPES[type].required ?? [], mutating: STEP_TYPES[type].mutating }))
  const authorizedApps = connections.map(connection => ({ connection: present(connection), app: APPS[connection.app] }))
  let response: Response
  try {
    response = await createAiClient(config).chat({
      messages: [
        { role: 'system', content: 'Build an editable native Crank graph from the request and submitted samples. The only authorized scope is the supplied scope: manual CRM GET, US-only filter, one USD QuickBooks invoice. Never add tools, accounts, recipients, transport, background triggers or new scope. If any requested behavior exceeds this scope, put a clear explanation in refusal. Return the schema exactly; do not execute tools. CRM output is steps.lead.body; map country and stable business key from this fetched record. A filter rule field is a plain dotted path, for example steps.lead.body.country, without template braces. Mapped invoice business_key uses template braces, for example {{steps.lead.body.id}}. Samples are trigger.input objects used to resolve the CRM URL. Missing or ambiguous business decisions must be explicit questions; do not invent answers. Include a question asking the owner to confirm the country field and invoice business key mappings. Even when refusing, return a schema-valid graph within supplied scope.' },
        { role: 'user', content: JSON.stringify({ prompt, scope, samples, schemas, authorized_apps: authorizedApps }) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'crank_authoring_proposal', strict: true, schema: proposalSchema(scope) } },
      max_completion_tokens: 6000, reasoning_effort: 'low', stream: false, store: false,
    }, { feature: 'crank-authoring', signal: AbortSignal.timeout(90000) })
  } catch (error) {
    if (error instanceof AiError) throw new CrankError(503, `Authoring model refused or could not complete generation (${error.code})`)
    throw new CrankError(503, 'Authoring model generation could not be confirmed')
  }
  const reader = response.body?.getReader()
  requireValue(reader, 'The authoring model returned no proposal', 502)
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      requireValue(size <= 131072, 'Authoring model response exceeds its limit', 502)
      chunks.push(part.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let wire: any, proposal: any
  try { wire = JSON.parse(new TextDecoder().decode(bytes)); proposal = JSON.parse(wire.choices[0].message.content) }
  catch { throw new CrankError(502, 'The authoring model did not return the required proposal schema') }
  exact(proposal, ['name', 'graph', 'questions', 'refusal'], 'Model proposal')
  requireValue(proposal.refusal === null || typeof proposal.refusal === 'string', 'The model proposal omitted its scope decision', 502)
  requireValue(!proposal.refusal, `Requested scope was refused: ${String(proposal.refusal).slice(0, 1000)}`, 422)
  const graph = scopedGraph(proposal.graph, scope), name = text(proposal.name, 'Proposal name', 200)
  requireValue(Array.isArray(proposal.questions) && proposal.questions.length <= 8, 'The proposal needs bounded unresolved questions', 502)
  const questions: Question[] = proposal.questions.map((question: unknown) => {
    exact(question, ['id', 'question'], 'Model question')
    return { id: text(question.id, 'Question id', 80), question: text(question.question, 'Question', 1000) }
  })
  requireValue(new Set(questions.map(q => q.id)).size === questions.length, 'Model question identifiers must be distinct', 502)
  if (!questions.length) questions.push({ id: 'mapping_confirmation', question: 'Confirm the fetched country field and stable invoice business key mappings before promotion.' })
  const usage = wire.usage && typeof wire.usage === 'object' ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(k => Number.isSafeInteger(wire.usage[k]) && wire.usage[k] >= 0).map(k => [k, wire.usage[k]])) : null
  return { name, graph, questions, schemas: { operations: schemas, apps: authorizedApps }, model: { model: config.model, provider: 'configured', response_id: typeof wire.id === 'string' ? wire.id.slice(0, 200) : null, generated_at: now() }, costs: { generation: { usage, usd: null, status: 'Provider charge not reported' } } }
}
