// Roles and the pure authorization policy of Base's own accounts. A product can
// replace defaultRolePolicy, but never the active-session guard or the
// database's final-owner protection.
export const DEFAULT_ROLES = Object.freeze(['owner', 'admin', 'member']);
export const ACTIONS = Object.freeze(['operators:list', 'operators:invite', 'operators:deactivate', 'operators:reactivate', 'operators:role',
  'sessions:list', 'sessions:revoke', 'providers:manage', 'domains:manage']);
export function emailAllowed(email, allowList) {
  return allowList === undefined || allowList.includes(email);
}
export function isActiveOperator(operator, allowList) {
  return !!operator && operator.status === 'active' && emailAllowed(operator.email, allowList);
}
// Default applied: owner/admin/member. Provider links and domain rules are the
// owner's alone.
export function defaultRolePolicy({ actor, action, target, role }) {
  if (!isActiveOperator(actor) || !ACTIONS.includes(action)) return false;
  if (action === 'sessions:list' || action === 'sessions:revoke') {
    if (target?.id === actor.id) return true;
  }
  if (actor.role === 'owner') return true;
  if (actor.role !== 'admin' || action === 'providers:manage' || action === 'domains:manage') return false;
  if (action === 'operators:list') return true;
  if (action === 'operators:invite') return role === 'member';
  if (target?.role !== 'member') return false;
  return action !== 'operators:role' || role === 'member';
}
