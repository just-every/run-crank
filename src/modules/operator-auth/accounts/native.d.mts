import type { AccountsAdapter, AccountPerson, Operator, Role, Session, CompletedSession, AuthOptions, Principal, OperatorAuth } from '../index.mjs';
import type { NativeProofPersistence } from '../identity/email-link/index.mjs';
import type { NativeDependencyAuthority } from '../../dependencies/index.mjs';
export type NativePerson<R extends string = string> = AccountPerson & Operator<R>;
/** All reads and mutations are scoped to the tenant selected by server composition. */
export interface NativeAccountsAdapter<R extends string = string> extends AccountsAdapter<R> {
  findByEmail(email: string): Promise<NativePerson<R> | null>;
  findBinding(principal: {issuer: string; subject: string}): Promise<NativePerson<R> | null>;
  findById(id: string): Promise<NativePerson<R> | null>;
  getSession(request: Request, input: {now: number}): Promise<Session<R> | null>;
  /** Revoke the request's native cookie token durably and return its native clearing cookie. */
  signOut(request: Request, input: {now: number}): Promise<{cookie: string}>;
  identityEnabled(): Promise<boolean>;
  policyVersion(): Promise<number>;
  requiredProvider(email: string): Promise<string | null>;
  /** Atomically check person version/status/email, domain, binding and policy generation; check the provider pin when present (server-verified seams have none). Bind, revoke password credentials AND existing password sessions, and issue a <=24h native session. */
  bindAndIssueSession(input: {person: NativePerson<R>; principal: Principal & {providerGeneration: number}; method: 'oidc'; returnTo?: string; request: Request}): Promise<CompletedSession<R> | null>;
  /** Atomically check current version/status/domain policy and, for password, absence of any provider binding. */
  issueLocalSession?(input: {request: Request; person: NativePerson<R>; kind: 'password' | 'review'; now: number; returnTo: string}): Promise<CompletedSession<R> | null>;
  /** Atomically claim the native owner. Without supported native dependency setup provenance, close first-setup identity eligibility. */
  bootstrap?(input: {request: Request; email: string; displayName: string; returnTo: string; now: number}): Promise<CompletedSession<R> | null>;
  completeLocalSetup?(request: Request): Promise<{complete: boolean}>;
  /** Atomically fence the current owner/session, audit, bump generation, and revoke all provider sessions when disabled. */
  setIdentitySettings?(input: {actor: Session<R>; idpSignIn: boolean; now: number}): Promise<boolean>;
  checkCredentialFence?(credential: {personId: string; fence: number; kind?: string}, input: {now: number}): Promise<boolean>;
  dependencies?: NativeDependencyAuthority<R>;
}
export interface NativeAuthOptions<R extends string = string> extends Omit<AuthOptions<R>, 'rolePolicy'> {
  accounts: NativeAccountsAdapter<R>;
  proofs: NativeProofPersistence<R>;
}

export interface NativeOperatorAuth<R extends string = string> extends Omit<OperatorAuth<R>, 'accounts'> {
  readonly native: true;
  readonly accounts: NativeAccountsAdapter<R>;
  /** Explicitly refuses with native_capability_unavailable (501); no native setup provenance capability is supplied. */
  authorizeDependencySetup(request: Request, input: {token?: string}): Promise<never>;
}
