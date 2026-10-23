import { guardedBatch, requireOwner } from '../access'
import { assertDispatchAuthority } from '../engine/authority'
import { StepError } from '../engine/errors'
import { resolve, type Scope } from '../engine/mapping'
import { runTransform } from '../engine/transforms'
import type { StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { body, canonical, CrankError, digest, id, json, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { PURE_SUBFLOW_FUNCTIONS, validateSubflowDefinition, validateSubflowValue } from './subflow-definition.mjs'

type Definition = { inputs: Record<string,string>; outputs: Record<string,string>; steps: {id:string;fn:string;input:Record<string,unknown>}[]; result: Record<string,unknown> }
type Version = { id:string; subflow_id:string; version:number; name:string; definition_json:string; definition_digest:string; active:number; created_by:string; created_at:string }
function checked(value: unknown) { try { validateSubflowDefinition(value) } catch (error) { throw new CrankError(422, (error as Error).message) } }
const present = ({definition_json,...version}: Version) => ({...version,definition:JSON.parse(definition_json)})
export async function readSubflow(env: CrankEnv, subflowId: string, version: number) {
  const row = await stmt(env, 'SELECT * FROM crank_subflow_versions WHERE subflow_id=? AND version=?', subflowId, version).first<Version>()
  requireValue(row, 'Subflow version not found', 404)
  return row
}
async function createVersion(env: CrankEnv, actor: Actor, input: Record<string,unknown>, subflowId: string = id()) {
  requireOwner(actor); checked(input.definition)
  const previous = await stmt(env, 'SELECT version,name FROM crank_subflow_versions WHERE subflow_id=? ORDER BY version DESC LIMIT 1', subflowId).first<{version:number;name:string}>()
  const version = (previous?.version ?? 0) + 1, key = subflowId + ':' + version, definition = canonical(input.definition), hash = await digest(definition)
  try {
    await guardedBatch(env, actor, 'owner', [
      stmt(env, 'INSERT INTO crank_subflow_versions(id,subflow_id,version,name,definition_json,definition_digest,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', key, subflowId, version, text(input.name ?? previous?.name, 'name', 100), definition, hash, actor.id, now()),
      auditStatement(env, actor.id, 'subflow.version', 'subflow', subflowId, {version,definition_digest:hash}),
    ])
  } catch (error) { if (/UNIQUE constraint/.test(String(error))) throw new CrankError(409, 'A version was created concurrently; read it before adding another'); throw error }
  return present(await readSubflow(env, subflowId, version))
}
/** Definitions confer no production authority; each caller pins a version and
 * still needs native owner publication. No provider/code/recursive capability is implied. */
export async function subflowApi(request: Request, env: CrankEnv, actor: Actor) {
  const path = new URL(request.url).pathname, root = '/api/crank/subflows'
  if (path !== root && !path.startsWith(root + '/')) return null
  requireOwner(actor)
  const m = /^\/api\/crank\/subflows\/([^/]+)\/versions(?:\/(\d+)(?:\/(review|revoke))?)?$/.exec(path)
  if (request.method === 'GET') {
    if (path === root) return json((await stmt(env, 'SELECT id,subflow_id,version,name,definition_digest,active,created_by,created_at FROM crank_subflow_versions ORDER BY subflow_id,version DESC').all()).results)
    requireValue(m && m[2] && !m[3], 'Subflow door not found', 404)
    return json(present(await readSubflow(env, decodeURIComponent(m[1]), Number(m[2]))))
  }
  requireValue(request.method === 'POST', 'Method not allowed', 405)
  const input = await body(request)
  if (path === root) return json(await createVersion(env, actor, input), 201)
  requireValue(m, 'Subflow door not found', 404)
  const subflowId = decodeURIComponent(m[1])
  if (!m[2]) { await readSubflow(env, subflowId, 1); return json(await createVersion(env, actor, input, subflowId), 201) }
  const row = await readSubflow(env, subflowId, Number(m[2]))
  requireValue(m[3], 'Subflow versions are immutable; add a new version', 405)
  if (m[3] === 'review') {
    requireValue(input.definition_digest === row.definition_digest && input.confirm === 'REVIEW_PURE_SUBFLOW', 'Review the exact definition digest and confirm REVIEW_PURE_SUBFLOW', 409)
    checked(JSON.parse(row.definition_json))
  }
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_subflow_versions SET active=? WHERE id=?', m[3] === 'review' ? 1 : 0, row.id),
    auditStatement(env, actor.id, 'subflow.' + m[3], 'subflow', subflowId, {version:row.version,definition_digest:row.definition_digest}),
  ])
  return json(present(await readSubflow(env, subflowId, row.version)))
}
/** Publication snapshots every referenced immutable version. Definition review
 * is eligibility only; it never publishes, resumes or changes a caller. */
