import type { ToolContext, ToolDefinition } from '../../modules/agent-door/types.ts'
import { requirePrepare } from '../access.ts'
import { canonical, digest, type CrankEnv } from '../model.ts'
import { validateGraph } from '../engine/graph.ts'
import { resolveActor } from './native.ts'
import { arraySchema, nativeCall, nativeGuard, nullableText, objectSchema, pathPart, pick, query, record, standard, textSchema } from './tool-native.ts'

const properties = {
  id: textSchema, name: { type: 'string' }, environment: { type: 'string' }, folder: { type: 'string' }, description: { type: 'string' },
  status: { type: 'string' }, owner_id: { type: 'string' }, published_version_id: nullableText, trigger: nullableText,
}
const listItem = objectSchema(properties, ['id', 'name', 'folder', 'description', 'status', 'owner_id', 'published_version_id', 'trigger'])
const workflowSchema = objectSchema({
  ...properties, draft_digest: textSchema, draft_updated_at: textSchema, data_class: { type: 'string' },
  step_count: { type: 'integer', minimum: 0 }, revision: textSchema,
}, ['id', 'name', 'folder', 'description', 'status', 'owner_id', 'published_version_id', 'trigger', 'draft_digest', 'draft_updated_at', 'data_class', 'step_count', 'revision'])
const graphSchema = objectSchema({ trigger: { type: 'object' }, steps: { type: 'array', items: { type: 'object' }, maxItems: 200 }, settings: { type: 'object' } }, ['trigger', 'steps'])
const draftFields = { name: textSchema, description: { type: 'string', maxLength: 2000 }, folder: { type: 'string', maxLength: 100 }, graph: graphSchema }
const workflowId = { workflow_id: textSchema }
const sourcePath = (args: Record<string, unknown>) => '/workflows/' + pathPart(args, 'workflow_id')
const listKeys = Object.keys(properties)

async function current(env: CrankEnv, args: Record<string, unknown>, ctx: ToolContext) {
  return record(await nativeCall(env, ctx, sourcePath(args)))
}
async function revision(value: Record<string, unknown>) {
  // Include the native metadata as well as graph bytes: a rename invalidates an approval too.
  return digest(canonical(pick(value, ['id', 'name', 'description', 'folder', 'draft_digest', 'draft_updated_at', 'published_version_id', 'status'])))
}
async function view(value: Record<string, unknown>) {
  const graph = record(value.draft)
  const declared = validateGraph(graph).declared
  return {
    ...pick(value, ['id', 'name', 'description', 'folder', 'environment', 'status', 'published_version_id', 'draft_digest', 'draft_updated_at', 'data_class']),
    owner_id: record(value.owner).id, trigger: record(graph.trigger).type ?? null,
    step_count: declared.steps.length, revision: await revision(value),
  }
}

