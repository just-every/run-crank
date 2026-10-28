import { resourceSelectors } from '../resources'
import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../../access'
import { validateConnectionScopes } from '../../custom/use-scope'
import { randomToken } from '../../connections/vault'
import { body, canonical, digest, id, json, now, requireValue, stmt, text, type CrankEnv } from '../../model'
import { auditStatement } from '../../ops/audit'
import type { TeamGrant } from '../policy'

const root='/api/crank/team-provisioning'
export async function ownerApi(request: Request,env: CrankEnv) {
  const actor=await authorize(request,env);requireOwner(actor)
  const path=new URL(request.url).pathname
  if(request.method==='GET') {
    if(path===root||path===root+'/credentials')return json((await stmt(env,'SELECT id,issuer,owner_id,owner_version,created_at,revoked_at FROM crank_scim_credentials ORDER BY created_at,id').all()).results)
    if(path===root+'/groups')return json((await stmt(env,'SELECT g.*,mapping.grants_json,mapping.revision AS mapping_revision FROM crank_scim_groups g LEFT JOIN crank_scim_group_grants mapping ON mapping.group_id=g.id ORDER BY g.id').all<any>()).results.map(({grants_json,...row})=>({...row,grants:JSON.parse(grants_json??'[]')})))
    requireValue(false,'Route not found',404)
  }
  requireValue(request.method==='POST','Method not allowed',405);requireWriteOrigin(request,env,actor)
  const revoke=new RegExp('^'+root+'/credentials/([^/]+)/revoke$').exec(path)
  if(revoke) {
    const credentialId=decodeURIComponent(revoke[1]);requireValue(await stmt(env,'SELECT id FROM crank_scim_credentials WHERE id=?',credentialId).first(),'Credential not found',404)
    await guardedBatch(env,actor,'owner',[stmt(env,'UPDATE crank_scim_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND revoked_at IS NULL',now(),credentialId),auditStatement(env,actor.id,'scim.credential.revoke','scim_credential',credentialId)])
    return json({id:credentialId,revoked:true})
  }
  const input=await body(request)
  if(path===root+'/credentials') {
    requireValue(actor.kind==='native','A native owner session is required to issue a provisioning credential',403)
    const issuer=text(input.issuer,'issuer',500)
    let url: URL|undefined;try {url=new URL(issuer)}catch{}
    requireValue(url&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search,'Issuer must be an HTTPS issuer URL',422)
    requireValue(!await stmt(env,'SELECT id FROM crank_scim_credentials WHERE issuer=? AND revoked_at IS NULL',issuer).first(),'Issuer already exists',409)
    const credentialId=id(),token='crp_'+randomToken(),at=now()
    await guardedBatch(env,actor,'owner',[
      stmt(env,'INSERT INTO crank_scim_credentials(id,issuer,token_hash,owner_id,owner_version,created_at) VALUES(?,?,?,?,?,?)',credentialId,issuer,await digest(token),actor.id,actor.version,at),
      auditStatement(env,actor.id,'scim.credential.issue','scim_credential',credentialId),
    ])
    return json({id:credentialId,issuer,token,scope:'scim',created_at:at},201)
  }
  const mapping=new RegExp('^'+root+'/groups/([^/]+)/grants$').exec(path)
  requireValue(mapping,'Route not found',404)
  const groupId=decodeURIComponent(mapping[1]);requireValue(await stmt(env,'SELECT id FROM crank_scim_groups WHERE id=?',groupId).first(),'Group not found',404)
  requireValue(Array.isArray(input.grants)&&input.grants.length<=100,'Grants must be an array',422)
  const grants:TeamGrant[]=[]
  for(const value of input.grants as any[]) {
    requireValue(value&&['admin','builder','operator','approver','viewer','auditor','billing'].includes(value.role),'Choose a product role',422)
    requireValue(Object.keys(value).every(key=>['role','workflow_ids','connection_ids','folder_ids','environment_ids'].includes(key)),'Only explicit role and resource scopes may be mapped',422)
    const raw=value.workflow_ids??[]
    requireValue(Array.isArray(raw)&&raw.length<=500&&raw.every(id=>typeof id==='string'),'Workflow scopes must contain record ids',422)
    const workflowIds=[...new Set<string>(raw)].sort()
    requireValue(!workflowIds.includes('workspace:production'),'Map group creation through an environment or folder scope',422)
    const rows=await stmt(env,"SELECT id FROM (SELECT id FROM crank_workflows UNION SELECT id FROM crank_flows) WHERE id IN (SELECT value FROM json_each(?))",JSON.stringify(workflowIds)).all()
    requireValue(rows.results.length===workflowIds.length,'Scope contains an unknown workflow',422)
    grants.push({role:value.role,workflow_ids:workflowIds,connection_ids:await validateConnectionScopes(env,value.connection_ids??[]),...await resourceSelectors(env,value)})
  }
  const prior=await stmt(env,'SELECT * FROM crank_scim_group_grants WHERE group_id=?',groupId).first<{grants_json:string;owner_id:string;owner_version:number;revision:string}>()
  if(prior&&prior.grants_json===canonical(grants)&&prior.owner_id===actor.id&&prior.owner_version===actor.version)return json({group_id:groupId,grants,revision:prior.revision})
  const revision=id()
  await guardedBatch(env,actor,'owner',[
    stmt(env,'INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN COALESCE((SELECT revision FROM crank_scim_group_grants WHERE group_id=?),\'\')=? AND EXISTS(SELECT 1 FROM crank_scim_groups WHERE id=?) THEN 1 ELSE 0 END',revision,groupId,prior?.revision??'',groupId),
    stmt(env,`INSERT INTO crank_scim_group_grants(group_id,grants_json,owner_id,owner_version,revision,changed_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(group_id) DO UPDATE SET grants_json=excluded.grants_json,owner_id=excluded.owner_id,owner_version=excluded.owner_version,revision=excluded.revision,changed_at=excluded.changed_at`,groupId,canonical(grants),actor.id,actor.version,revision,now()),
    auditStatement(env,actor.id,'scim.group.mapping','scim_group',groupId,{revision}),
    stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',revision),
  ])
  return json({group_id:groupId,grants,revision})
}
