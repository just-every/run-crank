// Server-only entry. Never import this module into browser components/loaders.
// Layers: identity/ proves who a person is, accounts/ holds who they are in this
// app and what they may do, dev/ is local only. See README.md.
export { createOperatorAuth, STEP_UP_ACTIONS } from './service.mjs';
export { createAuthHandler } from './routes.mjs';
export { createSignInHandler } from './signin/index.mjs';
export { AuthError } from './errors.mjs';
export { normalizeEmail, safeReturnTo } from './policy.mjs';
export { DEFAULT_ROLES, defaultRolePolicy, isActiveOperator } from './accounts/roles.mjs';
export { requireLoopback, isLoopbackHost, securityHeaders } from './http.mjs';
export { devGate, devNotFound, DEV_KEY_HEADER } from './dev-gate.mjs';
