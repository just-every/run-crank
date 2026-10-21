import { retryRequest } from '../connectors/retry'
import { retryExhausted } from '../connectors/retry-policy'
import type { StepContext } from '../engine/types'
import { canonical } from '../model'
import type { CustomOperation } from './definition'
import { gatewayAttempt } from './gateway-tasks'

/** Gateway waits release their execution slot. Every physical read attempt gets
 * its own signed job, retaining the same page/input and ordinary retry budget. */
export async function gatewayPage(ctx:StepContext,step:Record<string,unknown>,op:CustomOperation,input:Record<string,unknown>,ordinal:number) {
  const url=new URL(`/api/crank/gateways/${encodeURIComponent(String(step.gateway_id))}/operations/${encodeURIComponent(op.id)}/pages/${ordinal}`,ctx.env.AUTH_ORIGIN)
  const body=new TextEncoder().encode(canonical({connector_id:step.connector_id,connector_version:step.connector_version,environment:step.environment,input}))
  const result=await retryRequest(ctx,{method:op.method,url,body,idempotent:false,deferred:true},async policy=>{
    const output=await gatewayAttempt(ctx,step,op,input,ordinal,policy)
    return {status:200,headers:new Headers({'content-type':'application/json'}),bytes:new TextEncoder().encode(canonical(output)),url:url.href,redirects:0}
  })
  if(result.exhausted)throw retryExhausted('provider','the private read repeatedly failed')
  return JSON.parse(new TextDecoder().decode(result.response.bytes)) as unknown
}
