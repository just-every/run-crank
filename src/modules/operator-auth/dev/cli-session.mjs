import { isLocalCli } from '../local-cli.mjs';
import { requireLoopback, requirePost, sessionCookie } from '../http.mjs';
import { opaqueToken } from '../crypto.mjs';
import { safeReturnTo } from '../policy.mjs';
import { isActiveOperator } from '../accounts/roles.mjs';
import { AuthError } from '../errors.mjs';
import { devNotFound } from '../dev-gate.mjs';
import { readInput } from '../input.mjs';

// Owner-side local tooling proves possession of this installation's session
// secret. This endpoint exists only in the local dev entry, never production.
export async function cliSession(request, { config, store, hash, everyone }, headers) {
  requireLoopback(request);
  requirePost(request, config);
  if (!await isLocalCli(request, config)) return devNotFound();
  const input = await readInput(request);
  const ownerEmail = (await everyone()).find(persona => persona.as === 'owner')?.email;
  const operator = ownerEmail ? await store.byEmail(ownerEmail) : null;
  if (operator?.role !== 'owner' || !isActiveOperator(operator, config.allowList)) throw new AuthError('owner_required', 403);
  const now = Date.now(), token = opaqueToken();
  const session = { id: crypto.randomUUID(), hash: await hash(token), expiresAt: now + config.sessionSeconds * 1000 };
  const record = await store.issue({ operatorId: operator.id, expectedVersion: operator.version, session, now, kind: 'native' });
  if (!record || record.operator.role !== 'owner') throw new AuthError('authority_changed', 409);
  // A local owner proof uses the existing durable, version-fenced proof ledger.
  // It can authorize setup linking without manufacturing an email credential.
  const proofId = crypto.randomUUID();
  const inserted = await store.first(`INSERT INTO oa_step_up_challenges(id,token_hash,session_id,operator_id,operator_version,action,return_to,created_at,expires_at,consumed_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
      WHERE s.id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=?) RETURNING id`,
    [proofId, await hash(opaqueToken()), record.id, operator.id, operator.version, 'local-cli', '/', now, session.expiresAt, now, record.id, operator.version]);
  if (inserted?.id !== proofId) throw new AuthError('authority_changed', 409);
  return new Response(null, { status: 303, headers: { ...headers, location: safeReturnTo(input.returnTo), 'set-cookie': sessionCookie(token, config) } });
}
