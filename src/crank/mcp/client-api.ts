import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { grantFence } from '../grants/authority'
import { grantLeaves } from '../grants/policy'
import { startTask } from '../grants/tasks'
import { body, CrankError, id, json, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { authorizeClient, createClient, readClients, revokeClient } from './clients'
import { toolInput } from './client-tools'
import { refusedCall } from './call-history'

const protocol = '2025-06-18'
const rpcError = (id: unknown, message: string, status = 400, code = -32000, data?: Record<string,unknown>) => json({jsonrpc:'2.0',id:id ?? null,error:{code,message,...(data?{data}:{})}},status)

export async function clientApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname, remote = /^\/api\/crank\/v1\/mcp\/([^/]+)$/.exec(path)
  if (remote) return clientMcp(request,env,decodeURIComponent(remote[1]))
  if (path !== '/api/crank/mcp-clients' && !/^\/api\/crank\/mcp-clients\/[^/]+\/(revoke|calls)$/.test(path)) return null
  try {
    const actor = await authorize(request,env); requireOwner(actor)
    if (request.method === 'GET') {
      if (path.endsWith('/calls')) {
        const client = path.split('/')[4]
        requireValue(await stmt(env,'SELECT id FROM crank_mcp_clients WHERE id=? AND owner_id=?',client,actor.id).first(),'Client not found',404)
        return json((await stmt(env,"SELECT c.id,c.tool,c.run_id,CASE WHEN c.status='refused' THEN c.status ELSE COALESCE(r.status,c.status) END AS status,c.reason,c.created_at FROM crank_mcp_calls c LEFT JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.client_id=? ORDER BY c.created_at DESC,c.id LIMIT 100",client).all()).results)
      }
      return json(await readClients(env,actor))
    }
    requireValue(request.method === 'POST','Use GET or POST',405); requireWriteOrigin(request,env,actor)
    const input = await body(request,128*1024)
    return path.endsWith('/revoke') ? json(await revokeClient(env,actor,path.split('/')[4])) : json(await createClient(env,actor,input),201)
  } catch (error) { return json({error:error instanceof CrankError ? error.message : 'Client operation could not be confirmed'},error instanceof CrankError ? error.status : 422) }
}

