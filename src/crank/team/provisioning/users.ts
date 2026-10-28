import { normalizeEmail } from '../../../modules/operator-auth/index.mjs'
import { canonical, id, now, requireValue, stmt, text, type CrankEnv } from '../../model'
import { auditStatement } from '../../ops/audit'
import { issuerBatch, type Issuer } from './credential'
import { listing, patchResource, precondition, schema, scim, ScimError, scimBody } from './protocol'

interface UserRow {id:string;issuer:string;external_id:string;user_name:string;resource_json:string;revision:number;created_at:string;updated_at:string;role:string;status:string;email:string}
const select=`SELECT u.*,o.role,o.status,o.email FROM crank_scim_users u JOIN oa_operators o ON o.id=u.id`
function userInput(input: Record<string,any>, externalId?: string) {
  requireValue(Array.isArray(input.schemas)&&input.schemas.includes(schema('User')),'User schema is required')
  const external=text(input.externalId??externalId,'externalId',500)
  if(externalId && external!==externalId)throw new ScimError(400,'externalId is immutable','mutability')
  const userName=text(input.userName,'userName',254)
  requireValue(input.active===undefined||typeof input.active==='boolean','active must be boolean')
  requireValue(input.emails===undefined||Array.isArray(input.emails)&&input.emails.length<=10,'emails must be an array')
  const emails=input.emails??[{value:userName,primary:true}]
  requireValue(emails.length>0&&emails.every((email:any)=>email&&typeof email.value==='string'),'An email is required')
  requireValue(emails.filter((email:any)=>email.primary===true).length<=1,'Choose one primary email')
  let email: string
  try {email=normalizeEmail((emails.find((email:any)=>email.primary===true)??emails[0]).value)}catch{throw new ScimError(400,'A valid email is required','invalidValue')}
  const displayName=text(input.displayName??input.name?.formatted??userName,'displayName',200)
  return {external,userName,email,displayName,resource:{schemas:[schema('User')],userName,displayName,active:input.active??true,emails,...(input.name?{name:input.name}:{})}}
}
async function present(env: CrankEnv,url: URL,row: UserRow) {
  const memberships=await stmt(env,'SELECT g.id,g.display_name FROM crank_scim_groups g JOIN crank_scim_members m ON m.group_id=g.id WHERE m.operator_id=? AND g.issuer=? ORDER BY g.id',row.id,row.issuer).all<{id:string;display_name:string}>()
  return {...JSON.parse(row.resource_json),id:row.id,externalId:row.external_id,active:row.status==='active',groups:memberships.results.map(g=>({value:g.id,display:g.display_name,$ref:url.origin+'/scim/v2/Groups/'+g.id})),
    meta:{resourceType:'User',created:row.created_at,lastModified:row.updated_at,version:`W/"${row.revision}"`,location:url.origin+'/scim/v2/Users/'+row.id}}
}
async function user(env: CrankEnv,issuer: Issuer,resourceId: string) {
  const row=await stmt(env,select+' WHERE u.id=? AND u.issuer=?',resourceId,issuer.issuer).first<UserRow>()
  if(!row) {
    const owner=await stmt(env,"SELECT id FROM oa_operators WHERE id=? AND role='owner'",resourceId).first()
    throw new ScimError(owner?403:404,owner?'SCIM cannot manage an owner':'User not found')
  }
  requireValue(row.role!=='owner','SCIM cannot manage an owner',403)
  return row
}
export async function users(request: Request,env: CrankEnv,issuer: Issuer,resourceId?: string): Promise<Response> {
  const url=new URL(request.url),method=request.method
  if(method==='GET') {
    if(resourceId){const row=await user(env,issuer,resourceId);return scim(await present(env,url,row),200,{etag:`W/"${row.revision}"`})}
    const rows=await stmt(env,select+" WHERE u.issuer=? AND o.role!='owner' ORDER BY u.id",issuer.issuer).all<UserRow>()
    return listing(url,await Promise.all(rows.results.map(row=>present(env,url,row))))
  }
  if(!resourceId) {
    requireValue(method==='POST','Method not allowed',405)
    const input=userInput(await scimBody(request)),existing=await stmt(env,select+' WHERE u.issuer=? AND u.external_id=?',issuer.issuer,input.external).first<UserRow>()
    if(existing){requireValue(existing.role!=='owner','SCIM cannot manage an owner',403);return scim(await present(env,url,existing))}
    const resourceId=id(),at=now()
    requireValue(!await stmt(env,'SELECT id FROM oa_operators WHERE email=? COLLATE NOCASE',input.email).first(),'Email belongs to another identity; identities are never merged',409)
    try {await issuerBatch(env,issuer,[
      stmt(env,'INSERT INTO oa_operators(id,email,display_name,role,status,version,created_at) VALUES(?,?,?,?,?,1,?)',resourceId,input.email,input.displayName,'member',input.resource.active?'active':'inactive',Date.now()),
      stmt(env,'INSERT INTO crank_scim_users(id,issuer,external_id,user_name,resource_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',resourceId,issuer.issuer,input.external,input.userName,canonical(input.resource),at,at),
      auditStatement(env,'scim:'+issuer.id,'scim.user.create','operator',resourceId),
    ])}catch(error) {
      if(/UNIQUE constraint failed/.test(String(error))) {
        const concurrent=await stmt(env,select+' WHERE u.issuer=? AND u.external_id=?',issuer.issuer,input.external).first<UserRow>()
        if(concurrent&&concurrent.role!=='owner')return scim(await present(env,url,concurrent))
      }
      throw error
    }
    const row=await user(env,issuer,resourceId)
    return scim(await present(env,url,row),201,{location:url.origin+'/scim/v2/Users/'+resourceId,etag:`W/"${row.revision}"`})
  }
  requireValue(['PUT','PATCH','DELETE'].includes(method),'Method not allowed',405)
  const current=await user(env,issuer,resourceId);precondition(request,current.revision)
  const original={...JSON.parse(current.resource_json),externalId:current.external_id,active:current.status==='active'}
  const raw=method==='DELETE'?{...original,active:false}:await scimBody(request)
  const input=userInput(method==='PATCH'?patchResource(original,raw,'User'):raw,current.external_id)
  requireValue(!await stmt(env,'SELECT id FROM oa_operators WHERE email=? COLLATE NOCASE AND id!=?',input.email,resourceId).first(),'Email belongs to another identity; identities are never merged',409)
  if(canonical(input.resource)===current.resource_json&&input.email===current.email&&input.resource.active===(current.status==='active'))return method==='DELETE'?new Response(null,{status:204}):scim(await present(env,url,current),200,{etag:`W/"${current.revision}"`})
  const at=now(),epoch=Date.now(),revoke=!input.resource.active||input.email!==current.email
  const jobs=[
    stmt(env,"UPDATE oa_operators SET email=?,display_name=?,status=?,version=version+CASE WHEN email!=? THEN 1 ELSE 0 END WHERE id=? AND role!='owner'",input.email,input.displayName,input.resource.active?'active':'inactive',input.email,resourceId),
    stmt(env,'UPDATE crank_scim_users SET user_name=?,resource_json=?,revision=revision+1,updated_at=? WHERE id=?',input.userName,canonical(input.resource),at,resourceId),
    auditStatement(env,'scim:'+issuer.id,revoke?'scim.user.deactivate':'scim.user.update','operator',resourceId),
  ]
  if(revoke)jobs.push(
    stmt(env,'UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?',epoch,resourceId),
    stmt(env,'UPDATE oa_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?',epoch,resourceId),
    stmt(env,'UPDATE oa_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?',epoch,resourceId),
    stmt(env,'UPDATE crank_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE created_by=?',at,resourceId),
  )
  await issuerBatch(env,issuer,jobs,{sql:"EXISTS(SELECT 1 FROM crank_scim_users u JOIN oa_operators o ON o.id=u.id WHERE u.id=? AND u.revision=? AND o.role!='owner')",args:[resourceId,current.revision]})
  if(method==='DELETE')return new Response(null,{status:204})
  const row=await user(env,issuer,resourceId)
  return scim(await present(env,url,row),200,{etag:`W/"${row.revision}"`})
}
