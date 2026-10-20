import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { body, CrankError, id, json, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'

export async function teamApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank/team' && !path.startsWith('/api/crank/team/')) return null
  try {
    const actor = await authorize(request, env); requireOwner(actor)
    if (request.method === 'GET' && path === '/api/crank/team') {
      const rows = await stmt(env, 'SELECT operator_id,role,workflow_ids_json,connection_ids_json,revision,changed_by,changed_at FROM crank_team_access ORDER BY operator_id').all<any>()
      return json(rows.results.map(({workflow_ids_json,connection_ids_json,...row}) => ({...row,workflow_ids:JSON.parse(workflow_ids_json),connection_ids:JSON.parse(connection_ids_json)})))
    }
    requireValue(request.method === 'POST', 'Method not allowed', 405); requireWriteOrigin(request, env, actor)
    const input = await body(request)
    if (path === '/api/crank/team/transfer') {
      requireValue(typeof input.workflow_id === 'string' && typeof input.new_owner_id === 'string', 'Choose a workflow and its new owner')
      const person = await stmt(env, "SELECT id FROM oa_operators WHERE id=? AND status='active'", input.new_owner_id).first()
      requireValue(person, 'The new owner must be an active person', 422)
      requireValue(await stmt(env, 'SELECT id FROM crank_workflows WHERE id=?', input.workflow_id).first(), 'Workflow not found', 404)
      await guardedBatch(env, actor, 'owner', [
        stmt(env, "UPDATE crank_workflows SET owner_id=? WHERE id=? AND EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND status='active')", input.new_owner_id, input.workflow_id, input.new_owner_id),
        auditStatement(env, actor.id, 'workflow.transfer', 'workflow', input.workflow_id, {new_owner_id:input.new_owner_id}),
      ])
      return json({workflow_id:input.workflow_id,owner_id:input.new_owner_id})
    }
    const operatorId = decodeURIComponent(path.slice('/api/crank/team/'.length))
    const person = await stmt(env, "SELECT id,role FROM oa_operators WHERE id=? AND status='active'", operatorId).first<{id:string;role:string}>()
    requireValue(person && person.role !== 'owner', 'Choose an active non-owner person', 422)
    requireValue(['none','admin','builder','operator','approver','viewer'].includes(String(input.role)), 'Choose a product role', 422)
    const scope = async (value: unknown, table: string) => {
      requireValue(Array.isArray(value) && value.length <= 500 && value.every(v => typeof v === 'string'), 'Scope must be an array of record ids', 422)
      const values = [...new Set(value as string[])].sort()
      if (values.length) {
        const rows = await stmt(env, `SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(values)).all()
        requireValue(rows.results.length === values.length, 'Scope contains an unknown record', 422)
      }
      return values
    }
    const workflowIds = await scope(input.workflow_ids ?? [], 'crank_workflows'), connectionIds = await scope(input.connection_ids ?? [], 'crank_connections')
    const revision = id(), at = now()
    await guardedBatch(env, actor, 'owner', [
      stmt(env, `INSERT INTO crank_team_access(operator_id,role,workflow_ids_json,connection_ids_json,revision,changed_by,changed_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(operator_id) DO UPDATE SET role=excluded.role,workflow_ids_json=excluded.workflow_ids_json,connection_ids_json=excluded.connection_ids_json,revision=excluded.revision,changed_by=excluded.changed_by,changed_at=excluded.changed_at`, operatorId, input.role === 'none' ? 'viewer' : input.role, JSON.stringify(input.role === 'none' ? [] : workflowIds), JSON.stringify(input.role === 'none' ? [] : connectionIds), revision, actor.id, at),
      auditStatement(env, actor.id, 'team.scope', 'operator', operatorId, {role:input.role,workflow_ids:workflowIds,connection_ids:connectionIds,revision}),
    ])
    return json({operator_id:operatorId,role:input.role,workflow_ids:workflowIds,connection_ids:connectionIds,revision})
  } catch (error) {
    if (error instanceof CrankError) return json({error:error.message},error.status)
    const status = (error as {status?:number}).status
    return json({error:'Team operation could not be confirmed'}, status && status >= 400 && status < 500 ? status : 503)
  }
}
