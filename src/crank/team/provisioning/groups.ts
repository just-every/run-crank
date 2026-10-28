import { canonical, id, now, requireValue, stmt, text, type CrankEnv } from '../../model'
import { auditStatement } from '../../ops/audit'
import { issuerBatch, type Issuer } from './credential'
import { listing, patchResource, precondition, schema, scim, scimBody, ScimError } from './protocol'

interface GroupRow {id:string;issuer:string;external_id:string;display_name:string;revision:number;created_at:string;updated_at:string}
async function group(env: CrankEnv,issuer: Issuer,resourceId: string) {
  const row=await stmt(env,'SELECT * FROM crank_scim_groups WHERE id=? AND issuer=?',resourceId,issuer.issuer).first<GroupRow>()
  requireValue(row,'Group not found',404);return row
}
async function present(env: CrankEnv,url: URL,row: GroupRow) {
  const members=await stmt(env,'SELECT m.operator_id,u.user_name FROM crank_scim_members m JOIN crank_scim_users u ON u.id=m.operator_id WHERE m.group_id=? ORDER BY m.operator_id',row.id).all<{operator_id:string;user_name:string}>()
  return {schemas:[schema('Group')],id:row.id,externalId:row.external_id,displayName:row.display_name,
    members:members.results.map(member=>({value:member.operator_id,display:member.user_name,$ref:url.origin+'/scim/v2/Users/'+member.operator_id})),
    meta:{resourceType:'Group',created:row.created_at,lastModified:row.updated_at,version:`W/"${row.revision}"`,location:url.origin+'/scim/v2/Groups/'+row.id}}
}
async function groupInput(env: CrankEnv,issuer: Issuer,input: Record<string,any>,externalId?: string) {
  requireValue(Array.isArray(input.schemas)&&input.schemas.includes(schema('Group')),'Group schema is required')
  const external=text(input.externalId??externalId,'externalId',500)
  if(externalId&&external!==externalId)throw new ScimError(400,'externalId is immutable','mutability')
  const displayName=text(input.displayName,'displayName',200),raw=input.members??[]
  requireValue(Array.isArray(raw)&&raw.length<=1000&&raw.every(member=>member&&typeof member.value==='string'),'Members must name provisioned users')
  const members=[...new Set<string>(raw.map(member=>member.value))].sort()
  const known=await stmt(env,"SELECT u.id FROM crank_scim_users u JOIN oa_operators o ON o.id=u.id WHERE u.issuer=? AND o.role!='owner' AND u.id IN (SELECT value FROM json_each(?))",issuer.issuer,JSON.stringify(members)).all()
  requireValue(known.results.length===members.length,'Each member must be a non-owner user of this issuer',422)
  return {external,displayName,members}
}
export async function groups(request: Request,env: CrankEnv,issuer: Issuer,resourceId?: string): Promise<Response> {
  const url=new URL(request.url),method=request.method
  if(method==='GET') {
    if(resourceId){const row=await group(env,issuer,resourceId);return scim(await present(env,url,row),200,{etag:`W/"${row.revision}"`})}
    const rows=await stmt(env,'SELECT * FROM crank_scim_groups WHERE issuer=? ORDER BY id',issuer.issuer).all<GroupRow>()
    return listing(url,await Promise.all(rows.results.map(row=>present(env,url,row))))
  }
  if(!resourceId) {
    requireValue(method==='POST','Method not allowed',405)
    const input=await groupInput(env,issuer,await scimBody(request)),existing=await stmt(env,'SELECT * FROM crank_scim_groups WHERE issuer=? AND external_id=?',issuer.issuer,input.external).first<GroupRow>()
    if(existing)return scim(await present(env,url,existing))
    const resourceId=id(),at=now()
    try {await issuerBatch(env,issuer,[
      stmt(env,'INSERT INTO crank_scim_groups(id,issuer,external_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)',resourceId,issuer.issuer,input.external,input.displayName,at,at),
      ...input.members.map(member=>stmt(env,'INSERT INTO crank_scim_members(group_id,operator_id) VALUES(?,?)',resourceId,member)),
      auditStatement(env,'scim:'+issuer.id,'scim.group.create','scim_group',resourceId),
    ])}catch(error) {
      if(/UNIQUE constraint failed/.test(String(error))) {
        const concurrent=await stmt(env,'SELECT * FROM crank_scim_groups WHERE issuer=? AND external_id=?',issuer.issuer,input.external).first<GroupRow>()
        if(concurrent)return scim(await present(env,url,concurrent))
      }
      throw error
    }
    const row=await group(env,issuer,resourceId)
    return scim(await present(env,url,row),201,{location:url.origin+'/scim/v2/Groups/'+resourceId,etag:`W/"${row.revision}"`})
  }
  requireValue(['PUT','PATCH','DELETE'].includes(method),'Method not allowed',405)
  const current=await group(env,issuer,resourceId);precondition(request,current.revision)
  const original=await present(env,url,current)
  if(method==='DELETE') {
    await issuerBatch(env,issuer,[stmt(env,'DELETE FROM crank_scim_group_grants WHERE group_id=?',resourceId),stmt(env,'DELETE FROM crank_scim_members WHERE group_id=?',resourceId),stmt(env,'DELETE FROM crank_scim_groups WHERE id=?',resourceId),auditStatement(env,'scim:'+issuer.id,'scim.group.delete','scim_group',resourceId)],{sql:'EXISTS(SELECT 1 FROM crank_scim_groups WHERE id=? AND revision=?)',args:[resourceId,current.revision]})
    return new Response(null,{status:204})
  }
  const raw=await scimBody(request),input=await groupInput(env,issuer,method==='PATCH'?patchResource(original,raw,'Group'):raw,current.external_id)
  const oldMembers=original.members.map(member=>member.value).sort()
  if(current.display_name===input.displayName&&canonical(oldMembers)===canonical(input.members))return scim(original,200,{etag:`W/"${current.revision}"`})
  await issuerBatch(env,issuer,[
    stmt(env,'UPDATE crank_scim_groups SET display_name=?,revision=revision+1,updated_at=? WHERE id=?',input.displayName,now(),resourceId),
    stmt(env,'DELETE FROM crank_scim_members WHERE group_id=?',resourceId),
    ...input.members.map(member=>stmt(env,'INSERT INTO crank_scim_members(group_id,operator_id) VALUES(?,?)',resourceId,member)),
    auditStatement(env,'scim:'+issuer.id,'scim.group.update','scim_group',resourceId),
  ],{sql:'EXISTS(SELECT 1 FROM crank_scim_groups WHERE id=? AND revision=?)',args:[resourceId,current.revision]})
  const row=await group(env,issuer,resourceId)
  return scim(await present(env,url,row),200,{etag:`W/"${row.revision}"`})
}
