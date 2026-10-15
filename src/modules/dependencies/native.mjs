import { AuthError } from '../operator-auth/errors.mjs';
// These are D1 transaction fragments, not a second linking protocol. Each
// fragment uses only the adopter's tenant/account/session tables. The common
// protocol adds key/link/code/pin guards and commits everything in one batch.
export function nativeDependencyAuthority(value) {
  const methods = ['unclaimed', 'ownerFence', 'approvalFence', 'linkedStatements', 'unlinkStatements', 'consumeLogout'];
  if (!value || typeof value !== 'object' || methods.some(k => typeof value[k] !== 'function') || value.claimOwner !== undefined && typeof value.claimOwner !== 'function') throw new AuthError('native_dependency_capability_required', 503);
  return value;
}
