import type { AuthConfig, Database } from '../operator-auth/index.mjs';
export interface OwnerClaimConfig {
  /** Trusted exact Run Edit Run origin. */
  issuer: string;
  installationId: string;
  appOrigin: string;
  /** Canonical lowercase configured owner email; never taken from the token. */
  expectedEmail: string;
  publicKeys: Record<string, JsonWebKey>;
}
export interface OwnerClaim {
  v: 1; iss: string; aud: string; installationId: string; email: string;
  jti: string; iat: number; exp: number;
}
export class OwnerClaimError extends Error { constructor(code?: string, status?: number); code: string; status: number }
export function verifyOwnerClaim(token: string, config: OwnerClaimConfig & { /** Epoch seconds. */ now?: number }): Promise<Readonly<OwnerClaim>>;
export interface OwnerClaimHandlerOptions extends OwnerClaimConfig {
  db: Database;
  /** Includes the server-only hidden SETUP_TOKEN and SESSION_SECRET. */
  authConfig: AuthConfig;
  clientIp: (request: Request) => string | Promise<string>;
  /** Milliseconds, default Date.now. */
  clock?: () => number;
}
export function createOwnerClaimHandler(options: OwnerClaimHandlerOptions): (request: Request) => Promise<Response | null>;

export function createIdpOwnerClaimHandler(options:{db:import('../operator-auth/index.mjs').Database;authConfig:import('../operator-auth/index.mjs').AuthConfig;clientIp:(request:Request)=>string|Promise<string>;clock?:()=>number;fetch?:typeof fetch}):(request:Request)=>Promise<Response|null>;