export async function subflowPublication(env: CrankEnv, actor: Actor, graph: {steps: unknown[]}) {
  const refs: {subflow_id:string;version:number;definition_digest:string}[] = []
  const walk = async (steps: unknown) => {
    if (!Array.isArray(steps)) return
    for (const step of steps) if (isObject(step)) {
      if (step.type === 'subflow') {
        requireOwner(actor)
        const row = await readSubflow(env, String(step.subflow_id), Number(step.subflow_version))
        requireValue(row.active === 1, 'Review the pinned subflow version before publishing this caller', 409)
        refs.push({subflow_id:row.subflow_id,version:row.version,definition_digest:row.definition_digest})
      }
      await walk(step.steps)
      if (Array.isArray(step.branches)) for (const branch of step.branches) if (isObject(branch)) await walk(branch.steps)
      if (isObject(step.fallback)) await walk(step.fallback.steps)
      if (isObject(step.always)) await walk(step.always.steps)
    }
  }
  await walk(graph.steps)
  return refs
}
async function callable(ctx: StepContext, row: Version) {
  await assertDispatchAuthority(ctx.env, ctx.run.id)
  const live = await stmt(ctx.env, `SELECT 1 FROM crank_subflow_versions s JOIN crank_workflow_versions v ON v.id=? JOIN oa_operators o ON o.id=v.published_by
    WHERE s.id=? AND s.active=1 AND s.definition_digest=? AND o.role='owner' AND o.status='active'`, ctx.run.version_id, row.id, row.definition_digest).first()
  if (!live) throw new StepError('authority', 'The pinned pure subflow needs current owner review and native owner publication before use')
}
export const subflow: StepType = {
  mutating: false,
  validate(step) { if (typeof step.subflow_id !== 'string' || !step.subflow_id || !Number.isSafeInteger(step.subflow_version) || Number(step.subflow_version) < 1) throw new StepError('validation', 'Subflow calls pin subflow_id and a positive subflow_version') },
  async execute(step, ctx) {
    const row = await readSubflow(ctx.env, String(step.subflow_id), Number(step.subflow_version))
    await callable(ctx, row)
    if (await digest(row.definition_json) !== row.definition_digest) throw new StepError('validation', 'The subflow definition digest does not match')
    const definition = JSON.parse(row.definition_json) as Definition
    const scope: Scope = { trigger: { input: ctx.input }, steps: {}, run: {} }
    try {
      validateSubflowDefinition(definition); validateSubflowValue(definition.inputs, ctx.input, 'input')
      for (const operation of definition.steps) {
        await callable(ctx, row)
        const input = resolve(operation.input, scope)
        if (!isObject(input) || operation.fn === 'text.replace' && input.pattern === true) throw new Error('Subflow: only literal replacement is supported')
        if (!PURE_SUBFLOW_FUNCTIONS.includes(operation.fn)) throw new Error('Subflow: unsupported transformation')
        const output = runTransform(operation.fn, input)
        if (JSON.stringify(output).length > 65536) throw new Error('Subflow: intermediate output exceeds 64 KiB')
        scope.steps[operation.id] = output
      }
      const output = resolve(definition.result, scope)
      validateSubflowValue(definition.outputs, output, 'output')
      await callable(ctx, row)
      return { status: 'succeeded', output, trace: { subflow_id: row.subflow_id, version: row.version, definition_digest: row.definition_digest, operations: definition.steps.map(({id,fn})=>({id,fn})) } }
    } catch (error) { if (error instanceof StepError) throw error; throw new StepError('validation', (error as Error).message) }
  },
}
