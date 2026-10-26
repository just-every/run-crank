import { guardedBatch, requireOwner } from '../access'
import { requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { readWorkflowEstimate } from '../ops/usage'
import { draftSnapshot } from '../workflows/drafts'
import { createWorkflow, publishWorkflow } from '../workflows/store'
import { testWorkflow } from '../workflows/testing'
import { generateProposal } from './authoring-model'
import { authoringDigest, authoringState, saveAuthoring, type AuthoringRecord } from './authoring-record'
import { exact, samplesOf, scopeOf, scopedGraph } from './authoring-schema'

export async function generateAuthoring(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  exact(input, ['prompt', 'crm_connection_id', 'quickbooks_connection_id', 'lead_url', 'realm_id', 'customer_id', 'item_id', 'amount_usd', 'samples'], 'Authoring request')
  const scope = await scopeOf(env, input), samples = samplesOf(input.samples)
  requireValue(typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 8000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt), 'Describe the business result in at most 8000 characters', 422)
  const prompt = input.prompt.trim()
  const proposal = await generateProposal(env, prompt, scope, samples)
  const workflow = await createWorkflow(env, actor, { name: proposal.name, environment: 'sandbox', graph: proposal.graph, settings: { authoring: { created_by: actor.id } } })
  const record: AuthoringRecord = { revision: 0, schemas: proposal.schemas, scope, samples, questions: proposal.questions, model: proposal.model, costs: proposal.costs, tested: null }
  await guardedBatch(env, actor, 'owner', [
    await draftSnapshot(env, actor, workflow.id, null, proposal.graph, { authoring: record }),
    auditStatement(env, actor.id, 'authoring.generate', 'workflow', workflow.id, { model: record.model, sample_count: samples.length }),
  ])
  return readAuthoring(env, actor, workflow.id)
}
export async function readAuthoring(env: CrankEnv, actor: Actor, workflowId: string) {
  requireOwner(actor)
  const state = await authoringState(env, workflowId), { record, graph, workflow } = state
  const hash = await authoringDigest(graph, record)
  const promotion = workflow.published_version_id ? await stmt(env, "SELECT id FROM crank_audit WHERE action='authoring.promote' AND subject_id=? AND version_id=?", workflowId, workflow.published_version_id).first() : null
  return { workflow_id: workflowId, graph, samples: record.samples, questions: record.questions, scope: record.scope, model: record.model,
    costs: { ...record.costs, execution: await readWorkflowEstimate(env, workflowId) }, digest: hash,
    tested: { passed: record.tested?.digest === hash, digest: record.tested?.digest ?? null, run_ids: record.tested?.run_ids ?? [] }, promoted: !!promotion,
    schemas: { authorized: record.schemas, sample_fields: [...new Set(record.samples.flatMap(sample => Object.keys(sample)))], source: 'Owner submitted samples; CRM records are read only during explicit tests' },
    grant_proposal: { status: 'Proposal only; no execution authority issued', workflow_id: workflowId, version_id: workflow.published_version_id,
      rules: graph.steps.map(step => ({ step_id: step.id, type: step.type, connection_id: step.connection_id ?? null,
        fields: Object.keys(step.input ?? {}), ...(step.id === 'invoice' ? { recipient_field: 'payload.CustomerRef.value', recipients: [record.scope.customer_id], amount_field: 'amount_usd', max_usd: record.scope.amount_usd } : {}), max_per_minute: null })),
      expires_at: null, required_choices: ['Owner must choose expiry, per-tool rates and approval routing before separately issuing any execution grant'], promotion: 'Native human approval of this exact tested version only' },
    provenance: { generated_by: record.model, created_by: workflow.created_by, created_at: workflow.created_at, draft_id: state.row.id },
    disclosures: [
      { recipient: 'Configured model provider', purpose: 'Generate an editable proposal', fields: ['prompt', 'submitted samples', 'connector identifiers', 'invoice scope', 'native graph schema'], credentials: 'Configured AI credential; never included in proposal content', region: 'Provider controlled', retention: 'store:false requested; provider policy applies' },
      { recipient: record.scope.lead_url, purpose: 'Read the chosen CRM lead during explicit sandbox testing', fields: ['Mapped sample identifiers'], credentials: 'Stored CRM connection', region: 'Provider controlled', retention: 'Native draft and test retention policy' },
      { recipient: 'QuickBooks sandbox company ' + record.scope.realm_id, purpose: 'Create and read back the explicitly tested USD invoice', fields: ['Customer reference', 'Item reference', 'USD amount', 'CRM business key'], credentials: 'Stored QuickBooks connection', region: 'Provider controlled', retention: 'QuickBooks sandbox policy and native test retention' },
    ],
  }
}
export async function reviseAuthoring(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  exact(input, ['graph', 'samples', 'answers'], 'Revision')
  const state = await authoringState(env, workflowId), graph = scopedGraph(input.graph ?? state.graph, state.record.scope)
  const samples = input.samples === undefined ? state.record.samples : samplesOf(input.samples)
  const answers = input.answers ?? {}; exact(answers, state.record.questions.map(q => q.id), 'Answers')
  const questions = state.record.questions.map(q => answers[q.id] === undefined ? q : typeof answers[q.id] === 'string' && !(answers[q.id] as string).trim()
    ? { id: q.id, question: q.question } : { ...q, answer: text(answers[q.id], 'Answer', 2000) })
  const record = { ...state.record, samples, questions, tested: null }
  await saveAuthoring(env, actor, state, graph, record)
  return readAuthoring(env, actor, workflowId)
}
export async function testAuthoring(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  exact(input, ['bindings'], 'Authoring test')
  const state = await authoringState(env, workflowId), graph = scopedGraph(state.graph, state.record.scope)
  const bindings = input.bindings; exact(bindings, [state.record.scope.crm_connection_id, state.record.scope.quickbooks_connection_id], 'Test bindings')
  const runIds: string[] = []; let passed = true
  for (const sample of state.record.samples) {
    const run = await testWorkflow(env, actor, workflowId, { bindings, input: sample }, structuredClone(graph))
    runIds.push(run.id); passed = passed && run.status === 'succeeded'
  }
  const record = { ...state.record, tested: passed ? { digest: await authoringDigest(graph, state.record), run_ids: runIds } : null }
  await saveAuthoring(env, actor, state, graph, record)
  return { ...await readAuthoring(env, actor, workflowId), test_runs: runIds }
}
export async function promoteAuthoring(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  exact(input, ['digest', 'confirm'], 'Promotion')
  requireValue(input.confirm === true, 'Explicitly confirm human promotion', 422)
  await publishWorkflow(env, actor, workflowId, { authoring_digest: input.digest, authoring_confirm: true })
  return readAuthoring(env, actor, workflowId)
}