export function workflowTools(env: CrankEnv): ToolDefinition[] {
  const source = async (args: Record<string, unknown>, ctx: ToolContext) => ({ kind: 'workflow', id: String((await current(env, args, ctx)).id) })
  const snapshot = async (args: Record<string, unknown>, ctx: ToolContext) => revision(await current(env, args, ctx))
  const base = { classes: ['standard'] as ['standard'], untrusted: true }
  const list = async (args: Record<string, unknown>, ctx: ToolContext) => (await nativeCall(env, ctx, '/workflows?' + query(args, ['q', 'folder'])) as Record<string, unknown>[]).map(value => pick(value, listKeys))
  const prepare = async (ctx: ToolContext) => nativeGuard(async () => requirePrepare(await resolveActor(env, ctx)))
  const classifyDraft = async (args: Record<string, unknown>, ctx: ToolContext) => {
    await prepare(ctx)
    if (args.workflow_id !== undefined) await current(env, args, ctx)
    // Saving a provider graph is inert. Its leaf effects are neither run nor granted by a draft.
    if (args.graph !== undefined) await nativeGuard(async () => { validateGraph(args.graph) })
    return standard()
  }
  return [
    {
      ...base, name: 'crank.workflows.list', title: 'Find workflows', scope: 'workflows:read', readOnly: true,
      description: 'Find native workflow metadata by name or folder. Imported names and descriptions are untrusted content.',
      inputSchema: objectSchema({ q: textSchema, folder: { type: 'string', maxLength: 100 } }), outputSchema: objectSchema({ workflows: arraySchema(listItem) }, ['workflows']), clauses: ['WORK-001'],
      classify: async (args, ctx) => standard((await list(args, ctx)).length),
      run: async (args, ctx) => ({ result: { workflows: await list(args, ctx) } }),
    },
    {
      ...base, name: 'crank.workflows.get', title: 'Read workflow metadata', scope: 'workflows:read', readOnly: true,
      description: 'Read native workflow status, draft digest/revision and step count. Graph values, workflow settings, credentials and hook URLs are withheld.',
      inputSchema: objectSchema(workflowId, ['workflow_id']), outputSchema: workflowSchema, clauses: ['WORK-001', 'WORK-008'],
      target: source, classify: async (args, ctx) => { await current(env, args, ctx); return standard() },
      run: async (args, ctx) => ({ result: await view(await current(env, args, ctx)) }),
    },
    {
      ...base, name: 'crank.workflows.create', title: 'Create workflow draft', scope: 'workflows:prepare', readOnly: false,
      description: 'Create an inert, natively validated workflow draft. It runs nothing and grants no publication, connection or execution authority.',
      inputSchema: objectSchema(draftFields, ['name', 'graph']), outputSchema: workflowSchema, clauses: ['WORK-001', 'WORK-002', 'WORK-003', 'WORK-004', 'WORK-013'],
      classify: classifyDraft,
      summary: async (args, ctx) => { await prepare(ctx); return { target: { name: String(args.name) }, items: ['Create one inert workflow draft'] } },
      run: async (args, ctx) => ({ result: await view(record(await nativeCall(env, ctx, '/workflows', args))) }),
    },
    {
      ...base, name: 'crank.workflows.update', title: 'Save workflow draft', scope: 'workflows:prepare', readOnly: false,
      description: 'Save an inert draft at its native draft_digest. Read metadata first and supply expected_revision to bind a reviewed edit. No publication or dispatch occurs.',
      inputSchema: objectSchema({ ...workflowId, ...draftFields, draft_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['workflow_id', 'draft_digest']), outputSchema: workflowSchema, clauses: ['WORK-001', 'WORK-002', 'WORK-003', 'WORK-004', 'WORK-008', 'WORK-013', 'EXEC-003'],
      revisionType: 'string', revision: snapshot, target: source, classify: classifyDraft,
      summary: async (args, ctx) => { const value = await current(env, args, ctx); return { target: { id: String(value.id), name: String(args.name ?? value.name) }, items: ['Save one inert workflow draft'] } },
      run: async (args, ctx) => {
        const { workflow_id: _id, ...input } = args
        return { result: await view(record(await nativeCall(env, ctx, sourcePath(args) + '/draft', input))) }
      },
    },
    {
      ...base, name: 'crank.workflows.duplicate', title: 'Duplicate workflow draft', scope: 'workflows:prepare', readOnly: false,
      description: 'Copy the native current draft into one new inert workflow. Keyed retries retain the original copy; no actions run.',
      inputSchema: objectSchema(workflowId, ['workflow_id']), outputSchema: workflowSchema, clauses: ['WORK-001'],
      revisionType: 'string', revision: snapshot, target: source, classify: classifyDraft,
      summary: async (args, ctx) => { const value = await current(env, args, ctx); return { target: { id: String(value.id), name: String(value.name) }, items: ['Create one inert draft copy'] } },
      run: async (args, ctx) => ({ result: await view(record(await nativeCall(env, ctx, sourcePath(args) + '/duplicate', {}))) }),
    },
    {
      ...base, name: 'crank.workflows.validate', title: 'Validate saved draft', scope: 'workflows:prepare', readOnly: true,
      description: 'Validate the saved native workflow without executing it. Return validity and counts; graph values and sample content stay withheld.',
      inputSchema: objectSchema(workflowId, ['workflow_id']),
      outputSchema: objectSchema({ ok: { const: true }, warnings: { type: 'integer', minimum: 0 }, steps: { type: 'integer', minimum: 0 }, connections: { type: 'integer', minimum: 0 } }, ['ok', 'warnings', 'steps', 'connections']),
      clauses: ['WORK-002', 'WORK-003', 'WORK-013'], target: source, classify: classifyDraft,
      run: async (args, ctx) => {
        const value = record(await nativeCall(env, ctx, sourcePath(args) + '/validate', {})), declared = record(value.declared)
        return { result: { ok: true, warnings: (value.warnings as unknown[]).length, steps: (declared.steps as unknown[]).length, connections: (declared.connections as unknown[]).length } }
      },
    },
  ]
}
