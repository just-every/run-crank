import type { ToolContext, ToolDefinition } from '../../modules/agent-door/types.ts'
import { requirePrepare } from '../access.ts'
import type { CrankEnv } from '../model.ts'
import { resolveActor } from './native.ts'
import { arraySchema, nativeCall, nativeGuard, nullableText, objectSchema, pathPart, pick, query, record, standard, strings, textSchema } from './tool-native.ts'

const runKeys = ['id', 'mode', 'workflow_id', 'version_id', 'trigger_kind', 'business_outcome', 'status', 'source_time', 'payload_expired_at', 'received_at', 'started_at', 'finished_at', 'latency_ms']
const runProperties = Object.fromEntries(runKeys.map(key => [key, key === 'latency_ms' ? { type: ['number', 'null'] } : nullableText]))
const runSchema = objectSchema(runProperties, ['id', 'workflow_id', 'version_id', 'status', 'business_outcome'])
const connectionKeys = ['id', 'app', 'environment', 'purpose', 'label', 'auth_kind', 'account_name', 'domains', 'scopes', 'status', 'expires_at', 'renewed_at', 'previous_expires_at', 'created_by', 'created_at', 'rotated_at', 'revoked_at', 'consented_at']
const connectionSchema = objectSchema(Object.fromEntries(connectionKeys.map(key => [key, ['domains', 'scopes'].includes(key) ? strings : nullableText])), ['id', 'app', 'label', 'auth_kind', 'status', 'domains', 'scopes'])
const operationSchema = objectSchema({ id: textSchema, name: { type: 'string' }, step: { type: 'string' }, trigger: { type: 'string' } }, ['id', 'name'])
const catalogSchema = objectSchema({ app: textSchema, name: { type: 'string' }, clauses: strings, actions: arraySchema(operationSchema), searches: arraySchema(operationSchema), triggers: arraySchema(operationSchema), restrictions: strings }, ['app', 'name', 'clauses', 'actions', 'searches', 'triggers'])
const inventoryItem = objectSchema({ app: textSchema, operation: textSchema, public_api: { enum: ['openapi', 'rest', 'partner', 'none'] } }, ['app', 'operation'])
const coverageItem = objectSchema({ app: { type: 'string' }, operation: { type: 'string' }, public_api: { type: 'string' }, source: { type: 'string' }, status: { enum: ['native', 'agent-buildable', 'blocked'] }, clause: { type: 'string' }, reason: { type: 'string' }, operation_id: { type: 'string' } }, ['app', 'operation', 'status'])

