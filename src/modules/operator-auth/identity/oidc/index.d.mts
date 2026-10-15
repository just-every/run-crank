import type { Admission, Role, Database, IdentityProviderConfig, IdentityProviders } from '../../index.mjs';
export interface OidcProvidersConfig {
  origin: string;
  local?: boolean;
  /** Independent high-entropy secret of at least 32 characters; never browser data. */
  transactionSecret: string;
  providers: IdentityProviderConfig[];
  signInPath?: string;
  transactionSeconds?: number;
  timeoutMs?: number;
  clockSkewSeconds?: number;
  maxTokenAgeSeconds?: number;
  startLimit?: number;
}
export interface OidcProvidersOptions<R extends string = Role> {
  admission: Pick<Admission<R>, 'admit'> & Partial<Pick<Admission<R>,'accounts'>>;
  enabled?:()=>Promise<boolean>;
  policyVersion?:()=>Promise<number>;
  claimScope?:()=>Promise<boolean>;
  claim?:(request:Request,token:string,pin:{id:string;issuer:string;clientId:string;linkedAt:number})=>Promise<Response|null>;
  db: Database;
  config: OidcProvidersConfig;
  clientIp: (request: Request) => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
}
export const HIDE_AFTER_MS: number;
export const MINIMUM_PROVIDER_VERSION: string;
export const PRESETS: Readonly<Record<'auth' | 'google' | 'microsoft' | 'okta' | 'legacy-rs256', { label: string; algorithms: string[]; methods: string[]; email: 'verified-at' | 'google' | 'subject' | 'legacy-verified' }>>;
export function createOidcProviders<R extends string>(options: OidcProvidersOptions<R>): IdentityProviders;
export function createOidcHandler(providers: IdentityProviders, options?: { signInPath?: string }): (request: Request) => Promise<Response | null>;
export class OidcError extends Error { constructor(code: string, status?: number); code: string; status: number }
