import { credential } from '../connections/store'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const HUBSPOT_CONTACT_READ = 'crm.objects.contacts.read'
const ENDPOINT = 'https://api.hubapi.com/crm/v3/objects/contacts'
const PAGE_SIZE = 100, MAX_BYTES = 262144, SCAN_BYTES = 1048576
const invalid = (message: string): never => { throw new StepError('validation', `HubSpot contact search: ${message}`) }
const malformed = (): never => { throw new StepError('provider', 'HubSpot contact search returned malformed or conflicting contact data') }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')

/** Exact comparison of trimmed, lowercased whole addresses; no substring or alias matching. */
function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || /[\x00-\x1f\x7f]/.test(value)) return invalid('email must be one nonempty typed email address')
  return value.trim().toLowerCase()
}
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) invalid('select one fixed managed HubSpot connection')
  if (step.create_if_not_found !== undefined) invalid('this operation is read only; creation is unsupported')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'email')) return invalid('input accepts only email')
  if (!mapped(step.input.email)) email(step.input.email)
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 20)) invalid('max_pages must be 1 to 20')
  if (!isObject(step.sort) || step.sort.field !== 'id') invalid('declare id sorting and its direction')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
}
async function account(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'hubspot' || row.auth_kind !== 'oauth2' || !JSON.parse(row.scopes_json).includes(HUBSPOT_CONTACT_READ)) throw new StepError('authority', 'HubSpot contact search requires current selected-connection contact-read consent')
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
function contact(value: unknown) {
  if (!isObject(value) || !text(value.id,128) || !/^[A-Za-z0-9_-]+$/.test(value.id) || !isObject(value.properties) || value.archived !== undefined && value.archived !== false) return malformed()
  const properties: Record<string,string|null> = {}
  for (const key of ['email','firstname','lastname']) {
    const field = value.properties[key]
    if (field !== undefined && field !== null && (typeof field !== 'string' || field.length > (key === 'email' ? 254 : 2048) || /[\x00-\x1f\x7f]/.test(field))) return malformed()
    properties[key] = field === undefined ? null : field as string|null
  }
  // Missing email is a non-match. Invalid nonempty provider addresses are errors.
  if (properties.email) { try { email(properties.email) } catch { return malformed() } }
  return { id:value.id, properties }
}
function page(bytes: BoundedResponse['bytes']) {
  let value: unknown
  try { value = JSON.parse(utf8(bytes)) } catch { return malformed() }
  if (!isObject(value) || !Array.isArray(value.results) || value.results.length > PAGE_SIZE) return malformed()
  const results = value.results.map(contact)
  let after: string|undefined
  if (value.paging !== undefined) {
    if (!isObject(value.paging) || value.paging.next !== undefined && !isObject(value.paging.next)) return malformed()
    if (value.paging.next !== undefined) {
      if (!text(value.paging.next.after,1024) || /\s/.test(value.paging.next.after)) return malformed()
      after = value.paging.next.after
    }
  }
  return {results,...(after ? {paging:{next:{after}}} : {})}
}

/** Only the contacts list endpoint is read. Every completed page is projected
 * before retention; provider links, unrelated properties and errors are discarded. */
export const hubspotFindContact: StepType = {
  mutating:false,connection:'required',required:['email'],validate,
  async execute(step,ctx) {
    validate({...step,input:ctx.input})
    const key = email(ctx.input.email), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await account(ctx,connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = {...ctx,beforeRequest}
    const contacts = new Map<string,ReturnType<typeof contact>>(), cursors = new Set<string>()
    let after = '', pages = 0, bytes = 0
    do {
      // Consent also fences consumption of a previously completed checkpoint.
      await beforeRequest()
      const url = new URL(ENDPOINT)
      url.searchParams.set('limit',String(PAGE_SIZE)); url.searchParams.set('properties','email,firstname,lastname'); url.searchParams.set('archived','false')
      if (after) url.searchParams.set('after',after)
      const result = await retryRequest(context,{method:'GET',url,body:null,idempotent:false,reconnectStatuses:[401,403]},policy => sendRequest(context,{
        url,method:'GET',body:null,headers:new Headers({accept:'application'+'/'+'json'}),timeout:Number(step.timeout_ms ?? 15000),maxBytes:MAX_BYTES,follow:0,
        sanitizeResponse:async response => {
          const bytes = new TextEncoder().encode(JSON.stringify(response.status === 200 ? page(response.bytes) : {}))
          if (bytes.length > MAX_BYTES) return malformed()
          return {...response,url:ENDPOINT,headers:new Headers([...response.headers].filter(([name]) => ['content-type','retry-after'].includes(name))),bytes}
        },
      },connectionId,policy))
      const status = result.response.status
      if (status !== 200) throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider',`HubSpot contact search refused with status ${status}`,{status,...(result.exhausted ? {exhausted:true} : {})})
      const projected = page(result.response.bytes)
      bytes += result.response.bytes.length
      if (bytes > SCAN_BYTES) throw new StepError('provider','HubSpot contact search exceeded the retained scan bound; no match decision was made')
      for (const record of projected.results) {
        const prior = contacts.get(record.id)
        if (prior && canonical(prior) !== canonical(record)) return malformed()
        contacts.set(record.id,record)
      }
      after = projected.paging?.next.after ?? ''
      if (after && cursors.has(after)) throw new StepError('provider','HubSpot contact search returned a repeated page cursor; scan is incomplete')
      if (after) cursors.add(after)
      pages++
    } while (after && pages < Number(step.max_pages ?? 20))
    const records = [...contacts.values()].filter(record => record.properties.email && email(record.properties.email) === key).map(record => ({id:record.id,email:record.properties.email,first_name:record.properties.firstname,last_name:record.properties.lastname}))
    records.sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * ((step.sort as Record<string,unknown>).direction === 'desc' ? -1 : 1))
    const result = searchOutcome({...step,sort:undefined},records,!!after)
    if (!('output' in result)) return result
    return {...result,output:{...(result.output as object),pages,complete:!after}}
  },
}
