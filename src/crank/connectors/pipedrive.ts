import { connectionDomains, credential } from '../connections/store'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const invalid = (message: string): never => { throw new StepError('validation', `Pipedrive deal search: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Pipedrive deal search returned malformed ${message}`) }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
const allowed = new Set(['id','type','name','connection_id','subdomain','filter_id','input','no_match','multi_match','on_multiple','limit','sort','max_pages','timeout_ms','retry_policy','on_error','cap','category','amount','recipients'])
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return invalid('title must be nonempty text of at most 2048 characters')
  return value
}
function validate(step: Step) {
  if (Object.keys(step).some(key => !allowed.has(key))) invalid('unsupported setting; only read-only exact title lookup is available')
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) invalid('choose one fixed Pipedrive connection')
  if (typeof step.subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(step.subdomain)) invalid('choose one fixed bare tenant subdomain')
  if (step.filter_id !== undefined && (typeof step.filter_id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(step.filter_id))) invalid('filter_id must be one fixed saved-filter identifier')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'title')) return invalid('input accepts only title')
  if (!mapped(step.input.title)) title(step.input.title)
  if (!isObject(step.sort) || step.sort.field !== 'id') invalid('declare deterministic sorting by id with a direction')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 10)) invalid('max_pages must be 1 to 10')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
}
function identity(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) return value
  return malformed('stable deal or stage identity')
}
function deal(value: unknown) {
  if (!isObject(value) || typeof value.title !== 'string' || value.title.length > 2048 || !value.title.trim() || /[\x00-\x1f\x7f]/.test(value.title) || typeof value.status !== 'string' || !['open','won','lost','deleted'].includes(value.status)) return malformed('deal fields')
  return {id:identity(value.id),title:value.title,status:value.status,stage_id:identity(value.stage_id)}
}
function page(bytes: Uint8Array<ArrayBuffer>) {
  let value: unknown
  try { value = JSON.parse(utf8(bytes)) } catch { return malformed('JSON') }
  if (!isObject(value) || value.success !== true || !Array.isArray(value.data) || value.data.length > 100 || !isObject(value.additional_data) || !Object.hasOwn(value.additional_data,'next_cursor')) return malformed('complete deal page')
  const cursor = value.additional_data.next_cursor
  if (cursor !== null && (typeof cursor !== 'string' || !cursor.trim() || cursor.length > 2048 || /[\x00-\x1f\x7f]/.test(cursor))) return malformed('page cursor')
  return {success:true,data:value.data.map(deal),additional_data:{next_cursor:cursor as string | null}}
}
async function account(ctx: StepContext, connectionId: string, host: string) {
  const {row} = await credential(ctx.env,connectionId)
  // Keep the existing explicit bearer consent and exact tenant domain. A generic
  // HTTP credential or a parent-domain wildcard grants no Pipedrive authority.
  if (row.app !== 'pipedrive' || row.auth_kind !== 'bearer' || !row.consented_at || !connectionDomains(row).includes(host)) throw new StepError('authority','Pipedrive deal search needs current Pipedrive bearer consent for this exact tenant')
}

/** The existing v2 list shape, through admitted workflow transport and private
 * continuation checkpoints. Polling baselines and cursors are never touched. */
export const pipedriveFindDeal: StepType = {
  mutating:false,connection:'required',required:['title'],validate,
  async execute(step,ctx) {
    validate({...step,input:ctx.input})
    const key = title(ctx.input.title), connectionId = String(step.connection_id), host = `${step.subdomain}.pipedrive.com`
    const beforeRequest = async () => { await account(ctx,connectionId,host); await ctx.beforeRequest?.() }
    const context: StepContext = {...ctx,beforeRequest}, records = new Map<string,ReturnType<typeof deal>>(), cursors = new Set<string>()
    let cursor: string | null = null, pages = 0
    do {
      await beforeRequest()
      const url = new URL(`https://${host}/api/v2/deals`)
      url.searchParams.set('limit','100');url.searchParams.set('sort_by','id');url.searchParams.set('sort_direction','asc')
      if (step.filter_id !== undefined) url.searchParams.set('filter_id',String(step.filter_id))
      if (cursor !== null) url.searchParams.set('cursor',cursor)
      const {response} = await retryRequest(context,{method:'GET',url,body:null,idempotent:false,reconnectStatuses:[401,403]},policy => sendRequest(context,{
        url,method:'GET',body:null,headers:new Headers({accept:'application'+'/'+'json'}),timeout:Number(step.timeout_ms ?? 15000),maxBytes:1024*1024,follow:0,
        // Persist only declared fields, with no tenant or cursor in plaintext
        // metadata. The request digest still binds the actual URL and account.
        sanitizeResponse:async response => ({...response,url:'https://api.pipedrive.com/api/v2/deals',headers:new Headers([...response.headers].filter(([name]) => ['content-type','retry-after'].includes(name))),bytes:new TextEncoder().encode(JSON.stringify(response.status === 200 ? page(response.bytes) : {}))}),
      },connectionId,policy))
      if (response.status !== 200) throw new StepError([401,403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'provider',`Pipedrive deal search refused with status ${response.status}`,{status:response.status})
      const result = page(response.bytes)
      for (const record of result.data) {
        const prior = records.get(record.id)
        if (prior && canonical(prior) !== canonical(record)) throw new StepError('provider','Pipedrive deal search returned conflicting duplicate deals; no match decision was made')
        records.set(record.id,record)
      }
      cursor = result.additional_data.next_cursor
      if (cursor !== null) {
        if (cursors.has(cursor)) throw new StepError('provider','Pipedrive deal search returned a repeated cursor; no match decision was made')
        cursors.add(cursor)
      }
      pages++
    } while (cursor !== null && pages < Number(step.max_pages ?? 10))
    // Numeric identities sort without lossy number coercion. Apply outcomes only
    // after the declared scan, including duplicates outside the matching title.
    const direction = (step.sort as Record<string,unknown>).direction === 'desc' ? -1 : 1
    const matches = [...records.values()].filter(record => record.title === key).sort((a,b) => (a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) * direction)
    const result = searchOutcome({...step,sort:undefined},matches,cursor !== null)
    return 'output' in result ? {...result,output:{...(result.output as object),pages,complete:cursor === null}} : result
  },
}