/** Stateless Streamable HTTP, restricted to one client and one immutable publication. */
async function clientMcp(request: Request, env: CrankEnv, clientId: string): Promise<Response> {
  let rpcId: unknown = null
  try {
    const {row,actor,tools,policy} = await authorizeClient(request,env,clientId)
    requireWriteOrigin(request,env,actor)
    if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST','cache-control':'no-store'}})
    const accept = request.headers.get('accept') ?? ''
    requireValue(accept.includes('application'+'/'+'json') && accept.includes('text'+'/'+'event-stream'),'Accept must include JSON and event stream media types',406)
    const version = request.headers.get('mcp-protocol-version')
    requireValue(!version || version === protocol,'Unsupported MCP protocol version')
    const input = await body(request,128*1024); rpcId = input.id
    requireValue(input.jsonrpc === '2.0' && typeof input.method === 'string' && (rpcId === undefined || typeof rpcId === 'number' || typeof rpcId === 'string'),'Invalid JSON-RPC request')
    if (rpcId === undefined) {
      requireValue(['notifications'+'/'+'initialized','notifications'+'/'+'cancelled'].includes(input.method),'Unsupported notification')
      return new Response(null,{status:202,headers:{'cache-control':'no-store'}})
    }
    const result = (value: unknown) => json({jsonrpc:'2.0',id:rpcId,result:value})
    if (input.method === 'initialize') return result({protocolVersion:protocol,capabilities:{tools:{listChanged:false}},serverInfo:{name:'crank-client',version:'1.0.0'},instructions:'Only the listed tools and exact client grant are enabled. Approval-required calls wait in Crank. Revocation stops further dispatch.'})
    if (input.method === 'ping') return result({})
    if (input.method === 'tools'+'/'+'list') return result({tools:tools.map(({name,description,inputSchema})=>({name,description,inputSchema}))})
    if (input.method !== 'tools'+'/'+'call') return rpcError(rpcId,'Method not found',200,-32601)
    const params = input.params as {name?: unknown;arguments?: unknown} | undefined
    const name = typeof params?.name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(params.name) ? params.name : 'invalid_tool'
    const callId = id(), tool = tools.find(t=>t.name===name), at = now()
    const refuse = async (reason: string, status: number) => {
      const runId = await refusedCall(env,actor,{id:callId,clientId,tool:name,workflowId:row.workflow_id,versionId:row.version_id,at,arguments:params?.arguments??{},reason,status})
      return rpcError(rpcId,reason,status,-32000,{run_id:runId})
    }
    if (!tool) return refuse('Tool is not enabled for this client',403)
    const source = await stmt(env,'SELECT graph_json FROM crank_workflow_versions WHERE id=?',row.version_id).first<{graph_json:string}>()
    requireValue(source,'The tool publication is unavailable',409)
    const leaves = grantLeaves(JSON.parse(source.graph_json)), template = leaves.find(s=>s.id===tool.step_id), rule = policy.rules.find(r=>r.step_id===tool.step_id)
    requireValue(template && rule,'The enabled tool no longer matches its grant',403)
    let values: Record<string,unknown>
    try { values = toolInput(tool,params?.arguments ?? {},template.input,rule) }
    catch (error) { return refuse(error instanceof CrankError ? error.message : 'Tool parameters were refused',error instanceof CrankError ? error.status : 422) }
    const fence = grantFence(env,row.grant_id,row.workflow_id,row.version_id)
    const aliases = tools.filter(t=>t.step_id===tool.step_id).map(t=>t.name)
    const admitted = await guardedBatch(env,actor,'read',[
      stmt(env,`INSERT INTO crank_mcp_calls(id,client_id,tool,status,created_at)
        SELECT ?,?,?,'admitted',? WHERE ${fence.sql} AND EXISTS(SELECT 1 FROM crank_mcp_clients WHERE id=? AND revoked_at IS NULL)
        AND (SELECT COUNT(*) FROM crank_mcp_calls WHERE client_id=? AND tool IN (${aliases.map(()=>'?').join(',')}) AND status!='refused' AND created_at>?)<?`,callId,clientId,name,at,...fence.args,clientId,clientId,...aliases,new Date(Date.now()-60000).toISOString(),rule.max_per_minute),
    ])
    if (admitted[0].meta.changes !== 1) return refuse('Rate exceeds the client grant',429)
    const approval = tool.approval_step_id ? leaves.find(s=>s.id===tool.approval_step_id) : undefined
    const actions = [...(approval ? [{step_id:approval.id,input:{...approval.input as Record<string,unknown>,proposal:values}}] : []),{step_id:tool.step_id,input:values}]
    try {
      const run = await startTask(env,actor,{task_id:`mcp:${clientId}:${name}`,actions},request.headers.get('idempotency-key'))
      await env.DB.batch([
        stmt(env,'UPDATE crank_mcp_calls SET run_id=?,status=? WHERE id=?',run.id,run.status,callId),
        auditStatement(env,actor.id,'mcp.call','run',run.id,{client_id:clientId,call_id:callId,tool:name},run.version_id),
      ])
      return result({content:[{type:'text',text:JSON.stringify(run)}],structuredContent:{client_id:clientId,tool:name,run},isError:['failed','uncertain','rejected'].includes(run.status)})
    } catch (error) {
      await env.DB.batch([stmt(env,"UPDATE crank_mcp_calls SET status='unconfirmed',reason='Inspect current run history before retrying' WHERE id=?",callId),auditStatement(env,actor.id,'mcp.call.unconfirmed','mcp_client',clientId,{call_id:callId,tool:name},row.version_id)])
      throw error
    }
  } catch (error) {
    return rpcError(rpcId,error instanceof CrankError ? error.message : 'The call could not be confirmed; inspect current run history before retrying',error instanceof CrankError ? error.status : 503)
  }
}
