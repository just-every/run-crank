import { demoEffectsEnabled } from '../../demo/effects.mjs';
import { devAdmitted } from '../dev-admission.mjs';
import { deny } from '../errors.mjs';
import { requireOrigin } from '../http.mjs';
import { safeReturnTo } from '../policy.mjs';
import { emailAllowed } from './roles.mjs';
import { operatorColumns } from './store.mjs';

export const oneClickHref = (email, returnTo = '/app') => `/auth/one-click?as=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;

// Local entry needs the checkout's key on every request. Hosted demos live in
// the visitor's isolated database; only the installed demo effect guard enables
// this door. Ordinary production cannot enable it with a request header.
export function oneClickAccounts({ config, store, clock, sessions, authorizedLink, requireRoute, afterConfirm }) {
  async function mode(request) {
    if (config.local) return await devAdmitted(request) ? 'dev' : null;
    return demoEffectsEnabled() ? 'native' : null;
  }
  async function invitation(request, operator) {
    const token = await store.first(`SELECT token_hash AS digest FROM oa_tokens
      WHERE operator_id=? AND kind='invite' AND consumed_at IS NULL AND revoked_at IS NULL
      AND expires_at>? AND operator_version=? ORDER BY created_at DESC LIMIT 1`, [operator.id, clock(), operator.version]);
    const approval = token && await authorizedLink(request, token.digest);
    return approval ? { digest: token.digest, approval } : null;
  }
  async function eligible(request, operator) {
    if (!operator || !emailAllowed(operator.email, config.allowList)) return false;
    if (operator.status === 'invited') return !!await invitation(request, operator);
    return operator.status === 'active';
  }
  return {
    async people(request) {
      if (!await mode(request)) return null;
      requireOrigin(request, config);
      const rows = (await store.statement(`SELECT ${operatorColumns} FROM oa_operators WHERE status IN ('active','invited') ORDER BY created_at,id`).all()).results;
      const people = await Promise.all(rows.map(async operator => {
        if (!await eligible(request, operator)) return null;
        return { email: operator.email, displayName: operator.displayName, role: operator.role, href: oneClickHref(operator.email) };
      }));
      return people.filter(Boolean);
    },
    async enter(request, { as, returnTo }) {
      const kind = await mode(request);
      if (!kind) deny('not_found', 404);
      requireOrigin(request, config);
      if (request.method !== 'GET') deny('method_not_allowed', 405);
      const operator = typeof as === 'string' ? await store.byEmail(as) : null;
      if (!await eligible(request, operator)) deny('not_found', 404);
      await requireRoute(operator);
      const session = await sessions.newSession(kind);
      let record;
      if (operator.status === 'invited') {
        const link = await invitation(request, operator);
        if (!link) deny('invalid_or_expired', 400);
        record = await store.consume(link.digest, clock(), session, config.allowList, link.approval.issuer, kind);
      } else {
        record = await store.issue({ operatorId: operator.id, expectedVersion: operator.version, session, now: clock(), kind });
      }
      const completed = sessions.completed(session, record, returnTo ?? record?.returnTo);
      return afterConfirm(request, completed, 'email');
    },
  };
}
