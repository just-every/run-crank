import { AuthError } from '../errors.mjs';
import { safeReturnTo } from '../policy.mjs';

// The owner of the session store supplies revocation; a refused sign-in must
// lose its persisted authority before its error is returned to the caller.
export function completionHook({ hooks, revokeSession }) {
  return async (request, completed, method) => {
    completed = { ...completed, returnTo: safeReturnTo(completed.returnTo) };
    if (typeof hooks.afterConfirm !== 'function') return completed;
    try {
      const result = await hooks.afterConfirm({ request, operator: completed.operator, session: completed.session, method, returnTo: completed.returnTo });
      return result?.returnTo === undefined ? completed : { ...completed, returnTo: safeReturnTo(result.returnTo) };
    } catch (error) {
      await revokeSession(completed.session.id);
      throw error instanceof AuthError ? error : new AuthError('sign_in_refused', 403);
    }
  };
}
