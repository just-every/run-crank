import type { AuthConfig, CompletedSession, MailMessage, VerifiedIdentity } from '../index.mjs';

export type ConformanceMailStatus = 'accepted' | 'rejected' | 'uncertain';
export interface ConformanceRequestOptions {
  method?: string;
  input?: unknown;
  cookie?: string;
  headers?: HeadersInit;
  ip?: string;
}
export interface ConformanceOpenOptions {
  /** Test-only owner and secret values supplied to the disposable Worker. */
  config: AuthConfig;
  /** Synthetic IF-056-shaped test result. This adapter never sends real mail. */
  mailStatus: ConformanceMailStatus;
  noMail: boolean;
}
export interface OperatorAuthConformanceRuntime {
  /** Dispatch through the consumer's real Worker and mounted `/auth/*` handler. */
  call(path: string, options?: ConformanceRequestOptions): Promise<Response>;
  /** Invoke a native protected HTTP API that authenticates with this same module instance. */
  privateRequest(cookie?: string, options?: Omit<ConformanceRequestOptions, 'cookie' | 'input' | 'method'>): Promise<Response>;
  /** Return only messages captured by the test-only synthetic sender. */
  mails(): Promise<MailMessage[]>;
  /** Optional test-only call through the trusted, already-verified OIDC admission seam. */
  admitVerifiedIdentity?(identity: VerifiedIdentity, returnTo?: string): Promise<CompletedSession>;
  close(): Promise<void>;
}
export interface OperatorAuthConformanceAdapter {
  /** Verify the consumer's same-origin font links and their bounded CSP permissions. */
  confirmationFonts?: boolean;
  /** The consumer's configured product name, served mark and rer-theme.css paths, when declared. */
  branding?: { productName?: string; mark?: string; theme?: string };
  /** Set only when the runtime also implements the provider-key-free admission seam case. */
  oidcIssuer?: string;
  /** Must create disposable real workerd/D1 state and mount the consumer's actual auth and private API routes. */
  open(options: ConformanceOpenOptions): Promise<OperatorAuthConformanceRuntime>;
}
export type ConformanceTestRegistrar = (name: string, fn: () => void | Promise<void>) => unknown;
export function registerOperatorAuthConformance(input: {
  test: ConformanceTestRegistrar;
  adapter: OperatorAuthConformanceAdapter;
}): void;
