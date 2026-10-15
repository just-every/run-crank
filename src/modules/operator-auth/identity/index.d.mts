import type { AccountsAdapter, Admission, AuthHooks, Principal } from '../index.mjs';
export { createOidcProviders, createOidcHandler, OidcError, PRESETS, MINIMUM_PROVIDER_VERSION } from './oidc/index.mjs';
export const EMAIL_PROOF_DAYS: number;
/** Admission over any accounts adapter: a verified principal in, a session out. */
export function createAdmission<R extends string>(input: { accounts: AccountsAdapter<R>; config: { origin: string; local?: boolean }; clock?: () => number; hooks?: AuthHooks<R> }): Admission<R>;
export function trustedEmail(principal: Principal, now: number): string | null;
export function refuseInProduction(principal: Principal, config: { local?: boolean }): void;
