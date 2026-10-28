import { digest, id, requireValue, stmt, type CrankEnv } from '../../model'

export interface Issuer {id:string;issuer:string;owner_id:string;owner_version:number}
export function issuerFence(issuer: Issuer) {
  return {sql:`EXISTS(SELECT 1 FROM crank_scim_credentials c JOIN oa_operators o ON o.id=c.owner_id
    WHERE c.id=? AND c.issuer=? AND c.owner_id=? AND c.owner_version=? AND c.revoked_at IS NULL
    AND o.status='active' AND o.role='owner' AND o.version=c.owner_version)`,args:[issuer.id,issuer.issuer,issuer.owner_id,issuer.owner_version] as unknown[]}
}
export async function authenticate(request: Request,env: CrankEnv): Promise<Issuer> {
  const header=request.headers.get('authorization')??''
  requireValue(/^Bearer crp_[A-Za-z0-9_-]{43}$/.test(header),'A SCIM credential is required',401)
  const row=await stmt(env,`SELECT c.id,c.issuer,c.owner_id,c.owner_version FROM crank_scim_credentials c JOIN oa_operators o ON o.id=c.owner_id
    WHERE c.token_hash=? AND c.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=c.owner_version`,await digest(header.slice(7))).first<Issuer>()
  requireValue(row,'SCIM credential is invalid or revoked',401)
  const origin=request.headers.get('origin');requireValue(origin===null||origin===env.AUTH_ORIGIN,'Request origin is not allowed',403)
  return row
}
/** The issuer and optimistic resource fence bracket all writes and their audit. */
export async function issuerBatch(env: CrankEnv,issuer: Issuer,jobs: D1PreparedStatement[],resource?:{sql:string;args:unknown[]}) {
  const guard=id(),fence=issuerFence(issuer),guardResource=id()
  try {
    return await env.DB.batch([
      stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${fence.sql} THEN 1 ELSE 0 END`,guard,...fence.args),
      ...(resource?[stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${resource.sql} THEN 1 ELSE 0 END`,guardResource,...resource.args)]:[]),
      ...jobs,
      stmt(env,`UPDATE crank_authority_guards SET ok=CASE WHEN ${fence.sql} THEN 1 ELSE 0 END WHERE id=?`,...fence.args,guard),
      stmt(env,'DELETE FROM crank_authority_guards WHERE id IN (?,?)',guard,guardResource),
    ])
  } catch(error) {
    if(/crank_authority_guards|CHECK constraint failed: ok/.test(String(error))) {
      const {ScimError}=await import('./protocol');throw new ScimError(409,'Issuer authority or resource changed')
    }
    throw error
  }
}
