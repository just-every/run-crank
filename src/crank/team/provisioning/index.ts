import { CrankError, json, type CrankEnv } from '../../model'
import { authenticate } from './credential'
import { groups } from './groups'
import { ownerApi } from './owner'
import { schema, scim, scimError } from './protocol'
import { users } from './users'
export { groupAccess, groupGrantRowsSql, groupRevisionFence } from './access'

export async function provisioningApi(request: Request,env: CrankEnv): Promise<Response|null> {
  const path=new URL(request.url).pathname,ownerPath=path==='/api/crank/team-provisioning'||path.startsWith('/api/crank/team-provisioning/')
  if(!ownerPath&&path!=='/scim/v2'&&!path.startsWith('/scim/v2/'))return null
  try {
    if(ownerPath)return await ownerApi(request,env)
    const issuer=await authenticate(request,env)
    if(path==='/scim/v2/ServiceProviderConfig'&&request.method==='GET')return scim({schemas:[schema('ServiceProviderConfig')],patch:{supported:true},bulk:{supported:false,maxOperations:0,maxPayloadSize:0},filter:{supported:true,maxResults:1000},changePassword:{supported:false},sort:{supported:false},etag:{supported:true},authenticationSchemes:[{type:'oauthbearertoken',name:'Owner-issued SCIM credential',description:'Limited to native provisioning',primary:true}]})
    const match=/^\/scim\/v2\/(Users|Groups)(?:\/([^/]+))?\/?$/.exec(path)
    if(!match)return scimError(new CrankError(404,'SCIM endpoint not found'))
    const resourceId=match[2]?decodeURIComponent(match[2]):undefined
    return match[1]==='Users'?await users(request,env,issuer,resourceId):await groups(request,env,issuer,resourceId)
  }catch(error) {
    if(ownerPath)return json({error:error instanceof CrankError?error.message:'Provisioning operation could not be confirmed'},error instanceof CrankError?error.status:/UNIQUE constraint failed/.test(String(error))?409:503)
    return scimError(error)
  }
}

export { provisioningErasureStatements } from './erasure'