export function metadataTools(env: CrankEnv): ToolDefinition[] {
  const base = { classes: ['standard'] as ['standard'], untrusted: true }
  const listRuns = async (args: Record<string, unknown>, ctx: ToolContext) => {
    const result = record(await nativeCall(env, ctx, '/workflow-runs?' + query(args, ['workflow', 'status', 'before', 'limit', 'from', 'to'])))
    return { runs: (result.runs as Record<string, unknown>[]).map(run => pick(run, runKeys)), next: result.next }
  }
  const runDetail = async (args: Record<string, unknown>, ctx: ToolContext) => record(await nativeCall(env, ctx, '/workflow-runs/' + pathPart(args, 'run_id')))
  const connections = async (ctx: ToolContext) => (await nativeCall(env, ctx, '/connections') as Record<string, unknown>[]).map(value => pick(value, connectionKeys))
  const catalog = async (ctx: ToolContext) => {
    const value = record(await nativeCall(env, ctx, '/catalog'))
    return (value.apps as Record<string, unknown>[]).map(app => ({
      ...pick(app, ['app', 'name', 'clauses', 'restrictions']),
      ...Object.fromEntries(['actions', 'searches', 'triggers'].map(key => [key, (app[key] as Record<string, unknown>[]).map(operation => pick(operation, ['id', 'name', 'step', 'trigger']))])),
    }))
  }
  return [
    {
      ...base, name: 'crank.runs.list', title: 'List run metadata', scope: 'runs:read', readOnly: true,
      description: 'Read native run status, timing and version identities with native visibility and pagination. Payloads, business keys, source IDs and error text are withheld.',
      clauses: ['EXEC-005'], inputSchema: objectSchema({ workflow: textSchema, status: textSchema, before: textSchema, limit: { type: 'integer', minimum: 1, maximum: 100 }, from: textSchema, to: textSchema }),
      outputSchema: objectSchema({ runs: arraySchema(runSchema), next: nullableText }, ['runs', 'next']),
      classify: async (args, ctx) => standard((await listRuns(args, ctx)).runs.length),
      run: async (args, ctx) => ({ result: await listRuns(args, ctx) }),
    },
    {
      ...base, name: 'crank.runs.get', title: 'Read run metadata', scope: 'runs:read', readOnly: true,
      description: 'Read a native run’s status, timing and counts of steps/waits/attempts. No payload, result text, provider request, bearer URL or task-execution authority is returned.',
      clauses: ['EXEC-005'], inputSchema: objectSchema({ run_id: textSchema }, ['run_id']),
      outputSchema: objectSchema({ ...runProperties, step_count: { type: 'integer', minimum: 0 }, wait_count: { type: 'integer', minimum: 0 }, attempt_count: { type: 'integer', minimum: 0 } }, ['id', 'workflow_id', 'version_id', 'status', 'business_outcome', 'step_count', 'wait_count', 'attempt_count']),
      target: async (args, ctx) => ({ kind: 'run', id: String((await runDetail(args, ctx)).id) }),
      classify: async (args, ctx) => { await runDetail(args, ctx); return standard() },
      run: async (args, ctx) => { const value = await runDetail(args, ctx); return { result: { ...pick(value, runKeys), step_count: (value.steps as unknown[]).length, wait_count: (value.waits as unknown[]).length, attempt_count: (value.attempts as unknown[]).length } } },
    },
    {
      ...base, name: 'crank.connections.list', title: 'List connection metadata', scope: 'connections:read', readOnly: true,
      description: 'Read credential-free native connection metadata within current native scope. Secrets, connection tokens, encrypted material and provider calls are excluded.',
      clauses: ['CONN-002'], inputSchema: objectSchema(), outputSchema: objectSchema({ connections: arraySchema(connectionSchema) }, ['connections']),
      classify: async (_args, ctx) => standard((await connections(ctx)).length),
      run: async (_args, ctx) => ({ result: { connections: await connections(ctx) } }),
    },
    {
      ...base, name: 'crank.catalog.list', title: 'Read native connector catalogue', scope: 'catalog:read', readOnly: true,
      description: 'List the operations built into this installation and their native restrictions. Catalogue presence does not grant dispatch authority or implement planned connectors.',
      clauses: ['CONN-001'], inputSchema: objectSchema(), outputSchema: objectSchema({ apps: arraySchema(catalogSchema) }, ['apps']),
      classify: async (_args, ctx) => standard((await catalog(ctx)).length),
      run: async (_args, ctx) => ({ result: { apps: await catalog(ctx) } }),
    },
    {
      ...base, name: 'crank.coverage.report', title: 'Assess connector coverage', scope: 'catalog:read', readOnly: true,
      description: 'Compare a typed app/operation inventory with the native catalogue. This is local metadata analysis; it fetches no API schema and performs no provider action.',
      clauses: ['CONN-001', 'CONN-011'], inputSchema: objectSchema({ items: { type: 'array', items: inventoryItem, minItems: 1, maxItems: 500 } }, ['items']),
      outputSchema: objectSchema({ summary: objectSchema({ native: { type: 'integer', minimum: 0 }, 'agent-buildable': { type: 'integer', minimum: 0 }, blocked: { type: 'integer', minimum: 0 } }, ['native', 'agent-buildable', 'blocked']), items: arraySchema(coverageItem) }, ['summary', 'items']),
      classify: async (args, ctx) => { await resolveActor(env, ctx); return standard((args.items as unknown[]).length) },
      run: async (args, ctx) => ({ result: await nativeCall(env, ctx, '/coverage', args) }),
    },
    {
      ...base, name: 'crank.custom.propose', title: 'Propose a custom connector', scope: 'workflows:prepare', readOnly: false,
      description: 'Convert a supplied public OpenAPI document into a native inert connector proposal. Imported declarations are untrusted; this grants no scopes, credentials, installation or execution authority.',
      clauses: ['CONN-011', 'CONN-020'], inputSchema: objectSchema({ openapi: { type: 'object' } }, ['openapi']),
      outputSchema: objectSchema({ definition: { type: 'object', required: ['id', 'name', 'version', 'auth', 'operations', 'disclosure'] }, digest: textSchema, requires_owner_review: { const: true }, runtime: { type: 'string' } }, ['definition', 'digest', 'requires_owner_review', 'runtime']),
      classify: async (_args, ctx) => { await nativeGuard(async () => requirePrepare(await resolveActor(env, ctx))); return standard() },
      summary: async (_args, ctx) => { await resolveActor(env, ctx); return { items: ['Prepare one uninstalled connector proposal; no provider request'] } },
      run: async (args, ctx) => ({ result: await nativeCall(env, ctx, '/custom-connectors/propose', args) }),
    },
  ]
}
