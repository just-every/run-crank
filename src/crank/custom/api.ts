import { proposeEnterpriseRecipe } from './enterprise-recipes'
import { authorize, guardedBatch, requireOwner, requirePrepare, requireWriteOrigin } from '../access'
import { executeRun } from '../engine/executor'
import { StepError } from '../engine/errors'
import { checkEgress } from '../engine/egress'
import { body, canonical, CrankError, digest, json, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { parseDefinition } from './definition'
import { enroll, enrollment, gatewayActor, grantGateway, listGateways, revokeGateway } from './gateways'
import { gatewayResult, pollGateway, wakeGatewayTask } from './gateway-tasks'
import { proposeOpenApi } from './openapi'
import { loadPicker, readPicker, selectPicker } from './pickers'
import { acceptSandbox } from './sandbox'
import { customVersion, installCustom, listCustom, presentCustom, revokeCustom, reviewCustom, revokeCustomScopes } from './store'

export async function customApi(request:Request,env:CrankEnv):Promise<Response|null> {
  const path=new URL(request.url).pathname
  if(!/^\/api\/crank\/(custom-connectors|gateways)(\/|$)/.test(path))return null
  try {
    if(request.method==='POST' && path==='/api/crank/gateways/enroll')return json(await enroll(env,await body(request,4096)),201)
    const service=/^\/api\/crank\/gateways\/([^/]+)\/(poll|tasks\/([^/]+)\/result)$/.exec(path)
    if(service) {
      requireValue(request.method==='POST','Method not allowed',405)
      const input=await body(request,96*1024),gateway=await gatewayActor(request,env,decodeURIComponent(service[1]),input)
      if(service[2]==='poll')return json(await pollGateway(env,gateway))
      const taskId=decodeURIComponent(service[3]),result=await gatewayResult(env,gateway,taskId,input)
      const runId=await wakeGatewayTask(env,gateway.id,taskId)
      if(runId)await executeRun(env,runId)
      return json(result)
    }
    const actor=await authorize(request,env)
    if(request.method==='POST')requireWriteOrigin(request,env,actor)
    if(request.method==='POST' && path==='/api/crank/custom-connectors/propose') {
      requirePrepare(actor)
      const input=await body(request,512*1024),definition=input.recipe!==undefined?proposeEnterpriseRecipe(input):input.openapi===undefined?parseDefinition(input.definition):proposeOpenApi(input.openapi)
      for(const op of definition.operations) if(!op.gateway && op.kind!=='trigger') {
        // A path parameter cannot control the scheme or recipient host.
        const url=checkEgress(op.path.replace(/\{[^}]+\}/g,'sample'))
        requireValue(!op.path.slice(0,op.path.indexOf('/',8)).includes('{') && url.protocol==='https:','Custom public operations require a literal HTTPS recipient')
      }
      await guardedBatch(env,actor,'prepare',[auditStatement(env,actor.id,'custom.propose','custom_connector',definition.id,{version:definition.version,operations:definition.operations.map(op=>op.id)})])
      return json({definition,digest:await digest(canonical(definition)),requires_owner_review:true,runtime:'Read-only actions/searches and signed webhook delivery; unsupported operations are refused'})
    }
    try {requireOwner(actor)} catch(error) {
      await auditStatement(env,actor.id,'custom.owner_denied','workspace','custom_connectors',{session_kind:actor.kind,role:actor.role}).run()
      throw error
    }
    if(request.method==='GET') {
      const picker=/^\/api\/crank\/custom-connectors\/pickers\/([^/]+)$/.exec(path)
      if(picker) {
        const query=new URL(request.url).searchParams
        requireValue([...query.keys()].every(key=>query.getAll(key).length===1),'Picker query fields must be unique',422)
        return json(await readPicker(env,actor,decodeURIComponent(picker[1]),Object.fromEntries(query)))
      }
      if(path==='/api/crank/custom-connectors')return json(await listCustom(env))
      if(path==='/api/crank/gateways')return json(await listGateways(env))
      const version=/^\/api\/crank\/custom-connectors\/([^/]+)\/versions\/(\d+)$/.exec(path)
      if(version)return json(presentCustom(await customVersion(env,decodeURIComponent(version[1]),Number(version[2]))))
      return json({error:'Route not found'},404)
    }
    requireValue(request.method==='POST','Method not allowed',405)
    const input=await body(request,512*1024)
    if(path==='/api/crank/custom-connectors/pickers')return json(await loadPicker(env,actor,input))
    if(path==='/api/crank/custom-connectors/selection')return json(await selectPicker(env,actor,input))
    if(path==='/api/crank/custom-connectors')return json(await installCustom(env,actor,input),201)
    if(path==='/api/crank/gateways')return json(await enrollment(env,actor,input),201)
    const gateway=/^\/api\/crank\/gateways\/([^/]+)\/(grants|revoke)$/.exec(path)
    if(gateway)return json(gateway[2]==='grants'?await grantGateway(env,actor,decodeURIComponent(gateway[1]),input):await revokeGateway(env,actor,decodeURIComponent(gateway[1])),gateway[2]==='grants'?201:200)
    const grant=/^\/api\/crank\/gateways\/grants\/([^/]+)\/revoke$/.exec(path)
    if(grant) {
      const grantId=decodeURIComponent(grant[1]);requireValue(await stmt(env,'SELECT id FROM crank_gateway_grants WHERE id=?',grantId).first(),'Grant not found',404)
      await guardedBatch(env,actor,'owner',[stmt(env,"UPDATE crank_gateway_grants SET status='revoked',revoked_at=COALESCE(revoked_at,datetime('now')) WHERE id=?",grantId),auditStatement(env,actor.id,'gateway.grant_revoke','gateway_grant',grantId)])
      return json({id:grantId,status:'revoked'})
    }
    const action=/^\/api\/crank\/custom-connectors\/([^/]+)\/versions\/(\d+)\/(sandbox|revoke-scopes|revoke|review)$/.exec(path)
    if(action && action[3]==='review')return json(await reviewCustom(env,actor,decodeURIComponent(action[1]),Number(action[2]),input))
    if(action && action[3]==='revoke')return json(await revokeCustom(env,actor,decodeURIComponent(action[1]),Number(action[2])))
    if(action)return json(action[3]==='sandbox'?await acceptSandbox(env,actor,decodeURIComponent(action[1]),Number(action[2]),input):await revokeCustomScopes(env,actor,decodeURIComponent(action[1]),Number(action[2]),input))
    return json({error:'Route not found'},404)
  } catch(error) {
    if(error instanceof CrankError)return json({error:error.message},error.status)
    if(error instanceof StepError)return json({error:error.message,category:error.category},422)
    const status=(error as {status?:number}).status
    return json({error:status && status<500?'Authentication or request was refused':'Custom connector operation could not be confirmed'},status && status>=400 && status<500?status:503)
  }
}
