import { body, CrankError, json, requireValue } from '../../model'

export const schema = (kind: string) => `urn:ietf:params:scim:schemas:core:2.0:${kind}`
export class ScimError extends CrankError {
  constructor(status: number, message: string, readonly scimType?: string) { super(status,message) }
}
export function scim(value: unknown, status = 200, headers: Record<string,string> = {}) {
  const response=json(value,status)
  response.headers.set('content-type','application/scim+json')
  for(const [key,value] of Object.entries(headers))response.headers.set(key,value)
  return response
}
export function scimError(error: unknown) {
  const status=error instanceof CrankError ? error.status : /UNIQUE constraint failed/.test(String(error)) ? 409 : 503
  return scim({schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],status:String(status),
    detail:error instanceof CrankError ? error.message : status===409 ? 'Identity or email already exists' : 'Provisioning operation could not be confirmed',
    ...(error instanceof ScimError && error.scimType ? {scimType:error.scimType} : status===409 ? {scimType:'uniqueness'} : {})},status)
}
export async function scimBody(request: Request) {
  const type=request.headers.get('content-type')?.split(';')[0].trim()
  requireValue(type==='application/scim+json'||type==='application/json','Use application/scim+json',415)
  const headers=new Headers(request.headers);headers.set('content-type','application/json')
  return body(new Request(request,{headers}))
}
export function precondition(request: Request, revision: number) {
  const tag=request.headers.get('if-match')
  if(tag && tag!==`W/"${revision}"` && tag!==`"${revision}"` && tag!=='*')throw new ScimError(412,'Resource changed')
}
export function listing(url: URL, resources: Record<string,unknown>[]) {
  let filtered=resources
  const filter=url.searchParams.get('filter')
  if(filter) {
    const match=/^(externalId|userName|displayName|id)\s+eq\s+("(?:[^"\\]|\\.)*")$/i.exec(filter)
    if(!match)throw new ScimError(400,'Only equality filters for id, externalId, userName and displayName are supported','invalidFilter')
    const key=['externalId','userName','displayName','id'].find(key=>key.toLowerCase()===match[1].toLowerCase())!
    const value=JSON.parse(match[2]);filtered=resources.filter(row=>row[key]===value)
  }
  const start=Number(url.searchParams.get('startIndex')??1),count=Number(url.searchParams.get('count')??100)
  requireValue(Number.isInteger(start)&&start>=1&&Number.isInteger(count)&&count>=0&&count<=1000,'Invalid pagination')
  return scim({schemas:['urn:ietf:params:scim:api:messages:2.0:ListResponse'],totalResults:filtered.length,startIndex:start,itemsPerPage:Math.min(count,Math.max(0,filtered.length-start+1)),Resources:filtered.slice(start-1,start-1+count)})
}
export function patchResource(current: Record<string,any>, input: Record<string,unknown>, kind: 'User'|'Group') {
  requireValue(Array.isArray(input.schemas)&&input.schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp'),'PatchOp schema is required')
  requireValue(Array.isArray(input.Operations)&&input.Operations.length>0&&input.Operations.length<=100,'Operations are required')
  const next=structuredClone(current)
  for(const operation of input.Operations as any[]) {
    const op=String(operation.op).toLowerCase(),path=operation.path
    requireValue(['add','replace','remove'].includes(op),'Unsupported patch operation')
    if(!path) {requireValue(op!=='remove'&&operation.value&&typeof operation.value==='object'&&!Array.isArray(operation.value),'Patch value is required');Object.assign(next,operation.value);continue}
    requireValue(typeof path==='string','Patch path must be a string')
    const member=/^members\[value eq "([^"\\]+)"\]$/i.exec(path)
    if(kind==='Group' && (path.toLowerCase()==='members'||member)) {
      const before=next.members??[]
      if(member) {requireValue(op==='remove','Filtered membership supports remove');next.members=before.filter((m:any)=>m.value!==member[1]);continue}
      if(op==='remove')next.members=[]
      else {requireValue(Array.isArray(operation.value),'Members must be an array');next.members=op==='add'?[...before,...operation.value]:operation.value}
      continue
    }
    const allowed=kind==='User'?['userName','displayName','active','emails','name']:['displayName']
    const key=allowed.find(key=>key.toLowerCase()===path.toLowerCase())
    if(!key)throw new ScimError(400,'Attribute cannot be changed','mutability')
    if(op==='remove')delete next[key];else next[key]=operation.value
  }
  return next
}
