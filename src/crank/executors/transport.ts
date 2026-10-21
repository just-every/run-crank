import { retryRequest } from '../connectors/retry'
import { sendRequest } from '../connectors/request-transport'
import { checkEgress, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepContext } from '../engine/types'
import { isObject } from '../engine/values'

/** Every job request uses connection custody, account admission and the existing
 * bounded retry policy. Poll responses are fresh, never continuation snapshots. */
export async function executorRequest(ctx: StepContext, connectionId: string, url: string, method: string, value?: unknown) {
  const body = value === undefined ? null : new TextEncoder().encode(JSON.stringify(value))
  const prepared = {url:checkEgress(url),method,headers:new Headers({'content-type':'application/json'}),body,timeout:15000,maxBytes:1024*1024,follow:0}
  const result = await retryRequest(ctx,{...prepared,idempotent:false,checkpoint:false}, policy=>sendRequest(ctx,prepared,connectionId,policy))
  if (![200,202,404].includes(result.response.status)) throw new StepError(result.response.status===401 || result.response.status===403 ? 'auth' : 'provider',`Executor request failed with status ${result.response.status}`,{status:result.response.status})
  let payload: unknown
  try { payload = JSON.parse(utf8(result.response.bytes)) } catch { throw new StepError('provider','Executor returned an invalid response') }
  if (!isObject(payload)) throw new StepError('provider','Executor returned an invalid response')
  return {status:result.response.status,value:payload}
}
