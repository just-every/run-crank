import { devAdmitted } from '../dev-admission.mjs';
import { deny } from '../errors.mjs';
import { requirePost } from '../http.mjs';

export function providerControl({ store, accounts, authenticate, config, clock }) {
  async function owner(request, post = false) {
    if (post) requirePost(request, config);
    const actor = await authenticate(request), current = await accounts.owner();
    if (!actor) deny('unauthenticated', 401);
    if (!current || current.id !== actor.operator.id) deny('owner_required', 403);
    return actor;
  }
  return {
    async identitySettings(request) { await owner(request); return { idpSignIn: await accounts.identityEnabled() }; },
    async setIdentitySettings(request, { idpSignIn }) {
      const actor = await owner(request, true);
      if (typeof idpSignIn !== 'boolean') deny('invalid_input', 400);
      const fence = store.actorFence(actor, clock());
      const currentOwner = `?=(SELECT o.id FROM oa_operators o LEFT JOIN oa_bootstrap b ON b.claim_id=o.id WHERE o.role='owner' AND o.status='active' ORDER BY b.claim_id IS NULL,o.created_at,o.id LIMIT 1)`;
      const auditId=crypto.randomUUID();
      const results = await store.batch([
        [`INSERT INTO oa_auth_settings(singleton,idp_sign_in,generation,first_setup) SELECT 1,0,0,0 WHERE ${fence.sql} AND ${currentOwner} ON CONFLICT(singleton) DO UPDATE SET first_setup=0 RETURNING singleton`, [...fence.args, actor.operator.id]],
        [`INSERT INTO oa_auth_settings(singleton,idp_sign_in,generation) SELECT 1,?,1 WHERE ${fence.sql} AND ${currentOwner} AND NOT EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=?)
          ON CONFLICT(singleton) DO UPDATE SET idp_sign_in=excluded.idp_sign_in,generation=oa_auth_settings.generation+1,first_setup=0 RETURNING singleton`, [idpSignIn ? 1 : 0, ...fence.args, actor.operator.id, idpSignIn ? 1 : 0]],
        [`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,?,'idpSignIn',?,? WHERE changes()=1`, [auditId, actor.operator.id, String(idpSignIn), clock()]],
        [`UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE kind='oidc' AND EXISTS(SELECT 1 FROM oa_auth_audit WHERE id=? AND value='false')`, [clock(), auditId]],
      ]);
      if (!results[0].results.some(row => row.singleton === 1) && !results[1].results.some(row => row.singleton === 1)) deny('authority_changed', 409);
      return { idpSignIn };
    },
    async requireEditorOwner(request) {
      const actor = await owner(request);
      if (actor.kind === 'oidc') {
        if (!actor.issuer || !actor.subject || await accounts.currentBoundSubject({ personId: actor.operator.id, issuer: actor.issuer }) !== actor.subject) deny('owner_subject_required', 403);
      }
      const { hash, ...session } = actor;
      return session;
    },
    async credentialFence(request) {
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      return { personId: actor.operator.id, fence: actor.operator.version, kind: actor.kind };
    },
    async checkCredentialFence(credential,request) {
      if (!credential || !Number.isSafeInteger(credential.fence)) return false;
      const person = await store.operator(credential.personId);
      return !!person && person.status === 'active' && person.version === credential.fence && (credential.kind !== 'dev' || request && await devAdmitted(request));
    },
  };
}
