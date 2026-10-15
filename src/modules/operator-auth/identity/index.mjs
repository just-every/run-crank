// Identity: proves who a person is and outputs a verified principal. It never
// decides who may enter; an accounts adapter does (../accounts/adapter.mjs).
export { createAdmission } from './admission.mjs';
export { trustedEmail, refuseInProduction, EMAIL_PROOF_DAYS } from './principal.mjs';
export { createOidcProviders, createOidcHandler, OidcError, PRESETS, MINIMUM_PROVIDER_VERSION } from './oidc/index.mjs';
